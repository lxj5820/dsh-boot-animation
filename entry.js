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

import { readdir, stat, open } from 'node:fs/promises'
import { createReadStream, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, extname, join, resolve, sep } from 'node:path'
import { optimizeInPlace } from './src/remux.js'
import z from '@deepseek-ai/schemastery'

/**
 * Absolute path of the pre-boot screen source.
 *
 * The script is read per index render rather than once at module load. Reading it
 * at load time would pin the served script to whatever the file held when the
 * process started, so editing a label or the exit fade would require restarting
 * dsh — the one operation this plugin's whole design tries to avoid asking for.
 */
const BOOT_SCREEN_PATH = fileURLToPath(new URL('./src/boot-screen.js', import.meta.url))

/** Video container extensions the pool accepts, in discovery order. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.m4v', '.mov'])

/** Route prefix both the manifest and the clip bytes live under. */
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
})

/** Package name the loader mounts this row as. */
export const name = 'dsh-boot-animation'

/** Services this half consumes. */
export const inject = ['webServer']

/** The clip directory, resolved from this module rather than the process cwd. */
const assetDir = fileURLToPath(new URL('./assets/videos', import.meta.url))

/** MIME type served for one clip. */
function contentType(file) {
  switch (extname(file).toLowerCase()) {
    case '.webm': return 'video/webm'
    case '.mov': return 'video/quicktime'
    default: return 'video/mp4'
  }
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
 * List the clip files currently on disk, newest first.
 *
 * The modification time travels with each path because the manifest publishes it
 * as the clip's revision: the bytes route caches immutably under a filename that
 * carries no revision of its own, so a clip replaced in place must be requested
 * under a new URL or the browser keeps serving the year-old copy it holds.
 * @returns every servable clip with its revision stamp and card metadata.
 */
async function listClips() {
  let entries
  try {
    entries = await readdir(assetDir, { withFileTypes: true })
  } catch (error) {
    // A missing directory is an empty pool, not a failure: the overlay then has
    // nothing to play and the plugin must stay invisible rather than break boot.
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const files = entries
    .filter(entry => entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map(entry => join(assetDir, entry.name))
  const stamped = await Promise.all(files.map(async (file) => {
    const info = await stat(file)
    return {
      file,
      // Sorted on the raw time, published rounded: two files written in the same
      // millisecond would tie on the rounded value and order nondeterministically.
      mtime: info.mtimeMs,
      revision: Math.round(info.mtimeMs),
      bytes: info.size,
      faststart: await readFaststart(file),
    }
  }))
  return stamped.sort((left, right) => right.mtime - left.mtime)
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
 * Stream one clip, honouring range requests so the browser can seek and so a
 * repeated load does not re-download bytes it already holds.
 * @param absolute - resolved clip path on disk.
 * @param req - incoming request.
 * @param res - outgoing response.
 */
async function serveClip(absolute, req, res) {
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
 * Resolve a requested pool path to a file inside the clip directory.
 * @param url - request URL.
 * @returns the absolute path, or undefined when the request is not a pool clip.
 */
function resolveClip(url) {
  const pathname = decodeURIComponent(url.split('?')[0])
  if (!pathname.startsWith(`${ROUTE}/clip/`)) return undefined
  const requested = basename(pathname.slice(`${ROUTE}/clip/`.length))
  if (!VIDEO_EXTENSIONS.has(extname(requested).toLowerCase())) return undefined
  const absolute = resolve(assetDir, requested)
  // Containment: a traversal attempt must not escape the clip directory.
  if (!absolute.startsWith(assetDir + sep)) return undefined
  return absolute
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
      return {
        enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_SETTINGS.enabled,
        fadeMs: typeof fadeMs === 'number' ? fadeMs : DEFAULT_SETTINGS.fadeMs,
        enterMode: ENTER_MODES.includes(enterMode) ? enterMode : DEFAULT_SETTINGS.enterMode,
        disabledClips: Array.isArray(disabledClips) ? disabledClips : [],
        sound: typeof sound === 'boolean' ? sound : DEFAULT_SETTINGS.sound,
        clickToEnter: typeof clickToEnter === 'boolean' ? clickToEnter : DEFAULT_SETTINGS.clickToEnter,
        showHint: typeof showHint === 'boolean' ? showHint : DEFAULT_SETTINGS.showHint,
      }
    } catch (error) {
      ctx.logger?.warn?.('boot-animation: settings unreadable, using defaults', error)
      return DEFAULT_SETTINGS
    }
  }

  // Two routes rather than one prefix over ROUTE. The web server resolves
  // prefixes longest-first, so a prefix on ROUTE also claims
  // `<ROUTE>/client.js` — the URL the browser fetches for this package's own
  // client bundle (client-modules serves every bundle at
  // `/plugins/<package>/client.js`). That request would answer this plugin's
  // 404, the bundle would never materialize, and the Settings card would never
  // register. An exact manifest route plus a `/clip` prefix leaves every other
  // path under ROUTE to its owner.
  ctx.effect(() => server.register({
    kind: 'exact',
    path: `${ROUTE}/clips.json`,
    handler: (req, res) => {
      void (async () => {
        const clips = await listClips()
        const disabled = new Set(currentSettings().disabledClips)
        sendJson(res, 200, {
          clips: clips.map(clip => ({
            // The revision is the size+time pair the bytes route also answers as
            // its ETag, and the URL is what makes a stale cache entry unreachable:
            // it changes whenever the file does — or whenever the scheme that
            // produced a bad entry changes. The first scheme (mtime alone) left
            // truncated `immutable` entries that a normal reload kept reusing, and
            // nothing but a hard reload could dislodge them.
            src: `${ROUTE}/clip/${encodeURIComponent(basename(clip.file))}`
              + `?v=${String(clip.revision)}-${String(clip.bytes)}`,
            name: basename(clip.file),
            // Everything on disk is listed, with the pool decision carried as a
            // field. The screen plays only the enabled ones; the settings card
            // needs the whole list to offer them back.
            enabled: !disabled.has(basename(clip.file)),
            bytes: clip.bytes,
            faststart: clip.faststart,
          })),
        })
      })().catch((error) => {
        ctx.logger?.error?.('boot-animation: manifest route failed', error)
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
        else res.end()
      })
    },
  }), 'boot-animation: manifest route')

  ctx.effect(() => server.register({
    kind: 'prefix',
    path: `${ROUTE}/clip`,
    handler: (req, res) => {
      void (async () => {
        const absolute = resolveClip(req.url ?? '')
        if (absolute === undefined) {
          sendJson(res, 404, { error: 'not found' })
          return
        }
        try {
          await serveClip(absolute, req, res)
        } catch (error) {
          if (error?.code === 'ENOENT') {
            sendJson(res, 404, { error: 'not found' })
            return
          }
          throw error
        }
      })().catch((error) => {
        ctx.logger?.error?.('boot-animation: clip route failed', error)
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
        else res.end()
      })
    },
  }), 'boot-animation: clip route')

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
        // The same containment rule as `resolveClip`: a bare file name from this
        // pool, nothing that could name a path. Comparing against `basename`
        // rejects any separator the query carried in, encoded or not.
        const name = basename(requested)
        const absolute = resolve(assetDir, name)
        if (name === '' || name !== requested
          || !VIDEO_EXTENSIONS.has(extname(name).toLowerCase())
          || !absolute.startsWith(assetDir + sep)) {
          sendJson(res, 400, { ok: false, error: '素材名不合法。' })
          return
        }
        if (optimising.has(name)) {
          sendJson(res, 409, { ok: false, error: '这一条正在处理，稍等一下再点。' })
          return
        }
        optimising.add(name)
        try {
          const result = await optimizeInPlace({
            file: absolute,
            backupDir: join(assetDir, 'originals'),
            scratchDir: join(assetDir, '.faststart-work'),
          })
          sendJson(res, 200, result)
        } finally {
          optimising.delete(name)
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

  // `ctx.on` already returns a disposer the fiber tracks, so it is registered
  // directly rather than wrapped in an effect — matching the other subscribers
  // of this event (ui-theme, client-modules, client-connection).
  ctx.on('webserver/index-inject', (table) => {
    const settings = currentSettings()

    // Switched off means switched off: no configuration row, no screen script, no
    // overlay, and not one request for a clip. The kernel's own boot page is what
    // shows. Injecting a disabled screen and making the script bail out would look
    // the same and leave the whole thing running; this is the only version of
    // "off" that is actually off.
    if (!settings.enabled) return

    // The row reads a plain global the script fills in, so the injection stays
    // JSON-serializable data and the script itself stays a static asset.
    table.push({
      kind: 'script',
      placement: 'head',
      text: `globalThis.__DSH_BOOT_ANIM_CFG__=${JSON.stringify({
        base: ROUTE,
        manifest: `${ROUTE}/clips.json`,
        holdMs: 15000,
        fadeMs: settings.fadeMs,
        enterMode: settings.enterMode,
        sound: settings.sound,
        clickToEnter: settings.clickToEnter,
        showHint: settings.showHint,
      })}`,
    })
    table.push({ kind: 'script', placement: 'head', text: bootScreenSource() })
  })
}

/**
 * The pre-boot screen source, re-read on every index render.
 *
 * Synchronous because the injection table is collected synchronously; the file is
 * a few kilobytes and read once per page load, not per request in a hot path.
 * A missing or unreadable file must not blank the boot page: the caller then
 * serves the kernel page alone, which is the documented fallback.
 * @returns the script text, or an empty string when the source cannot be read.
 */
function bootScreenSource() {
  try {
    return readFileSync(BOOT_SCREEN_PATH, 'utf8')
  } catch (error) {
    process.emitWarning(`boot-animation: cannot read ${BOOT_SCREEN_PATH}: ${String(error)}`)
    return ''
  }
}
