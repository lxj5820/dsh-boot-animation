// dsh-boot-animation — Host half.
//
// Two contributions, both required for the overlay to exist at all:
//
//  1. a webserver route serving the clip pool (bytes from ./assets/videos), a
//     same-origin manifest naming them, and one on-demand route that moves a
//     clip's index table to the front of its file (the card's 优化 button), and
//  2. an index injection whose head row installs the screen before the shell
//     boots.
//
// The head row is the whole reason this is a plugin rather than a client
// component: the kernel constructs its own boot page synchronously in
// `AppWebEntry`'s constructor, which runs from the shell module script, so only a
// parser-blocking index row executes early enough to pre-empt it.
//
// Settings are the third contribution, and under DSH 0.2.0-rc.2 they are
// DECLARED rather than registered. The Host `settings` service has no
// `register(ns, schema)` method any more: a settings namespace IS a plugin entry.
// `@deepseek-ai/dsh-settings` describes every running entry whose resolved export
// carries a `Config` schema — `entry.fiber.runtime.Config`, filled from this
// module's `Config` export by `RegistryService.plugin` — keyed by the entry id in
// the profile patch, here `boot-animation`. The browser half pairs with that same
// string, through the client `configForms` service, which exposes only the
// namespaces the Host actually serves. Two consequences are load-bearing:
//
//   * `Config` must be a property of the module namespace object, so the schema
//     package has to resolve at module-evaluation time. The previous lazy import
//     degraded to "no settings card"; a static import fails the whole module,
//     which is why `@deepseek-ai/schemastery` is a peer dependency — the host
//     supplies it — and never a vendored copy.
//   * `describe()` reports only an entry whose Config projects a non-empty form,
//     and that projection keeps only fields marked `.volatile()`. A schema with
//     no live field is invisible to the settings page; see `LIVE_CAPABLE`.
//
// The patch id is therefore part of the contract: renaming the `- insert:` id in
// cordis.patch.yml moves the namespace and silently orphans the browser card,
// whose key is the same string.

import { readdir, stat, open, mkdir } from 'node:fs/promises'
import { createReadStream, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { basename, extname, join, resolve, sep } from 'node:path'
import { optimizeInPlace } from './src/remux.js'
import { createIdleProbe } from './src/idle-probe.js'
import z from '@deepseek-ai/schemastery'

/**
 * Where the plugin writes a plain-text startup trace.
 *
 * A FILE, not the console. The desktop app shows no console and the user cannot open devtools, so
 * every diagnostic that only reached `console.log` has been invisible to them — which is why the
 * last several rounds of "verified the code is correct" could not explain a boot screen that never
 * appeared. This file is the only channel through which the Host half can tell the user what it
 * actually did.
 *
 * It lives beside the plugin so it is easy to find, and it is truncated once per process.
 */
const TRACE_PATH = fileURLToPath(new URL('./assets/startup-trace.log', import.meta.url))

/**
 * Append one line to the startup trace.
 *
 * Best effort by design: a trace that cannot be written must never affect the injection it is
 * describing.
 * @param {string} line - what happened.
 */
function trace(line) {
  try {
    appendFileSync(TRACE_PATH, `${new Date().toISOString()}  ${line}\n`, 'utf8')
  } catch {
    /* the trace is diagnostic only */
  }
}

/**
 * Absolute path of the pre-boot screen source.
 *
 * The script is read per index render rather than once at module load. Reading it
 * at load time would pin the served script to whatever the file held when the
 * process started, so editing a label or the exit fade would require restarting
 * dsh — the one operation this plugin's whole design tries to avoid asking for.
 */
const BOOT_SCREEN_PATH = fileURLToPath(new URL('./src/boot-screen.js', import.meta.url))

/**
 * Absolute path of the media renderer module.
 *
 * A separate file rather than a section of the screen, because the renderers are
 * the part with per-kind knowledge and the screen is the part with the timeline.
 * Keeping them apart is what lets `verify-renderers.mjs` exercise the media
 * contract in a minimal DOM without booting the whole overlay.
 */
const RENDERERS_PATH = fileURLToPath(new URL('./src/renderers.js', import.meta.url))

/**
 * Absolute path of the screensaver module.
 *
 * Injected like the screen and the renderers rather than bundled into the client
 * half, for a reason that is about LIFETIME: the screensaver has to keep working for
 * the whole session, and the client bundle can fail to materialize (a missing
 * baseline module, a roster that never activates) without the screensaver having
 * anything to do with it. An injected script has no such dependency — it runs on the
 * page, on its own.
 */
const SCREENSAVER_PATH = fileURLToPath(new URL('./src/screensaver.js', import.meta.url))

/**
 * The media kinds a pool entry can be, and what each one MEANS to the screen.
 *
 * `kind` is the whole abstraction: the browser half picks a renderer by it, and
 * the timeline questions ("does this end?", "can it make a sound?") are answered
 * from it rather than from the file. The extension decides the kind, because
 * that is the only signal available without decoding the file:
 *
 *   - `video`    has a duration and fires `ended`; may carry audio. The ONLY kind
 *                that can drive the tail dissolve or unlock sound.
 *   - `image`    static, no timeline. Shows until something else takes it away.
 *   - `animated` loops by itself (GIF/WebP) and never reports an end, so it is
 *                treated as unbounded and always gets a time bound.
 *   - `live2d`   a model directory (`*.model3.json`), rendered through an adapter.
 *                Also no reliable end, so also bounded.
 *
 * A still `.webp` is indistinguishable from an animated one by extension, which
 * is why `animated` is a rendering strategy and not a promise that it moves: a
 * still WebP under it simply shows and sits there, which is the correct outcome
 * for the bound it gets.
 */
const MEDIA_TYPES = {
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.m4v': { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.avif': { kind: 'image', mime: 'image/avif' },
  '.gif': { kind: 'animated', mime: 'image/gif' },
  '.webp': { kind: 'animated', mime: 'image/webp' },
}

// SVG is deliberately absent. It is the one image format that can carry script
// and external references, and this route serves bytes straight into a page that
// is already the boot screen; the convenience is not worth the surface.

/** The extension a Live2D model's entry file carries. */
const LIVE2D_SUFFIX = '.model3.json'

/**
 * The two pools, and what each one is FOR.
 *
 * They are separate directories rather than one pool with a flag, because the two
 * have different jobs and different lifetimes: a boot clip is watched once and
 * hands over, while screensaver media is what covers the app after the user has
 * been idle. A single pool would force the rotation to guess which of the two a
 * file was meant for, and a user adding a screensaver loop would silently change
 * their boot rotation.
 *
 * The key names are part of the wire contract: they travel in the manifest URL, the
 * bytes prefix, the preview request and the reveal request. `verify-entry.mjs`
 * asserts the route table they produce, so renaming one is a change to the routes.
 */
const POOLS = {
  clips: { dir: 'assets/videos', label: '片头' },
  screensaver: { dir: 'assets/screensaver', label: '屏保' },
}

/** Route prefix both the manifest and the media bytes live under. */
const ROUTE = '/plugins/dsh-boot-animation'

/**
 * The values the screen runs with when the applied config does not carry one.
 *
 * With a `Config` schema present these are unreachable in practice: Cordis
 * validates the raw profile row against the schema before `apply` runs, so every
 * field arrives already defaulted and an absent settings document and an empty
 * one resolve identically. They are kept anyway, because the fallback must not
 * depend on the schema having been resolvable — a profile that cannot load the
 * schema package still boots, and this plugin then still serves its clips.
 */
const DEFAULT_SETTINGS = {
  /**
   * Whether the screen is injected at all. Off restores DSH's own boot page: the
   * rows are simply not added, so no overlay, no clip request and no script run.
   */
  enabled: true,
  /** How long the dissolve into the app takes. */
  fadeMs: 2000,
  /** When the hand-off happens: see ENTER_MODES. */
  enterMode: 'tail',
  /** Clip file names excluded from the pool by the user. */
  disabledClips: [],
  /**
   * Whether the screensaver runs at all.
   *
   * The screensaver covers the app after the user has been idle for a while, and
   * any real input brings it back. OFF BY DEFAULT, and that is deliberate rather
   * than cautious: this feature TAKES OVER THE SCREEN, so a user who never asked
   * for it would have the app covered while they were reading. A feature that
   * interrupts has to be opted into.
   */
  screensaverEnabled: false,
  /**
   * How long the app must be idle before the screensaver appears, in milliseconds.
   *
   * Bounded at both ends: below the lower bound it would fire while someone is
   * still reading a sentence, and above the upper bound it would never fire in a
   * normal session at all.
   */
  screensaverIdleMs: 180000,
  /**
   * Whether the screensaver exit plays the break-into-pixels effect.
   *
   * Off falls back to a plain dissolve, which is also what a user who has asked
   * their system for reduced motion gets regardless of this setting.
   */
  screensaverBreakEffect: true,
  /**
   * Which exit effect the screensaver plays when it is dismissed.
   *
   * `random` picks one per dismissal, which is the default: the effect is a flourish, and the
   * same flourish every time stops being one. The other three name a specific effect for
   * somebody who has picked a favourite.
   *
   * The value is validated against this list rather than trusted, because it arrives from the
   * settings document and an unknown name must not leave the screensaver with no exit at all —
   * see `breakStyleOf()` in src/screensaver.js, which falls back to the plain dissolve.
   */
  screensaverBreakStyle: 'random',
  /**
   * Whether the screensaver shows its "click or press any key" line.
   *
   * Defaults ON because movement deliberately does NOT dismiss the layer — without a
   * line saying so, a user who nudges the mouse and sees nothing happen reads it as a
   * freeze. Somebody who already knows the gesture can turn it off, and nothing about
   * the dismissal changes either way.
   */
  screensaverHint: true,
  /**
   * Which pointer-reactive effect plays on the screensaver, or `none`.
   *
   * `none` is the default and keeps the screensaver exactly as it was: a still layer that only
   * responds to a click. Every other value draws a light decoration that follows the pointer, which
   * is possible ONLY because movement deliberately does not dismiss the layer — the pointer can
   * travel across it without tearing it down.
   *
   * `random` picks one per appearance, like the exit effect.
   */
  screensaverPointerEffect: 'none',
  /**
   * Whether the screensaver's media may make a sound.
   *
   * OFF by default, and that is the point rather than caution: this layer covers the screen
   * while nobody is looking at it, so a video with a soundtrack would play to an empty room
   * and startle whoever walks back in. The switch exists because a user may want their own
   * loop audible — it is their machine and their clip — but it must be chosen, not inherited.
   *
   * A video is the only kind that can honour this; an image, an animated image and a Live2D
   * model have no audio path at all, so the switch is simply inert for them.
   */
  screensaverSound: false,
  /**
   * How loud the screensaver plays, 0..1.
   *
   * A separate number rather than a fixed level, because the layer plays a clip the user supplied
   * and nobody can predict how hot its soundtrack is mixed: one loop is inaudible at 30% and
   * another is overpowering there. It only applies while `screensaverSound` is on — with the
   * switch off the element stays muted and this number is never read.
   *
   * 0.35 rather than 1.0 is the default. The layer is background by design, and a first
   * experience that is too loud is the one people act on: they switch the whole feature off
   * rather than turn it down.
   */
  screensaverVolume: 0.35,
  /**
   * How long each entry stays on screen before the next one takes over, in milliseconds.
   *
   * 0 means "do not rotate": the layer picks one entry per appearance and keeps it until the user
   * comes back, which is how every version before this one behaved. A non-zero value makes a
   * screensaver left up for a long time cycle through the pool, so a single loop is not the only
   * thing on screen for an hour.
   *
   * The default is 0 rather than, say, 30 seconds: rotation CHANGES what an existing profile does,
   * and a feature that starts animating on somebody's machine uninvited is the kind of change
   * that gets the whole plugin switched off. It is opted into.
   *
   * Bounded below at 5 seconds because anything faster is a slideshow rather than a screensaver,
   * and above at 10 minutes because a rotation nobody lives long enough to see is not a feature.
   */
  screensaverRotateMs: 0,
  /** Screensaver file names excluded from its pool by the user. */
  disabledScreensaver: [],
  /**
   * Whether the clip may make a sound at all.
   *
   * On, the screen tries to play unmuted and offers its sound button as the
   * gesture the audio policy asks for. Off, the screen is silenced for good: no
   * unmuted attempt, no sound button and no way to re-enable audio from the
   * overlay. Defaults to on so an existing profile behaves exactly as before.
   */
  sound: true,
  /**
   * Whether a pointer press enters immediately.
   *
   * The screen normally spends the first press unlocking audio (Chromium grants
   * sound only to a gesture, and the entering gesture cannot also be the unlock)
   * and the second press leaving. On, the first press leaves — the shortcut a
   * user wants once the clip has no sound to offer, or when they simply do not
   * care to hear it.
   */
  clickToEnter: false,
  /**
   * Whether the bottom hint line is drawn.
   *
   * Off leaves the title and the progress bar in place and only hides the
   * sentence that says what a press does, for a screen judged to be better
   * without instructions on it.
   */
  showHint: true,
}

/** The accepted `enterMode` values, in the order the browser card presents them. */
const ENTER_MODES = ['tail', 'end', 'click']

/**
 * The accepted `screensaverBreakStyle` values.
 *
 * `random` first, because it is the default and the card shows them in this order. The other
 * three are the effects that survived selection; each names an implementation in
 * src/screensaver.js. This list is the single place a new effect has to be registered — the
 * schema, the validated reader and the card all read it.
 */
const BREAK_STYLES = ['random', 'particles', 'fall', 'glitch']

/**
 * The accepted `screensaverPointerEffect` values.
 *
 * `none` first: it is the default, and the card shows them in this order. `random` picks per
 * appearance. The other three name implementations in src/screensaver.js, and this list is the one
 * place a new one has to be registered.
 */
const POINTER_EFFECTS = ['none', 'random', 'ripples', 'attract', 'lens']

/**
 * Whether the resolved schemastery can mark a Config field live-editable.
 *
 * `.volatile()` is what makes `dsh-settings` project a field into the form the
 * settings page renders: `volatileForm()` keeps only fields with `meta.volatile`,
 * and `describe()` drops every entry whose projected form is empty. The kernel's
 * copy (3.18.4, inside the app payload) has the method. An older copy linked next
 * to this package — the 3.18.1 build that sits beside a workspace checkout — does
 * not, and calling it there would throw while this module is being evaluated,
 * taking the routes and the boot screen down with the settings card.
 *
 * So the method is probed once and the schema degrades to non-volatile when it is
 * absent. The cost is a hidden settings card; `apply` warns with the fix.
 */
const LIVE_CAPABLE = typeof z.boolean().volatile === 'function'

/** Mark one Config field live-editable, where the schema library allows it. */
function live(schema) {
  return LIVE_CAPABLE ? schema.volatile() : schema
}

/**
 * The well-known key cosmokit puts on a live config reference.
 *
 * `.volatile()` does not yield the value: it yields a stable reference whose
 * `get()` answers the current immutable snapshot, identified across ESM/CJS
 * copies of the library by this global-registry symbol rather than by identity.
 * A plugin therefore reads a volatile field through `get()`, exactly as the
 * shipped Host plugins do (`dsh-bash-local`: `config.timeoutMs.get()`).
 *
 * The reference is also what lets a stored edit take effect without a restart:
 * when only volatile values differ, `@deepseek-ai/cordis-plugin-loader` commits
 * the new snapshot into the SAME reference (`updateVolatile`) and emits
 * `loader/volatile-update` instead of restarting the fiber. `apply` is not run
 * again, so a value read per index render is always the stored one.
 */
const VOLATILE_REF = Symbol.for('cosmokit.volatile.write')

/** Whether a config value is a live reference rather than a plain snapshot. */
function isLive(value) {
  return typeof value === 'object' && value !== null && VOLATILE_REF in value
}

/**
 * Read one applied-config field.
 *
 * The field is a live reference when `Config` declared it volatile — the normal
 * case — and a plain value when the config arrived without schema resolution,
 * which is the same pair of shapes `dsh-settings`' own `plainConfig()` handles.
 * An absent field stays absent, leaving the per-field defaulting to its caller.
 * @param config - the applied config, possibly undefined.
 * @param key - field name.
 * @returns the current value, or undefined when the field is absent.
 */
function readField(config, key) {
  const value = config?.[key]
  return isLive(value) && typeof value.get === 'function' ? value.get() : value
}

/**
 * This entry's Host configuration schema.
 *
 * The namespace is not named here because it is no longer named anywhere on this
 * side: it is the entry id the profile patch mounts this row under,
 * `- insert: id: boot-animation`. `src/client.js` spells that same string in
 * `SETTINGS_NAMESPACE`, and nothing else checks that the two agree.
 *
 * The field names, defaults and bounds are the ones the removed
 * `settings.register(SETTINGS_NS, schema)` call declared, plus the three
 * behaviour switches added later (sound, clickToEnter, showHint), so an absent
 * settings document and an empty one still behave identically.
 *
 * Every field is volatile, because that is the only class the settings service
 * serves: it projects volatile fields and nothing else. The price is that the
 * applied config carries live references rather than plain values — see
 * `readField`.
 */
export const Config = z.object({
  enabled: live(z.boolean().default(DEFAULT_SETTINGS.enabled)),
  fadeMs: live(z.number().min(300).max(5000).default(DEFAULT_SETTINGS.fadeMs)),
  enterMode: live(z.union([...ENTER_MODES]).default(DEFAULT_SETTINGS.enterMode)),
  disabledClips: live(z.array(z.string()).default([])),
  sound: live(z.boolean().default(DEFAULT_SETTINGS.sound)),
  clickToEnter: live(z.boolean().default(DEFAULT_SETTINGS.clickToEnter)),
  showHint: live(z.boolean().default(DEFAULT_SETTINGS.showHint)),
  screensaverEnabled: live(z.boolean().default(DEFAULT_SETTINGS.screensaverEnabled)),
  // Bounded at both ends rather than merely positive: a threshold under 30s would
  // cover the screen while somebody is still reading, and one over an hour would
  // never fire in a normal session.
  screensaverIdleMs: live(z.number().min(30000).max(3600000)
    .default(DEFAULT_SETTINGS.screensaverIdleMs)),
  screensaverBreakEffect: live(z.boolean().default(DEFAULT_SETTINGS.screensaverBreakEffect)),
  // Which exit effect plays. An enum, not a string, so an unknown value is rejected by the
  // schema rather than reaching the screensaver and silently disabling the exit.
  screensaverBreakStyle: live(z.union([
    z.const('random').description('随机'),
    z.const('particles').description('粒子消散'),
    z.const('fall').description('重力下坠'),
    z.const('glitch').description('Glitch 宽带位移'),
  ]).default(DEFAULT_SETTINGS.screensaverBreakStyle)),
  // Whether the screensaver shows the "click or press any key" line.
  //
  // It exists because movement does NOT dismiss the layer, which looks like a freeze unless
  // something says otherwise — so it defaults ON. Turning it off is a deliberate choice by
  // somebody who knows the gesture, and the click still works exactly the same.
  screensaverHint: live(z.boolean().default(DEFAULT_SETTINGS.screensaverHint)),
  // Which pointer-reactive decoration follows the mouse while the screensaver is up. An enum for
  // the same reason as the exit style: an unknown value must be rejected here rather than reaching
  // the screensaver and silently drawing nothing.
  screensaverPointerEffect: live(z.union([
    z.const('none').description('不显示'),
    z.const('random').description('随机'),
    z.const('ripples').description('水波涟漪'),
    z.const('attract').description('星屑吸附'),
    z.const('lens').description('菱形涟漪'),
  ]).default(DEFAULT_SETTINGS.screensaverPointerEffect)),
  disabledScreensaver: live(z.array(z.string()).default([])),
  // Whether the screensaver's media may make a sound. OFF by default: this layer covers the
  // screen while nobody is looking, so a soundtrack would play to an empty room.
  screensaverSound: live(z.boolean().default(DEFAULT_SETTINGS.screensaverSound)),
  // How loud the screensaver plays, 0..1. Bounded at the top rather than allowing 1.5: the
  // element's own volume is capped at 1 by the HTML spec, so a larger number would be silently
  // clamped and the slider would appear to do nothing at its top end.
  screensaverVolume: live(z.number().min(0).max(1).default(DEFAULT_SETTINGS.screensaverVolume)),
  // How long each entry stays up before the next one takes over. 0 = no rotation, which is the
  // behaviour every version before this one had; a non-zero value cycles the pool.
  screensaverRotateMs: live(z.number().min(0).max(600000).default(DEFAULT_SETTINGS.screensaverRotateMs)),
})

/** Package name the loader mounts this row as. */
export const name = 'dsh-boot-animation'

/** Services this half consumes. */
export const inject = ['webServer']

/**
 * The package root, resolved from this module rather than the process cwd.
 *
 * `POOLS` names its directories relative to THIS, not relative to `assets/`:
 * naming them `assets/videos` against a root that was already `assets` resolved
 * to `assets/assets/videos`, which is why every pool came back empty while the
 * manifests still answered 200.
 */
const packageRoot = fileURLToPath(new URL('.', import.meta.url))

/** MIME type served for one media file. */
function contentType(file) {
  const name = file.toLowerCase()
  if (name.endsWith(LIVE2D_SUFFIX)) return 'application/json; charset=utf-8'
  return MEDIA_TYPES[extname(name)]?.mime ?? 'application/octet-stream'
}

/** The media descriptor for a file, or undefined when it is not a supported kind. */
function mediaTypeOf(file) {
  const name = file.toLowerCase()
  if (name.endsWith(LIVE2D_SUFFIX)) return { kind: 'live2d', mime: 'application/json; charset=utf-8' }
  return MEDIA_TYPES[extname(name)]
}

/**
 * Whether the movie box precedes the media data.
 *
 * A player cannot decode a frame until it has read `moov`, so a file whose
 * `moov` sits at the end must be fetched almost in full before anything appears
 * — the usual reason a clip shows nothing but black for a while. This is reported
 * to the browser card, which is where a user can act on it (tools/faststart.mjs
 * rewrites such a file losslessly).
 *
 * The header window is 64 KiB because the order of the first two boxes is NOT the
 * answer: all three clips in this pool carry a ~21 KiB `uuid` metadata box before
 * the media data, so a 1 KiB read saw `ftyp, uuid` and returned no verdict at all.
 * @param absolute - resolved clip path.
 * @returns true when `moov` comes first, false when `mdat` does, undefined when
 *   neither box is found within the header window.
 */
async function readFaststart(absolute) {
  let handle
  try {
    handle = await open(absolute, 'r')
    const head = Buffer.alloc(65536)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    let offset = 0
    while (offset + 8 <= bytesRead) {
      const type = head.toString('latin1', offset + 4, offset + 8)
      if (type === 'moov') return true
      if (type === 'mdat') return false
      const size = head.readUInt32BE(offset)
      if (size < 8) break
      offset += size
    }
    return undefined
  } catch {
    // An unreadable header is not a reason to drop the clip from the pool; the
    // card simply shows no optimisation verdict for it.
    return undefined
  } finally {
    await handle?.close()
  }
}

/**
 * List one pool's entries, newest first.
 *
 * A pool holds two shapes of thing, and both are entries:
 *
 *   - a flat media file at the top level (`1.mp4`, `blink.gif`, `pose.png`);
 *   - a DIRECTORY holding a Live2D model, identified by the `.model3.json` inside
 *     it. The directory is the entry, not the JSON: a model is a set of files
 *     (the model3.json, the `.moc3`, one or more textures) whose internal
 *     references are relative, so they have to travel together and be served from
 *     one prefix. Publishing the JSON alone would give the browser a manifest it
 *     could fetch and not use.
 *
 * The modification time travels with each path because the manifest publishes it
 * as the entry's revision: the bytes route caches immutably under a filename that
 * carries no revision of its own, so a file replaced in place must be requested
 * under a new URL or the browser keeps serving the year-old copy it holds. For a
 * model directory the newest mtime inside it is the revision, so editing any part
 * of the model — a texture, the moc3, the JSON — invalidates the whole entry.
 *
 * @param dir - absolute pool directory.
 * @param route - route segment this pool's bytes are served under.
 * @returns every servable entry with its revision stamp and card metadata.
 */
async function listPool(dir, route) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    // A missing directory is an empty pool, not a failure: the overlay then has
    // nothing to play and the plugin must stay invisible rather than break boot.
    if (error?.code === 'ENOENT') return []
    throw error
  }

  /** Newest mtime under a path, following one level of directory. */
  async function newestMtime(path) {
    const info = await stat(path)
    if (!info.isDirectory()) return info.mtimeMs
    let newest = info.mtimeMs
    let children = []
    try {
      children = await readdir(path, { withFileTypes: true })
    } catch {
      return newest
    }
    for (const child of children) {
      try {
        const childInfo = await stat(join(path, child.name))
        if (childInfo.mtimeMs > newest) newest = childInfo.mtimeMs
      } catch {
        /* a file that vanished mid-scan simply does not contribute */
      }
    }
    return newest
  }

  const found = []
  for (const entry of entries) {
    const absolute = join(dir, entry.name)
    if (entry.isFile()) {
      const media = mediaTypeOf(entry.name)
      // Hidden and backup files are not pool entries. `originals/` (the pre-rewrite
      // copies) is a directory and therefore never reaches here, and the
      // `.faststart-work` scratch directory is skipped by the dot rule below.
      if (media === undefined || entry.name.startsWith('.')) continue
      const info = await stat(absolute)
      found.push({
        name: entry.name,
        rel: entry.name,
        kind: media.kind,
        dir: false,
        file: absolute,
        mtime: info.mtimeMs,
        bytes: info.size,
        faststart: media.kind === 'video' ? await readFaststart(absolute) : undefined,
      })
      continue
    }
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    // A directory is an entry only when it actually holds a model. This is also
    // what keeps `originals/` — a directory of pre-rewrite video copies — out of
    // the rotation, which `verify-tree-hygiene.mjs` relies on.
    //
    // `find` answers `undefined` when nothing matches, not `null`; testing for
    // `null` let every model-less directory through and then threw on `.name`,
    // which turned the whole clips manifest into a 500.
    let model
    try {
      const inside = await readdir(absolute, { withFileTypes: true })
      model = inside.find(child => child.isFile() && child.name.toLowerCase().endsWith(LIVE2D_SUFFIX))
    } catch {
      continue
    }
    if (!model) continue
    found.push({
      name: entry.name,
      rel: `${entry.name}/${model.name}`,
      kind: 'live2d',
      dir: true,
      file: join(absolute, model.name),
      mtime: await newestMtime(absolute),
      bytes: (await stat(join(absolute, model.name))).size,
      faststart: undefined,
    })
  }

  return found
    .map(entry => ({
      ...entry,
      // No `revision` field: the manifest publishes only `src`, and the revision it
      // needs is already the `?v=<mtime>-<bytes>` suffix that `src` carries. A second
      // copy of that number was computed and then never read by anything.
      src: `${route}/${entry.rel.split('/').map(encodeURIComponent).join('/')}`
        + `?v=${String(Math.round(entry.mtime))}-${String(entry.bytes)}`,
    }))
    .sort((left, right) => right.mtime - left.mtime)
}

/** Answer one JSON response. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Parse one `Range` header against a known length.
 * @param header - raw header value, if present.
 * @param size - complete resource length.
 * @returns inclusive byte range, or undefined for a full response.
 */
function parseRange(header, size) {
  if (typeof header !== 'string') return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return undefined
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return undefined
  if (rawStart === '') {
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return undefined
    return { start: Math.max(size - length, 0), end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return { unsatisfiable: true }
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isFinite(end) || end < start) return { unsatisfiable: true }
  return { start, end }
}

/**
 * Stream one media file, honouring range requests so the browser can seek and so
 * a repeated load does not re-download bytes it already holds.
 *
 * Images are served through the same path as video: `Range` on an image is
 * honoured the same way, which costs nothing and keeps one implementation. The
 * cache reasoning below is written for video because that is where it bit, but it
 * applies to every kind — an aborted request leaves a truncated body, and a
 * truncated image is exactly as broken as a truncated clip.
 * @param absolute - resolved file path on disk.
 * @param req - incoming request.
 * @param res - outgoing response.
 */
async function serveMedia(absolute, req, res) {
  const info = await stat(absolute)
  const type = contentType(absolute)
  const range = parseRange(req.headers.range, info.size)
  if (range?.unsatisfiable === true) {
    res.writeHead(416, { 'content-range': `bytes */${String(info.size)}` })
    res.end()
    return
  }

  // Nothing about a clip response may be stored, complete or not.
  //
  // The overlay replaces the media element when it hands over or skips on, which
  // aborts the in-flight request; whatever arrived is a TRUNCATED body. Any
  // directive that lets the browser keep it — `immutable`, or `no-cache` plus an
  // ETag — turns that into a poisoned cache entry: the next normal reload decodes
  // the fragment, and a clip whose `moov` sits at the end has no index in a
  // fragment, so it paints nothing while a faststart clip still plays. An ETag is
  // no defence, because it only ever claimed the FILE had not changed, never that
  // the copy in hand was complete — and answering `If-None-Match` with 304 is
  // precisely what made the browser confident in a fragment.
  //
  // The cost is that each page load streams the chosen clip again. These are local
  // files over loopback — a few tens of milliseconds — and it buys the only
  // guarantee that matters: what the player decodes is always the whole file.
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }

  // Streamed from disk rather than read whole and sliced. A browser playing a
  // clip issues many overlapping range requests, and reading a 10 MB file per
  // request holds the whole clip in memory on every one of them; the original
  // implementation did exactly that. Streaming also lets the response start
  // before the file is fully read, which is what keeps playback fed while the
  // element seeks into the parts it still needs.
  const from = range === undefined ? 0 : range.start
  const to = range === undefined ? info.size - 1 : range.end
  res.writeHead(range === undefined ? 200 : 206, {
    ...headers,
    'content-length': String(to - from + 1),
    ...(range === undefined ? {} : {
      'content-range': `bytes ${String(from)}-${String(to)}/${String(info.size)}`,
    }),
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(absolute, { start: from, end: to })
  stream.on('error', () => { res.destroy() })
  res.on('close', () => { stream.destroy() })
  stream.pipe(res)
}

/**
 * The backup directory every pool keeps its pre-rewrite copies in.
 *
 * `listPool` never publishes it — it holds media files, not a model, so the
 * "does it contain a `.model3.json`" rule excludes it. The bytes route refuses it
 * EXPLICITLY as well, because the two routes must agree on what a pool entry is
 * even if one of them is later relaxed: a backup directory is not part of the
 * pool's contract, and a pool's `originals/` directory is the one thing in it
 * that was never meant to be reachable over HTTP.
 */
const BACKUP_DIR = 'originals'

/**
 * Whether a directory is a pool ENTRY of the model kind.
 *
 * The single judge both halves of the contract use: `listPool` decides "this
 * directory is an entry" by looking for a `.model3.json` inside it, and the bytes
 * route must use the SAME rule rather than a rule of its own. Without it the route
 * only ever validated the LAST path segment's extension, so any subdirectory
 * became a servable namespace — a scratch pool served `/clips/notamodel/secret.json`
 * with a 200 even though `notamodel/` holds no model at all, which is exactly the
 * "general file server" outcome this file's own comment said the extension check
 * prevented.
 *
 * Read fresh on every request, deliberately. A cache keyed by directory would have
 * to answer "is this still a model entry" after a user adds or deletes a
 * `.model3.json`, and a stale answer either serves files out of a directory that is
 * no longer an entry or 404s a model that is — both are behaviour that changes
 * without anyone asking. One `readdir` per multi-segment request is cheap and always
 * correct.
 *
 * @param pool - pool key.
 * @param name - first path segment, already validated as a plain file name.
 * @returns true when the directory exists and holds a `.model3.json`.
 */
async function isModelEntryDirectory(pool, name) {
  if (name.startsWith('.')) return false
  let inside
  try {
    inside = await readdir(join(poolDir(pool), name), { withFileTypes: true })
  } catch {
    // Missing, unreadable, or a file rather than a directory: not a pool entry.
    return false
  }
  return inside.some(child => child.isFile() && child.name.toLowerCase().endsWith(LIVE2D_SUFFIX))
}

/**
 * Resolve a requested pool path to a file inside one pool directory.
 *
 * Two shapes are served, matching `listPool`: a flat media file, and a file inside
 * a model directory (so the model's own relative references — the `.moc3` and its
 * textures — resolve from the same prefix the `model3.json` was served from). The
 * containment rule is applied per segment, so `..` in any position is rejected
 * before it can reach the filesystem.
 *
 * ASYNC because the multi-segment case has to ask the filesystem a question, and
 * that question is the whole point: the FIRST segment must be a directory
 * `listPool` would publish as a model entry, and `originals/` is refused outright.
 * Validating only the last segment's extension let any subdirectory through.
 *
 * @param url - request URL.
 * @param pool - which pool the request claims.
 * @returns `{ status: 200, absolute }` when the request names a servable pool file,
 *   `{ status: 400 }` when the URL cannot even be decoded, and `{ status: 404 }`
 *   for everything that is not a pool file. The split matters: a malformed escape
 *   used to throw `URIError` out of here and reach the route's catch, which answered
 *   a 500 and logged an error — turning `%E0%A4%A` into a log-flooding scan.
 */
async function resolvePoolFile(url, pool) {
  // A malformed percent-escape is the CLIENT's mistake, not this Host's failure, so
  // it is answered as 400 before anything else is decided.
  let pathname
  try {
    pathname = decodeURIComponent(url.split('?')[0])
  } catch {
    return { status: 400 }
  }
  const base = `${ROUTE}/${pool}`
  if (!pathname.startsWith(`${base}/`)) return { status: 404 }
  const rest = pathname.slice(base.length + 1)
  if (rest === '') return { status: 404 }

  // Segment-wise: every piece must be a plain name, so no separator can survive
  // inside one and no `..` can walk out of the pool.
  const segments = rest.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..'
    || segment.includes('\\') || segment.includes(sep))) {
    return { status: 404 }
  }

  // `originals/` is refused at ANY depth, before any filesystem question is asked.
  // It is the backup directory both pools keep their pre-rewrite copies in, and it
  // is deliberately outside the pool's contract. Compared case-insensitively
  // because Windows resolves `Originals/` to the same directory: a check that only
  // matched the exact spelling would be a bypass on the platform this ships on.
  if (segments.some(segment => segment.toLowerCase() === BACKUP_DIR)) return { status: 404 }

  const dir = poolDir(pool)
  const absolute = resolve(dir, ...segments)
  if (absolute !== dir && !absolute.startsWith(dir + sep)) return { status: 404 }

  const last = segments[segments.length - 1]
  if (segments.length === 1) {
    // A flat file at the pool root: the pool holds media only.
    if (mediaTypeOf(last) === undefined) return { status: 404 }
    return { status: 200, absolute }
  }

  // Everything below is inside a subdirectory, and there is only one kind of
  // subdirectory a pool serves: a model. The FIRST segment therefore has to be a
  // directory `listPool` would publish as an entry — the same `.model3.json` test —
  // and `originals/` never is. This is the check that stops the pool from becoming
  // a general file server for whatever a user drops in a subdirectory.
  if (segments.some(segment => segment.startsWith('.'))) return { status: 404 }
  if (!await isModelEntryDirectory(pool, segments[0])) return { status: 404 }
  // Inside a model, the moc3, the textures and the auxiliary JSONs are served by
  // their own extensions.
  if (!MODEL_FILE.test(last)) return { status: 404 }
  return { status: 200, absolute }
}

/** Extensions a file inside a model directory may carry. */
const MODEL_FILE = /\.(model3\.json|moc3|png|json|physics3\.json|cdi3\.json|motion3\.json|exp3\.json|pose3\.json|userdata3\.json)$/i

/** Absolute directory of one pool. */
function poolDir(pool) {
  return resolve(packageRoot, POOLS[pool].dir)
}

/**
 * Open a directory in the system file manager.
 *
 * Detached and unreferenced on purpose: this is a launcher, not a worker. The
 * child's stdio is `ignore` rather than piped, because nothing here reads its
 * output and a piped child is a handle that has to be drained and reaped — and
 * because the agent sandbox refuses a child whose output is captured through a
 * pipe, which would make this route work on a desktop and fail under an agent.
 *
 * The promise settles when the child has STARTED, not when it exits: `explorer`
 * returns immediately, while `open` and `xdg-open` may stay alive for as long as
 * the window does. Waiting for exit would hold the request open indefinitely on
 * macOS.
 *
 * @param dir - absolute directory to show; the caller has already created it.
 * @returns `{ via }` naming the launcher used, for the card's message.
 */
function revealDirectory(dir) {
  return new Promise((done, fail) => {
    let command
    let args
    if (process.platform === 'win32') {
      // `explorer` is the file manager itself, so the path is the argument. It is
      // passed as its own argv entry rather than through a shell, so no quoting or
      // escaping is involved and a path with spaces or `&` cannot become a command.
      command = 'explorer'
      args = [dir]
    } else if (process.platform === 'darwin') {
      command = 'open'
      args = [dir]
    } else {
      command = 'xdg-open'
      args = [dir]
    }

    let settled = false
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      fail(error)
    })
    child.on('spawn', () => {
      if (settled) return
      settled = true
      // Detached so the launcher outlives this request; unreferenced so it does not
      // hold the DSH process open on shutdown.
      child.unref()
      done({ via: command })
    })
  })
}

/**
 * Mount the clip route and the pre-boot index injection.
 * @param ctx - Host plugin context.
 * @param config - the applied config, already validated against `Config`. Each
 *   field arrives as a live reference carrying its defaulted value, so a profile
 *   with no settings document reads the same values as one holding an empty
 *   document.
 */
export function apply(ctx, config) {
  // Start a fresh trace for this process. Everything after this line is recorded, so the file shows
  // whether the plugin activated at all — the one fact that could not be checked from outside.
  try {
    writeFileSync(TRACE_PATH, `boot-animation startup trace\nplugin dir: ${import.meta.url}\n`, 'utf8')
  } catch {
    /* see trace() */
  }
  trace('apply: entered')
  trace(`apply: LIVE_CAPABLE = ${LIVE_CAPABLE}`)

  const server = ctx.webServer

  if (!LIVE_CAPABLE) {
    ctx.logger?.warn?.(
      'boot-animation: the resolved @deepseek-ai/schemastery has no .volatile(), so DSH '
      + 'will not serve this entry as a settings namespace and the settings card stays '
      + 'hidden. Link node_modules/@deepseek-ai/schemastery to the copy the kernel loads '
      + '(>= 3.18.4).',
    )
  }

  /**
   * The settings the screen should run with right now.
   *
   * Read per index render rather than cached, because the boot screen is rebuilt
   * from this on the next page load — which is exactly when a new value can take
   * effect, and the loader has by then already committed a stored edit into the
   * references this reads.
   *
   * Every field falls back individually. With `Config` resolved the fallback is
   * unreachable, but it must stay so that a profile which could not load the
   * schema, and therefore receives an unresolved config, still boots a working
   * animation under the documented defaults.
   * @returns the resolved settings, with every field defaulted.
   */
  function currentSettings() {
    try {
      const enabled = readField(config, 'enabled')
      const fadeMs = readField(config, 'fadeMs')
      const enterMode = readField(config, 'enterMode')
      const disabledClips = readField(config, 'disabledClips')
      const sound = readField(config, 'sound')
      const clickToEnter = readField(config, 'clickToEnter')
      const showHint = readField(config, 'showHint')
      const screensaverEnabled = readField(config, 'screensaverEnabled')
      const screensaverIdleMs = readField(config, 'screensaverIdleMs')
      const screensaverBreakEffect = readField(config, 'screensaverBreakEffect')
      const screensaverBreakStyle = readField(config, 'screensaverBreakStyle')
      const screensaverHint = readField(config, 'screensaverHint')
      const screensaverPointerEffect = readField(config, 'screensaverPointerEffect')
      const screensaverSound = readField(config, 'screensaverSound')
      const screensaverVolume = readField(config, 'screensaverVolume')
      const screensaverRotateMs = readField(config, 'screensaverRotateMs')
      const disabledScreensaver = readField(config, 'disabledScreensaver')
      return {
        enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_SETTINGS.enabled,
        fadeMs: typeof fadeMs === 'number' ? fadeMs : DEFAULT_SETTINGS.fadeMs,
        enterMode: ENTER_MODES.includes(enterMode) ? enterMode : DEFAULT_SETTINGS.enterMode,
        disabledClips: Array.isArray(disabledClips) ? disabledClips : [],
        sound: typeof sound === 'boolean' ? sound : DEFAULT_SETTINGS.sound,
        clickToEnter: typeof clickToEnter === 'boolean' ? clickToEnter : DEFAULT_SETTINGS.clickToEnter,
        showHint: typeof showHint === 'boolean' ? showHint : DEFAULT_SETTINGS.showHint,
        screensaverEnabled: typeof screensaverEnabled === 'boolean'
          ? screensaverEnabled
          : DEFAULT_SETTINGS.screensaverEnabled,
        screensaverIdleMs: typeof screensaverIdleMs === 'number'
          ? screensaverIdleMs
          : DEFAULT_SETTINGS.screensaverIdleMs,
        screensaverBreakEffect: typeof screensaverBreakEffect === 'boolean'
          ? screensaverBreakEffect
          : DEFAULT_SETTINGS.screensaverBreakEffect,
        // Validated against the four known names. An unknown value falls back to `random`
        // rather than reaching the screensaver, where it would have to be handled anyway.
        screensaverBreakStyle: BREAK_STYLES.includes(screensaverBreakStyle)
          ? screensaverBreakStyle
          : DEFAULT_SETTINGS.screensaverBreakStyle,
        screensaverHint: typeof screensaverHint === 'boolean'
          ? screensaverHint
          : DEFAULT_SETTINGS.screensaverHint,
        screensaverPointerEffect: POINTER_EFFECTS.includes(screensaverPointerEffect)
          ? screensaverPointerEffect
          : DEFAULT_SETTINGS.screensaverPointerEffect,
        screensaverSound: typeof screensaverSound === 'boolean'
          ? screensaverSound
          : DEFAULT_SETTINGS.screensaverSound,
        // Clamped rather than merely type-checked: a stored value outside 0..1 would be clamped
        // by the element anyway, and passing it through would make the slider disagree with what
        // is actually heard.
        screensaverVolume: typeof screensaverVolume === 'number' && isFinite(screensaverVolume)
          ? Math.min(1, Math.max(0, screensaverVolume))
          : DEFAULT_SETTINGS.screensaverVolume,
        // Clamped like the volume: a stored value outside the schema's range would be rejected by
        // the element's own timer or, worse, fire every frame.
        screensaverRotateMs: typeof screensaverRotateMs === 'number' && isFinite(screensaverRotateMs)
          ? Math.min(600000, Math.max(0, Math.round(screensaverRotateMs)))
          : DEFAULT_SETTINGS.screensaverRotateMs,
        disabledScreensaver: Array.isArray(disabledScreensaver) ? disabledScreensaver : [],
      }
    } catch (error) {
      ctx.logger?.warn?.('boot-animation: settings unreadable, using defaults', error)
      return DEFAULT_SETTINGS
    }
  }

  // Two routes per pool rather than one prefix over ROUTE. The web server resolves
  // prefixes longest-first, so a prefix on ROUTE also claims
  // `<ROUTE>/client.js` — the URL the browser fetches for this package's own
  // client bundle (client-modules serves every bundle at
  // `/plugins/<package>/client.js`). That request would answer this plugin's
  // 404, the bundle would never materialize, and the Settings card would never
  // register. An exact manifest route plus a per-pool prefix leaves every other
  // path under ROUTE to its owner.
  //
  // The manifest is per pool and each pool is served under its own prefix, so each
  // pool can be fetched independently — and so a model directory's own relative
  // references resolve from a prefix that means something rather than from the
  // pool's flat file list.
  for (const [pool, meta] of Object.entries(POOLS)) {
    const disabled = () => new Set(
      pool === 'clips'
        ? currentSettings().disabledClips
        : currentSettings().disabledScreensaver,
    )

    ctx.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE}/${pool}.json`,
      handler: (req, res) => {
        void (async () => {
          const items = await listPool(poolDir(pool), `${ROUTE}/${pool}`)
          const off = disabled()
          sendJson(res, 200, {
            pool,
            label: meta.label,
            // The directory this pool lives in, as an absolute path.
            //
            // Published here because the CARD cannot compute it: the plugin's
            // install location is a Host fact, not a page fact, and the card has no
            // way to ask. It needs it to show the user where to put files — which is
            // the whole point of the folder dialog — and getting it from the
            // manifest means that dialog costs no extra request.
            dir: poolDir(pool),
            items: items.map(item => ({
              // The revision is the size+time pair the URL carries, and the URL is
              // what makes a stale cache entry unreachable: it changes whenever the
              // file does — or whenever the scheme that produced a bad entry
              // changes. The first scheme (mtime alone) left truncated `immutable`
              // entries that a normal reload kept reusing, and nothing but a hard
              // reload could dislodge them.
              src: item.src,
              name: item.name,
              // What the screen must render this as. See MEDIA_TYPES.
              kind: item.kind,
              // True for a Live2D model directory, whose `src` names the
              // `model3.json` and whose siblings are fetched relative to it.
              model: item.dir,
              // Everything on disk is listed, with the pool decision carried as a
              // field. The screen plays only the enabled ones; the settings card
              // needs the whole list to offer them back.
              enabled: !off.has(item.name),
              bytes: item.bytes,
              faststart: item.faststart,
            })),
          })
        })().catch((error) => {
          ctx.logger?.error?.(`boot-animation: ${pool} manifest failed`, error)
          if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
          else res.end()
        })
      },
    }), `boot-animation: ${pool} manifest route`)

    ctx.effect(() => server.register({
      kind: 'prefix',
      path: `${ROUTE}/${pool}`,
      handler: (req, res) => {
        void (async () => {
          const resolved = await resolvePoolFile(req.url ?? '', pool)
          // The resolver's own verdict: 400 for a URL it cannot decode, 404 for
          // everything that is not a pool file. Neither is a 500 — a request this
          // Host cannot honour is not a failure of this Host, and answering 500
          // for `%E0%A4%A` made a single malformed escape into a log entry any
          // scanner could produce at will.
          if (resolved.status !== 200) {
            sendJson(res, resolved.status, { error: 'not found' })
            return
          }
          try {
            await serveMedia(resolved.absolute, req, res)
          } catch (error) {
            if (error?.code === 'ENOENT') {
              sendJson(res, 404, { error: 'not found' })
              return
            }
            throw error
          }
        })().catch((error) => {
          ctx.logger?.error?.(`boot-animation: ${pool} route failed`, error)
          if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
          else res.end()
        })
      },
    }), `boot-animation: ${pool} route`)
  }

  /**
   * The card's icon.
   *
   * A dedicated read-only route rather than serving the picture out of a media
   * pool: the pools are the USER's media and are listed, probed and rotated, while
   * this is a shipped asset of the plugin. Putting it in a pool would make it
   * selectable as a boot clip and count into the pool summary.
   *
   * GET/HEAD only, and the file name is a whitelist rather than a path: the same
   * containment rule the pool routes follow, for the same reason — a route that
   * takes a path is a way to read anything this process can read.
   */
  const ICON_DIR = fileURLToPath(new URL('./assets/icon/', import.meta.url))
  const ICON_FILES = new Set(['icon-40.png', 'icon-80.png', 'icon-160.png'])
  ctx.effect(() => server.register({
    kind: 'prefix',
    path: `${ROUTE}/icon`,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: '这个地址只接受 GET。' })
        return
      }
      // A prefix route is handed the WHOLE request URL, prefix included, so the
      // icon name is what remains after the route's own base. Reading it as if the
      // base were already stripped yields `plugins/dsh-boot-animation/icon/x.png`,
      // which is not in the whitelist — a 404 on every icon, silently, because the
      // card hides a failed image.
      //
      // The decode is guarded for the same reason `resolvePoolFile`'s is: a malformed
      // percent-escape throws `URIError`, and letting it out of the handler answers a
      // 500 and writes an error log for what is purely a bad request. 400 here, not
      // 404, because the request itself could not be read.
      let pathname
      try {
        pathname = decodeURIComponent((req.url ?? '').split('?')[0])
      } catch {
        sendJson(res, 400, { error: 'bad request' })
        return
      }
      const base = `${ROUTE}/icon`
      const name = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : ''
      if (!ICON_FILES.has(name)) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      void serveMedia(join(ICON_DIR, name), req, res).catch((error) => {
        // A missing icon is not an error worth a 500: the card hides the image on
        // a failed load, so answering 404 is the honest and the harmless answer.
        if (!res.headersSent) sendJson(res, 404, { error: 'not found' })
        else res.end()
        if (error?.code !== 'ENOENT') ctx.logger?.error?.('boot-animation: icon route failed', error)
      })
    },
  }), 'boot-animation: icon route')

  /**
   * One clip's index table moved to the front, on request — the card's 优化 button.
   *
   * A prefix route with the file name in the query string, for two reasons: these
   * handlers are handed the raw request (the clip route already reads its own `?v=`
   * suffix), and an `exact` route matches the whole URL, query included. Nothing in
   * the pool is written unless this is called: the card only ever REPORTS the
   * `moov` position, and a decorative plugin that rewrote a user's media on its own
   * is the behaviour this route exists to keep out of the boot path.
   */
  const optimising = new Set()
  ctx.effect(() => server.register({
    kind: 'prefix',
    path: `${ROUTE}/optimize`,
    handler: (req, res) => {
      void (async () => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        const requested = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? ''
        // The pool travels in the query too, because the two pools are separate
        // directories and the same file name can exist in both. The prefix is
        // stripped before the containment check, which is then identical for both.
        const inScreensaver = requested.startsWith('screensaver/')
        const bare = inScreensaver ? requested.slice('screensaver/'.length) : requested
        const dir = poolDir(inScreensaver ? 'screensaver' : 'clips')
        // The same containment rule as `resolvePoolFile`: a bare file name from
        // this pool, nothing that could name a path. Comparing against `basename`
        // rejects any separator the query carried in, encoded or not.
        const name = basename(bare)
        const absolute = resolve(dir, name)
        // Only a video can be faststart-optimised: `moov` is an mp4 box, and an
        // image has no index table to move. Refusing here is what keeps the card
        // from offering a button that cannot work.
        if (name === '' || name !== bare
          || mediaTypeOf(name)?.kind !== 'video'
          || !absolute.startsWith(dir + sep)) {
          sendJson(res, 400, { ok: false, error: '素材名不合法。' })
          return
        }
        // The lock is keyed by the full pool-qualified name so two pools cannot
        // collide on one file name and report a spurious "already running".
        const key = (inScreensaver ? 'screensaver/' : '') + name
        if (optimising.has(key)) {
          sendJson(res, 409, { ok: false, error: '这一条正在处理，稍等一下再点。' })
          return
        }
        optimising.add(key)
        try {
          const result = await optimizeInPlace({
            file: absolute,
            backupDir: join(dir, 'originals'),
            scratchDir: join(dir, '.faststart-work'),
          })
          sendJson(res, 200, result)
        } finally {
          optimising.delete(key)
        }
      })().catch((error) => {
        if (res.headersSent) {
          res.end()
          return
        }
        if (error?.code === 'ENOENT') {
          sendJson(res, 404, { ok: false, error: '素材不在了。' })
          return
        }
        if (typeof error?.code === 'string' && error.code.startsWith('E_')) {
          // A refusal raised on purpose; its message is written to be shown as is.
          sendJson(res, 422, { ok: false, error: error.message })
          return
        }
        ctx.logger?.error?.('boot-animation: optimize route failed', error)
        sendJson(res, 500, { ok: false, error: 'internal' })
      })
    },
  }), 'boot-animation: optimize route')

  /**
   * Open one pool's directory in the system file manager — the card's 打开文件夹 button.
   *
   * This route exists because a PAGE CANNOT DO IT. Browsers deliberately deny a web
   * page the ability to launch a local program or reveal a path, and that boundary
   * is not something a plugin can or should work around from inside the page. The
   * Host half runs in Node, which has the privilege, so the button asks the Host to
   * do it on the user's behalf.
   *
   * What that privilege buys is the security requirement: this route LAUNCHES A
   * PROGRAM on the user's machine, so it must not be steerable from the page. Two
   * rules follow, and both are load-bearing:
   *
   *   - The pool is a WHITELIST KEY (`clips` / `screensaver`), never a path. The directory
   *     is computed here from `POOLS`; no part of the request can name a location.
   *     A route that took a path would be remote file-manager-launching for any
   *     page on this origin, which is a far bigger hole than the feature is worth.
   *   - POST only, for the same reason the rewrite route is POST only: a GET that
   *     launches a program can be triggered by anything that can make the browser
   *     issue a request, including an <img> tag on another page.
   *
   * The directory is created if it is missing. That is the point rather than a side
   * effect: an empty pool is the normal first-run state, and a user who presses
   * "open folder" to put something IN it needs the folder to exist.
   */
  const revealing = new Set()
  ctx.effect(() => server.register({
    kind: 'prefix',
    path: `${ROUTE}/reveal`,
    handler: (req, res) => {
      void (async () => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        const requested = new URL(req.url ?? '/', 'http://localhost').searchParams.get('pool') ?? ''
        // The whitelist, not a sanitizer: anything not in POOLS is refused outright,
        // so there is no path to validate and no traversal to reason about.
        if (!Object.hasOwn(POOLS, requested)) {
          sendJson(res, 400, { ok: false, error: '池子名不合法。' })
          return
        }
        const dir = poolDir(requested)
        if (revealing.has(requested)) {
          sendJson(res, 409, { ok: false, error: '正在打开，稍等一下。' })
          return
        }
        revealing.add(requested)
        try {
          // Created first: `explorer` on a path that does not exist opens Documents
          // instead, which looks like the button is broken and sends the user to the
          // wrong place entirely.
          await mkdir(dir, { recursive: true })
          const result = await revealDirectory(dir)
          sendJson(res, 200, { ok: true, dir, via: result.via })
        } catch (error) {
          // The path travels back on failure too, so the dialog can fall back to
          // showing it for the user to copy — which is the only remaining way to get
          // there when the launcher itself is unavailable.
          ctx.logger?.warn?.('boot-animation: reveal failed', error)
          sendJson(res, 500, {
            ok: false,
            dir,
            error: '打不开文件管理器：' + (error?.message ? String(error.message) : '未知原因'),
          })
        } finally {
          revealing.delete(requested)
        }
      })().catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' })
        else res.end()
      })
    },
  }), 'boot-animation: reveal route')

  /**
   * Report how long the whole machine has been idle — the screensaver's trigger.
   *
   * This route exists because the number is an OPERATING-SYSTEM fact and the page
   * cannot obtain it. A renderer sees only the input that reaches its own window, so
   * "the user walked away while DSH stayed in front" is invisible to it. The Host
   * half runs in Node, which can read the OS counter, so the page asks it.
   *
   * Why a route rather than injecting the value: the answer changes continuously, so
   * a value pushed once at page load would be a snapshot pretending to be a clock.
   * The screensaver polls this on its own timer, which also means the probe's child
   * process only exists while somebody is actually asking.
   *
   * GET, unlike the reveal route: this reads a number and touches nothing, so there
   * is no side effect for a stray request to trigger. It also has to be cheap enough
   * to poll.
   *
   * `idleMs: null` means "cannot be known here" — a non-Windows platform, or a probe
   * that failed. The screensaver treats that as "use the focus trigger alone" rather
   * than as an error, because a machine without an OS idle counter still deserves a
   * screensaver.
   */
  ctx.effect(() => {
    const probe = createIdleProbe({ logger: ctx.logger })
    // The child is a resource: it is killed when this fiber unloads rather than left
    // to outlive the plugin.
    ctx.effect(() => () => probe.dispose(), 'boot-animation: idle probe')

    ctx.effect(() => server.register({
      kind: 'exact',
      // Named `system-idle.json` rather than `idle.json` on purpose: this package
      // once had an `idle.json` that was the retired idle POOL's manifest, and a
      // route that reuses that name would be read as the pool by anyone who
      // remembers it. This is a different thing — the OS idle counter — so it gets a
      // name that cannot be mistaken for the pool.
      path: `${ROUTE}/system-idle.json`,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 GET。' })
          return
        }
        const idleMs = probe.read()
        const status = probe.status()
        sendJson(res, 200, {
          ok: true,
          // `null` rather than omitting the field: the page distinguishes "the OS
          // says nothing has happened for N ms" from "there is no OS counter here",
          // and an absent key would read as the former with a zero value.
          idleMs: idleMs === undefined ? null : idleMs,
          // One of 'ok' | 'starting' | 'unavailable'. A caller needs this to tell
          // "ask again in a moment" from "never going to work, use the fallback" —
          // both of which read as null above.
          status,
          // Why it is unavailable, for the diagnostics line. Null while it works or
          // is still starting.
          reason: probe.unavailableReason(),
        })
      },
    }), 'boot-animation: idle route')
  }, 'boot-animation: idle probe and route')

  /**
   * Where the page reports what IT sees, so a problem can be read from outside.
   *
   * This exists because the desktop app has no browser console and no address bar: a
   * user cannot open devtools, cannot add `?dshbootdiag=1`, and cannot be asked to read
   * a diagnostic line off the screen. When the screensaver misbehaved, diagnosing it
   * from here meant guessing — the symptom ("it never appears") is identical for five
   * different causes, and the only person who could see the answer had no way to report
   * it.
   *
   * So the page POSTs its state here on a slow timer, the Host keeps the latest report,
   * and GET returns it. Anyone with access to the server — including this agent — can
   * then read the real state of the real page, with nothing asked of the user.
   *
   * POST is the right verb: this writes a report. It is NOT reachable by a stray <img>
   * tag or a link, which matters because it accepts a body from any page on the origin.
   */
  ctx.effect(() => {
    /** The most recent report, or null before the page has sent one. */
    let lastReport = null

    /**
     * The settings the screensaver should act on RIGHT NOW.
     *
     * WHY THIS ROUTE EXISTS AT ALL. The page reads its settings from
     * `globalThis.__DSH_BOOT_ANIM_CFG__`, which the Host injects once as a head row. Saving the
     * settings document does not rebuild that object, and the desktop shell has no reload key — so
     * a picker's value reached the document and never reached the screensaver. The client card
     * tried to patch the object after each save (`pokeLiveConfig`), and that is not dependable:
     * whether the card and the injected screensaver share one `globalThis` is a property of the
     * host shell, not of this code. Observed: the document held `ripples`, the card highlighted
     * 水波涟漪, and the screensaver still resolved `attract`.
     *
     * So the screensaver asks the Host instead, over the route it ALREADY calls for its manifest.
     * The Host answers from the live config, which is the authority. Reading a few bytes per
     * appearance costs nothing and removes the whole class of "the page has a stale copy" bugs.
     *
     * Read-only and GET-only, like `system-idle.json`: it answers data and touches nothing.
     */
    ctx.effect(() => server.register({
      // EXACT, not a prefix. This route answers data and has no sub-paths, so a
      // prefix made `/live-settings.json/anything` answer 200 as well — a match
      // wider than the route means. The same rule `clips.json` and
      // `system-idle.json` already follow.
      kind: 'exact',
      path: `${ROUTE}/live-settings.json`,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 GET。' })
          return
        }
        let live
        try {
          live = currentSettings()
        } catch (error) {
          sendJson(res, 500, { ok: false, error: '读不到设置。' })
          return
        }
        sendJson(res, 200, {
          ok: true,
          // Only the fields the screensaver acts on. A wider answer would be a settings dump on an
          // unauthenticated route, and nothing here needs one.
          settings: {
            screensaverEnabled: live.screensaverEnabled,
            screensaverIdleMs: live.screensaverIdleMs,
            screensaverBreakEffect: live.screensaverBreakEffect,
            screensaverBreakStyle: live.screensaverBreakStyle,
            screensaverHint: live.screensaverHint,
            screensaverPointerEffect: live.screensaverPointerEffect,
            screensaverSound: live.screensaverSound,
            screensaverVolume: live.screensaverVolume,
            screensaverRotateMs: live.screensaverRotateMs,
          },
        })
      },
    }), 'boot-animation: live settings route')

    ctx.effect(() => server.register({
      // EXACT for the same reason as `live-settings.json` above: this is a data
      // route with no sub-paths, and a prefix let `/saver-report/anything` answer
      // 200. Both verbs (GET for the readout, POST for a report) still land, because
      // the web server matches an exact route on the PATHNAME alone — the query
      // string is not part of the match.
      kind: 'exact',
      path: `${ROUTE}/saver-report`,
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (req.method === 'GET' || req.method === 'HEAD') {
          sendJson(res, 200, {
            ok: true,
            // `null` means "no page has reported yet", which is a different fact from
            // any report a page could send — a profile whose screensaver is off still
            // has a page, it just never reports.
            report: lastReport,
          })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 GET 和 POST。' })
          return
        }
        // A small body cap. This endpoint is reachable from the page, so an unbounded
        // read would be a way to make the Host hold arbitrary memory.
        //
        // The cap is enforced by STOPPING THE ACCUMULATION and answering 413 straight
        // away, rather than by `req.destroy()`. Destroying the request was the first
        // version and it made the 413 unreachable: `end` never fires on a destroyed
        // request, so the branch that answers 413 was dead code and the client saw a
        // network error instead. Nothing is appended after the cap either, so a page
        // that streams megabytes into this route cannot grow the Host's memory.
        let body = ''
        let answered = false
        req.on('data', (chunk) => {
          if (answered) return
          body += chunk
          if (body.length > 8192) {
            answered = true
            body = ''
            sendJson(res, 413, { ok: false, error: '报告太大。' })
          }
        })
        req.on('end', () => {
          if (answered) return
          answered = true
          try {
            const parsed = JSON.parse(body)
            // Only plain JSON is kept. Storing the parsed object as-is would let a page
            // put anything in the Host's memory, and this is a diagnostic rather than a
            // data channel — nothing here is trusted, only reported.
            lastReport = {
              at: Date.now(),
              from: typeof parsed?.from === 'string' ? parsed.from.slice(0, 32) : 'page',
              state: typeof parsed?.state === 'object' && parsed.state !== null ? parsed.state : {},
            }
            sendJson(res, 200, { ok: true })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: '报告不是 JSON。' })
          }
        })
        req.on('error', () => {
          if (answered) return
          answered = true
          if (!res.headersSent) sendJson(res, 400, { ok: false, error: '读取请求失败。' })
        })
      },
    }), 'boot-animation: saver report route')
  }, 'boot-animation: saver report')

  // `ctx.on` already returns a disposer the fiber tracks, so it is registered
  // directly rather than wrapped in an effect — matching the other subscribers
  // of this event (ui-theme, client-modules, client-connection).
  ctx.on('webserver/index-inject', (table) => {
    trace('index-inject: listener fired')
    let settings
    try {
      settings = currentSettings()
    } catch (error) {
      trace(`index-inject: currentSettings THREW — ${error && error.message}`)
      throw error
    }
    trace(`index-inject: boot animation enabled = ${settings.enabled}`)
    trace(`index-inject: screensaver enabled = ${settings.screensaverEnabled}`)

    // `enabled` governs the BOOT ANIMATION ONLY, and this row set is built so that
    // switching it off cannot take the screensaver down with it.
    //
    // It used to `return` here, before any row was pushed, so a user who switched the
    // boot animation off also lost the screensaver's injected script: the card kept
    // showing its screensaver section, still let them tick 启用屏保, and still reported
    // 已开启, while nothing on the page had ever installed the layer. The two modules
    // have separate lifetimes and separate switches (see AGENTS.md, "Two modules, two
    // lifetimes"), so they are gated separately now: the config row, the renderers row
    // and the screensaver row are pushed UNCONDITIONALLY, and only the boot screen's
    // own row is behind `enabled`. The CFG row carries both sets of fields, so pushing
    // it while the boot animation is off has no side effect — the script that would
    // read the boot fields is the one that is not injected.
    //
    // The ORDER is load-bearing and unchanged: CFG first because it is plain data,
    // renderers second because both scripts build their media through the factory, and
    // the screensaver third because it depends on the two rows above it. Dropping or
    // reordering a row here is the silent-failure shape this file keeps warning about:
    // a script that never runs looks exactly like a feature the user never asked for.

    // Four rows, in this order. The renderers come BEFORE the two screens because the
    // screens build their media through them and would otherwise have to wait for a
    // separate load; the config comes before all three because it is plain data.
    //
    // The rows read plain globals the scripts fill in, so the injection stays
    // JSON-serializable data and each script stays a static asset.
    const rowsBefore = table.length
    table.push({
      kind: 'script',
      placement: 'head',
      text: `globalThis.__DSH_BOOT_ANIM_CFG__=${JSON.stringify({
        base: ROUTE,
        manifest: `${ROUTE}/clips.json`,
        // The screensaver's own manifest and settings. The screensaver itself runs
        // in the CLIENT half rather than in this injected screen, because it has to
        // be alive long after the boot path has handed over — but it reads its
        // configuration from here, so there is still exactly one source of truth for
        // what a pool is and where it lives.
        screensaverManifest: `${ROUTE}/screensaver.json`,
        // Where the OS idle counter is read. The screensaver polls this rather than
        // being handed a value once, because the answer changes continuously.
        systemIdle: `${ROUTE}/system-idle.json`,
        // Where the page reports what it sees, so a problem can be read from outside.
        // The desktop app has no console and no address bar, so this is the only channel
        // a diagnosis can travel on.
        saverReport: `${ROUTE}/saver-report`,
        // Where the screensaver re-reads the settings before each appearance. This exists because
        // the values below are a SNAPSHOT taken when the page loaded: saving the document does not
        // rebuild this object, and the desktop shell has no reload key. Without the route a
        // changed picker applied to the document and never to the running screensaver.
        liveSettings: `${ROUTE}/live-settings.json`,
        holdMs: 15000,
        fadeMs: settings.fadeMs,
        enterMode: settings.enterMode,
        sound: settings.sound,
        clickToEnter: settings.clickToEnter,
        showHint: settings.showHint,
        screensaverEnabled: settings.screensaverEnabled,
        screensaverIdleMs: settings.screensaverIdleMs,
        screensaverBreakEffect: settings.screensaverBreakEffect,
        screensaverBreakStyle: settings.screensaverBreakStyle,
        screensaverHint: settings.screensaverHint,
        screensaverPointerEffect: settings.screensaverPointerEffect,
        screensaverSound: settings.screensaverSound,
        screensaverVolume: settings.screensaverVolume,
        screensaverRotateMs: settings.screensaverRotateMs,
      })}`,
    })
    table.push({ kind: 'script', placement: 'head', text: readSource(RENDERERS_PATH) })
    // The screensaver, third because it depends on both the config above and the
    // renderer factory before it. It installs itself and then keeps its own timer:
    // nothing else in the page has to call into it.
    //
    // UNCONDITIONAL, like the two rows above. It has its own switch
    // (`screensaverEnabled`, which the screensaver reads from CFG and from the live
    // route), so the boot animation's switch has no business deciding whether its
    // script exists at all.
    table.push({ kind: 'script', placement: 'head', text: readSource(SCREENSAVER_PATH) })

    // The boot screen is the ONE row `enabled` governs. Switched off means the
    // kernel's own boot page shows: no overlay, and not one request for a clip.
    // Injecting a disabled screen and making the script bail out would look the same
    // and leave the whole overlay running; not injecting it at all is the only
    // version of "off" that is actually off.
    const bootInjected = settings.enabled
    if (bootInjected) {
      table.push({ kind: 'script', placement: 'head', text: readSource(BOOT_SCREEN_PATH) })
    }

    // Record what actually landed in the table, and WHY a row is missing. The sizes
    // are the point: a row that is present but EMPTY is the failure mode that
    // produces no error anywhere — the overlay never installs, and the native boot
    // page stays up looking exactly like a plugin that is not running. The row
    // count, the per-row byte counts and the skip reason distinguish a row that
    // never arrived from a row that arrived blank.
    //
    // Only THIS plugin's rows are listed. The table is shared with every other
    // subscriber of `webserver/index-inject`, so reporting `table.length` alone said
    // nothing about which of them came from here — and that number was the one thing
    // the trace was for.
    const ours = table.slice(rowsBefore)
    trace(`index-inject: pushed ${ours.length} row(s) of ${table.length} in the table`
      + ` — config, renderers, screensaver${bootInjected ? ', boot screen' : ''}`)
    for (let i = 0; i < ours.length; i += 1) {
      const row = ours[i]
      const text = typeof row.text === 'string' ? row.text : ''
      trace(`index-inject:   our row ${i} kind=${row.kind} placement=${row.placement}`
        + ` bytes=${text.length}` + (text.length === 0 ? '  <-- EMPTY' : ''))
    }
    if (!bootInjected) {
      trace('index-inject: SKIPPED the boot-screen row — enabled is false '
        + '(the config, renderers and screensaver rows were pushed regardless, because '
        + 'the boot animation and the screensaver are separate features)')
    }
  })
}

/**
 * Read one injected script source.
 *
 * Shared by the screen and the renderers so a missing file degrades the same way
 * for both: the row is empty, the boot page is the kernel's own, and a warning
 * names the path. A renderers module that failed to load is worse than a missing
 * screen only in that the screen would then find no factory — which it already
 * treats as "this entry cannot be rendered", so the pool is skipped rather than
 * the page being held.
 * @param path - absolute path of the source file.
 * @returns the script text, or an empty string when it cannot be read.
 */
function readSource(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    process.emitWarning(`boot-animation: cannot read ${path}: ${String(error)}`)
    return ''
  }
}
