// The screensaver: a full-window layer that covers the app after the user has been
// away, and gets out of the way when they come back.
//
// Why this is a separate module from `src/boot-screen.js` rather than a section of
// it: the boot screen is injected into `<head>` and exists only until the app takes
// over — it removes itself on hand-over. The screensaver has to be alive long after
// that, watching for inactivity for the whole life of the session. Different
// lifetime, different timing, different failure modes; sharing a file would mean
// sharing the boot screen's "this runs before React exists" constraints for no
// reason.
//
// So it is injected into `<head>` as its own script row, exactly like the renderers
// and the boot screen before it — NOT bundled into the client half. That distinction
// is the reason it survives: the client bundle can fail to materialize (a missing
// baseline module, a roster that never activates) and the screensaver would go with
// it, while an injected script runs on the page on its own.
//
// It is plain script text with no module syntax because of how it is injected: the
// row is evaluated as a script, so an `import` or `export` here would be a syntax
// error rather than a load.
//
// `entry.js` injects the three rows in dependency order — renderers, then this, then
// the boot screen — because this module builds its media through the renderer factory
// that the first row publishes.
//
// The trigger is deliberately two conditions rather than one, because neither alone
// covers the case that was asked for:
//
//   - the OS idle counter catches "walked away", including while DSH is still the
//     foreground window — which no page-side signal can see;
//   - the window focus flag catches "switched to another program", which the OS
//     counter misses while the user keeps typing over there.
//
// Either one firing shows the screensaver. That is the point: they cover each
// other's blind spots.
//
// There is no settings card, no React, and no dependency on the boot screen's
// namespace. It is plain DOM, because it must survive the app's own UI failing.

/* eslint-disable */
;(function () {
  'use strict'

  /** Where the OS idle counter is read. Injected by the Host as a global. */
  var CFG = globalThis.__DSH_BOOT_ANIM_CFG__

  /**
   * Replace the settings half of `CFG` with the Host's current answer.
   *
   * THE PROBLEM THIS SOLVES, because it cost three reports that all said "the chosen effect is not
   * the one that plays". `CFG` is injected once, as a head row, when the page loads. Saving the
   * settings document does not rebuild it and the desktop shell has no reload key, so every
   * setting the user changed was applied to the DOCUMENT and never reached this script. The client
   * card patches the same global after each save (`pokeLiveConfig`), and that turned out not to be
   * dependable — whether the card and this injected script share one `globalThis` is a property of
   * the host shell. Observed directly: the document held `screensaverPointerEffect: ripples`, the
   * card highlighted 水波涟漪, and this script still resolved `attract`.
   *
   * So the authoritative value is fetched instead. The route answers from the live config on the
   * Host, which is the same source entry.js writes the head row from — one authority, read fresh,
   * once per appearance. Cost: one small GET on a route this script already talks to for its
   * manifest.
   *
   * Failure is silent and keeps the injected values: a screensaver that cannot refresh its
   * settings must still be a screensaver.
   * @returns {Promise<void>} resolves after the merge attempt, always.
   */
  function refreshLiveSettings() {
    var url = typeof CFG === 'object' && CFG !== null && typeof CFG.liveSettings === 'string'
      ? CFG.liveSettings
      : null
    if (url === null) return Promise.resolve()
    return fetch(url, { cache: 'no-store' })
      .then(function (response) { return response.ok ? response.json() : null })
      .then(function (payload) {
        var next = payload && payload.ok ? payload.settings : null
        if (next === null || typeof next !== 'object') return
        if (CFG === undefined || CFG === null || typeof CFG !== 'object') {
          CFG = {}
          globalThis.__DSH_BOOT_ANIM_CFG__ = CFG
        }
        for (var key in next) {
          if (Object.prototype.hasOwnProperty.call(next, key)) CFG[key] = next[key]
        }
      })
      .catch(function () {
        /* an unreachable route leaves the injected values in place */
      })
  }

/**
 * How often to check the two idle conditions.
 *
 * Not once per second: this polls an HTTP route, and the threshold it compares
 * against is measured in minutes. Two seconds is responsive enough that the layer
 * appears when expected and cheap enough that the polling is invisible.
 */
var CHECK_MS = 2000

/**
 * How long a state must hold before the screensaver appears, in milliseconds.
 *
 * Two conditions, either of which triggers:
 *
 *   - `systemIdleMs`: how long the OS has seen no input at all. Null when the probe
 *     cannot answer (a non-Windows platform, or one that failed to start).
 *   - `blurredForMs`: how long this window has been without focus, measured locally.
 *
 * `blurredForMs` is tracked in the page rather than asked of the Host because the
 * page already gets `blur`/`focus` events; routing that through the Host would add a
 * round trip for something the renderer can observe directly.
 *
 * The local clock is also the fallback when the OS probe is unavailable: without it,
 * a machine with no idle counter would have no screensaver at all.
 */
var DEFAULTS = {
  enabled: false,
  idleMs: 180000,
  breakEffect: true,
  // On by default: movement does NOT dismiss, so without a line saying so a nudge that
  // does nothing reads as a freeze.
  hint: true,
  // The two named pickers. 'random' and 'none' are the documented defaults, and they are
  // declared HERE as well as at the call site so `config` is complete no matter which route
  // assembled it — the readers below answer `undefined` otherwise.
  breakStyle: 'random',
  pointerEffect: 'none',
  // Silent unless asked. This layer covers the screen while nobody is looking at it, so a
  // soundtrack would play to an empty room.
  sound: false,
  /** How loud, 0..1. Background by design: a first impression that is too loud gets the whole
   * feature switched off rather than turned down. */
  volume: 0.35,
}

/** The overlay's own class prefix, distinct from the boot screen's `dshba`. */
var PREFIX = 'dshsaver'

/** Every listener this module attaches, so it can detach them all again. */
var listeners = []

var config = { ...DEFAULTS }
var root = null
var media = null
var pieces = []
var visible = false
var timer = null
var blurredSince = null
/** When the window last reported itself hidden, or null while it reports visible. */
var hiddenSince = null
var lastIdleMs = null
var idleStatus = 'starting'
/**
 * True from a dismissal until a FRESH, non-idle reading has been seen.
 *
 * Without it the layer comes back on its own about two seconds after being dismissed,
 * which is what made it take two clicks to get rid of: the click resets the OS counter,
 * but the poll decides against the reading it ALREADY holds (still "idle"), so it shows
 * the layer again. The user's second click then dismisses that second appearance.
 *
 * The guard is a latch rather than a timer on purpose: it clears on EVIDENCE — a reading
 * that says the machine is in use — rather than on a guess about how long that takes.
 */
var dismissedUntilActive = false
/** The stylesheet that recolours the window's caption buttons, or null. */
var captionStyle = null
var disposed = false

/** Read a number-or-null field from the config global. */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Resolve one setting the page must act on NOW: the LIVE value first, the install-time snapshot as
 * the fallback, then the documented default.
 *
 * THIS IS THE SHAPE `pointerEffect()` AND `breakStyle()` ALREADY USE, extended to the five fields
 * that were still reading the snapshot: `enabled`, `idleMs`, `breakEffect`, `hint`, `sound`.
 *
 * Why it matters, plainly: the card marks all nine screensaver fields as live (`LIVE_FIELDS` in
 * `src/client.js`), `entry.js` really does serve them on `/live-settings.json`, and the desktop
 * shell has NO reload key. A field that only reads `config` therefore makes 已保存，已经生效 a
 * promise the product cannot keep — the value is stored, the route answers with it, and the layer
 * goes on using what the page was LOADED with, forever.
 *
 * `config` is the copy `installScreensaver` took when this script first ran; `CFG` is merged from
 * the live route on every appearance and on every poll while the layer is down.
 *
 * The type check is NOT relaxed by the change of source. `CFG` comes off the wire, so a value that
 * arrives with the wrong type is ignored exactly as `installScreensaver` ignores it, and the chain
 * stays live -> snapshot -> default.
 * @param {*} liveValue - the value from `CFG`, of any type.
 * @param {*} snapshotValue - the value kept in `config`.
 * @param {*} fallback - the documented default.
 * @param {(value: *) => boolean} isValid - the strict test a value must pass to be used.
 * @returns {*} the first value that passes `isValid`, or `fallback`.
 */
function liveSetting(liveValue, snapshotValue, fallback, isValid) {
  if (isValid(liveValue)) return liveValue
  if (isValid(snapshotValue)) return snapshotValue
  return fallback
}

/** Strict test for the on/off switches: only a real boolean is accepted. */
function isSwitch(value) {
  return typeof value === 'boolean'
}

/** Strict test for the idle threshold: a positive, finite number of milliseconds. */
function isThreshold(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Whether the layer may appear at all, resolved live. */
function saverEnabled() {
  return liveSetting(CFG?.screensaverEnabled, config.enabled, DEFAULTS.enabled, isSwitch)
}

/** How long a state must hold before the layer appears, in milliseconds, resolved live. */
function idleThresholdMs() {
  return liveSetting(CFG?.screensaverIdleMs, config.idleMs, DEFAULTS.idleMs, isThreshold)
}

/** Whether a dismissal plays the exit effect at all, resolved live. */
function breakEffectOn() {
  return liveSetting(CFG?.screensaverBreakEffect, config.breakEffect, DEFAULTS.breakEffect, isSwitch)
}

/** Whether the layer shows the 点击或按任意键继续 line, resolved live. */
function hintOn() {
  return liveSetting(CFG?.screensaverHint, config.hint, DEFAULTS.hint, isSwitch)
}

/** Whether the layer's media may make a sound, resolved live. */
function soundOn() {
  return liveSetting(CFG?.screensaverSound, config.sound, DEFAULTS.sound, isSwitch)
}

/** Attach a listener and remember it, so `dispose` can take it off again. */
function on(target, type, handler, options) {
  target.addEventListener(type, handler, options)
  listeners.push(() => target.removeEventListener(type, handler, options))
}

/**
 * The stylesheet, built once.
 *
 * Plain string concatenation rather than a template literal, matching the rest of
 * this package: a stray backtick in a CSS blob has already cost this project one
 * silent build failure.
 */
function styles() {
  return [
    // The layer itself.
    //
    // It is taken out of the input and paint trees entirely when hidden, using
    // `visibility: hidden` AND `display: none` rather than relying on `pointer-events`
    // alone. That is a deliberate escalation after a real incident: `pointer-events`
    // has a cascade trap (a child naming `auto` ignores a parent's `none`) and the
    // failure mode is the worst one this feature has — the user's whole window stops
    // accepting clicks and scrolls, invisibly, with nothing on screen to explain it.
    // `display: none` removes the element from layout, so it CANNOT receive a click,
    // cannot be hit-tested, and cannot be scrolled to, whatever any descendant says.
    // Nothing about a hidden screensaver is worth a rule that can be got wrong.
    // The z-index is the MAXIMUM a 32-bit signed integer can hold, matching the boot
    // overlay. It is not a number picked to be "very large" — it is the ceiling, and the
    // reason is that the window's own caption buttons live ABOVE the page.
    //
    // Those three buttons are Electron's `titleBarOverlay` (height 40), drawn in the window
    // chrome rather than in the DOM. No `z-index` can cover them, because they are not in
    // the page's stacking context at all — the overlay is painted by the OS/Electron over
    // the web contents. What this number buys is that the screensaver sits at least as high
    // as anything the page itself can produce, including the boot overlay, so nothing
    // INSIDE the page can end up above it.
    '.' + PREFIX + '{position:fixed;inset:0;z-index:2147483647;overflow:hidden;',
    'background:#050b14;opacity:0;transition:opacity .45s ease;',
    'display:none;visibility:hidden;pointer-events:none;',
    '-webkit-user-select:none;user-select:none}',
    // Shown: visible, painted, and the only state in which this layer takes input.
    '.' + PREFIX + '[data-shown="1"]{display:block;visibility:visible;opacity:1;pointer-events:auto}',
    // Leaving: still in layout so the fade is SEEN, but already out of the input tree.
    //
    // `display: none` cannot be used to hide the layer on the way out, because it would
    // remove it instantly and the 450ms fade would never render — the screensaver would
    // blink away instead of dissolving. So the fade gets its own state: still `block`,
    // opacity driven to 0, and input refused from the first frame.
    //
    // `display: block` has to be restated here rather than inherited, and that is the
    // subtlety: the base rule carries `display: none`, and this state does NOT match the
    // `[data-shown="1"]` rule that would otherwise put the layer back in layout. Without
    // this line the leaving layer would be removed instantly and the fade would never
    // happen — a bug that looks like "the dissolve stopped working" rather than like a
    // CSS ordering problem.
    //
    // This rule is written AFTER the shown rule on purpose: equal specificity, so the
    // later one wins, which is what lets it override the shown rule's opacity.
    '.' + PREFIX + '[data-leaving="1"]{display:block;visibility:visible;opacity:0;pointer-events:none}',
    // The catcher is what makes a click anywhere count as "come back". It sits above
    // the media so the media never has to care about input at all, and it takes input
    // only while the layer is shown — for the same reason, and with the same bug behind
    // it. It is `display: none` with the layer, so even a descendant that named `auto`
    // unconditionally cannot receive anything while the layer is hidden.
    '.' + PREFIX + '-catch{position:absolute;inset:0;z-index:3;cursor:pointer;pointer-events:none}',
    '.' + PREFIX + '[data-shown="1"] .' + PREFIX + '-catch{pointer-events:auto}',
    // ...and the catcher stops taking input the moment the layer starts leaving, which
    // is the half of the bug that actually locked the window: a dismissed layer must
    // refuse the very next click, not the one after the fade finishes.
    '.' + PREFIX + '[data-leaving="1"] .' + PREFIX + '-catch{pointer-events:none}',
    '.' + PREFIX + '-media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
    '.' + PREFIX + '-media.' + PREFIX + '-contain{object-fit:contain}',
    // The renderer's element also carries the boot screen's own `dshba-media` class,
    // whose rule holds it at `opacity: 0` until `data-shown="1"`. That stylesheet
    // belongs to another module and can be removed with it, so this layer states the
    // visibility rule for its OWN class as well: a screensaver must not depend on the
    // boot screen still being around to show its picture.
    //
    // The descendant form (`.dshsaver .dshsaver-media`) rather than a single class,
    // because specificity decides this and the boot screen's sheet is injected AFTER
    // this one: at equal specificity the later rule wins, and `opacity: 0` would take
    // the picture away. Two class selectors outrank the boot screen's single-class
    // rule, so this holds whether or not that sheet is still present.
    '.' + PREFIX + ' .' + PREFIX + '-media{opacity:1}',
    // The same for the Live2D canvas the adapter creates inside the element.
    '.' + PREFIX + ' .' + PREFIX + '-media canvas{opacity:1}',
    // The hint. Bottom centre, quiet: it is the answer to "why will nothing
    // happen when I move the mouse", so it has to be readable, and nothing more.
    //
    // It carries its own translucent plate rather than relying on a text shadow,
    // because the artwork behind it is whatever the user put in the pool: a shadow
    // is enough over a dark photo and useless over the white one, and this hint is
    // the only thing telling the user how to get out.
    '.' + PREFIX + '-hint{position:absolute;left:50%;bottom:40px;transform:translateX(-50%);',
    'z-index:4;font:12px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
    'letter-spacing:.14em;color:rgba(233,241,250,.9);',
    'background:rgba(8,14,24,.55);border:1px solid rgba(160,190,220,.22);',
    'border-radius:999px;padding:7px 16px;',
    'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);',
    'white-space:nowrap;pointer-events:none;transition:opacity .5s ease}',
    // Fades out after a few seconds so it does not sit on the artwork forever, and
    // comes back if the user tries something that does not dismiss it.
    '.' + PREFIX + '-hint[data-quiet="1"]{opacity:0}',
    // The hint switched off. `display: none` rather than opacity, so it is out of the layout
    // and the accessibility tree entirely — a hint nobody can see should not be read aloud or
    // occupy a line of the artwork.
    '.' + PREFIX + '-hint[data-hidden="1"]{display:none}',
    // The diagnostic panel. Top-left, monospace, above everything and inert to the pointer, so it
    // can be read off the screen without changing what it is measuring.
    '.' + PREFIX + '-trace{position:absolute;left:12px;top:12px;z-index:9;pointer-events:none;',
    'font:12px/1.5 ui-monospace,Consolas,monospace;color:#eaf2ff;',
    'background:rgba(8,14,24,.78);border-radius:8px;padding:8px 12px;max-width:52ch;',
    'white-space:pre-wrap;word-break:break-all}',
    '.' + PREFIX + '-trace[data-hidden="1"]{display:none}',
    // The break effect is drawn on ONE canvas, so there is a single rule for it and no
    // per-tile CSS at all.
    //
    // This replaced a DOM implementation — tens of thousands of elements, each with its own
    // transform and opacity transition — which measured catastrophically: 12,180 tiles
    // produced FOUR frames in 11.9 seconds on a real machine, one frame alone taking
    // 10,987ms. The user's "18 seconds to dismiss" was that freeze. Every DOM element is a
    // separate compositing unit; a canvas is one, and the grid is redrawn per frame with
    // `drawImage` — a GPU blit per block with no layout and no style recalculation.
    //
    // `position: fixed` because it is attached to the document rather than inside the
    // screensaver root: it has to outlive the root's own fade, and the root's box is the
    // viewport anyway.
    '.' + PREFIX + '-tear{position:fixed;inset:0;z-index:2147483647;pointer-events:none}',
    // Motion-sickness guard: a user who asked their system for reduced motion gets
    // the plain dissolve instead of the tear, with no setting to change.
    '@media (prefers-reduced-motion: reduce){',
    '.' + PREFIX + '{transition:opacity .2s ease}',
    '.' + PREFIX + '-tiles{display:none}}',
  ].join('')
}

/** Build the layer once, and keep it in the document from then on. */
function build() {
  const style = document.createElement('style')
  style.setAttribute('data-' + PREFIX, '')
  style.textContent = styles()

  const node = document.createElement('div')
  node.className = PREFIX
  node.setAttribute('role', 'presentation')
  node.setAttribute('aria-hidden', 'true')

  const catcher = document.createElement('div')
  catcher.className = PREFIX + '-catch'

  const hint = document.createElement('div')
  hint.className = PREFIX + '-hint'
  hint.textContent = '点击或按任意键继续'
  hint.setAttribute('data-quiet', '0')
  // Built regardless, and hidden by a rule when the setting is off. Creating it always keeps
  // the DOM shape identical between the two states, so nothing downstream has to test for its
  // absence — and `show()` would otherwise need a guard on every line that touches it.
  //
  // Read LIVE: the switch is one of the fields the card calls "already in effect", and the layer is
  // built once. `beginAppearance()` re-states the attribute on every appearance, so flipping the
  // switch changes the very next appearance without a reload; this line only decides the state the
  // element starts in.
  if (!hintOn()) hint.setAttribute('data-hidden', '1')

  node.appendChild(catcher)
  node.appendChild(hint)

  // A DIAGNOSTIC PANEL, created only when the page was opened with a trace flag.
  //
  // The desktop app has no console and no address bar, so the only way to answer "did the mouse
  // event arrive, and did the decoration draw" for a user is on the screen they are already
  // looking at. It sits above everything, ignores the pointer, and reports the four links of the
  // chain: events received, whether the pointer counted as inside, whether the loop is running,
  // and how many strokes went into the canvas.
  const trace = document.createElement('div')
  trace.className = PREFIX + '-trace'
  trace.setAttribute('data-hidden', '1')
  node.appendChild(trace)

  return { style, node, catcher, hint, trace }
}

/**
 * Ask the Host how long the whole machine has been idle.
 *
 * Failure is expected and handled: a non-Windows platform answers `unavailable`
 * forever, and a request that fails leaves the previous answer in place rather than
 * pretending the machine just became busy.
 */
function pollSystemIdle() {
  const url = typeof CFG?.systemIdle === 'string' ? CFG.systemIdle : null
  if (url === null) {
    idleStatus = 'unavailable'
    return
  }
  fetch(url, { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      if (payload === null || typeof payload !== 'object') return
      idleStatus = typeof payload.status === 'string' ? payload.status : 'unavailable'
      lastIdleMs = numberOrNull(payload.idleMs)
      // A reading that says the machine is in use is the EVIDENCE that clears a
      // dismissal. Until one arrives, the layer must not come back — see
      // `dismissedUntilActive` for why that matters (it was the two-click bug).
      //
      // Compared against the LIVE threshold, so an edit to 闲置时长 takes effect on this poll
      // rather than on the next page load.
      if (lastIdleMs !== null && lastIdleMs < idleThresholdMs()) dismissedUntilActive = false
    })
    .catch(() => {
      // A failed request says nothing about the user, so the status is left alone.
      // Treating it as "unavailable" would silently disable the OS half of the
      // trigger because of one dropped request.
    })
}

/**
 * How long the window has been unfocused, in milliseconds, or 0 while focused.
 *
 * Tracked from the page's own `blur`/`focus` events. The page is also asked directly
 * on the first check, because the layer is built after the app is up and the window
 * may already have been unfocused for a long time before any listener existed.
 */
function blurredFor() {
  if (blurredSince === null) return 0
  return Date.now() - blurredSince
}

/**
 * How long the window has been reporting itself hidden, in milliseconds, or 0 while it
 * reports itself visible.
 *
 * A GRACE PERIOD sits on top of this, and it is there because of a real flicker. In the
 * Electron shell `visibilityState` is not the stable signal it is in a browser tab: it
 * flips between `visible` and `hidden` while the window is plainly on screen. Acting on
 * each flip showed and hid the layer in turn — the whole screen strobed, which is worse
 * than any of the bugs this check was meant to prevent.
 *
 * So "hidden" is only believed once it has PERSISTED. A brief flip is ignored; a real
 * minimise or switch-away still takes the layer down, a few seconds later instead of
 * instantly. The cost of waiting is a layer that is up for a moment longer than needed
 * in a window nobody can see; the cost of not waiting was a strobing screen.
 */
function hiddenFor() {
  if (hiddenSince === null) return 0
  return Date.now() - hiddenSince
}

/** How long `hidden` must persist before it is believed. */
const HIDDEN_GRACE_MS = 5000

/** Whether either idle condition has been met. */
function shouldShow() {
  // THE LIVE `screensaverEnabled`, not the install-time snapshot. The layer is installed
  // unconditionally now (see `installScreensaver` for why), so this line is the ONLY thing that
  // decides whether it appears — and it is asked on every tick, which is what makes the switch
  // take effect the moment it is saved instead of after a reload the desktop shell cannot offer.
  if (!saverEnabled()) return false
  // A dismissal holds until the machine is seen to be in use again. Without this the
  // layer reappears about two seconds after the user dismisses it — on the reading the
  // poll was already holding, which still said "idle" — and getting rid of it takes a
  // second click. See `dismissedUntilActive`.
  if (dismissedUntilActive) return false
  // The boot overlay owns the screen until it hands over. A screensaver that covered
  // it would be the boot animation's own failure mode reproduced by a different
  // feature: the user would never see the animation they configured, and the hand-off
  // would happen underneath a layer they did not ask for. The overlay removes itself
  // when it is done, so this clears by itself a few seconds later.
  if (globalThis.__DSH_BOOT_ANIM__ !== undefined && globalThis.__DSH_BOOT_ANIM__.el?.parentNode) {
    return false
  }
  // A window nobody can see should not be covered. This is the half of "is anybody
  // looking" that the page CAN answer — but only once the answer has PERSISTED, because
  // in the Electron shell `visibilityState` flickers while the window is plainly on
  // screen. Believing each flip showed and hid the layer in turn, and the screen strobed.
  //
  // The other half is not answerable and is NOT attempted: a window merely COVERED by
  // another window still reports 'visible', because that is an operating-system fact the
  // renderer cannot see.
  if (hiddenFor() >= HIDDEN_GRACE_MS) return false
  // The OS half. Only a reading counts: 'starting' means the probe has not answered
  // yet, and 'unavailable' means it never will, so neither may be read as "idle".
  //
  // The threshold is resolved live, per check, for the same reason as the switch above: 闲置时长
  // is one of the fields the card promises is already in effect.
  if (idleStatus === 'ok' && lastIdleMs !== null && lastIdleMs >= idleThresholdMs()) return true
  // The focus half. Always available, and the only half on a platform without an OS
  // idle counter.
  if (blurredFor() >= idleThresholdMs()) return true
  return false
}

/** Show the layer, picking a fresh entry from the screensaver pool. */
function show() {
  if (visible || root === null) return
  // Refresh the settings BEFORE anything reads them. The effects resolve their style from `CFG` at
  // the moment they run, so a stale object here is a whole appearance drawn with the previous
  // choice. The fetch is started first and the rest of the appearance waits on it, which costs one
  // round trip on a local route — invisible next to the manifest fetch that follows.
  //
  // `visible` is set first so the wait cannot let a second `show()` start: the guard at the top is
  // what makes this safe, and moving it after the await would allow two layers.
  visible = true
  // DRAW FIRST, then refresh the settings.
  //
  // This used to be `refreshLiveSettings().then(beginAppearance)`, and that is a deadlock waiting to
  // happen: `visible` is already true, so `tick()` never calls `show()` again, and if the fetch is
  // slow or never settles the appearance — including the pointer decoration that registers its own
  // listeners — simply never happens. The symptom is exactly what was reported: after some
  // restarts the mouse effect stops working, and the same build works on other runs.
  //
  // The values in `CFG` are the ones the page was served with, which is correct for the first
  // appearance. So the layer is raised now, and the fetch updates those values for the NEXT read
  // (`pointerEffect()` / `breakStyle()` are resolved per use). Nothing waits on the network.
  beginAppearance()
  refreshLiveSettings()
}

/** When the settings were last refreshed, for the diagnostic readout. */
var liveSettingsAt = 0

/** Everything `show()` does once the settings are current. */
function beginAppearance() {
  liveSettingsAt = Date.now()
  if (!visible || root === null) return

  // A fresh entry per appearance, and the previous one released: a Live2D adapter
  // holds a render loop and a GL context, so reusing the node would leak both.
  releaseMedia()

  // Setting the attribute is what shows the layer AND what lets it take input: the
  // stylesheet ties both `opacity` and `pointer-events` to it. Nothing is assigned to
  // `style.pointerEvents` here, deliberately — an inline value would outrank the rule,
  // and a stale inline `auto` is what left an invisible click blocker over the app.
  //
  // `data-leaving` is cleared FIRST, and it has to be: a layer that was fading out when
  // it became idle again would otherwise come back invisible and inert, because the
  // leaving rule outranks the shown one. That is a real sequence — the idle reading can
  // drop and rise again within one fade.
  root.removeAttribute('data-leaving')
  root.setAttribute('data-shown', '1')
  root.setAttribute('aria-hidden', 'false')
  // The caption buttons are recoloured to vanish against the layer, and restored on the way
  // out. See `setCaptionHidden` for how a page can reach the window chrome at all.
  setCaptionHidden(true)

  // The hint is shown on arrival and then fades, so it explains the exit without
  // becoming permanent furniture on the artwork. Skipped entirely when the setting is off —
  // the element carries `data-hidden` and its rule is `display: none`, so touching
  // `data-quiet` here would be harmless but pointless.
  //
  // BOTH attributes are re-stated here rather than decided once in `build()`, because the element
  // is created a single time and the switch is one the card calls "already in effect". Deciding
  // `data-hidden` only at build time would mean a flip made while the app is running needed a page
  // reload, and the desktop shell has no reload key. Off means no fade timer is armed either: a
  // timer that flips `data-quiet` on an element nobody can see is pure noise.
  if (hintOn()) {
    pieces.hint.removeAttribute('data-hidden')
    pieces.hint.setAttribute('data-quiet', '0')
    setTimeout(() => {
      if (visible) pieces.hint.setAttribute('data-quiet', '1')
    }, 6000)
  } else {
    pieces.hint.setAttribute('data-hidden', '1')
  }

  pickAndPlace()
  // The diagnostic panel, when the page asked for one.
  startTracePanel()
  // The pointer decoration starts with the appearance. It draws over the media, so it must be
  // attached AFTER the layer is up; starting it here rather than inside pickAndPlace means it also
  // works for an appearance whose media never arrives (a ring on an empty layer is still visible,
  // which is better than a dead screen).
  const pointer = pointerEffect()
  if (pointer !== null) startPointerArt(pointer)

  // Start the rotation clock, if the user asked for one. Armed from `show()` rather than from
  // `pickAndPlace()` so the interval is measured from the appearance, and disarmed in `hide()`.
  startRotation()
}

/** The rotation timer, or null when the layer rotates nothing. */
let rotateTimer = null
/** Names already shown since this appearance, so a rotation does not repeat one before it must. */
let rotationSeen = []
/**
 * Whether the interval has elapsed and a switch is owed.
 *
 * Set by the tick, cleared by the switch itself. While it is set, the current entry is allowed to
 * run to its end and is replaced the moment it does — the switch waits for the CLIP, not for the
 * next tick.
 */
let rotationDue = false

/**
 * Swap the current entry for the next one, keeping the layer up.
 *
 * Deliberately NOT `hide()` + `show()`: that would play the exit effect and re-run the whole
 * appearance (caption buttons, hint, pointer art), which is a dismissal the user did not ask for.
 * This replaces the media in place and leaves everything else exactly as it was.
 *
 * The next name is remembered across rotations so the pool CYCLES rather than repeats: with two
 * clips, a plain random pick lands on the same one half the time, which reads as "it is not
 * rotating at all".
 */
function rotateEntry() {
  if (!visible || root === null) return
  const pool = rotationPool()
  if (pool.length === 0) return

  // THE INTERVAL IS WHEN THE SWITCH BECOMES DUE, NOT WHEN IT HAPPENS.
  //
  // What the user asked for, in their words: "当前播完再换，不是下次再检查" — the moment the due
  // time arrives the current entry is allowed to end, and it must be swapped the instant it does,
  // not at the next tick. Polling `currentTime()` from the rotation interval cannot do that: with a
  // 15s interval and a clip that ends at 15.2s, the switch would land at 30s.
  //
  // BUT "播完再换" DOES NOT EXIST ON THIS LAYER, and that is the correction. `pickAndPlace` builds
  // every screensaver renderer with `{ loop: true }`, and per the HTML spec a LOOPING `<video>`
  // NEVER fires `ended`. So arming `onEnded` here waited for an event that could not arrive: the
  // first tick armed the listener and returned, the second tick found `rotationDue` already set
  // and switched — a 15-second interval that took 30 seconds, on every rotation, forever. The
  // intent above is kept for the ONE case where it can be honoured (a renderer this module knows
  // will really finish, i.e. one built without `loop`); everything else switches on the tick that
  // finds the interval due, which is the earliest moment the user's setting allows.
  //
  // The renderer contract still gives the three-way answer for the non-looping case — a video
  // emits `ended`, and a kind with no timeline has no `onEnded` at all:
  //   - looping (the normal screensaver case): no end to wait for, this tick IS the switch
  //   - no `onEnded` (a still, an animated image, a Live2D model): nothing to wait for, switch now
  //   - `isEnded()` already true: the clip finished before the due time, switch now
  //   - otherwise: wait for the event, and only for THIS entry (`media !== watched` guards a
  //     replacement that happened underneath us)
  //
  // A non-looping clip longer than the interval therefore plays to its end and is replaced on the
  // last frame; a clip shorter than the interval plays out, and the switch waits for the due time
  // as asked.
  if (!rotationDue) {
    rotationDue = true
    const renderer = media
    if (mediaLoops === false && renderer !== null && typeof renderer === 'object'
      && typeof renderer.onEnded === 'function') {
      const watched = renderer
      let alreadyEnded = false
      try {
        alreadyEnded = typeof renderer.isEnded === 'function' && renderer.isEnded() === true
      } catch (error) {
        alreadyEnded = false
      }
      if (!alreadyEnded) {
        renderer.onEnded(() => {
          // Only if this is still the entry on screen, and it is still time to rotate. A clip that
          // ends while the layer has been dismissed must not start a switch on a dead layer.
          if (media === watched && visible && rotationDue) rotateNow()
        })
        return
      }
    }
    // Nothing to wait for: this tick IS the switch.
  }
  rotateNow()
}

/**
 * Perform the switch, right now.
 *
 * Split out from `rotateEntry()` because there are two callers — the interval tick when the entry
 * has no timeline to finish, and the `ended` event when it does — and both must do exactly the same
 * thing. Called at most once per due period: `rotationDue` is cleared first, so a renderer that
 * fires `ended` twice cannot switch twice.
 */
function rotateNow() {
  if (!visible || root === null) return
  rotationDue = false
  const pool = rotationPool()
  if (pool.length === 0) return

  const current = mediaName
  // Prefer an entry not yet seen this appearance; when every entry has been seen, start the round
  // over — but never the one on screen, so no clip is shown twice in a row.
  let candidates = pool.filter((name) => name !== current && !rotationSeen.includes(name))
  if (candidates.length === 0) {
    rotationSeen = []
    candidates = pool.filter((name) => name !== current)
  }
  if (candidates.length === 0) return

  const next = candidates[Math.floor(Math.random() * candidates.length)]
  rotationSeen.push(next)
  forcedEntryName = next
  // `pickAndPlace` only ADDS; it never removes. So the old entry is released here, after the
  // snapshot is taken (the dissolve needs its pixels) and before the new one mounts. Without this
  // the previous element stays in the layer and the two pictures stack.
  const before = captureForDissolve()
  releaseMedia()
  pickAndPlace()
  crossDissolve(before)
  // The lens displaces a SNAPSHOT of the media, and the media was just replaced. Re-taking it is
  // the difference between a lens that shows the new picture and one showing the old one forever.
  if (pointerArt !== null && typeof pointerArt.refreshSource === 'function') {
    setTimeout(() => {
      if (pointerArt !== null && typeof pointerArt.refreshSource === 'function') pointerArt.refreshSource()
    }, 420)
  }
}

/**
 * A snapshot of what is on screen right now, for the dissolve into the next entry.
 *
 * (`currentEntryFinished()` USED TO SIT HERE AND HAS BEEN DELETED. Its own comment claimed it was
 * "kept for the diagnostic readout and for `state()`", and neither was true — it had no call site
 * anywhere in this file, so it was dead code that read as a live diagnostic. It could not usefully
 * be wired into `saverState()` either: it answers `currentTime() >= duration() - 0.35`, and every
 * screensaver renderer is built with `loop: true`, so a looping `<video>`'s `currentTime` wraps
 * back to 0 at the end and `ended` never becomes true. The value it would report is therefore
 * "not finished" for the entire life of every appearance, which tells a reader nothing about why
 * a layer is behaving the way it is — the opposite of what a diagnostic field is for. Deleted
 * rather than wired in, so nobody reads it as evidence.)
 *
 * Taken as ONE downsampled canvas rather than as per-element copies, and that is the point: the
 * kinds differ (a video element, an img, a Live2D canvas), and the only thing they share is that
 * they have painted something. Copying the layer is what makes the dissolve work for all of them
 * without teaching this function what a kind is.
 *
 * Returns null when a snapshot cannot be taken — the layer has no size, or the canvas refuses a
 * context. Callers must treat null as "dissolve without a picture", not as an error.
 */
function captureForDissolve() {
  if (root === null) return null
  const width = root.clientWidth
  const height = root.clientHeight
  if (width === 0 || height === 0) return null
  const small = document.createElement('canvas')
  // Quarter scale: the dissolve lasts a few hundred milliseconds and a soft cross-fade does not
  // need full resolution. It also keeps the copy cheap for a 4K window.
  small.width = Math.max(1, Math.round(width / 4))
  small.height = Math.max(1, Math.round(height / 4))
  const surface = small.getContext('2d')
  if (surface === null) return null
  const source = media !== null && typeof media.el === 'function' ? media.el() : null
  if (source === null || source === undefined) return null
  try {
    surface.drawImage(source, 0, 0, small.width, small.height)
  } catch (error) {
    // A canvas from another origin taints the snapshot; a Live2D surface may not be drawable.
    return null
  }
  return small
}

/**
 * Fade the previous picture out over the new one. The default transition, per the request.
 *
 * Drawn on its own canvas above the media and below the catcher's z-index, removed when it has
 * finished. A CSS opacity ramp is not enough here: the OLD picture has to fade OUT while the NEW
 * one is already beneath it, and the old one no longer exists as an element — only as this
 * snapshot.
 *
 * Reduced motion is honoured: the caller still gets a switch, just without the fade.
 */
function crossDissolve(before) {
  if (before === null || root === null) return
  if (prefersReducedMotion()) return
  const canvas = document.createElement('canvas')
  canvas.className = PREFIX + '-dissolve'
  canvas.width = before.width
  canvas.height = before.height
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;'
    + 'pointer-events:none;z-index:2'
  const surface = canvas.getContext('2d')
  if (surface === null) return
  surface.drawImage(before, 0, 0)
  root.appendChild(canvas)
  const FADE_MS = 420
  const startedAt = performance.now()
  const step = (now) => {
    const t = Math.min(1, (now - startedAt) / FADE_MS)
    canvas.style.opacity = String(1 - t)
    if (t >= 1) { canvas.remove(); return }
    globalThis.requestAnimationFrame(step)
  }
  globalThis.requestAnimationFrame(step)
  // A timer as well as the ramp: `requestAnimationFrame` does not run in a hidden window, and a
  // dissolve canvas that never got its last frame would sit at full opacity forever.
  setTimeout(() => { if (canvas.parentNode) canvas.remove() }, FADE_MS + 400)
}

/**
 * The names the rotation may choose from: the pool's entries, minus the ones the user unchecked.
 *
 * Kept as names rather than entries because that is what `pickAndPlace` consumes. The manifest is
 * re-read on every appearance anyway, so a pool edited while the screensaver is up is picked up by
 * the next appearance rather than by a rotation.
 */
function rotationPool() {
  const items = Array.isArray(lastManifestItems) ? lastManifestItems : []
  const enabled = items.filter((item) => item !== null && item.enabled !== false)
  const pool = enabled.length > 0 ? enabled : items
  return pool.map((item) => item && item.name).filter((name) => typeof name === 'string')
}

/**
 * Arm the rotation timer from the live setting.
 *
 * Read from the injected config global rather than from the snapshot taken at install, for the
 * same reason the two pickers are: an interval the user just set must apply on the next
 * appearance, not after a rebuild.
 */
/**
 * Show the pointer chain's state on the layer itself, when the page asked for it.
 *
 * THE REASON THIS EXISTS, plainly: this decoration has been reported broken four times, and every
 * round was spent guessing because the four links — the setting reached the page, the canvas was
 * mounted, a pointer event arrived, strokes went into it — are invisible from outside, and the
 * desktop app has no console to read. The Host report answers the first three but only every ten
 * seconds and only when somebody fetches it; this puts the answer where the person who is looking
 * at the broken effect can see it.
 *
 * Off unless the URL carries a trace flag, because it is a debug surface and not a feature.
 */
function startTracePanel() {
  if (pieces.length === 0 || !pieces.trace) return
  const wanted = globalThis.location !== undefined
    && typeof globalThis.location.search === 'string'
    && /[?&](dshtrace|dshbootdiag)=1/.test(globalThis.location.search)
  if (!wanted) return
  pieces.trace.removeAttribute('data-hidden')
  const paint = () => {
    if (!visible) return
    const st = saverState()
    pieces.trace.textContent = 'moves=' + st.pointerMoves
      + ' inside=' + (st.pointerInside ? 1 : 0)
      + ' mounted=' + (st.pointerArtMounted ? 1 : 0)
      + ' running=' + (st.pointerRunning ? 1 : 0)
      + ' strokes=' + st.pointerStrokes
      + '\nstyle=' + st.pointerRaw + ' -> ' + st.pointerNow
      + '\nrect=' + (root === null ? '-' : Math.round(root.clientWidth) + 'x' + Math.round(root.clientHeight))
  }
  paint()
  setInterval(paint, 400)
}

function startRotation() {
  stopRotation()
  const ms = typeof CFG?.screensaverRotateMs === 'number' ? CFG.screensaverRotateMs : 0
  // Under a second is not a rotation, it is a flicker. The Host clamps too, but a hand-edited
  // document must not be able to arm a timer that fires every frame.
  if (!(ms >= 1000)) return
  rotateTimer = setInterval(rotateEntry, ms)
}

/** Disarm the rotation. Safe to call when nothing is armed. */
function stopRotation() {
  if (rotateTimer !== null) clearInterval(rotateTimer)
  rotateTimer = null
  rotationSeen = []
  // The due flag belongs to one armed period. Leaving it set would make the NEXT appearance treat
  // its first tick as already due and switch a clip the user had only just started watching.
  rotationDue = false
}

/**
 * Make the window's caption buttons vanish against the layer, or put them back.
 *
 * HOW A PAGE CAN REACH THE WINDOW CHROME AT ALL — and it can, which is not obvious.
 *
 * The three buttons (minimise, maximise, close) are Electron's `titleBarOverlay`, drawn
 * above the web contents, so no `z-index` touches them and the plugin cannot call
 * `setTitleBarOverlay` itself. But the desktop shell derives their colours FROM THE PAGE:
 * its preload keeps a hidden probe element styled with
 *
 *     background-color: var(--dsw-specific-sidebar-fill)
 *     color:            var(--dsw-alias-label-primary)
 *
 * reads the computed values, and forwards them over its `windowsAppearance` IPC — which the
 * main process turns into `setTitleBarOverlay({ color, symbolColor })`. It re-sends on a
 * MutationObserver watching `document.head` for childList changes. So overriding those two
 * variables from a stylesheet the page inserts is enough to recolour the buttons.
 *
 * The override has to be aimed at `body`, where the app declares them — see the note inside.
 *
 * That is exactly what the boot overlay does by accident: its dark background is painted
 * over the whole window, so the dark caption glyphs have nothing to contrast against.
 *
 * What this buys is the glyphs matching the layer's own background, so they are invisible
 * while it is up. What it does NOT buy is the HOVER state — Windows paints that itself, on
 * top, and nothing in the page can suppress it. Worth knowing: a stray hover near the close
 * button during a screensaver can still dismiss the window.
 */
function setCaptionHidden(hidden) {
  if (document.head === null || document.head === undefined) return
  if (hidden) {
    if (captionStyle !== null) return
    // A data attribute rather than a class, so the rule cannot collide with the app's own
    // selectors, and a single style element rather than an inline property, so it is removed
    // cleanly and nothing is left behind.
    captionStyle = document.createElement('style')
    captionStyle.setAttribute('data-' + PREFIX + '-caption', '')
    // THE COLOURS ARE TRANSPARENT, and that is the correction after the first attempt made
    // the buttons a BLACK BLOCK.
    //
    // `titleBarOverlay.color` paints only the caption-button STRIP — not the whole title bar —
    // and the app's own value for it is `#f9fafb`, a light grey. Setting it to the layer's
    // background colour therefore produced a dark strip laid over a full-bleed image, which
    // reads as a black rectangle rather than as part of the picture. Transparent lets the
    // screensaver show through, which is what "covered" should mean.
    //
    // The glyphs go transparent too: with no strip behind them there is nothing for an opaque
    // glyph to contrast against, and a visible glyph is exactly what the user does not want.
    //
    // THE SELECTOR IS `body`, NOT `:root`, and getting that wrong is why the version before
    // this did nothing at all. The app declares these two variables on `body`
    // (`body{--dsw-specific-sidebar-fill:var(--dsw-static-neutral-bluish-50); ...}`), and the
    // preload's probe element is APPENDED TO BODY, so it inherits from `body`. A `:root`
    // override is on an ancestor and loses to the closer `body` declaration no matter how
    // important it is.
    //
    // `!important` is still required, because the app's own `body` rule would otherwise win on
    // order rather than specificity.
    captionStyle.textContent = 'body{'
      + '--dsw-specific-sidebar-fill:transparent !important;'
      + '--dsw-alias-label-primary:transparent !important;'
      + '}'
    document.head.appendChild(captionStyle)
    return
  }
  if (captionStyle !== null && captionStyle.parentNode) captionStyle.remove()
  captionStyle = null
}

/** Take the layer down, optionally with the break effect. */
function hide(withBreak, forcedStyle) {
  if (!visible || root === null) return
  visible = false
  // The buttons go back to the app's colours the moment the layer stops covering them.
  setCaptionHidden(false)
  // A dismissal — as opposed to the layer standing down for a hidden window or the boot
  // overlay — must hold until the machine is seen to be in use again. Setting the latch
  // for every hide would be wrong: a window that was merely hidden would then need a
  // click to come back, which is not what anybody asked for. So it is set only when the
  // user actually dismissed something, which is exactly what `withBreak` distinguishes:
  // the click and key paths pass true, the automatic stand-downs pass false.
  //
  // A PREVIEW is the one dismissal that must not latch: the user is present by definition
  // (they just clicked 预览), and leaving the latch set would silently disable the
  // screensaver for the rest of the session.
  if (withBreak && !previewing) dismissedUntilActive = true
  // The preview flag and its forced style are consumed by the dismissal they led to. Clearing
  // them here rather than in the caller is what makes them one-shot: a preview ends, and the
  // next appearance — a real one, minutes later — goes back to the configured behaviour.
  const forcedForPreview = previewForcedStyle
  previewing = false
  previewForcedStyle = null

  // Put the boot overlay back where it was. A preview took it out of the DOM so the two layers
  // would not fight over the screen; the boot screen is a node with its own state and children,
  // so restoring the node restores the animation — nothing was destroyed.
  if (bootOverlayParked !== null) {
    const parked = bootOverlayParked
    bootOverlayParked = null
    try {
      if (parked.parent !== null && parked.parent.isConnected) {
        parked.parent.insertBefore(parked.el, parked.next)
      }
    } catch (error) {
      /* a parent that has gone away is not worth failing the dismissal over */
    }
  }

  // The pointer decoration is torn down FIRST, before the layer starts leaving: its canvas sits
  // above the media, and an effect still animating over a fading layer would be a bright ghost of
  // the screensaver left on screen. Its own teardown is idempotent and never throws.
  stopPointerArt()

  // The rotation stops with the layer. A timer left armed would keep fetching and rebuilding media
  // for a layer nobody can see, and would fire into a `root` that is on its way out.
  stopRotation()

  // The exit-effect switch, read LIVE: 退出特效 is one of the fields the card promises is already in
  // effect, and this is asked per dismissal, which is exactly when the newest value must win.
  if (withBreak && breakEffectOn() && !prefersReducedMotion()) {
    // Resolved HERE, per dismissal, so 'random' actually varies within a session. A preview may
    // force a specific style; a real dismissal never does.
    const explicit = typeof forcedStyle === 'string' && forcedStyle !== ''
      ? forcedStyle
      : forcedForPreview
    breakApart(explicit !== null && explicit !== undefined && explicit !== '' ? explicit : breakStyle())
  } else {
    // Two steps, because a fade and a removal cannot happen in the same frame.
    //
    // First the layer leaves: input is refused immediately (the `data-leaving` rule)
    // while the opacity transition runs, so the layer is already inert at the moment
    // the user's click lands. Refusing input only when the fade FINISHES is the half of
    // the original bug that made the window feel dead — a dismissed layer ate the next
    // click.
    root.setAttribute('data-leaving', '1')
    root.setAttribute('data-shown', '0')
    root.setAttribute('aria-hidden', 'true')
    // Then it is taken out of layout, once the fade is over. `display: none` cannot be
    // applied at the start or the fade would never render, and it must be applied at the
    // end or the layer would linger invisibly — which is exactly the state that locked
    // the window.
    //
    // The timer only clears the leaving state if the layer is STILL gone. `show()` also
    // clears it, so clearing it here unconditionally would race: a layer that came back
    // mid-fade would be stripped of the shown state by this timer and disappear.
    const fadeMs = 500
    setTimeout(() => {
      if (!visible) {
        root.removeAttribute('data-leaving')
        releaseMedia()
      }
    }, fadeMs)
  }
}

/** Whether the user asked their system for reduced motion. */
function prefersReducedMotion() {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
  } catch (error) {
    return false
  }
}

/** Release the current media renderer, if any. */
function releaseMedia() {
  if (media !== null && typeof media.dispose === 'function') {
    try {
      media.dispose()
    } catch (error) {
      /* a renderer's own cleanup is best effort */
    }
  }
  media = null
  // Nothing is on screen any more, so the rotation has no "current" entry to avoid. Cleared here
  // rather than in `rotateEntry`'s caller so every path that drops the media stays consistent.
  mediaName = null
  // And nothing is on screen to wait for an `ended` event from either. Left as the previous value,
  // `rotateEntry` would arm a listener on a renderer that has just been disposed.
  mediaLoops = null
  if (root !== null) {
    for (const child of [...root.querySelectorAll('.' + PREFIX + '-media, .' + PREFIX + '-tiles')]) {
      child.remove()
    }
  }
}

/**
 * Fetch the screensaver pool and place one entry.
 *
 * Every failure here leaves the layer showing its own background rather than
 * crashing: a screensaver with no artwork is still a screensaver, and the user still
 * needs the way out.
 */
/**
 * The pool entry the next appearance must play, or null.
 *
 * Set by a preview so the artwork on screen is the row that was clicked, and cleared as soon as it is
 * used: the NEXT appearance — a real one, minutes later — must go back to picking at random.
 */
let forcedEntryName = null

/**
 * The name of the entry currently on screen, or null.
 *
 * Kept because the rotation must never pick the clip that is already up: with a small pool,
 * choosing uniformly at random means the same entry is chosen again about half the time, which
 * looks like the rotation is broken.
 */
let mediaName = null

/**
 * Whether the renderer on screen was built with `loop: true` — or null when there is no renderer.
 *
 * THIS EXISTS BECAUSE A LOOPING ELEMENT NEVER FIRES `ended`. `pickAndPlace()` passes
 * `{ loop: true }` on purpose: the layer covers the screen for an unknown length of time, so a
 * clip that stopped at its end would freeze. The consequence is that `rotateEntry()`'s "wait for
 * the current entry to finish" branch could never be satisfied — it armed a listener, nothing ever
 * arrived, and the switch fell through to the NEXT tick. A 15-second interval therefore took 30
 * seconds, on every rotation, and the "播完再换" behaviour it was written for did not exist at all.
 *
 * Recorded here rather than asked of the renderer, because the loop flag is decided by the CALLER
 * (see `src/renderers.js`: "`loop` is what the entry is FOR, not a property of the file") and the
 * renderer contract has no getter for it. `pickAndPlace` is the only thing that creates media, so
 * this is the one place that knows.
 *
 * Null means "no renderer, so nothing to wait for"; true means the usual screensaver case; false
 * means a renderer this module built WITHOUT looping, which is the only case where `ended` is a
 * real event and the wait is worth arming.
 */
let mediaLoops = null

/**
 * The pool's entries as last read from the manifest.
 *
 * The rotation needs the list of enabled names while the layer is already up, and the manifest is
 * fetched per appearance — this is that answer, kept so a rotation tick does not have to fetch it
 * again. Null before the first appearance.
 */
let lastManifestItems = null

/**
 * An exit effect forced by a preview, or null.
 *
 * Set when a preview starts and consumed by the dismissal it leads to, so the preview plays the
 * effect the card asked for while a real dismissal still resolves 'random' itself. Kept as module
 * state rather than a parameter because the dismissal happens in a LISTENER, long after `preview()`
 * returned.
 */
let previewForcedStyle = null

/**
 * True while the layer on screen is a preview rather than a real appearance.
 *
 * A preview is dismissed by the user like a real one, and that dismissal must not latch the
 * screensaver off: the user is present by definition. It is also the flag that tells `hide()` to
 * consume `previewForcedStyle`.
 */
let previewing = false

/**
 * The boot overlay a preview took out of the DOM, and where it goes back.
 *
 * `{ el, parent, next }`, or null. A preview parks the overlay because the two layers would
 * otherwise both want the screen; `hide()` restores it, so a preview never destroys the boot
 * animation's own DOM or state.
 */
let bootOverlayParked = null

/**
 * Turn a slider position (0..1) into an element gain (0..1).
 *
 * THIS IS NOT A STRAIGHT COPY, and the difference is what the user reported: at 2% the sound was
 * still clearly audible. `video.volume` is a LINEAR amplitude multiplier, while loudness is
 * roughly logarithmic — halving the gain does not halve how loud it sounds, it takes about a
 * 10dB cut before the ear reads it as half. So a linear slider spends almost all of its travel in
 * a range that sounds nearly identical, and its bottom end cannot get quiet.
 *
 * A square is the cheapest curve that fixes it: 2% x 2% = 0.04% (-68dB, inaudible), 50% -> 25%,
 * 100% -> 100%. Cubing would be even steeper at the bottom but makes the middle feel dead; a
 * square keeps the upper half expressive, which is the part people adjust by ear.
 *
 * The value stays 0..1 on both sides, so the schema, the stored document and the renderer
 * contract are unchanged — only the mapping from a position to a gain lives here.
 * @param position - slider position, 0..1.
 * @returns the gain to hand to the element, 0..1.
 */
function volumeToGain(position) {
  const p = typeof position === 'number' && isFinite(position)
    ? Math.min(1, Math.max(0, position))
    : 0.35
  return p * p
}

function pickAndPlace() {
  const url = typeof CFG?.screensaverManifest === 'string' ? CFG.screensaverManifest : null
  const factory = globalThis.__DSH_BOOT_ANIM_RENDERERS__
  if (url === null || root === null) return

  fetch(url, { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : { items: [] }))
    .then((payload) => {
      if (!visible || root === null) return
      const published = Array.isArray(payload?.items) ? payload.items : []
      // Kept for the rotation, which picks the next name while the layer is already up and must
      // not fetch the manifest again on every tick.
      lastManifestItems = published

      // A forced name wins over the random pick, and is matched against EVERY published entry — not
      // just the enabled ones. A row whose checkbox is off is exactly the kind of row somebody wants
      // to look at before deciding whether to turn it back on, so excluding it here would make 预览
      // fail silently on precisely those rows.
      let chosen = null
      if (forcedEntryName !== null) {
        chosen = published.find((item) => item !== null && item.name === forcedEntryName) || null
        // One shot: consumed whether or not it matched, so a stale name cannot keep hijacking later
        // appearances.
        forcedEntryName = null
      }

      if (chosen === null) {
        const items = published.filter((item) => item.enabled !== false)
        const pool = items.length > 0 ? items : published
        if (pool.length === 0) return
        chosen = pool[Math.floor(Math.random() * pool.length)]
      }
      if (typeof factory?.create !== 'function') return
      // `loop: true` is the screensaver's job, and it is also the reason `rotateEntry` cannot wait
      // for `ended` — a looping element never fires it. Recorded in `mediaLoops` so the rotation
      // can tell "there is no end to wait for" apart from "this renderer really will end".
      const loops = true
      const renderer = factory.create(chosen, { loop: loops })
      if (renderer === undefined || renderer === null) return

      media = renderer
      mediaLoops = loops
      // The rotation needs to know what is currently up, so it can avoid picking it again.
      mediaName = typeof chosen.name === 'string' ? chosen.name : null
      const element = renderer.el()
      element.classList.add(PREFIX + '-media')
      if (renderer.kind === 'live2d') element.classList.add(PREFIX + '-contain')
      // The sound switch. A renderer is BUILT muted — that is the only state a browser allows
      // an unattended layer to be in without a gesture — so turning sound ON means asking the
      // element to unmute, and the play() below is what makes the browser decide whether to
      // honour it. An entry with no audio path (image / animated / live2d) has no `mute`
      // method at all, so this is inert for them rather than a branch that has to know kinds.
      //
      // Read LIVE: 屏保声音 is one of the fields the card calls "already in effect", and this runs
      // per entry, so a flip applies to the very next appearance — and to the next ROTATION, since
      // a rotation builds its entry through this same function.
      if (soundOn() && typeof renderer.mute === 'function') {
        renderer.mute(false)
        // ...and at the level the slider asks for. `setVolume` is absent on every non-video kind,
        // so this is inert for them rather than a branch that has to know kinds. Read from the
        // LIVE global, so a level the user just dragged applies on the next appearance.
        if (typeof renderer.setVolume === 'function') {
          const level = typeof CFG?.screensaverVolume === 'number' ? CFG.screensaverVolume : config.volume
          renderer.setVolume(volumeToGain(level))
        }
      }
      // The catcher goes UNDER the media in paint order but ABOVE it for input, so
      // the media never sees a click and the whole surface stays dismissible.
      pieces.catcher.after(element)
      // The renderer's element carries the boot screen's own class, whose rule is
      // `opacity: 0` until `data-shown="1"` — it is built to be revealed by the boot
      // screen's hand-off, not to be visible on its own. Without this the media
      // loads, reports the right dimensions, and is INVISIBLE: a black screensaver
      // that looks exactly like an empty pool. Found by the browser check, which
      // could see the element's size and not its pixels.
      element.setAttribute('data-shown', '1')

      if (typeof renderer.onError === 'function') {
        renderer.onError(() => {
          // A failed entry leaves the plain background, which is still dismissible.
          if (element.parentNode) element.remove()
        })
      }
      try {
        renderer.start()
      } catch (error) {
        /* an entry that cannot start is a background-only screensaver */
      }
    })
    .catch(() => {
      /* an unreachable pool leaves the layer's own background */
    })
}

/**
 * Tear the current picture into tiles that drift right and fade.
 *
 * The trick that makes this cheap: the tiles are not built by cutting the artwork
 * into pieces. A downsampled snapshot of the whole layer is taken once, and each
 * tile is that SAME snapshot with a background-position offset, sized to show only
 * its own slice. So the pixelation comes free with the downsampling, and there is
 * exactly one image decode no matter how many tiles there are.
 *
 * The snapshot is of the layer's own box, which is why the media is released only
 * after this: the tiles are a picture OF the media, and removing it first would
 * capture an empty box.
 */

/* ---- pointer-reactive decoration ------------------------------------------------
 *
 * The three effects share a lifecycle: attach listeners when the layer is shown, park when the
 * pointer leaves, and tear everything down when the layer goes. `pointerArt` owns that lifecycle.
 */

/** The lens radius the user chose. Not a setting: picked once, tuned on a comparison page. */
const LENS_RADIUS = 170

let pointerArt = null

/**
 * Start the pointer decoration for this appearance, or do nothing.
 *
 * @param {string} which - 'ripples' | 'attract' | 'lens', already resolved from the setting.
 */
function startPointerArt(which) {
  stopPointerArt()
  if (root === null) return
  if (which !== 'ripples' && which !== 'attract' && which !== 'lens') return

  const width = root.clientWidth
  const height = root.clientHeight
  if (width === 0 || height === 0) return

  const canvas = document.createElement('canvas')
  canvas.className = PREFIX + '-pointer'
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  // Above the media and above the catcher's paint order, but never taking input: the layer's whole
  // surface has to stay clickable or the screensaver cannot be dismissed.
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;'
    + 'pointer-events:none;z-index:3'
  root.appendChild(canvas)

  const ctx = canvas.getContext('2d')
  if (ctx === null) { canvas.remove(); return }

  const W = canvas.width
  const H = canvas.height

  const state = {
    canvas,
    ctx,
    W,
    H,
    dpr,
    which,
    raf: null,
    running: false,
    // Presence fades 0..1 so the decoration appears and leaves smoothly.
    presence: 0,
    x: W / 2,
    y: H / 2,
    px: W / 2,
    py: H / 2,
    inside: false,
    last: 0,
    // Effect-specific state, built once.
    rings: [],
    dust: null,
    source: null,
    sourceDirty: true,
    // A running total of `stroke()` calls, so `state()` can report whether the decoration is
    // actually putting anything into the canvas. Counted here rather than inferred from the frame
    // count, because an effect can run its loop and draw nothing (an empty ring list, a zero-size
    // canvas, a missing source) and those are exactly the failures that look like "no effect".
    strokes: 0,
  }

  /* ---- input ---- */

  /**
   * Track the pointer by listening on the DOCUMENT, not on the layer.
   *
   * This is the fix for "选中了水波涟漪但看不见". Listening on `root` looked right — the layer is
   * full-screen and carries `pointer-events: auto` — but the layer also holds a full-bleed
   * `dshsaver-catch` at a higher paint order, and whether a `mousemove` reaches the layer under it
   * depends on where the event lands. Measured on the running app: `pointerArtMounted` true,
   * `pointerRunning` false, `pointerStrokes` 0 — a mounted canvas whose loop had never been
   * started, because no event had ever arrived. Every other reading looked healthy.
   *
   * The document sees every move no matter which child it hits, so the decoration is driven by
   * coordinates instead of by hit-testing: inside the layer's box means inside. That also makes the
   * effect work over the media, over the catcher, and over the hint, with no ordering to reason
   * about.
   */
  const onMove = (event) => {
    const rect = root === null ? null : root.getBoundingClientRect()
    if (rect === null || rect.width === 0 || rect.height === 0) return
    const right = typeof rect.right === 'number' ? rect.right : rect.left + rect.width
    const bottom = typeof rect.bottom === 'number' ? rect.bottom : rect.top + rect.height
    const insideBox = event.clientX >= rect.left && event.clientX <= right
      && event.clientY >= rect.top && event.clientY <= bottom
    // Counted so `state()` can answer "did a pointer event ever arrive at all". This is the one
    // link in the chain that cannot be inferred from any other reading.
    state.moves = (state.moves || 0) + 1
    if (!insideBox) { state.inside = false; return }
    state.x = (event.clientX - rect.left) * dpr
    state.y = (event.clientY - rect.top) * dpr
    state.inside = true
    if (!state.running) startLoop()
  }
  const onLeave = () => { state.inside = false }

  document.addEventListener('mousemove', onMove, { passive: true })
  // `mouseleave` on the document fires when the pointer leaves the WINDOW, which is the only
  // "gone" this decoration needs to know about; leaving the layer is handled by the box test above.
  document.addEventListener('mouseleave', onLeave)
  state.detach = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseleave', onLeave)
  }

  /* ---- the picture, for the lens ---- */

  const captureSource = () => {
    // The lens displaces the PICTURE, so it needs a full-resolution copy of what the media is
    // showing. Captured on demand and re-captured when a new entry is placed.
    const element = media === null ? null : media.el()
    if (element === null) return
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const g = c.getContext('2d')
    if (g === null) return
    try {
      g.drawImage(element, 0, 0, W, H)
      state.source = c
    } catch {
      // An element that has not decoded yet throws; it is retried on the next attempt.
    }
  }

  /* ---- the three effects ---- */

  /**
   * Ripples: rings spreading outward from the pointer, like a stone dropped in water.
   *
   * WHY IT NOW SELF-STARTS. This effect used to require a `mousemove` before it would draw
   * anything, and that is the one condition a real screensaver cannot promise: the layer appears
   * because the machine went IDLE, so the window is typically unfocused, and a window without
   * focus is not guaranteed to receive pointer events at all in the desktop shell. The user
   * reported "水波涟漪 我一直没看到效果" — the effect was never broken, it was never TRIGGERED.
   *
   * So a ring is seeded on a timer whether or not the pointer has ever moved, at the pointer's
   * last known position (the centre of the screen until it moves). Movement still drives rings
   * at the pointer, which is the part that makes it feel interactive; the timer is what makes it
   * exist at all.
   */
  const tickRipples = (dt, now) => {
    // Where the next ring comes from. The centre is only the origin while the pointer has not been
    // seen yet in this appearance; a ring with no pointer behind it is what the user objected to.
    const originX = state.inside ? state.x : W / 2
    const originY = state.inside ? state.y : H / 2

    const moved = state.inside && Math.hypot(state.x - state.px, state.y - state.py) > 6 * dpr
    state.px = state.x; state.py = state.y

    // RINGS COME FROM THE POINTER, and only while it is over the layer.
    //
    // An earlier version seeded one every 320ms unconditionally, on the theory that an unfocused
    // window might never deliver a pointer event. That made the effect play on a screensaver
    // nobody was touching, which the user rejected outright: "我鼠标都没有放进来，它自己就在中间
    // 一直生效". A decoration that reacts to the pointer has to be caused by the pointer.
    //
    // While the pointer IS inside, a ring every 260ms — a stream rather than one per gesture, so
    // holding the mouse still still reads as waves. Gating on movement alone left the layer blank
    // whenever somebody stopped moving.
    const sinceLast = now - (state.lastRing || 0)
    const insideStream = state.inside && sinceLast > 260
    if ((moved && sinceLast > 90) || insideStream) {
      state.lastRing = now
      state.rings.push({ x: originX, y: originY, r: 0, life: 1 })
      if (state.rings.length > 40) state.rings.shift()
    }

    ctx.clearRect(0, 0, W, H)
    ctx.globalCompositeOperation = 'lighter'
    for (let i = state.rings.length - 1; i >= 0; i -= 1) {
      const g = state.rings[i]
      // A SMALL wave. 96px per second over a one-second life tops out at a ~96px radius, so the
      // rings stay AROUND the pointer instead of sweeping across the picture. The earlier 190px/s
      // over 1.6s reached ~300px, which the user reported as "水波太大了" — the ring was wider
      // than the face it was drawn over.
      g.r += 96 * dpr * dt
      g.life -= dt * 1.0
      if (g.life <= 0) { state.rings.splice(i, 1); continue }
      // `life` fades the ring as it travels, eased so the first half of the travel stays near full
      // strength and the fade is concentrated at the end — a linear ramp left most of the journey
      // too faint to see on a busy picture.
      const fade = Math.min(1, g.life * 1.6)
      ctx.strokeStyle = 'rgba(180,232,255,' + (0.85 * fade) + ')'
      ctx.lineWidth = Math.max(1.6, 3.2 * dpr * fade)
      ctx.beginPath()
      ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2)
      ctx.stroke()
      // A second, slightly smaller and fainter ring, which gives the wave a front rather than a
      // hairline.
      ctx.strokeStyle = 'rgba(120,195,255,' + (0.38 * fade) + ')'
      ctx.lineWidth = Math.max(1.2, 1.8 * dpr * fade)
      ctx.beginPath()
      ctx.arc(g.x, g.y, g.r * 0.72, 0, Math.PI * 2)
      ctx.stroke()
      state.strokes += 2
    }
    ctx.globalCompositeOperation = 'source-over'
    // Packs up when there is nothing left to draw. `tick()` keeps the loop alive while the pointer
    // is inside, so a held-still pointer still gets its stream; leaving the layer parks it.
    return state.rings.length > 0 || state.inside
  }

  const buildDust = () => {
    const COUNT = 150
    const dust = []
    for (let i = 0; i < COUNT; i += 1) {
      dust.push({
        x: Math.random(), y: Math.random(),
        vx: 0, vy: 0,
        size: 0.8 + Math.random() * 1.8,
        phase: Math.random() * Math.PI * 2,
      })
    }
    return dust
  }

  const tickAttract = (dt) => {
    if (state.dust === null) state.dust = buildDust()
    ctx.clearRect(0, 0, W, H)
    ctx.globalCompositeOperation = 'lighter'
    const now = performance.now()
    let moving = false
    for (const d of state.dust) {
      const px = d.x * W, py = d.y * H
      if (state.inside) {
        const dx = state.x - px, dy = state.y - py
        const dist = Math.hypot(dx, dy) || 1
        const pull = Math.max(0, 1 - dist / (420 * dpr)) * 900 * dpr
        d.vx += (dx / dist) * pull * dt
        d.vy += (dy / dist) * pull * dt
      }
      d.vx *= 0.94
      d.vy *= 0.94
      if (Math.abs(d.vx) > 0.5 || Math.abs(d.vy) > 0.5) moving = true
      d.x += d.vx * dt / W
      d.y += d.vy * dt / H
      d.x += (Math.random() - 0.5) * 0.0004
      d.y += (Math.random() - 0.5) * 0.0004
      const twinkle = 0.55 + 0.45 * Math.sin(now * 0.0016 + d.phase)
      ctx.fillStyle = 'rgba(210,240,255,' + (0.55 * twinkle) + ')'
      ctx.fillRect(d.x * W, d.y * H, d.size * dpr, d.size * dpr)
    }
    ctx.globalCompositeOperation = 'source-over'
    // The dust twinkles even at rest, so this one never parks while the layer is up. It is 150
    // fillRects per frame — cheap enough that parking it would be the more surprising choice.
    return true
  }

  /**
   * The lens: a WATER RIPPLE under the pointer, not a magnifier.
   *
   * Rewritten twice, and both rewrites came from the same report: "why does this effect look so
   * bad". Version one tiled the disc with 30px cells, which read as a mosaic of little squares.
   * Version two drew concentric rings, which removed the grid but made the disc a static grey
   * haze — a magnifier, and on a dark picture a magnifier is just a smudge.
   *
   * What it does now is DISPLACE the picture with a travelling wave, the way a ripple on water
   * does. The displacement is radial: every sample point is pushed a few pixels away from the
   * pointer (or toward it), by an amount that is a sine of its distance and of time. That is the
   * one formulation that produces rings that visibly move outward, and it needs no magnification
   * at all — the picture keeps its scale, which is why it no longer looks like a smudge.
   *
   * Drawn as a grid of small source patches, and the grid size is chosen so the patches are
   * SMALLER than the displacement: at 6 device pixels per patch a 13px wave is smooth, because
   * neighbouring patches land at noticeably different offsets. The old version's mistake was the
   * opposite — 30px cells with a smaller wave, which is a mosaic with steps you can count.
   *
   * Three things make it read as water rather than as a glitch:
   *   - the displacement is a smooth sine of distance, so the patches form rings;
   *   - the wave TRAVELS outward with time, so the rings move;
   *   - the whole thing is masked by a radial falloff, so there is no hard disc edge — the old
   *     version's "it looks like a round disc stuck on the picture".
   *
   * Cost is bounded by construction: the patch grid covers a fixed-radius square, not the screen,
   * so the work does not grow with window size.
   */
  const tickLens = (dt, now) => {
    if (state.source === null) {
      captureSource()
      if (state.source === null) { ctx.clearRect(0, 0, W, H); return false }
    }
    ctx.clearRect(0, 0, W, H)
    if (state.presence < 0.02) return false

    const t = now / 1000
    const R = LENS_RADIUS * dpr
    const cx = state.x
    const cy = state.y
    const alpha = state.presence

    // The ripple lives in a square around the pointer, larger than the visible falloff so the
    // wave has room to die out rather than being cut off at the mask.
    const reach = R * 1.35
    const left = Math.max(0, Math.floor(cx - reach))
    const top = Math.max(0, Math.floor(cy - reach))
    const right = Math.min(W, Math.ceil(cx + reach))
    const bottom = Math.min(H, Math.ceil(cy + reach))

    ctx.save()
    // A radial mask, not a circular clip: the edge of the effect has to FADE. A clip gives a
    // hard rim, which is exactly what made the previous version look like a disc laid on top.
    const mask = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.2)
    mask.addColorStop(0, 'rgba(0,0,0,1)')
    mask.addColorStop(0.55, 'rgba(0,0,0,0.95)')
    mask.addColorStop(0.85, 'rgba(0,0,0,0.45)')
    mask.addColorStop(1, 'rgba(0,0,0,0)')

    // The patch grid. PATCH is deliberately SMALL relative to the wave amplitude, and the wave
    // itself is short enough that neighbouring patches land at visibly different offsets: that
    // is what makes the displacement smooth instead of stepped. Measured on a comparison page —
    // 4px patches with a 16px amplitude was the only combination that read as water rather than
    // as broken glass, which is what 6px/11px produced.
    const PATCH = 4 * dpr
    for (let y = top; y < bottom; y += PATCH) {
      for (let x = left; x < right; x += PATCH) {
        const px = x + PATCH / 2
        const py = y + PATCH / 2
        const dx = px - cx
        const dy = py - cy
        const dist = Math.hypot(dx, dy)

        // Nothing outside the ripple: the mask would fade it to nothing anyway, and skipping the
        // draw is what keeps the cost proportional to the disc rather than to the window.
        if (dist > R * 1.25) continue

        // Falloff toward the edge, so a patch that is fading out also stops moving. Movement
        // without a fade at the rim is what makes a ripple look cut out.
        const edgeFall = Math.max(0, 1 - dist / (R * 1.1))
        if (edgeFall <= 0.01) continue

        // The wave: a sine of distance MINUS time, so crests travel outward from the pointer.
        // The second term at a lower frequency gives the rings a slight wobble, which is what
        // stops them looking like a mechanical bullseye.
        const wave = Math.sin(dist * 0.052 - t * 4.4) * 0.75
          + Math.sin(dist * 0.021 - t * 1.9) * 0.25
        const amp = 16 * dpr * edgeFall * alpha * wave

        // Radial displacement: each patch is sampled a little nearer to, or further from, the
        // pointer. Along the direction of `dx,dy`, which is what makes the rings circular.
        const nx = dist === 0 ? 0 : dx / dist
        const ny = dist === 0 ? 0 : dy / dist
        const sx = px - nx * amp
        const sy = py - ny * amp

        ctx.drawImage(state.source,
          sx, sy, PATCH, PATCH,
          x, y, PATCH, PATCH)
      }
    }

    // The cool light that makes it read as water rather than as a smear: a faint blue sheen,
    // faded out by the same radial mask.
    ctx.globalCompositeOperation = 'lighter'
    const sheen = ctx.createRadialGradient(cx, cy, 0, cx, cy, R)
    sheen.addColorStop(0, 'rgba(150,210,255,' + (0.09 * alpha) + ')')
    sheen.addColorStop(0.7, 'rgba(120,185,240,' + (0.04 * alpha) + ')')
    sheen.addColorStop(1, 'rgba(120,185,240,0)')
    ctx.fillStyle = sheen
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.fill()

    // Punch the mask out: the ripple is drawn at full strength above, and this multiplies the
    // whole thing back down toward the edges. `destination-in` with the same gradient is what
    // makes the boundary soft instead of a cut.
    ctx.globalCompositeOperation = 'destination-in'
    ctx.fillStyle = mask
    ctx.fillRect(left, top, right - left, bottom - top)
    ctx.globalCompositeOperation = 'source-over'

    ctx.restore()
    return true
  }

  /* ---- the loop ---- */

  const tick = (now) => {
    state.raf = null
    if (!state.running) return
    // THE FIRST TICK CAN HAVE A NEGATIVE `dt`, and that is not a rounding curiosity.
    //
    // `startLoop()` seeds `state.last` from `performance.now()`, which is a TIME-ORIGIN
    // reading. A `requestAnimationFrame` callback is instead handed the FRAME-START
    // timestamp, and that value can precede the `performance.now()` that scheduled it —
    // measured in the real browser: `scheduledAt 181.0` / `frameTs 180.9`, a delta of
    // -0.038ms. Only the first tick is affected, because every later tick seeds `state.last`
    // from its own frame timestamp.
    //
    // Why it mattered: every effect integrates `dt` into a size. `tickRipples` does
    // `g.r += 96 * dpr * dt`, so a negative `dt` produced a radius of -0.038, and
    // `CanvasRenderingContext2D.arc()` THROWS on a negative radius. The throw left `tick`
    // before it could schedule the next frame, so the loop died on its first frame while
    // `state.running` still said true — the exact signature the diagnostic reported:
    // `pointerRunning: true`, `pointerStrokes: 0`, zero painted pixels. 水波涟漪 drew
    // nothing at all, and only a real browser could show it: a stub canvas accepts any
    // radius, so every offline suite passed.
    //
    // Clamped at zero BEFORE the `|| 0.016` fallback, and the order matters: a negative
    // delta becomes 0, which the `||` turns into the same 16ms default step the original
    // expression used for a zero or NaN delta. So the first frame advances by one ordinary
    // frame step rather than by a negative one. The upper bound (0.05s) is unchanged — it is
    // what stops a backgrounded tab from integrating a multi-second gap into one jump.
    const elapsed = (now - state.last) / 1000
    const dt = Math.min(0.05, Math.max(0, elapsed) || 0.016)
    state.last = now

    // Presence eases toward 1 while the pointer is inside, 0 otherwise.
    const target = state.inside ? 1 : 0
    state.presence += (target - state.presence) * Math.min(1, dt * 6)

    let busy = false
    if (state.which === 'ripples') busy = tickRipples(dt, now)
    else if (state.which === 'attract') busy = tickAttract(dt)
    else busy = tickLens(dt, now)

    // Parking: an effect with nothing left to draw stops the loop, and the next pointer move
    // restarts it. Without this, an idle screensaver would run a rAF loop for hours.
    const keep = busy || state.inside || state.presence > 0.02
    if (keep) {
      state.raf = globalThis.requestAnimationFrame(tick)
    } else {
      state.running = false
    }
  }

  const startLoop = () => {
    if (state.running) return
    state.running = true
    state.last = performance.now()
    state.raf = globalThis.requestAnimationFrame(tick)
  }

  state.start = startLoop
  state.stop = () => {
    state.running = false
    if (state.raf !== null) globalThis.cancelAnimationFrame(state.raf)
    state.raf = null
  }
  // The lens works from a snapshot of the media, and the rotation replaces that media underneath
  // it. Without this the lens would keep displacing the discarded picture.
  state.refreshSource = () => {
    state.source = null
    captureSource()
  }

  pointerArt = state
  // The lens needs a frame of the picture before the pointer arrives, or the first second shows
  // nothing under the lens.
  if (which === 'lens') setTimeout(() => { if (pointerArt === state) captureSource() }, 350)

  // The loop starts only when there is something for it to do.
  //
  // It used to start unconditionally, because ripples seeded themselves on a timer and had to be
  // visible on a layer nobody was touching. That is no longer how ripples work — they come from the
  // pointer — so a loop running from the first frame would do nothing but burn frames on a layer
  // sitting idle. `onMove` calls `startLoop()` when the pointer arrives, and `attract` keeps its
  // own dust field so it starts immediately.
  if (state.inside || which === 'attract') startLoop()
}

/** Tear the pointer decoration down. Safe to call when there is none. */
function stopPointerArt() {
  if (pointerArt === null) return
  try {
    pointerArt.stop()
    if (typeof pointerArt.detach === 'function') pointerArt.detach()
    pointerArt.canvas.remove()
  } catch {
    /* tearing down must never throw */
  }
  pointerArt = null
}

/**
 * Which pointer effect to play, resolving `random` per appearance.
 *
 * Reads the LIVE config global rather than the `config` snapshot taken at install time, and that
 * is deliberate. `CFG` is filled by the injected config row, which the Host rebuilds on every
 * index render — so a settings edit is already in it by the time the next page load happens.
 * `config` is a copy taken once, when this script first ran.
 *
 * Why it matters: the snapshot made a settings change look IGNORED. The user switched 菱形涟漪 to
 * 星屑吸附, the card reported the save, and the next appearance still drew diamonds — because the
 * snapshot predated the write. Reading `CFG` here means the newest stored value wins as soon as
 * the page is reloaded, with no dependency on install order.
 * @returns {string|null} an effect name, or null for none.
 */
function pointerEffect() {
  const source = typeof CFG?.screensaverPointerEffect === 'string'
    ? CFG.screensaverPointerEffect
    : (config !== null && typeof config.pointerEffect === 'string' ? config.pointerEffect : 'none')
  if (source === 'ripples' || source === 'attract' || source === 'lens') return source
  if (source === 'random') {
    const options = ['ripples', 'attract', 'lens']
    return options[Math.floor(Math.random() * options.length)]
  }
  return null
}

/**
 * Which exit effect to play, resolving `random` per dismissal.
 *
 * Resolved at DISMISS time rather than at load: a session that resolved it once would keep
 * showing the same "random" effect for hours, which is not what random means here. An unknown
 * value from the settings document falls back to the plain dissolve rather than to a guess, so a
 * bad write degrades to "no flourish" instead of to "wrong flourish".
 * @returns {'particles'|'fall'|'glitch'|null} the effect to play, or null for a plain dissolve.
 */
function breakStyle() {
  // Read the LIVE config global first, for the same reason as pointerEffect(): `config` is a
  // snapshot taken when this script first ran, so a settings edit made afterwards looked
  // ignored until the page was rebuilt.
  const source = typeof CFG?.screensaverBreakStyle === 'string'
    ? CFG.screensaverBreakStyle
    : (config !== null && typeof config.breakStyle === 'string' ? config.breakStyle : 'random')
  if (source === 'particles' || source === 'fall' || source === 'glitch') return source
  if (source === 'random') {
    const options = ['particles', 'fall', 'glitch']
    return options[Math.floor(Math.random() * options.length)]
  }
  return null
}

/**
 * Play the exit effect.
 *
 * The layer comes down FIRST, before anything is drawn, so the screen is clear immediately
 * whatever the effect costs — the tear then plays over an empty screen, which is what it looks
 * like anyway once the pieces have flown.
 *
 * @param {string|null} style - one of 'particles' / 'fall' / 'glitch', or null for a dissolve.
 */
function breakApart(style) {
  if (root === null) return
  const width = root.clientWidth
  const height = root.clientHeight
  if (width === 0 || height === 0) {
    // Nothing to photograph: fall back rather than tearing up an empty layer.
    // `data-leaving` is set alongside, not instead: without it the layer would drop
    // `data-shown` and stay in layout, invisible and still taking input — the exact
    // state that locked the window.
    root.setAttribute('data-leaving', '1')
    root.setAttribute('data-shown', '0')
    setTimeout(() => {
      if (!visible) {
        root.removeAttribute('data-leaving')
        releaseMedia()
      }
    }, 500)
    return
  }
  if (style === null) {
    // No effect: the same two-step teardown the plain path uses.
    root.setAttribute('data-leaving', '1')
    root.setAttribute('data-shown', '0')
    root.setAttribute('aria-hidden', 'true')
    setTimeout(() => {
      if (!visible) {
        root.removeAttribute('data-leaving')
        releaseMedia()
      }
    }, 500)
    return
  }

  // The layer comes down before the effect runs — see the note above.
  root.setAttribute('data-leaving', '1')
  root.setAttribute('data-shown', '0')
  root.setAttribute('aria-hidden', 'true')

  // One full-screen canvas for the effect, attached to the DOCUMENT rather than inside the
  // root: the root's opacity is going to 0, and a child would fade with it.
  //
  // A canvas rather than DOM elements is load-bearing, not a preference: a DOM implementation
  // with 12,180 independently animated tiles measured FOUR frames in 11.9 seconds on a real
  // machine. A canvas is one compositing unit and draws the whole frame with `drawImage`.
  const canvas = document.createElement('canvas')
  canvas.className = PREFIX + '-tear'
  canvas.width = width
  canvas.height = height
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;'
    + 'z-index:2147483647;pointer-events:none'
  ;(document.body || document.documentElement).appendChild(canvas)

  // The artwork, at the resolution this effect needs. Taken BEFORE the media is released, because
  // the capture is a picture OF the media.
  //
  // Two families, two captures: the block-blowing effect works one sample per block (that IS its
  // pixelation), while the fall and glitch effects move the picture around with window coordinates
  // and need the frame at full size or they misalign and blur.
  const art = style === 'particles'
    ? snapshotFrame(width, height)
    : snapshotFull(width, height)

  const finish = () => {
    canvas.remove()
    if (!visible) {
      root.removeAttribute('data-leaving')
      releaseMedia()
    }
  }

  if (style === 'particles') breakParticles(canvas, art, width, height, finish)
  else if (style === 'fall') breakFall(canvas, art, width, height, finish)
  else if (style === 'glitch') breakGlitch(canvas, art, width, height, finish)
  else {
    // An unrecognised style must not silently play some OTHER effect. Bare `else` would do
    // exactly that, and would also swallow the next effect added here without a word — so the
    // final branch is explicit and falls back to the dissolve.
    finish()
  }
}

/**
 * Capture the layer at one sample per block, which IS the pixelation.
 *
 * @returns {HTMLCanvasElement} a small canvas holding the frame, one pixel per block.
 */
/**
 * Capture the layer at FULL device resolution.
 *
 * Needed by the effects that move the picture around (displace strips, split colour channels): those
 * index the source with window coordinates, so a downsampled source misaligns and blurs them. See the
 * note at the top of this file.
 *
 * @param {number} width - viewport width in CSS pixels.
 * @param {number} height - viewport height in CSS pixels.
 * @returns {HTMLCanvasElement|null} the frame, or null when the media is not drawable yet.
 */
function snapshotFull(width, height) {
  const full = document.createElement('canvas')
  full.width = width
  full.height = height
  const context = full.getContext('2d')
  if (context === null) return null
  const element = media === null ? null : media.el()
  if (element === null || typeof context.drawImage !== 'function') return null
  try {
    context.drawImage(element, 0, 0, width, height)
  } catch (error) {
    // A source that has not decoded yet throws; the caller falls back to the dissolve.
    return null
  }
  return full
}

function snapshotFrame(width, height) {
  // The downsampling factor, and it IS the pixel size: the snapshot is taken at one sample per
  // block, so the blocks are the pixels the user sees. 8px was chosen after 24px read as too
  // chunky.
  const BLOCK = 8
  // The tile count grows with the window area, so a large display would otherwise produce an
  // unworkable number of draws. The cap keeps the effect bounded by making the blocks COARSER
  // when the window is too big for fine ones — degrading fineness rather than smoothness.
  const MAX_TILES = 20000
  const area = width * height
  const block = Math.max(BLOCK, Math.ceil(Math.sqrt(area / MAX_TILES)))
  const cols = Math.max(1, Math.ceil(width / block))
  const rows = Math.max(1, Math.ceil(height / block))
  const small = document.createElement('canvas')
  small.width = cols
  small.height = rows
  const context = small.getContext('2d')
  const element = media === null ? null : media.el()
  if (element !== null && context !== null && typeof context.drawImage === 'function') {
    try {
      context.drawImage(element, 0, 0, cols, rows)
    } catch (error) {
      // A source that has not decoded yet throws; the caller falls back to the dissolve.
      return null
    }
  }
  return small
}

/**
 * 粒子消散 — the blocks drift right and fade, in a left-to-right stagger.
 *
 * This is the original effect, kept because it was the one the user was already using.
 */
function breakParticles(canvas, art, width, height, finish) {
  const surface = canvas.getContext('2d')
  if (surface === null || art === null) { finish(); return }
  const BLOCK = 8
  const block = Math.max(BLOCK, Math.ceil(Math.sqrt((width * height) / 20000)))
  const cols = art.width
  const rows = art.height
  const flights = new Float32Array(cols * rows * 4)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const i = (row * cols + col) * 4
      // Left-to-right stagger: the tear starts at the leading edge, which is what makes it
      // read as being blown away rather than as a dissolve.
      flights[i] = ((col / cols) * 260 + Math.random() * 90) / 1000
      flights[i + 1] = 170 + Math.random() * 390
      flights[i + 2] = Math.random() * 40 - 20
    }
  }
  const DURATION = 1.4
  const startedAt = performance.now()
  let handle = null
  let finished = false
  const stop = () => {
    if (finished) return
    finished = true
    if (handle !== null) globalThis.cancelAnimationFrame(handle)
    finish()
  }
  const draw = (now) => {
    if (surface === null || finished) return
    const elapsed = (now - startedAt) / 1000
    surface.clearRect(0, 0, width, height)
    let alive = 0
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const i = (row * cols + col) * 4
        const delay = flights[i]
        const local = (elapsed - delay) / DURATION
        if (local < 0) {
          surface.globalAlpha = 1
          surface.drawImage(art, col, row, 1, 1, col * block, row * block, block, block)
          alive += 1
          continue
        }
        if (local >= 1) continue
        alive += 1
        // Ease-out on the flight, so the pieces leave fast and settle.
        const eased = 1 - Math.pow(1 - local, 3)
        const dx = flights[i + 1] * eased
        const dy = flights[i + 2] * eased
        surface.globalAlpha = 1 - eased
        surface.drawImage(art, col, row, 1, 1,
          col * block + dx, row * block + dy, block, block)
      }
    }
    surface.globalAlpha = 1
    if (alive > 0) handle = globalThis.requestAnimationFrame(draw)
    else stop()
  }
  handle = globalThis.requestAnimationFrame(draw)
  // A hard stop, so a browser that never delivers another frame cannot leave the canvas up.
  setTimeout(stop, 4500)
}

/**
 * 重力下坠 — even squares fall with gravity, each with a delay, drift and spin.
 *
 * Distinct from 粒子消散 in DIRECTION and in what it says: the particles flow sideways and
 * evaporate; these drop out of the bottom of the frame under acceleration, so the picture reads
 * as something heavy coming apart.
 */
function breakFall(canvas, art, width, height, finish) {
  const surface = canvas.getContext('2d')
  if (surface === null || art === null) { finish(); return }
  const COLS = 28
  const bw = width / COLS
  const bh = bw
  const rowsN = Math.ceil(height / bh)
  const parts = []
  for (let r = 0; r < rowsN; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      parts.push({
        sx: c * bw,
        sy: r * bh,
        delay: Math.random() * 0.35,
        vx: (Math.random() - 0.5) * 90,
        vy: 380 + Math.random() * 260,
        spin: (Math.random() - 0.5) * 0.5,
      })
    }
  }
  const DURATION = 1.35
  const startedAt = performance.now()
  let finished = false
  let handle = null
  const stop = () => {
    if (finished) return
    finished = true
    if (handle !== null) globalThis.cancelAnimationFrame(handle)
    finish()
  }
  const draw = (now) => {
    if (surface === null || finished) return
    const elapsed = (now - startedAt) / 1000
    if (elapsed > DURATION) { stop(); return }
    surface.clearRect(0, 0, width, height)
    // NO BACKING COLOUR. This used to fill the canvas with a near-black first, "so the gaps left
    // by the pieces read as depth" — but the gaps are not depth, they are the app underneath, and
    // the user asked to see it: the pieces fall away and the conversation is revealed through
    // them. A fill here paints over that reveal with an opaque rectangle that fades out along
    // with the pieces, which reads as a black card dissolving rather than as the screensaver
    // breaking up.
    for (const p of parts) {
      const t = Math.max(0, elapsed - p.delay)
      // Gravity: distance grows with the square of time, so the pieces accelerate.
      const dy = 0.5 * p.vy * t * t * 1.6
      const dx = p.vx * t
      if (p.sy + dy > height + bh) continue
      const alpha = Math.max(0, 1 - (t / DURATION) * 1.05)
      if (alpha <= 0) continue
      surface.globalAlpha = alpha
      surface.save()
      const cxp = p.sx + bw / 2
      const cyp = p.sy + bh / 2
      surface.translate(cxp + dx, cyp + dy)
      surface.rotate(p.spin * t * 0.55)
      surface.drawImage(art, p.sx, p.sy, bw + 0.5, bh + 0.5, -bw / 2, -bh / 2, bw + 0.5, bh + 0.5)
      surface.restore()
    }
    surface.globalAlpha = 1
    handle = globalThis.requestAnimationFrame(draw)
  }
  handle = globalThis.requestAnimationFrame(draw)
  setTimeout(stop, 3600)
}

/**
 * Glitch·宽带位移 — wide horizontal bands displace, with a mosaic band and a chroma split.
 *
 * The loudest of the three. Bands are wide (20-90px) and the displacement is large, so the
 * picture reads as coming apart structurally rather than as dissolving.
 *
 * The chroma split is drawn with 'lighter' and a SINGLE-CHANNEL tint. Both matter: a tinted copy
 * carries black in the channels it does not keep, so painting it back with source-over drains
 * those channels and dims the frame; 'lighter' only adds light.
 */
function breakGlitch(canvas, art, width, height, finish) {
  const surface = canvas.getContext('2d')
  if (surface === null || art === null) { finish(); return }

  // A downsampled copy for the mosaic band.
  const mos = document.createElement('canvas')
  mos.width = Math.max(1, Math.round(width / 40))
  mos.height = Math.max(1, Math.round(height / 40))
  mos.getContext('2d').drawImage(art, 0, 0, mos.width, mos.height)

  // Single-channel copies: multiply by a colour that is zero in the other channels, so each copy
  // carries one channel and no colour of its own.
  const redTint = document.createElement('canvas')
  redTint.width = width
  redTint.height = height
  const blueTint = document.createElement('canvas')
  blueTint.width = width
  blueTint.height = height
  for (const [target, color] of [[redTint, 'rgb(255,0,0)'], [blueTint, 'rgb(0,150,255)']]) {
    const g2 = target.getContext('2d')
    g2.drawImage(art, 0, 0, width, height)
    g2.globalCompositeOperation = 'multiply'
    g2.fillStyle = color
    g2.fillRect(0, 0, width, height)
  }

  const BANDS = 14
  const DURATION = 1.35
  const startedAt = performance.now()
  let bands = []
  let finished = false
  let handle = null
  const stop = () => {
    if (finished) return
    finished = true
    if (handle !== null) globalThis.cancelAnimationFrame(handle)
    finish()
  }

  const draw = (now) => {
    if (surface === null || finished) return
    const elapsed = (now - startedAt) / 1000
    const local = elapsed / DURATION
    if (local >= 1) { stop(); return }
    const intensity = 0.35 + Math.min(1, local / 0.35) * 0.65
    const fade = local > 0.72 ? 1 - (local - 0.72) / 0.28 : 1

    surface.clearRect(0, 0, width, height)
    surface.globalAlpha = fade

    if (bands.length === 0 || Math.random() < 0.16) {
      bands = []
      for (let k = 0; k < BANDS; k += 1) {
        bands.push({
          y: Math.random() * height,
          h: 20 + Math.random() * 70,
          offset: (Math.random() - 0.5) * 180,
          wob: Math.random() * Math.PI * 2,
        })
      }
    }
    surface.drawImage(art, 0, 0, width, height)
    for (const b of bands) {
      const dx = b.offset * intensity + Math.sin(elapsed * 6 + b.wob) * 30 * intensity
      surface.save()
      surface.beginPath()
      surface.rect(0, b.y, width, b.h)
      surface.clip()
      surface.drawImage(art, 0, b.y, width, b.h, dx, b.y, width, b.h)
      surface.restore()
      // A bright seam at each band's edge: wide displacement needs an edge or it reads as the
      // picture sliding rather than as the picture being cut.
      surface.globalAlpha = fade * 0.22 * intensity
      surface.fillStyle = 'rgba(210,235,255,1)'
      surface.fillRect(0, b.y, width, 1)
      surface.fillRect(0, b.y + b.h - 1, width, 1)
      surface.globalAlpha = fade
    }

    // The mosaic band, drifting down.
    const my = ((local * 1.7) % 1) * height
    const mh = height * 0.16
    surface.save()
    surface.beginPath()
    surface.rect(0, my, width, mh)
    surface.clip()
    surface.imageSmoothingEnabled = false
    surface.drawImage(mos, 0, my * mos.height / height, mos.width, mh * mos.height / height,
      0, my, width, mh)
    surface.imageSmoothingEnabled = true
    surface.restore()

    // Chroma split, additive.
    const split = 3 + 10 * intensity
    surface.globalCompositeOperation = 'lighter'
    surface.globalAlpha = fade * 0.34
    surface.drawImage(redTint, -split, 0, width, height)
    surface.drawImage(blueTint, split, 0, width, height)
    surface.globalCompositeOperation = 'source-over'
    surface.globalAlpha = fade

    surface.fillStyle = 'rgba(0,0,0,.24)'
    for (let y = 0; y < height; y += 3) surface.fillRect(0, y, width, 1)

    surface.globalAlpha = 1
    handle = globalThis.requestAnimationFrame(draw)
  }
  handle = globalThis.requestAnimationFrame(draw)
  setTimeout(stop, 3600)
}

/** Check both idle conditions and act on the result. */
function tick() {
  if (disposed) return
  pollSystemIdle()
  if (shouldShow()) {
    if (!visible) show()
    return
  }
  // The layer is up and the idle reading has dropped. That does NOT mean "dismiss it".
  //
  // The rule this feature is built on is that MOVEMENT IS NOT DISMISSAL: the user asked
  // for a screensaver that survives a nudged mouse, so that reading a long page does not
  // clear the screen. The idle counter drops to zero the moment the mouse moves, so
  // treating "no longer idle" as a dismissal silently deleted that rule — and it did it
  // WITHOUT the break effect, because this path passes `false`. The visible symptom was
  // exactly that: the screensaver vanished on a mouse move, with no tear, which reads as
  // "the effect is broken" rather than as "the dismissal rule was inverted".
  //
  // So a shown layer stays up until something actually dismisses it: a click, a key, or
  // the window having been hidden for long enough to believe. The last of those is
  // decided here rather than on the event, because acting on the event is what made the
  // screen strobe.
  if (!visible) return
  // A PREVIEW is not subject to the automatic stand-downs, and this is the bug the user
  // reported as "the preview dismisses itself". The poll runs every couple of seconds, so a
  // preview raised while the boot overlay was still finishing would be taken down by this
  // very line — before the user had seen anything, and with no effect. A preview is a
  // deliberate, momentary act by somebody who is demonstrably present: it ends when THEY end
  // it, with a click or a key.
  if (previewing) return
  if (shouldYieldToOverlay() || hiddenFor() >= HIDDEN_GRACE_MS) hide(false)
}

/**
 * Whether a shown layer must step aside for the boot overlay.
 *
 * Split out from `shouldShow()` because the two are asked at different moments: this one
 * only matters while the layer is ALREADY up, and it must not be confused with "the user
 * is active again", which is deliberately not a dismissal.
 */
function shouldYieldToOverlay() {
  return globalThis.__DSH_BOOT_ANIM__ !== undefined
    && globalThis.__DSH_BOOT_ANIM__.el?.parentNode
}

/**
 * Build the state report: everything needed to explain why the layer is or is not up.
 *
 * Every field answers a question that would otherwise be a guess, because the failure
 * this feature has is SILENT and has five distinct causes — switched off, threshold not
 * reached, the probe not answering, the boot overlay still up, or a bug in the install —
 * all of which look identical from outside: an empty screen.
 */
function saverState() {
  const overlay = globalThis.__DSH_BOOT_ANIM__
  const overlayUp = overlay !== undefined && Boolean(overlay.el?.parentNode)
  return {
    // Every setting here is the LIVE resolution — the same function `shouldShow()` and `hide()`
    // consult — rather than the install-time snapshot. A diagnostic that reported the snapshot
    // would say "on" for a layer that had been switched off, which is the exact lie this report
    // exists to prevent.
    enabled: saverEnabled(),
    // Two spellings of the threshold and of the idle answer, because this object now serves TWO
    // callers that grew up apart: the Host report (which reads `thresholdMs` / `probeStatus`) and
    // the public `state()` a person or a test calls (which used to be a separate literal reading
    // `idleMs` / `systemStatus`). Renaming either would silently break one of them, and a
    // diagnostic that lies is worse than no diagnostic.
    idleMs: idleThresholdMs(),
    thresholdMs: idleThresholdMs(),
    breakEffect: breakEffectOn(),
    sound: soundOn(),
    hint: hintOn(),
    systemIdleMs: lastIdleMs,
    systemStatus: idleStatus,
    probeStatus: idleStatus,
    visible: visible,
    blurredMs: Math.round(blurredFor()),
    blurredForMs: Math.round(blurredFor()),
    visibility: document.visibilityState ?? 'unknown',
    hiddenMs: Math.round(hiddenFor()),
    overlayUp,
    shown: visible,
    hasLayer: root !== null,
    mediaCount: root === null ? 0 : root.querySelectorAll('.' + PREFIX + '-media').length,
    // WHY THE LAYER IS BEING HELD BACK, in the same order `shouldShow` checks.
    blockedBy: !saverEnabled() ? 'disabled' : (overlayUp ? 'boot-overlay' : null),
    // WHAT THE EFFECTS WILL ACTUALLY USE, as opposed to what the settings document says.
    //
    // This was missing for four rounds of "the chosen effect is not the one that plays", and the
    // omission is why each attempt was a guess. The stored document could be verified from the
    // Host (`cordis.patch.yml`) but the page's own view of it could not, so "the setting did not
    // reach the page" and "the page has it and draws the wrong thing" were indistinguishable.
    // `breakStyleRaw` is the stored value verbatim; `breakStyleNow` is that value resolved the
    // way a dismissal would resolve it, so `random` shows as the concrete effect it picks.
    breakStyleRaw: CFG && typeof CFG.screensaverBreakStyle === 'string' ? CFG.screensaverBreakStyle : null,
    breakStyleNow: breakStyle(),
    pointerRaw: CFG && typeof CFG.screensaverPointerEffect === 'string' ? CFG.screensaverPointerEffect : null,
    pointerNow: pointerEffect(),
    pointerArtMounted: pointerArt !== null,
    // HOW MUCH THE DECORATION HAS ACTUALLY DRAWN. `pointerArtMounted` says a canvas exists; it
    // does not say a single stroke went into it, and the two failures look identical from the
    // outside — an empty-looking layer. `pointerStrokes` is the count of `stroke()` calls made
    // since the decoration was created, so "selected, mounted, and drawing nothing" can be told
    // apart from "drawing fine and the user is looking at something else".
    pointerStrokes: pointerArt !== null && typeof pointerArt.strokes === 'number' ? pointerArt.strokes : 0,
    pointerRunning: pointerArt !== null ? pointerArt.running === true : false,
    // Did a pointer event ever reach the decoration? Zero here, with a mounted canvas, means the
    // events are not arriving — a fact about the window, not about this code — and that is the only
    // remaining way for the effect to look dead while every other reading is healthy.
    pointerMoves: pointerArt !== null && typeof pointerArt.moves === 'number' ? pointerArt.moves : 0,
    pointerInside: pointerArt !== null ? pointerArt.inside === true : false,
  }
}

/** The same state as one readable line, for the hint and the console. */
function saverLine() {
  const state = saverState()
  return 'saver on=' + (state.enabled ? 1 : 0)
    + ' thresh=' + Math.round(state.thresholdMs / 1000) + 's'
    + ' sys=' + (state.systemIdleMs === null ? '-' : Math.round(state.systemIdleMs / 1000) + 's')
    + ' probe=' + state.probeStatus
    + ' blur=' + Math.round(state.blurredMs / 1000) + 's'
    + ' vis=' + state.visibility
    + ' overlay=' + (state.overlayUp ? 'up' : 'gone')
    + ' shown=' + (state.shown ? 1 : 0)
}

/**
 * Report the page's state to the Host on a slow timer.
 *
 * This is the channel that actually works on the desktop app, and it exists because the
 * earlier ones did not: a desktop window has NO browser console and NO address bar, so
 * neither `console.log` nor `?dshbootdiag=1` is reachable by the person who has the
 * problem. When the screensaver misbehaved, the diagnosis had to be guessed at because
 * the only witness could not report what they saw.
 *
 * With this, the Host holds the real state of the real page and anyone with access to the
 * server can read it — no user action at all.
 *
 * The interval is slow (10s) because this is a diagnostic, not a heartbeat, and a report
 * every 10 seconds is a few hundred bytes. It runs regardless of whether the screensaver
 * is enabled: "switched off" is one of the states worth being able to see.
 *
 * IT RETURNS A DISPOSER, and that is a correction rather than a convenience: the handle used to be
 * dropped on the floor, so a plugin unload left an interval alive that kept POSTing the state of a
 * layer which no longer existed — for the rest of the session, once per unload. `installScreensaver`
 * splices this disposer into its own, which is what makes "the plugin is gone" mean "no timer of
 * this module is still running".
 * @returns {() => void} clears this reporting interval.
 */
function startStateReporting() {
  const url = typeof CFG?.saverReport === 'string' ? CFG.saverReport : null
  // A profile with no report route gets a no-op rather than an undefined return, so callers can
  // splice it unconditionally.
  if (url === null) return () => {}
  const report = () => {
    try {
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'screensaver', state: saverState() }),
      }).catch(() => {
        // A report that cannot be delivered says nothing about the screensaver, so it is
        // not allowed to surface as an error or to change any state.
      })
    } catch (error) {
      /* the same: reporting is best effort */
    }
  }
  report()
  const handle = setInterval(report, 10000)
  return () => {
    clearInterval(handle)
  }
}

/**
 * Log a live readout, when somebody has asked for one with `?dshbootdiag=1`.
 *
 * It writes to the CONSOLE ONLY, and that is a correction: the first version also
 * overwrote the layer's hint text every two seconds. The hint is user-facing — it is the
 * only thing telling somebody how to get out — and replacing it with a diagnostic line
 * both hid that instruction and made the text visibly churn. A diagnostic must never
 * take over a surface the user needs.
 *
 * The report to the Host is the channel that matters on the desktop, where this gate is
 * unreachable anyway; this one is for a browser with a console.
 */
function startSaverDiagnostics() {
  const readout = () => {
    console.log('boot-animation: ' + saverLine())
  }
  readout()
  setInterval(readout, 2000)
}

/**
 * Install the screensaver.
 *
 * @param options - `{ enabled, idleMs, breakEffect }`, already defaulted by the
 *   caller from the Host's injected config.
 * @returns a disposer that removes the layer and every listener.
 */
function installScreensaver(options = {}) {
  if (disposed) return () => {}
  config = {
    enabled: options.enabled === true,
    idleMs: typeof options.idleMs === 'number' && options.idleMs > 0 ? options.idleMs : DEFAULTS.idleMs,
    breakEffect: options.breakEffect !== false,
    hint: options.hint !== false,
    // BOTH of these were accepted by the caller and then DROPPED here for a while, which
    // silently disabled the exit-style picker and the whole pointer decoration: the call site
    // passed `breakStyle` / `pointerEffect`, this object did not carry them, and the two readers
    // below therefore always saw `undefined` and fell back to 'random' / 'none'. Every offline
    // check passed, because they asserted that the caller PASSED the value, never that this
    // object KEPT it.
    //
    // 'random' is carried as-is rather than resolved here: both readers resolve it late, per
    // appearance and per dismissal, which is what makes it actually vary.
    breakStyle: typeof options.breakStyle === 'string' ? options.breakStyle : 'random',
    pointerEffect: typeof options.pointerEffect === 'string' ? options.pointerEffect : 'none',
    // Whether the layer's media may make a sound. Read by pickAndPlace() when it builds the
    // renderer, so it is per appearance rather than per install.
    sound: options.sound === true,
    volume: typeof options.volume === 'number' && isFinite(options.volume)
      ? Math.min(1, Math.max(0, options.volume))
      : 0.35,
  }
  // THE LAYER IS INSTALLED UNCONDITIONALLY, EVEN WHEN THE SCREENSAVER IS SWITCHED OFF, AND THE
  // TRADE IS DELIBERATE.
  //
  // What used to be here: `if (!config.enabled) { startStateReporting(); return () => {} }`, on the
  // principle that a switched-off screensaver should cost nothing — no element, no listeners, no
  // polling. That principle is right about everything except the one thing that matters now: the
  // switch is a field the card promises is ALREADY IN EFFECT (`LIVE_FIELDS` in `src/client.js`),
  // `entry.js` really serves it, and `shouldShow()` reads it live. But with an early return there
  // was NOTHING installed to read it — no tick, no listeners, no layer — so a page loaded with the
  // screensaver off could never respond to the switch being turned ON. The only way to see the new
  // value would have been a page reload, and the desktop shell has no reload key. A setting that
  // cannot take effect is worse than a setting that costs a timer.
  //
  // So "whether the layer appears" is decided entirely by `shouldShow()` against the live `CFG`,
  // and everything is built up front. WHAT THAT COSTS, stated plainly rather than discovered later:
  //   - one hidden `<div>` in the document. It carries `display: none`, so it takes no layout, no
  //     paint, no hit-testing and no input — see the stylesheet's own note on why that rule is
  //     `display: none` and not `pointer-events`.
  //   - the 2-second `tick()` (`CHECK_MS`). While the screensaver is off this is a `shouldShow()`
  //     that answers false on its first line, plus the OS idle probe it polls — the same probe the
  //     feature exists to read, and the thing that makes "walked away" detectable at all.
  //   - the 10-second state report, which is wanted regardless: "switched off" is one of the states
  //     somebody needs to be able to SEE when they report that the screensaver never appears.
  // WHAT IT BUYS: turning the switch on, or changing the threshold, applies to the next tick —
  // which is the promise the card makes.
  //
  // `disposed` is the guard that keeps this to one install per page, so the cost is paid once.
  pieces = build()
  root = pieces.node
  document.head.appendChild(pieces.style)
  ;(document.body || document.documentElement).appendChild(root)

  // Focus tracking. `blurredSince` starts null and is seeded from the current focus
  // state, because the layer is installed after the app is up and the window may
  // already have been unfocused for longer than any listener could have measured.
  blurredSince = document.hasFocus() ? null : Date.now()
  on(globalThis, 'blur', () => { blurredSince = Date.now() })
  on(globalThis, 'focus', () => { blurredSince = null })

  // Hidden tracking, seeded the same way and for the same reason: the page is built
  // after the app is up, so a window that was already hidden would otherwise never be
  // noticed until the next change event.
  hiddenSince = document.visibilityState === 'hidden' ? Date.now() : null

  // Dismissal. A click or a key is what brings the user back, and that is deliberate
  // rather than lazy: moving the mouse does NOT dismiss, because a passing nudge
  // should not clear the screen, while a mouse move DOES still count as activity for
  // the idle threshold — so reading a long page never trips the screensaver at all.
  on(pieces.catcher, 'pointerdown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    hide(true)
  })
  on(globalThis, 'keydown', () => {
    if (visible) hide(true)
  }, true)
  // A pointer press anywhere in the window, not only on the catcher: the catcher
  // covers the layer, but the window may also receive presses through other paths
  // (a shortcut handler, an OS-level event) and a press is unambiguous intent.
  on(globalThis, 'pointerdown', () => {
    if (visible) hide(true)
  }, true)
  // Moving the mouse does not dismiss, but it must not leave a stale "unfocused"
  // measurement either: activity proves the user is present.
  on(globalThis, 'pointermove', () => {
    // Deliberately empty of dismissal. It exists so the intent is recorded in one
    // place: this listener is what says "movement is activity, not dismissal".
  })
  // Visibility is TRACKED here, not acted on.
  //
  // The previous version hid the layer the instant this event fired, which is what made
  // the screen strobe: in the Electron shell `visibilityState` flips repeatedly while the
  // window is on screen, so each flip showed and hid the layer. Taking it down is now
  // decided by the poll, which only believes a hidden window after it has stayed hidden
  // for a grace period — so a brief flip changes nothing and a real minimise still wins.
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (hiddenSince === null) hiddenSince = Date.now()
    } else {
      hiddenSince = null
    }
  })

  timer = setInterval(tick, CHECK_MS)
  tick()

  // The state report runs UNCONDITIONALLY, and that is the point of it.
  //
  // The desktop app has no console and no address bar, so the `?dshbootdiag=1` gate below
  // is unreachable for the person who actually has the problem. Reporting to the Host
  // instead means the answer can be read from outside, with nothing asked of the user.
  // It runs even when the screensaver is switched off, because "switched off" is one of
  // the states worth being able to see.
  //
  // Its disposer is KEPT and spliced into the one below: the handle used to be dropped, so an
  // unload left this interval POSTing the state of a layer that no longer existed.
  const stopReporting = startStateReporting()

  // `?dshbootdiag=1` additionally turns on an on-screen readout, in the same spirit as
  // the boot screen's. Kept for the case where somebody IS at a browser with a console:
  // the hint line is what a screenshot of a working screensaver shows, and the console
  // line survives the layer being hidden.
  if (globalThis.location?.search?.indexOf('dshbootdiag=1') >= 0) {
    startSaverDiagnostics()
  }

  return () => {
    disposed = true
    if (timer !== null) clearInterval(timer)
    timer = null
    // Every timer this module owns is cleared here, so "the plugin is unloaded" means no
    // interval survives it — the tick, the rotation (via `releaseMedia`'s path and the
    // explicit stop below) and the state report.
    stopReporting()
    stopRotation()
    for (const off of listeners.splice(0, listeners.length)) off()
    releaseMedia()
    // The caption colours must be put back even on unload: left overridden, the window's
    // buttons would keep the screensaver's colour after the plugin is gone, which reads as
    // the window itself being broken.
    setCaptionHidden(false)
    if (pieces.style?.parentNode) pieces.style.remove()
    if (root?.parentNode) root.remove()
    root = null
    pieces = []
    visible = false
  }
}

  globalThis.__DSH_BOOT_ANIM_SCREENSAVER__ = {
    install: installScreensaver,
    /**
     * Preview one entry: raise the REAL layer and LEAVE IT UP.
     *
     * The preview used to raise the layer, wait for the media, and dismiss it itself — so what a
     * user actually saw was the exit effect and nothing else. That answers "what does the exit look
     * like" while skipping everything the preview is more useful for: the picture, the hint line,
     * the pointer decoration, and whether the thing covers the app at all. It also made the
     * pointer effect unreachable from the card, because the layer came down within a second of
     * going up.
     *
     * So this raises the layer and stops. Dismissing it is a CLICK or a KEY, exactly like a real
     * dismissal, which means the exit effect plays through the real path too — including the
     * configured style, or an actual random pick when the setting is 'random'.
     *
     * The two things a preview must NOT do, and how they are handled:
     *   - it must not latch the screensaver off. A dismissal sets `dismissedUntilActive`; a preview
     *     is not a dismissal, so the flag is cleared once the layer is up. It is set by the real
     *     dismissal the user performs, and cleared by that same path's own bookkeeping — see the
     *     `previewing` handling in `hide()`.
     *   - it must not leave the layer up forever if the user walks away. It comes down on the same
     *     click/键 a real one does; there is deliberately no timeout, because a preview that
     *     disappeared on its own would be the bug this replaces.
     *
     * @param {string} [style] - a specific exit effect, overriding the setting. Omitted or empty
     *   means "whatever is configured", which is what the card's preview passes.
     * @param {string} [entryName] - the row to put on screen, or omitted for a random pick.
     * @returns {boolean} true when the preview started.
     */
    preview: function (style, entryName) {
      if (root === null) return false
      // A preview while the layer is already up would run two effects at once.
      if (visible) return false

      // The boot overlay normally holds the screensaver back — a screensaver that covered the
      // boot animation would be the animation's own failure mode reproduced by another feature.
      // But a PREVIEW is not the screensaver appearing on its own: somebody asked for it just
      // now, from the settings card. The overlay is usually still in the DOM when they do (it
      // stays up until the clip finishes and the kernel is ready), so refusing here made the
      // preview button do NOTHING for the whole first minute of a session — which is exactly
      // what was reported as "the mouse interaction is gone, the preview does nothing".
      //
      // So the overlay is TAKEN OUT OF THE DOM for the duration of the preview and put back
      // afterwards. That is what the user asked for: the screensaver, on top, now. Nothing about
      // the boot screen is destroyed — the node keeps its children and its state, and `hide()`
      // restores it.
      bootOverlayParked = null
      const overlay = globalThis.__DSH_BOOT_ANIM__
      if (overlay !== undefined && overlay !== null && overlay.el && overlay.el.parentNode) {
        bootOverlayParked = { el: overlay.el, parent: overlay.el.parentNode, next: overlay.el.nextSibling }
        overlay.el.parentNode.removeChild(overlay.el)
      }

      // Which entry to put on screen. Set BEFORE show(), because show() ends in pickAndPlace() and
      // reads it there; a preview of a named row must not land on a different file.
      forcedEntryName = typeof entryName === 'string' && entryName !== '' ? entryName : null

      // A style forced for the preview. 'random' stays null so the dismissal resolves it, which is
      // what makes repeated previews of 'random' actually differ. `hide()` consumes it.
      previewForcedStyle = typeof style === 'string' && style !== '' && style !== 'random'
        ? style
        : null

      // This layer is a preview, which changes one thing about its dismissal: no latch. Set BEFORE
      // `show()` so that a dismissal arriving in the same tick cannot read the previous value.
      previewing = true

      show()

      // A dismissal sets the latch that keeps the layer down until the machine is used again. The
      // user is demonstrably present — they just clicked 预览 — so the latch must not be left set
      // by anything in this path.
      dismissedUntilActive = false

      // Nothing else. The layer stays up until the user dismisses it, which is what makes the
      // pointer decoration previewable at all.
      return true
    },
    /**
     * What the screensaver currently believes, for the browser check.
     *
     * Exposed because the interesting failures here are INVISIBLE: a layer that
     * decides not to appear looks identical whether it is switched off, waiting for
     * its threshold, blocked by the boot overlay, or reading a counter that never
     * grows. A check that can only see the layer cannot tell those apart, and would
     * report "broken" for what is actually correct behaviour.
     *
     * Read-only: it returns a copy, so a caller cannot reach in and change a value
     * the timing depends on.
     */
    state: function () {
      // ONE state, not two. This used to be a hand-written copy of the same fields, and it drifted:
      // `saverState()` grew the settings readout (`breakStyleRaw`, `pointerRaw`, …) while this
      // literal kept the old list, so every diagnosis made through `__DSH_BOOT_ANIM_SCREENSAVER__
      // .state()` could not see WHICH effect the page was about to play. That is how four rounds of
      // "the chosen effect is not the one that plays" were spent guessing. Both channels now read
      // the same function.
      return saverState()
    },
  }

  // Install from the injected config, the way the boot screen installs itself.
  //
  // This script is injected into <head>, so it runs before the app exists and has
  // nothing to wait for: the config row above it has already filled the global, and
  // the installer only needs the document. Doing it here rather than from the client
  // bundle is deliberate — the screensaver must survive the client bundle failing to
  // materialize, which is a failure mode the bundle itself cannot report.
  //
  // The `disposed` guard makes a second evaluation a no-op, so a page that somehow
  // carries two copies does not end up with two layers and two timers.
  if (!disposed) {
    installScreensaver({
      enabled: CFG && CFG.screensaverEnabled === true,
      idleMs: CFG && CFG.screensaverIdleMs,
      breakEffect: !CFG || CFG.screensaverBreakEffect !== false,
    // Which exit effect. Read per dismissal by breakStyle() rather than validated here, because
    // 'random' has to resolve late.
    breakStyle: CFG && typeof CFG.screensaverBreakStyle === 'string'
      ? CFG.screensaverBreakStyle
      : 'random',
    // Which pointer decoration to run. Read per appearance by pointerEffect(), for the same reason
    // as the exit style: 'random' resolves late.
    pointerEffect: CFG && typeof CFG.screensaverPointerEffect === 'string'
      ? CFG.screensaverPointerEffect
      : 'none',
    // Whether the layer's media may make a sound. Off unless the user asked: this layer
    // covers the screen while nobody is looking at it.
    sound: CFG && CFG.screensaverSound === true,
    // How loud, 0..1. Read from the live global: a level the user just dragged must apply on the
    // next appearance rather than waiting for a rebuild.
    volume: CFG && typeof CFG.screensaverVolume === 'number' ? CFG.screensaverVolume : 0.35,
      hint: !CFG || CFG.screensaverHint !== false,
    })
  }
})()
