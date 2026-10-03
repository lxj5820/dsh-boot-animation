// Pre-boot screen, injected as a parser-blocking head row by entry.js.
//
// This file is a script *text*, not a module: it runs before the shell module
// script and therefore before `AppWebEntry` builds the kernel boot page. That
// ordering is the entire mechanism: by the time the kernel renders its own
// "HARNESS / Loading plugins..." page, this screen already owns the viewport.
//
// It reads the clip pool and hold budget from the JSON row emitted immediately
// before this script (window.__DSH_BOOT_ANIM_CFG__), and it reads live boot
// progress by observing the CSS custom property the kernel boot page writes on
// its spinner (`--dsh-boot-arc`: 72deg at zero active entries, 288deg at all).
//
// It deliberately does not touch React or the shell module table: it needs no
// framework and must survive the UI renderer failing.

/* eslint-disable */
;(function () {
  'use strict'

  var cfg = globalThis.__DSH_BOOT_ANIM_CFG__
  if (!cfg || typeof cfg !== 'object' || typeof cfg.manifest !== 'string') return
  if (globalThis.__DSH_BOOT_ANIM__) return

  var HOLD_MS = typeof cfg.holdMs === 'number' ? cfg.holdMs : 15000
  // How long the dissolve into the app takes. Configurable, so it is clamped
  // rather than trusted: a zero would make the overlay vanish between frames and
  // a huge value would hold the user on a decorative screen.
  var FADE_MS = typeof cfg.fadeMs === 'number' && cfg.fadeMs >= 300 && cfg.fadeMs <= 5000
    ? Math.round(cfg.fadeMs)
    : 2000
  // When the hand-off happens. `tail` dissolves over the clip's last FADE_MS so
  // both finish together; `end` plays the clip out and then fades; `click` never
  // enters on its own and waits for the user.
  var ENTER_MODE = cfg.enterMode === 'end' || cfg.enterMode === 'click' ? cfg.enterMode : 'tail'
  // Sound off is not "start muted": it is the absence of every audio path. The
  // unmuted attempt, the sound button and the retry that a press would otherwise
  // fire are all skipped, so nothing can bring the sound back for this screen.
  // A missing key means on, which is the behaviour every older Host row had.
  var SOUND_ON = cfg.sound !== false
  // A press enters instead of unlocking audio. See press().
  var CLICK_TO_ENTER = cfg.clickToEnter === true
  // The bottom hint line. Off hides that one element; the title and the progress
  // bar are not "instructions" and stay.
  var SHOW_HINT = cfg.showHint !== false
  // A clip shorter than this cannot carry the dissolve — it would have to start
  // before there is any picture to dissolve. Those play out and then fade instead.
  var TAIL_MIN_MS = FADE_MS * 2
  // A clip whose length is unknown never fires `ended` — a MediaRecorder WebM
  // reports `duration = Infinity` — so waiting for an end that cannot come would
  // hold the screen forever. This bounds that, and only that.
  var ENDLESS_MS = 20000
  var ARC_MIN = 72
  var ARC_SPAN = 216
  var cache = { startedAt: Date.now(), current: null, loaded: false }

  // The Windows caption (minimise / maximise / close) is painted by Electron
  // *above* the page, so no z-index here can ever cover it — which is why this
  // screen never looked finished on Windows. Its colours are not ours to set
  // either: the desktop preload builds a hidden probe styled from two theme
  // tokens, measures it, and forwards the result over its `windowsAppearance` IPC,
  // re-measuring whenever `document.head` changes. So the caption is repainted by
  // restyling that probe — and only that probe, because overriding the theme
  // tokens themselves would repaint the caption at the cost of dragging the whole
  // shell's sidebar fill and label colour along with it, which shows through the
  // dissolve. The probe is identified by the tokens it reads, the one thing about
  // it that is stable.
  var CAPTION_CSS = 'body>span[style*="dsw-specific-sidebar-fill"]'
    + '{background-color:rgba(0,0,0,0)!important;color:#e8f2fb!important}'
  var captionStyle = null
  // Once the overlay has left, a late call must not repaint a caption that has
  // already been handed back.
  var captionDone = false

  /**
   * Watch the clip so the dissolve can be aimed at its last frame.
   *
   * A per-frame callback where it exists, a coarse timer where it does not. Both
   * are needed at the call site: rAF is frame-accurate while the tab is visible
   * and stops when it is not, which is exactly the state a `timeupdate` listener
   * still covers.
   * @param fn - called repeatedly until it stops rescheduling itself.
   */
  var nextFrame = typeof globalThis.requestAnimationFrame === 'function'
    ? function (fn) { globalThis.requestAnimationFrame(fn) }
    : function (fn) { globalThis.setTimeout(fn, 50) }

  function shuffled(values) {
    var out = values.slice()
    for (var i = out.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1))
      var swap = out[i]
      out[i] = out[j]
      out[j] = swap
    }
    return out
  }

  function pickClip(clips) {
    var recentKey = 'dsh-boot-animation:recent'
    var recent = []
    try {
      recent = JSON.parse(sessionStorage.getItem(recentKey) || '[]')
      if (!Array.isArray(recent)) recent = []
    } catch (error) {
      recent = []
    }
    var fresh = clips.filter(function (clip) { return recent.indexOf(clip.name) < 0 })
    var pool = fresh.length > 0 ? fresh : clips
    var chosen = pool[Math.floor(Math.random() * pool.length)]
    recent.push(chosen.name)
    while (recent.length > Math.max(clips.length - 1, 1)) recent.shift()
    try {
      sessionStorage.setItem(recentKey, JSON.stringify(recent))
    } catch (error) {
      /* private mode: rotation degrades to plain random */
    }
    return chosen
  }

  function style() {
    return [
      '.dshba{position:fixed;inset:0;z-index:2147483647;overflow:hidden;',
      'background:radial-gradient(circle at 50% 42%,#0b1b2e 0%,#050b14 62%,#000 100%);',
      'font-family:system-ui,-apple-system,Segoe UI,Microsoft YaHei,sans-serif;',
      'color:#dbeaf7;cursor:pointer;-webkit-user-select:none;user-select:none;',
      // The whole overlay fades as a unit: the app underneath must not be veiled
      // by anything once the exit starts, so the background gradient fades along
      // with the clip instead of outlasting it.
      'transition:opacity ' + (FADE_MS / 1000) + 's ease;opacity:1}',
      '.dshba[data-state=leaving]{opacity:0;pointer-events:none}',
      // `cover`, because letterboxing reads as black bars and was rejected. The
      // mask feathers the crop so it does not end in a hard edge.
      '.dshba-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;',
      'opacity:0;transition:opacity 1.1s ease;',
      '-webkit-mask-image:radial-gradient(ellipse 88% 82% at 50% 50%,#000 62%,transparent 100%);',
      'mask-image:radial-gradient(ellipse 88% 82% at 50% 50%,#000 62%,transparent 100%)}',
      // Quoted for the same reason as the hint switch below: `[data-shown=1]` is
      // an invalid selector and the rule never applied.
      '.dshba-video[data-shown="1"]{opacity:1}',
      '.dshba-veil{position:absolute;inset:0;pointer-events:none;',
      'background:radial-gradient(ellipse 86% 78% at 50% 50%,transparent 44%,rgba(4,10,18,.45) 78%,rgba(2,6,12,.7) 100%)}',
      '.dshba-ui{position:absolute;left:0;right:0;bottom:0;padding:26px 30px 24px;',
      'display:flex;flex-direction:column;gap:9px;align-items:center;',
      'text-shadow:0 1px 10px rgba(0,0,0,.6)}',
      '.dshba-title{font-size:12px;letter-spacing:.34em;font-weight:600;color:#9fc4e6;',
      'text-transform:uppercase;opacity:.92}',
      '.dshba-bar{position:relative;width:min(340px,54vw);height:2px;border-radius:2px;',
      'background:rgba(159,196,230,.22);overflow:hidden}',
      '.dshba-fill{position:absolute;inset:0 auto 0 0;width:0%;border-radius:2px;',
      'background:linear-gradient(90deg,#4f9dd9,#8fd8ff);',
      'box-shadow:0 0 12px rgba(143,216,255,.75);transition:width .45s ease}',
      '.dshba-hint{font-size:12px;color:#8fb3d4;letter-spacing:.12em;opacity:0;',
      'transition:opacity .5s ease}',
      // The switch only removes the sentence. `display:none` rather than
      // `opacity:0` so the line cannot be revealed later by the state rules
      // below, which set the opacity this class would otherwise fight.
      //
      // The value is QUOTED. An unquoted `0` is not an identifier, so
      // `[data-hint=0]` is an invalid selector, Chrome drops the whole rule, and
      // the switch silently does nothing. The attention rules below carried the
      // same bug with `[data-attention=1]` and had never applied.
      '.dshba[data-hint="0"] .dshba-hint{display:none}',
      '.dshba[data-state=ready] .dshba-hint{opacity:.95}',
      '.dshba[data-attention="1"] .dshba-hint{opacity:1;color:#ffd79a;letter-spacing:.04em}',
      '.dshba[data-attention="1"] .dshba-fill{background:linear-gradient(90deg,#d99a4f,#ffd79a)}',
      '.dshba-sound{position:absolute;right:22px;bottom:22px;z-index:2;cursor:pointer;',
      'font:12px/1 system-ui,sans-serif;letter-spacing:.06em;padding:9px 14px;border-radius:999px;',
      'color:#cfe4f6;background:rgba(12,26,42,.62);border:1px solid rgba(159,196,230,.38);',
      'backdrop-filter:blur(4px);transition:opacity .4s ease,background .2s ease}',
      '.dshba-sound:hover{background:rgba(20,44,70,.78)}',
      '.dshba[data-state=leaving] .dshba-sound{opacity:0;pointer-events:none}',
    ].join('')
  }

  function build() {
    var css = document.createElement('style')
    css.setAttribute('data-dsh-boot-anim', '')
    css.textContent = style()
    var root = document.createElement('div')
    root.className = 'dshba'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', 'DSH boot animation')
    root.setAttribute('data-state', 'idle')
    root.setAttribute('data-hint', SHOW_HINT ? '1' : '0')
    var video = document.createElement('video')
    video.className = 'dshba-video'
    video.muted = true
    // Looping only in `click` mode. The other two modes are driven by the clip's
    // own end, and a looping element never fires `ended` — with `loop` on, the
    // automatic hand-off would simply never happen.
    video.loop = ENTER_MODE === 'click'
    video.playsInline = true
    video.setAttribute('playsinline', '')
    video.preload = 'auto'
    var veil = document.createElement('div')
    veil.className = 'dshba-veil'
    var ui = document.createElement('div')
    ui.className = 'dshba-ui'
    var title = document.createElement('div')
    title.className = 'dshba-title'
    title.textContent = 'DeepSeek Harness'
    var bar = document.createElement('div')
    bar.className = 'dshba-bar'
    var fill = document.createElement('div')
    fill.className = 'dshba-fill'
    bar.appendChild(fill)
    var hint = document.createElement('div')
    hint.className = 'dshba-hint'
    hint.textContent = ''
    // A sound toggle, deliberately separate from the enter gesture. Chromium only
    // grants audio to a user gesture, and entering is one — but entering also
    // dismisses the screen, so tying sound to it means the sound is only ever
    // heard on the way out. This button is the gesture that turns sound on while
    // the screen stays put, and once the origin has that engagement recorded the
    // clip starts with sound on later launches with no interaction at all.
    //
    // With sound off there is no button at all, because there is nothing it could
    // be allowed to do: a control that only ever fails is worse than no control.
    var sound = null
    if (SOUND_ON) {
      sound = document.createElement('button')
      sound.className = 'dshba-sound'
      sound.type = 'button'
      sound.textContent = '🔇 开声音'
      sound.addEventListener('pointerdown', function (event) { event.stopPropagation() }, true)
      sound.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        toggleSound()
      })
    }
    ui.appendChild(title)
    ui.appendChild(bar)
    ui.appendChild(hint)
    root.appendChild(video)
    root.appendChild(veil)
    if (sound) root.appendChild(sound)
    root.appendChild(ui)
    // The video part is a live view, not a snapshot: a clip that fails to play is
    // replaced by a fresh element, so anything holding the old node would pause
    // the wrong element on exit.
    return {
      css: css,
      root: root,
      fill: fill,
      hint: hint,
      ui: ui,
      veil: veil,
      sound: sound,
      video: function () { return video },
      replaceVideo: function (next) { video = next },
    }
  }

  // The kernel boot page is created synchronously after this script, so every
  // observation below is attached before its first mutation.
  var parts = build()
  var namespace = {
    el: parts.root,
    bootedAt: null,
    failed: false,
    // `null` means audio is fine (or was never in question); anything else is the
    // reason the clip is silent. Sound is off from the first frame when the
    // setting says so, so the hint never advertises an unlock that cannot happen.
    audioBlocked: SOUND_ON ? null : 'disabled',
    // Called by the browser half once the client roster activates. Boot has then
    // finished, so the screen may announce that entering is available — and if
    // the clip already played itself out while the kernel was still starting,
    // this is the moment the hand-off that was waiting on it can happen.
    clientReady: function () {
      if (namespace.bootedAt === null) namespace.bootedAt = Date.now()
      if (namespace.failed) return
      setState('ready')
      parts.hint.textContent = namespace.audioBlocked === null ? HINT_SOUND : HINT_SILENT
      // If the clip is already inside its final window the dissolve starts here,
      // rather than on whatever the next frame happens to be.
      if (typeof nudgeTail === 'function') nudgeTail()
      maybeEnter()
    },
  }
  globalThis.__DSH_BOOT_ANIM__ = namespace

  // The hints, one per state the screen can actually be in: while the clip is
  // silent the first press means "let me hear it", once sound is on a press means
  // "skip the rest", and in click mode a press is the only way in at all. Saying
  // so removes the guesswork about why nothing happened on the first click.
  //
  // Two of the switches remove the two-step entirely: with sound off there is
  // nothing to unlock, and with click-to-enter the first press is the way in — in
  // both cases a sentence about unlocking audio would be a lie.
  var HINT_ENTER = ENTER_MODE === 'click' ? '点击进入' : '播完自动进入 · 点一下提前进'
  var HINT_UNLOCK = ENTER_MODE === 'click' ? '点一下开声音 · 再点进入' : '点一下开声音 · 播完自动进入'
  var HINT_DIRECT = ENTER_MODE === 'click' ? '点击进入' : '点一下直接进入'
  var TWO_STEP = SOUND_ON && !CLICK_TO_ENTER
  // With sound off there is nothing to unlock, so the plain entry hint is the
  // true one; with click-to-enter the press skips audio, and the hint says that.
  var HINT_SOUND = CLICK_TO_ENTER ? HINT_DIRECT : HINT_ENTER
  var HINT_SILENT = TWO_STEP ? HINT_UNLOCK : HINT_SOUND

  function setState(value) {
    parts.root.setAttribute('data-state', value)
  }

  function attention(message) {
    parts.root.setAttribute('data-attention', '1')
    setState('ready')
    parts.hint.textContent = message
  }

  /** Drive the bar from the kernel's own progress arc. */
  function observeProgress() {
    var boot = document.querySelector('[data-dsh-boot]')
    if (boot === null) return
    var spinner = boot.querySelector('[data-dsh-boot-spinner]')
    if (spinner === null) return
    var update = function () {
      var raw = parseFloat(spinner.style.getPropertyValue('--dsh-boot-arc'))
      var ratio = Number.isFinite(raw) ? Math.min(Math.max((raw - ARC_MIN) / ARC_SPAN, 0), 1) : 0
      parts.fill.style.width = (ratio * 100).toFixed(1) + '%'
    }
    update()
    new MutationObserver(update).observe(spinner, { attributes: true, attributeFilter: ['style'] })
  }

  /**
   * Detect the kernel's failure rendering. The kernel replaces the boot card's
   * children with a failure report and never mounts the application, so without
   * this the screen would hold the viewport forever and hide the diagnosis.
   */
  function observeFailure() {
    var boot = document.querySelector('[data-dsh-boot]')
    if (boot === null) return
    var check = function () {
      if (namespace.failed) return
      var text = boot.textContent || ''
      if (text.indexOf('Failed to load plugins') < 0 && text.indexOf('did not activate') < 0) return
      namespace.failed = true
      attention('启动失败，点击查看')
    }
    new MutationObserver(check).observe(boot, { childList: true, subtree: true, characterData: true })
    check()
  }

  // Set by the clip loader once a clip is playing silently; called by the
  // entering gesture to retry with sound. Declared here because the entering
  // handler is defined outside the loader's scope.
  var audioRetry = null

  // Whether the clip has played itself out. Together with `bootedAt` this is the
  // whole hand-off condition: the animation runs to its end, and the app is shown
  // when both the clip is over and the kernel is actually ready.
  var clipDone = false

  // Set by the loader to the current clip's tail check.
  //
  // There is a genuine gap without it: if the kernel becomes ready while the clip
  // is inside its final window, the dissolve should begin right then — but the
  // frame loop may not tick again for a frame, and in a background tab rAF is
  // throttled hard enough to miss it until the clip is already over. Boot
  // readiness is a moment we know exactly, so it pushes instead of waiting to be
  // polled.
  var nudgeTail = null

  /**
   * Hand off to the app if — and only if — the clip is over AND boot finished.
   *
   * The order of those two is why this is a function rather than a listener on
   * `ended`: whichever of them happens second has to be the one that lets go, and
   * a clip that ends during a slow start must not reveal a half-built app. When
   * the clip finishes first the last frame is simply held; `clientReady` calls
   * back here the moment the kernel catches up.
   */
  function maybeEnter() {
    // In `click` mode the clip is the whole show and the user decides when it
    // ends; nothing about the clip or the kernel releases the screen but a press.
    if (ENTER_MODE === 'click') return
    if (!clipDone || namespace.failed) return
    if (namespace.bootedAt === null) {
      // Deliberately not the amber attention state: nothing is wrong yet, and
      // flashing the warning for an ordinary slow start would cry wolf on a
      // condition that resolves itself. The amber hint is saved for a real stall.
      parts.hint.textContent = '启动较慢，就绪后自动进入'
      return
    }
    enter()
  }

  /**
   * Turn sound on for the clip that is already playing, without leaving the
   * screen. This click is the user activation the audio policy wants, so it
   * succeeds where the initial muted-then-unmuted attempt could not.
   */
  function toggleSound() {
    // Nothing to toggle when the option is off; the button is not even built.
    if (!SOUND_ON) return
    var video = parts.video()
    if (!video.muted) {
      video.muted = true
      if (parts.sound) parts.sound.textContent = '🔇 开声音'
      namespace.audioBlocked = 'muted-by-user'
      return
    }
    video.muted = false
    namespace.audioBlocked = null
    if (parts.sound) parts.sound.textContent = '🔊 声音已开'
    var played = video.play()
    if (played && typeof played.catch === 'function') {
      played.catch(function (reason) {
        video.muted = true
        namespace.audioBlocked = reason && reason.name ? reason.name : 'refused'
        if (parts.sound) parts.sound.textContent = '🔇 被拒绝'
        var retryMuted = video.play()
        if (retryMuted && typeof retryMuted.catch === 'function') retryMuted.catch(function () {})
      })
    }
  }

  /**
   * Dissolve the overlay away and hand the app over.
   *
   * @param fadeMs - how long the dissolve takes. The tail dissolve passes the
   *   clip's actual remaining time so the fade lands exactly on the last frame
   *   instead of a fixed guess; everything else passes nothing and gets FADE_MS.
   * @param tail - true when the clip is still playing and will reach its own end
   *   during the dissolve. The clip then STAYS inside the overlay and fades with
   *   it, which is the whole effect: the picture dissolves into the app and the
   *   last frame is gone exactly when the clip is. Detaching it to `body` here —
   *   as a skip does — would park an opaque video on top of the app for the whole
   *   dissolve and erase the crossfade.
   */
  /**
   * Call back once the clip has a frame to show — starting it is not that moment.
   *
   * A resolved `play()` promise only means the element left the paused state. It
   * says nothing about whether a picture exists, and treating it as success
   * disarmed the retry watchdog, so a clip whose frames never arrived left the
   * screen on the bare gradient with no error and no further attempt.
   *
   * Nor may this wait for a frame to be COMPOSITED, which was the first attempt at
   * fixing that and locked the screen up instead: the element starts fully
   * transparent and this callback is what makes it visible, so
   * `requestVideoFrameCallback` can sit waiting for a frame that will not be
   * submitted until the very style change it is blocking. The signal is *decoded
   * data for the first frame*, from whichever report arrives first, with a
   * presented frame kept as one more route to the same fact.
   * @param video - the clip element.
   * @param done - called once the clip can show something.
   */
  function whenFramePresents(video, done) {
    var fired = false
    var once = function () {
      if (fired) return
      fired = true
      done()
    }
    // "Data for the current playback position is available", which for a fresh
    // element is the first frame.
    if (video.readyState >= 2) {
      once()
      return
    }
    video.addEventListener('loadeddata', once, { once: true })
    video.addEventListener('canplay', once, { once: true })
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(once)
    }
    // Advancing time is the same fact reported by none of the above, and it is the
    // case a MediaRecorder WebM can land in: it may never report `readyState >= 2`
    // and yet be playing frames.
    video.addEventListener('timeupdate', function () {
      if (video.currentTime > 0) once()
    })
  }

  function enter(fadeMs, tail) {
    if (parts.root.getAttribute('data-state') === 'leaving') return
    entered = true

    var span = typeof fadeMs === 'number' && fadeMs > 0
      ? Math.max(Math.min(fadeMs, FADE_MS), 120)
      : FADE_MS

    var video = parts.video()
    // A clip that has already reached its end must not be replayed on the way
    // out. The sound retry calls play() again, and play() on a finished element
    // seeks back to zero and starts the whole thing over — so the hand-off at the
    // end of a clip would restart the animation underneath the fade. The retry is
    // only meaningful while there are still frames left to hear it over.
    var finished = video.ended === true
    var live = !finished && !video.paused && tail !== true
    // The retry that lets a skip carry the sound out with the picture. Not with
    // click-to-enter: there the press is only ever the entry, and turning audio on
    // as a side effect of leaving is exactly the second meaning the option removes.
    if (!CLICK_TO_ENTER && !finished && tail !== true && typeof audioRetry === 'function') audioRetry()

    // A clip that is still RUNNING and is being skipped past is moved out of the
    // overlay before the overlay goes away. Two reasons, both required: removing
    // the overlay removes a <video> inside it, which would cut the sound off; and
    // the overlay must not keep painting over the app while it exits. Detached,
    // the element keeps playing its audio with nothing on screen, which is what
    // stops a skip from chopping the sound mid-phrase. A clip that already ended
    // has no audio left to protect, so it simply fades out with everything else.
    var standalone = false
    if (live && video.parentNode && video.parentNode.parentNode === document.body) {
      var box = video.getBoundingClientRect()
      video.style.position = 'fixed'
      video.style.left = box.left + 'px'
      video.style.top = box.top + 'px'
      video.style.width = box.width + 'px'
      video.style.height = box.height + 'px'
      video.style.transition = 'opacity ' + (span / 2 / 1000) + 's ease'
      video.style.pointerEvents = 'none'
      document.body.appendChild(video)
      standalone = true
    }

    // The WHOLE overlay fades as a unit — background gradient, clip and chrome
    // together — and is then removed. Fading only the chrome first, as an earlier
    // version did, left an opaque panel covering the conversation underneath for
    // the rest of the transition. Nothing here outlives the fade, so the app is
    // never left covered.
    //
    // The duration is set inline rather than left to the stylesheet because a tail
    // dissolve knows the exact time it has left; the CSS value is only the default
    // for the fades that have no deadline to hit.
    parts.root.style.transitionDuration = (span / 1000) + 's'
    setState('leaving')
    globalThis.setTimeout(function () {
      if (parts.root.parentNode) parts.root.parentNode.removeChild(parts.root)
      // Handed back here rather than when the fade starts: a transparent caption
      // stays correct for the whole dissolve — it shows whatever is behind it, which
      // is exactly what is fading — whereas an opaque one would flip to the shell's
      // colours while the sea is still on screen.
      restoreCaptionTokens()
    }, span + 100)

    if (standalone) {
      // Fade the detached clip out over the second half of the exit, then stop
      // it: the sound is allowed to outlive the picture it belonged to.
      globalThis.setTimeout(function () { video.style.opacity = '0' }, span / 2)
      globalThis.setTimeout(function () {
        try {
          video.pause()
        } catch (error) {
          /* already stopped */
        }
        if (video.parentNode) video.parentNode.removeChild(video)
      }, span + 1300)
    } else {
      globalThis.setTimeout(function () {
        try {
          video.pause()
        } catch (error) {
          /* an unplayed video needs no pause */
        }
      }, span + 400)
    }
  }

  // One press, two possible meanings, decided by the audio policy rather than by
  // a counter.
  //
  // Chromium grants audio only to a user gesture, and the gesture must NOT be the
  // one that dismisses the screen — otherwise the sound starts exactly as the
  // picture leaves, which is the contradiction of "click to hear it" plus "click
  // to leave". So while the clip is still silent a press unlocks the sound and
  // deliberately leaves the screen alone; once sound is on (or was never blocked)
  // a press means "skip the rest of it". The entry itself no longer needs a
  // press at all: the clip playing out is what enters. Any key enters directly —
  // a user reaching for Esc does not want a two-step.
  var entered = false

  function press() {
    if (entered) return
    // A clip that has already finished is never a sound-unlock target: the retry
    // path calls play(), and play() on a finished element restarts it from zero.
    // That case is reachable — the clip can end while the kernel is still
    // starting — and pressing then means "let me in", not "replay that".
    var finished = parts.video().ended === true
    // Click-to-enter skips the unlock: this press IS the entry, so there is no
    // first press spent on audio and no second press needed. With sound off the
    // condition below is already false (no audioRetry was ever armed), and this
    // flag is what makes the same shortcut explicit.
    if (!CLICK_TO_ENTER && !finished && namespace.audioBlocked !== null && typeof audioRetry === 'function') {
      audioRetry()
      namespace.audioBlocked = null
      if (!namespace.failed) parts.hint.textContent = HINT_SOUND
      return
    }
    enter()
  }

  /**
   * Whether a pointer event landed on the sound control.
   *
   * The overlay listens on pointerdown in the capture phase, which runs before
   * the button's own handlers and before any click, so a button that only stopped
   * propagation on click was never reached — pressing it entered the screen. The
   * check has to be on the event target instead of on propagation order.
   * @param event - the pointer event.
   * @returns true when the press belongs to the sound control.
   */
  function onSoundControl(event) {
    var node = event && event.target
    return !!(node && node.closest && node.closest('.dshba-sound'))
  }

  parts.root.addEventListener('pointerdown', function (event) {
    if (onSoundControl(event)) return
    press()
  }, true)
  globalThis.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' || event.key === ' ' || event.key === 'Enter') {
      entered = true
      enter()
    }
  })

  // The hold budget covers the case the kernel never settles: without it a boot
  // that neither activates the roster nor renders a failure report would trap
  // the user on a decorative screen.
  globalThis.setTimeout(function () {
    if (parts.root.getAttribute('data-state') === 'leaving') return
    if (namespace.bootedAt !== null) return
    attention('启动较慢，点击继续')
  }, HOLD_MS)

  // `?dshbootdiag=1` turns the hint line into a live readout of the clip and the
  // audio-policy outcome. Reported from the page itself so a stuck screen can be
  // diagnosed from a screenshot instead of a description: the fields say whether
  // frames are flowing, whether sound was allowed, and why not.
  function startDiagnostics() {
    if (globalThis.location.search.indexOf('dshbootdiag=1') < 0) return
    setInterval(function () {
      if (parts.root.getAttribute('data-state') === 'leaving') return
      var video = parts.video()
      var text = 'diag shown=' + (video.getAttribute('data-shown') || '-')
        + ' rs=' + video.readyState
        + ' muted=' + video.muted
        + ' t=' + (video.currentTime || 0).toFixed(1)
        + ' dur=' + (Number.isFinite(video.duration) ? video.duration.toFixed(1) : '?')
        + ' paused=' + video.paused
        + ' ended=' + video.ended
        + ' done=' + (clipDone ? 1 : 0)
        + ' boot=' + (namespace.bootedAt === null ? 0 : 1)
        + ' tail=' + (namespace.tailEntered ? 1 : 0)
        + ' clip=' + (cache.current ? cache.current.name : '-')
        + ' fail=' + (namespace.failures || '-')
        + ' fade=' + (FADE_MS / 1000) + 's'
        + ' stall=' + (namespace.lastStall ? Math.round((Date.now() - namespace.lastStall) / 1000) + 's ago' : '-')
        + ' err=' + (video.error ? video.error.code : '-')
        + ' audio=' + (namespace.audioBlocked === null ? 'ok' : namespace.audioBlocked)
      parts.hint.textContent = text
    }, 800)
  }

  /**
   * Repaint the Windows caption in this screen's colours.
   *
   * Appending to the head is the whole mechanism twice over: the rule restyles the
   * preload's probe, and the head mutation is what makes the preload measure again
   * and push the new colours to the caption.
   */
  function applyCaptionTokens() {
    if (captionDone || captionStyle) return
    captionStyle = document.createElement('style')
    captionStyle.setAttribute('data-dshba-caption', '')
    captionStyle.textContent = CAPTION_CSS
    document.head.appendChild(captionStyle)
  }

  /** Hand the caption back. Removing the rule is what makes the preload measure again. */
  function restoreCaptionTokens() {
    captionDone = true
    if (captionStyle && captionStyle.parentNode) captionStyle.parentNode.removeChild(captionStyle)
    captionStyle = null
  }

  function mount() {
    document.head.appendChild(parts.css)
    ;(document.body || document.documentElement).appendChild(parts.root)
    applyCaptionTokens()
    observeProgress()
    observeFailure()
    startDiagnostics()

    // Everything below releases the hand-off, so every way this can stop must
    // release it too. Two of them did not, and both left the only way in as a
    // click on a screen that otherwise looked alive:
    //
    //   - the manifest never answering (a busy or hung request), so no clip is
    //     ever chosen and nothing ever ends;
    //   - a pool that is genuinely empty, which the early `return` below used to
    //     take silently.
    //
    // The pool is a decoration; being unable to list it is not a reason to hold
    // someone in front of it.
    var releaseWithoutClip = function (message) {
      if (cache.loaded || clipDone) return
      cache.loaded = true
      if (message && parts.root.getAttribute('data-state') !== 'leaving') {
        parts.hint.textContent = message
      }
      clipDone = true
      maybeEnter()
    }
    var manifestWindow = globalThis.setTimeout(function () {
      releaseWithoutClip('素材清单没有回应 · 就绪后自动进入')
    }, 10000)

    // Discover the pool, then play one clip. Loading is deferred until the
    // manifest answers so a page load without clips shows only the gradient.
    fetch(cfg.manifest, { cache: 'no-store' })
      .then(function (response) { return response.ok ? response.json() : { clips: [] } })
      .then(function (payload) {
        globalThis.clearTimeout(manifestWindow)
        var published = payload && Array.isArray(payload.clips) ? payload.clips : []
        // The pool the user curated in the settings card. Switching every clip off
        // would leave nothing to play and therefore nothing to trigger the
        // hand-off, so a filter that would empty the pool is dropped rather than
        // obeyed — the same fallback the Host keeps, repeated here because this
        // manifest is the only input this script has.
        var clips = published.filter(function (clip) { return clip.enabled !== false })
        if (clips.length === 0) clips = published
        if (clips.length === 0) {
          releaseWithoutClip('素材池是空的 · 就绪后自动进入')
          return
        }
        cache.loaded = true

        // Entering must be available from the first frame: a slow boot is exactly
        // when a user wants to know they can skip ahead.
        if (!namespace.failed) parts.hint.textContent = HINT_SOUND

        // Try clips until one really plays. A pool entry can fail for reasons
        // outside this plugin's control (an unsupported codec, a truncated
        // download), and one failure must not leave the screen on a bare gradient
        // while the pool still holds playable clips.
        var preferred = pickClip(clips)
        var order = [preferred].concat(shuffled(clips).filter(function (clip) {
          return clip.name !== preferred.name
        }))

        var settled = false
        var attempt = 0
        // The retry lives in the outer scope so the entering gesture can reach it;
        // this flag records why the clip is silent, for the hint to report.
        namespace.audioBlocked = SOUND_ON ? null : 'disabled'

        /**
         * Start a clip. Sound first, muted only as the fallback.
         *
         * Chromium permits sound only with a user gesture, but it also counts
         * prior interaction with the origin (sticky activation) and its own media
         * engagement record, so an unmuted play() genuinely succeeds on a
         * regularly used origin. Trying muted first, as this screen used to, threw
         * that away: it silenced the clip on every machine, including the ones
         * where sound was already allowed.
         * @param video - the element to start.
         * @param onPlaying - called once frames are flowing.
         * @param onBlocked - called when neither unmuted nor muted playback starts.
         */
        function startClip(video, onPlaying, onBlocked) {
          var decided = false
          var settle = function (fn) { return function () { if (decided) return; decided = true; fn() } }
          var playing = settle(onPlaying)
          var blocked = settle(onBlocked)
          var attemptPlay = function (muted, onRefused) {
            video.muted = muted
            var played
            try {
              played = video.play()
            } catch (error) {
              onRefused()
              return
            }
            if (played && typeof played.then === 'function') {
              played.then(playing, onRefused)
              return
            }
            playing()
          }
          var fallback = function () {
            namespace.audioBlocked = 'refused'
            audioRetry = function () {
              attemptPlay(false, function () {/* stays silent */})
            }
            attemptPlay(true, blocked)
          }
          // Sound is off for good: skip the unmuted attempt and the retry entirely
          // rather than try them and have them refused. Muted autoplay is also the
          // one start the audio policy always permits, so this path cannot land in
          // `blocked` for a policy reason.
          if (!SOUND_ON) {
            namespace.audioBlocked = 'disabled'
            audioRetry = null
            attemptPlay(true, blocked)
            return
          }
          // The unmuted attempt may neither resolve nor reject on a slow or
          // conflicting load, and waiting on it forever is what leaves the screen
          // on a bare gradient. A short window bounds it; the muted retry always
          // starts because muted autoplay is what the policy permits.
          var soundWindow = globalThis.setTimeout(fallback, 1200)
          var settleWindow = function () { globalThis.clearTimeout(soundWindow) }
          var unmutedPlaying = function () { settleWindow(); playing() }
          var unmutedRefused = function () { settleWindow(); fallback() }
          video.muted = false
          var played
          try {
            played = video.play()
          } catch (error) {
            played = undefined
          }
          if (played && typeof played.then === 'function') played.then(unmutedPlaying, unmutedRefused)
          else if (played === undefined) unmutedRefused()
          else unmutedPlaying()
        }

        // Which clips failed and why, so a stuck screen can say so itself. Reported
        // in the hint line and in the diagnostic readout rather than only in the
        // console: this screen is the one thing the user is looking at when it goes
        // wrong, and a screenshot of its own sentence is worth more than a
        // description of the symptom.
        var failures = []
        var noteFailure = function (clip, reason) {
          failures.push(clip.name + '(' + reason + ')')
          namespace.failures = failures.join(' ')
        }

        var tryNext = function () {
          if (settled || attempt >= order.length) {
            // Every candidate failed. The gradient and the hint remain, so the
            // screen still works; only the artwork is missing. The hand-off is
            // still released, because a pool that cannot play anything is not a
            // reason to hold a user in front of a gradient — they can also leave
            // at any time with a press.
            if (!settled && parts.root.getAttribute('data-state') !== 'leaving') {
              parts.hint.textContent = failures.length === 0
                ? '片段无法播放 · 就绪后自动进入'
                : '片段无法播放 ' + failures.join(' ') + ' · 就绪后自动进入'
            }
            clipDone = true
            maybeEnter()
            return
          }
          var clip = order[attempt]
          attempt += 1
          cache.current = clip

          // A fresh element per attempt: a failed source leaves an element in an
          // error state that a later load on the same element does not clear.
          var video = document.createElement('video')
          var current = parts.video()
          video.className = current.className
          // See the note in build(): a looping clip never reports its own end,
          // and the end of the clip is what triggers the hand-off.
          video.loop = ENTER_MODE === 'click'
          video.playsInline = true
          video.setAttribute('playsinline', '')
          video.preload = 'auto'
          if (current.parentNode) current.parentNode.replaceChild(video, current)
          parts.replaceVideo(video)

          var advance = globalThis.setTimeout(function () {
            // The clip was given its six seconds and never showed anything. Say so
            // before moving on: "skipped silently" is indistinguishable from "the
            // whole screen is broken" when all you can see is a gradient.
            noteFailure(clip, 'no-frame')
            tryNext()
          }, 6000)
          // Armed only for a clip whose duration cannot be known; see below.
          var endless = null
          var reveal = function () {
            if (settled) return
            settled = true
            globalThis.clearTimeout(advance)
            // The fade is driven by an inline style rather than a CSS rule: an
            // inline value cannot lose a specificity contest with anything else on
            // the page. Written only once a frame has actually been presented —
            // see whenFramePresents for why a resolved play() is not that moment.
            video.style.opacity = '1'
            video.setAttribute('data-shown', '1')
            // Only while the clip is still the thing being watched. Once it has
            // ended, the hint belongs to the hand-off — a late frame arriving after
            // the end must not overwrite "waiting for the kernel to be ready".
            if (!namespace.failed && !clipDone) {
              parts.hint.textContent = namespace.audioBlocked === null
                ? HINT_SOUND
                : HINT_SILENT
            }
          }
          // The watchdog above stays armed until this fires. That is the whole
          // point: a clip that starts but never paints must be skipped, not
          // waited on — and it says which one it was.
          whenFramePresents(video, reveal)
          video.addEventListener('error', function () {
            globalThis.clearTimeout(advance)
            globalThis.clearTimeout(endless)
            var code = video.error ? video.error.code : 0
            noteFailure(clip, 'err' + String(code))
            tryNext()
          }, { once: true })

          // The clip's own end is the hand-off signal, and it works for any
          // length: a 8-second clip and a 15-second clip each fire this when they
          // are done, so nothing here has to know or care how long the clip is.
          video.addEventListener('ended', function () {
            globalThis.clearTimeout(endless)
            namespace.clipEndedAt = Date.now()
            clipDone = true
            maybeEnter()
          }, { once: true })

          // ...but a clip whose length is unknown never reports an end at all.
          // `duration` is Infinity for a MediaRecorder WebM, and `ended` on such
          // an element may never fire, so an unbounded wait would hold the screen
          // indefinitely. This is the only fallback for that case, and it is
          // armed only when the duration is genuinely unknowable.
          video.addEventListener('loadedmetadata', function () {
            if (Number.isFinite(video.duration)) return
            namespace.unknownLength = true
            endless = globalThis.setTimeout(function () {
              clipDone = true
              maybeEnter()
            }, ENDLESS_MS)
          }, { once: true })
          // A stall is the difference between "the clip ended" and "the clip is
          // waiting for bytes". Recording it is what makes a freeze reportable
          // instead of guessed at, and the diagnostic line prints it.
          video.addEventListener('stalled', function () {
            namespace.lastStall = Date.now()
          })
          video.addEventListener('waiting', function () {
            namespace.lastStall = Date.now()
          })

          video.src = clip.src

          startClip(video, function () {
            // Playback started. Deliberately does NOT reveal: leaving the paused
            // state is not the same fact as having a frame to show, and revealing
            // here is what used to disarm the watchdog before any picture existed.
          }, function () {
            // Neither unmuted nor muted playback started: move to the next clip.
            globalThis.clearTimeout(advance)
            globalThis.clearTimeout(endless)
            tryNext()
          })

          // Aim the dissolve at the clip's last frame.
          //
          // The exit used to begin when the clip ENDED, which meant the picture sat
          // on a frozen final frame for the whole fade. What is wanted is a
          // crossfade: the clip starts dissolving into the app FADE_MS before it
          // is over, so a 15-second clip dissolves from 13s and both are done at
          // 15s. That needs the clip's remaining time, not a fixed schedule.
          //
          // The trigger is a per-frame check rather than one timer computed at
          // load time, because a single scheduled timeout drifts the moment
          // playback stalls — and "lands exactly on the last frame" is the entire
          // property being bought here.
          var tailEntered = false
          namespace.tailEntered = false
          var tailCheck = function () {
            if (tailEntered || !settled) return
            if (parts.video() !== video) return
            if (parts.root.getAttribute('data-state') === 'leaving') { tailEntered = true; return }
            // An unknown length is the ENDLESS timer's problem, not this one.
            if (!Number.isFinite(video.duration)) return
            // Too short to carry the dissolve: it would have to start before the
            // picture is even up. Those play out and fade afterwards instead.
            if (video.duration * 1000 < TAIL_MIN_MS) return
            if (video.ended || video.paused) return
            // The dissolve is the moment the app becomes visible, so it may only
            // start once the app can actually be shown. A slow kernel simply keeps
            // the clip playing past its end; `maybeEnter` takes over from there.
            if (namespace.bootedAt === null) return
            var remaining = (video.duration - video.currentTime) * 1000
            if (remaining > FADE_MS || remaining <= 0) return
            tailEntered = true
            namespace.tailEntered = true
            enter(remaining, true)
          }
          var tailFrame = function () {
            tailCheck()
            if (!tailEntered && parts.video() === video) nextFrame(tailFrame)
          }
          // Only `tail` mode dissolves against the clip's own clock. The other two
          // have nothing to aim at, so the loop is never started at all rather
          // than started and immediately declined.
          if (ENTER_MODE === 'tail') {
            nudgeTail = tailCheck
            nextFrame(tailFrame)
            // The backstop for the state rAF cannot cover: a background tab
            // throttles frames, and media time keeps moving while they are gone.
            video.addEventListener('timeupdate', tailCheck)
          }
        }

        tryNext()
      })
      .catch(function () { /* an unreachable pool leaves the gradient */ })
  }

  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
})()
