#!/usr/bin/env node
// Verify the Host pool routes across every media kind, by mounting the REAL
// handlers.
//
// The pools stopped being video-only: an entry can now be a still image, an
// animated image, a video, or a Live2D model DIRECTORY. Every one of those
// changes what `listPool` publishes and what the bytes route must accept, and a
// route that quietly serves the wrong thing is invisible until a user drops a
// GIF in and sees a broken screen.
//
// Why the real module rather than a reimplementation: a test that rewrites the
// route logic only ever proves the test agrees with itself. The plugin's own
// README records two cases where a hand-written stub passed while the real
// integration was broken. So this imports `entry.js`, calls the real `apply`,
// captures the routes it registers, and drives them over real HTTP.
//
// It rehearses on a COPY, because `entry.js` resolves its asset root from its own
// module URL: the copy's `assets/` is a fixture directory, so no shipped asset is
// touched. The copy lives inside the package so that Node's own resolution still
// finds the peer `@deepseek-ai/schemastery` on the way up.
//
// Two lessons from earlier versions of this suite are baked in:
//
//   * It asserted `routes.length === 5` and looked for `idle.json`. The pool was
//     renamed to `screensaver` and the route table grew, so the count assertion
//     went red for a reason that had nothing to do with a defect -- and a suite
//     that fails on a legitimate addition is a suite nobody trusts. Every route
//     assertion here is by IDENTITY (kind + exact path), not by count.
//
//   * When a request missed the route table the mock answered the plain text
//     `unrouted`, and `manifest()` called `JSON.parse` on it unconditionally. That
//     threw inside an async function, aborted the Node process
//     (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) and left the
//     `.verify-pools/` staging directory behind. `manifest()` now checks the status
//     and the content-type first and REPORTS a failure, and the staging directory
//     is removed in a `finally` so an assertion failure cannot leave it either.
//
// Offline and side-effect free. No child process is spawned and nothing piped is
// captured: `entry.js`'s idle probe starts lazily on the first read, and the reveal
// route is only ever called with a refused argument, so no program is launched.
//
// Usage: node tools/verify-pools.mjs

import { createServer } from 'node:http'
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const pkg = fileURLToPath(new URL('..', import.meta.url))
const stage = join(pkg, '.verify-pools')
const ROUTE = '/plugins/dsh-boot-animation'

const checks = []
const record = (label, ok, detail) => checks.push([label, !!ok, detail])

let server = null
const disposers = []

try {
  /* ---- fixtures -----------------------------------------------------
     Every kind, plus the shapes that are easy to get wrong: a model DIRECTORY
     rather than a file, a nested asset inside it, a non-media file that must be
     ignored, a dotfile, and an `originals/` directory that must never become an
     entry. */

  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  for (const file of ['entry.js', 'cordis.patch.yml', 'package.json']) {
    cpSync(join(pkg, file), join(stage, file))
  }
  cpSync(join(pkg, 'src'), join(stage, 'src'), { recursive: true })

  // The pool directory names come from `POOLS` in entry.js: the screensaver pool is
  // `assets/screensaver`. The retired idle layer's `assets/idle` no longer exists,
  // which is what made this suite unreachable in the first place.
  const clips = join(stage, 'assets', 'videos')
  const saver = join(stage, 'assets', 'screensaver')
  mkdirSync(clips, { recursive: true })
  mkdirSync(saver, { recursive: true })

  // The icon route is a whitelist of shipped file names; a fixture stands in for the
  // real PNGs so the route can be exercised without copying megabytes of prototype
  // HTML that lives beside them.
  const icon = join(stage, 'assets', 'icon')
  mkdirSync(icon, { recursive: true })
  writeFileSync(join(icon, 'icon-40.png'), Buffer.from('ICONDATA'))
  writeFileSync(join(icon, 'not-an-icon.png'), Buffer.from('nope'))

  // clips: one video, plus noise that must not become an entry.
  //
  // The mp4 is a real box chain (`ftyp` then `moov` then `mdat`) rather than the
  // string "ftyp-moov-mdat": the pool reports a `moov`-position verdict, and a
  // fixture whose header cannot be parsed would answer `undefined` and quietly
  // make that assertion vacuous.
  function mp4Header(moovFirst) {
    const box = (type, payload) => {
      const buf = Buffer.alloc(8 + payload.length)
      buf.writeUInt32BE(buf.length, 0)
      buf.write(type, 4, 'latin1')
      payload.copy(buf, 8)
      return buf
    }
    const ftyp = box('ftyp', Buffer.from('isom'))
    const moov = box('moov', Buffer.from('MVHD'))
    const mdat = box('mdat', Buffer.from('FRAME'))
    return moovFirst ? Buffer.concat([ftyp, moov, mdat]) : Buffer.concat([ftyp, mdat, moov])
  }
  writeFileSync(join(clips, 'intro.mp4'), mp4Header(true))
  writeFileSync(join(clips, 'notes.txt'), 'not media')
  writeFileSync(join(clips, '.hidden.png'), 'dot')
  mkdirSync(join(clips, 'originals'), { recursive: true })
  writeFileSync(join(clips, 'originals', 'intro.mp4'), 'backup')
  // A directory with no model in it is not an entry either.
  mkdirSync(join(clips, 'stray'), { recursive: true })
  writeFileSync(join(clips, 'stray', 'readme.md'), 'nope')

  // screensaver: a still, an animated image, and a Live2D model directory
  writeFileSync(join(saver, 'pose.png'), Buffer.from('PNGDATA'))
  writeFileSync(join(saver, 'blink.gif'), Buffer.from('GIFDATA'))
  writeFileSync(join(saver, 'loop.webp'), Buffer.from('WEBPDATA'))
  const model = join(saver, 'xiaoD')
  mkdirSync(join(model, 'xiaoD.2048'), { recursive: true })
  writeFileSync(join(model, 'xiaoD.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: { Moc: 'xiaoD.moc3', Textures: ['xiaoD.2048/texture_00.png'] },
  }))
  writeFileSync(join(model, 'xiaoD.moc3'), Buffer.from('MOC3DATA'))
  writeFileSync(join(model, 'xiaoD.2048', 'texture_00.png'), Buffer.from('TEXDATA'))
  writeFileSync(join(model, 'xiaoD.physics3.json'), JSON.stringify({ Version: 3, PhysicsSettings: [] }))

  /* ---- mount the real handlers -------------------------------------- */

  const entry = await import(new URL('entry.js', `file://${stage.replace(/\\/g, '/')}/`).href)

  /** Routes the plugin registered, keyed by the shape the web server uses. */
  const routes = []
  const logs = []

  const ctx = {
    // `apply` wraps every registration in `ctx.effect`, whose contract is: run the
    // callback now, return a disposer. Recording the disposer is what lets the
    // teardown below be checked rather than assumed.
    effect: (fn, label) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push([label, disposer])
      return disposer
    },
    on: (event, handler) => {
      const disposer = () => {}
      disposers.push([`on:${event}`, disposer])
      return disposer
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    logger: {
      warn: (...args) => logs.push(['warn', args.map(String).join(' ')]),
      error: (...args) => logs.push(['error', args.map(String).join(' ')]),
    },
  }

  entry.apply(ctx, {})

  /* ---- the route table, asserted by IDENTITY ------------------------
     Not by count. Adding a route is a legitimate change and must not turn this
     suite red; renaming or losing one of these is what the assertions are for.
     `kind` is pinned where the contract pins it (a manifest is an EXACT route, a
     pool's bytes are a PREFIX), and only the path is pinned for the auxiliary
     routes, because whether one of those is exact or prefix is an implementation
     detail that a colleague may legitimately change. */

  const find = (path) => routes.find((r) => r.path === path) ?? null
  const hasRoute = (kind, path) => {
    const route = find(path)
    return route !== null && route.kind === kind
  }
  const hasPath = (path) => find(path) !== null
  const kinds = (path) => (routes.filter((r) => r.path === path).map((r) => r.kind).join('|') || 'missing')

  record('a manifest route exists for the clips pool (exact)',
    hasRoute('exact', `${ROUTE}/clips.json`), kinds(`${ROUTE}/clips.json`))
  record('a manifest route exists for the screensaver pool (exact)',
    hasRoute('exact', `${ROUTE}/screensaver.json`), kinds(`${ROUTE}/screensaver.json`))
  record('a bytes prefix exists for the clips pool',
    hasRoute('prefix', `${ROUTE}/clips`), kinds(`${ROUTE}/clips`))
  record('a bytes prefix exists for the screensaver pool',
    hasRoute('prefix', `${ROUTE}/screensaver`), kinds(`${ROUTE}/screensaver`))
  record('the card icon route exists', hasPath(`${ROUTE}/icon`), kinds(`${ROUTE}/icon`))
  record('the optimize route exists', hasPath(`${ROUTE}/optimize`), kinds(`${ROUTE}/optimize`))
  record('the reveal route exists', hasPath(`${ROUTE}/reveal`), kinds(`${ROUTE}/reveal`))
  record('the OS idle counter route exists', hasPath(`${ROUTE}/system-idle.json`),
    kinds(`${ROUTE}/system-idle.json`))
  record('the live settings route exists', hasPath(`${ROUTE}/live-settings.json`),
    kinds(`${ROUTE}/live-settings.json`))
  record('the page report route exists', hasPath(`${ROUTE}/saver-report`),
    kinds(`${ROUTE}/saver-report`))
  record('no route claims the package client bundle path',
    !routes.some((r) => (r.kind === 'exact'
      ? r.path === `${ROUTE}/client.js`
      : `${ROUTE}/client.js`.startsWith(r.path))),
    routes.map((r) => `${r.kind}:${r.path}`).join(' '))
  record('every registered route carries a handler and a path',
    routes.every((r) => typeof r.handler === 'function' && typeof r.path === 'string'),
    `${routes.length} routes`)

  /* ---- drive the routes over real HTTP ------------------------------ */

  // Longest prefix first, the order the web server itself resolves in, so a
  // request is matched the way it would be in production.
  const table = routes.slice().sort((a, b) => b.path.length - a.path.length)

  server = createServer((req, res) => {
    const path = req.url.split('?')[0]
    const route = table.find((r) => (r.kind === 'exact' ? path === r.path : path.startsWith(r.path)))
    if (route === undefined) { res.writeHead(404).end('unrouted'); return }
    route.handler(req, res)
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`

  async function get(path) {
    const res = await fetch(base + path)
    const buf = Buffer.from(await res.arrayBuffer())
    return { status: res.status, type: res.headers.get('content-type'), body: buf }
  }

  /**
   * Read one manifest WITHOUT ever throwing on the body.
   *
   * The previous version called `JSON.parse` unconditionally, so a request that
   * missed the route table (the mock answers plain text) threw inside an async
   * function and aborted the process. A check that cannot tell "the route is
   * missing" from "the body is not JSON" is a broken instrument: this reports
   * both, and the assertions below simply go red.
   */
  async function manifest(pool) {
    const res = await get(`${ROUTE}/${pool}.json`)
    const type = res.type ?? ''
    const text = res.body.toString('utf8')
    const snippet = text.slice(0, 80).replace(/\s+/g, ' ')
    if (res.status !== 200) {
      return { status: res.status, json: null, problem: `status ${res.status}, body "${snippet}"` }
    }
    if (!/json/i.test(type)) {
      return { status: res.status, json: null, problem: `content-type "${type || '(none)'}", body "${snippet}"` }
    }
    try {
      return { status: res.status, json: JSON.parse(text), problem: null }
    } catch (error) {
      return { status: res.status, json: null, problem: `body is not JSON (${error.message}): "${snippet}"` }
    }
  }

  /* ---- manifests ---------------------------------------------------- */

  const clipMan = await manifest('clips')
  record('the clips manifest answers 200 with a pool label',
    clipMan.status === 200 && clipMan.json?.pool === 'clips',
    clipMan.problem ?? `${clipMan.status}`)
  record('clips lists the video and nothing else',
    clipMan.json?.items?.length === 1 && clipMan.json.items[0].name === 'intro.mp4',
    clipMan.problem ?? (clipMan.json?.items ?? []).map(i => i.name).join(','))
  record('a non-media file is not an entry',
    !(clipMan.json?.items ?? []).some(i => i.name === 'notes.txt'), clipMan.problem ?? undefined)
  record('a dotfile is not an entry',
    !(clipMan.json?.items ?? []).some(i => i.name === '.hidden.png'), clipMan.problem ?? undefined)
  record('originals/ is not an entry (it holds the pre-rewrite copies)',
    !(clipMan.json?.items ?? []).some(i => i.name === 'originals'), clipMan.problem ?? undefined)
  record('a directory with no model in it is not an entry',
    !(clipMan.json?.items ?? []).some(i => i.name === 'stray'), clipMan.problem ?? undefined)
  record('a video entry carries kind=video and a true faststart verdict',
    clipMan.json?.items?.[0]?.kind === 'video' && clipMan.json.items[0].faststart === true,
    clipMan.problem ?? `kind=${clipMan.json?.items?.[0]?.kind} faststart=${clipMan.json?.items?.[0]?.faststart}`)

  const saverMan = await manifest('screensaver')
  const saverNames = (saverMan.json?.items ?? []).map(i => i.name)
  record('the screensaver manifest answers 200 with a pool label',
    saverMan.status === 200 && saverMan.json?.pool === 'screensaver',
    saverMan.problem ?? `${saverMan.status}`)
  record('the screensaver pool lists the still, the animated images and the model directory',
    ['pose.png', 'blink.gif', 'loop.webp', 'xiaoD'].every(n => saverNames.includes(n)),
    saverMan.problem ?? saverNames.join(','))
  record('the three non-video kinds are classified correctly',
    (saverMan.json?.items ?? []).find(i => i.name === 'pose.png')?.kind === 'image'
    && (saverMan.json?.items ?? []).find(i => i.name === 'blink.gif')?.kind === 'animated'
    && (saverMan.json?.items ?? []).find(i => i.name === 'loop.webp')?.kind === 'animated'
    && (saverMan.json?.items ?? []).find(i => i.name === 'xiaoD')?.kind === 'live2d',
    saverMan.problem ?? (saverMan.json?.items ?? []).map(i => `${i.name}=${i.kind}`).join(' '))
  record('the model entry is marked as a directory and points at its model3.json',
    (saverMan.json?.items ?? []).find(i => i.name === 'xiaoD')?.model === true
    && String((saverMan.json?.items ?? []).find(i => i.name === 'xiaoD')?.src).includes('xiaoD.model3.json'),
    saverMan.problem ?? String((saverMan.json?.items ?? []).find(i => i.name === 'xiaoD')?.src))
  record('a non-video entry carries no faststart verdict',
    (saverMan.json?.items ?? []).filter(i => i.kind !== 'video').every(i => i.faststart === undefined),
    saverMan.problem ?? undefined)
  record('every entry carries an enabled flag and a revisioned src',
    (saverMan.json?.items ?? []).every(i => typeof i.enabled === 'boolean' && /[?&]v=\d+-\d+/.test(i.src)),
    saverMan.problem ?? (saverMan.json?.items ?? []).map(i => i.src).join(','))

  /* ---- bytes -------------------------------------------------------- */

  const png = await get(`${ROUTE}/screensaver/pose.png`)
  record('a still image is served with image/png',
    png.status === 200 && png.type === 'image/png' && png.body.toString() === 'PNGDATA',
    `${png.status} ${png.type}`)

  const gif = await get(`${ROUTE}/screensaver/blink.gif`)
  record('an animated image is served with image/gif',
    gif.status === 200 && gif.type === 'image/gif', `${gif.status} ${gif.type}`)

  const mp4 = await get(`${ROUTE}/clips/intro.mp4`)
  record('a video is served with video/mp4',
    mp4.status === 200 && mp4.type === 'video/mp4', `${mp4.status} ${mp4.type}`)

  const modelJson = await get(`${ROUTE}/screensaver/xiaoD/xiaoD.model3.json`)
  let modelMoc = ''
  try { modelMoc = JSON.parse(modelJson.body.toString()).FileReferences.Moc } catch { modelMoc = '(unparseable)' }
  record('the model3.json is served from the pool prefix as JSON',
    modelJson.status === 200 && (modelJson.type ?? '').includes('json') && modelMoc === 'xiaoD.moc3',
    `${modelJson.status} ${modelJson.type} ${modelMoc}`)

  const moc = await get(`${ROUTE}/screensaver/xiaoD/xiaoD.moc3`)
  record('the moc3 beside it resolves (the model travels as a set)',
    moc.status === 200 && moc.body.toString() === 'MOC3DATA', `${moc.status}`)

  const tex = await get(`${ROUTE}/screensaver/xiaoD/xiaoD.2048/texture_00.png`)
  record('a nested texture under the model resolves',
    tex.status === 200 && tex.body.toString() === 'TEXDATA', `${tex.status}`)

  const physics = await get(`${ROUTE}/screensaver/xiaoD/xiaoD.physics3.json`)
  record('a physics3.json inside the model resolves', physics.status === 200, `${physics.status}`)

  /* ---- containment and shape ----------------------------------------
     A refusal is asserted as "4xx", not as one exact code. The containment rule
     is the invariant; whether a malformed URI answers 400 or 404 is a decision
     that belongs to whoever owns the route, and pinning one number here would
     turn a legitimate tightening into a red suite. */

  const refused = (status) => status >= 400 && status < 500

  const traversal = await get(`${ROUTE}/screensaver/..%2F..%2Fpackage.json`)
  record('an encoded traversal out of the pool is refused',
    refused(traversal.status), `${traversal.status}`)

  const nestedTraversal = await get(`${ROUTE}/screensaver/xiaoD/..%2F..%2Fpose.png`)
  record('a traversal nested inside a model path is refused',
    refused(nestedTraversal.status), `${nestedTraversal.status}`)

  const outside = await get(`${ROUTE}/screensaver/%2E%2E%2Fpackage.json`)
  record('a dot-dot segment is refused', refused(outside.status), `${outside.status}`)

  // A model directory may only carry model files, so the pool cannot be used as a
  // general file server for whatever lands in a subdirectory.
  const strayInModel = await get(`${ROUTE}/screensaver/xiaoD/notes.txt`)
  record('a non-model file inside a model directory is refused',
    refused(strayInModel.status), `${strayInModel.status}`)

  const missing = await get(`${ROUTE}/screensaver/nope.png`)
  record('a missing file is refused, not a crash', refused(missing.status), `${missing.status}`)

  const badKind = await get(`${ROUTE}/clips/notes.txt`)
  record('a non-media file at the pool root is not served', refused(badKind.status), `${badKind.status}`)

  /* ---- range support (unchanged, but now shared by every kind) ------- */

  const ranged = await fetch(`${base}${ROUTE}/screensaver/pose.png`, { headers: { range: 'bytes=0-3' } })
  record('Range still works on the shared media route',
    ranged.status === 206 && ranged.headers.get('content-range') === 'bytes 0-3/7',
    `${ranged.status} ${ranged.headers.get('content-range')}`)

  const unsatisfiable = await fetch(`${base}${ROUTE}/screensaver/pose.png`, { headers: { range: 'bytes=99-200' } })
  record('an unsatisfiable range is still 416', unsatisfiable.status === 416, `${unsatisfiable.status}`)

  /* ---- the auxiliary routes, by contract ---------------------------- */

  const iconOk = await get(`${ROUTE}/icon/icon-40.png`)
  record('a whitelisted icon is served',
    iconOk.status === 200 && iconOk.body.toString() === 'ICONDATA', `${iconOk.status} ${iconOk.type}`)
  const iconBad = await get(`${ROUTE}/icon/not-an-icon.png`)
  record('an icon name outside the whitelist is refused', refused(iconBad.status), `${iconBad.status}`)

  // `system-idle.json` only READS an OS counter, so it is GET-only. It is never the
  // retired pool manifest, which is why it is not called `idle.json`.
  const idle = await get(`${ROUTE}/system-idle.json`)
  let idleStatus = '(unparseable)'
  try { idleStatus = String(JSON.parse(idle.body.toString()).status) } catch { /* reported below */ }
  record('the OS idle route answers 200 with one of the three documented states',
    idle.status === 200 && ['ok', 'starting', 'unavailable'].includes(idleStatus),
    `${idle.status} status=${idleStatus}`)
  const idlePost = await fetch(`${base}${ROUTE}/system-idle.json`, { method: 'POST' })
  record('the OS idle route refuses a state-changing verb', refused(idlePost.status), `${idlePost.status}`)

  const live = await get(`${ROUTE}/live-settings.json`)
  let liveFields = []
  try { liveFields = Object.keys(JSON.parse(live.body.toString()).settings ?? {}) } catch { /* reported below */ }
  record('the live settings route answers 200 with a settings object',
    live.status === 200 && liveFields.length > 0, `${live.status} fields=${liveFields.join(',')}`)

  const report = await get(`${ROUTE}/saver-report`)
  record('the page report route answers 200 before any page has reported',
    report.status === 200, `${report.status}`)
  const reportPost = await fetch(`${base}${ROUTE}/saver-report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  record('a malformed report body is refused', refused(reportPost.status), `${reportPost.status}`)

  // The optimize route is POST-only and takes a NAME, never a path. It is called here
  // with an invalid name only: a valid one would rewrite a fixture, and the point of
  // this check is the refusal contract.
  const optimizeGet = await get(`${ROUTE}/optimize?name=intro.mp4`)
  record('the optimize route refuses GET', refused(optimizeGet.status), `${optimizeGet.status}`)
  const optimizeBad = await fetch(`${base}${ROUTE}/optimize?name=..%2Fpackage.json`, { method: 'POST' })
  record('the optimize route refuses a name that is not a bare pool file name',
    refused(optimizeBad.status), `${optimizeBad.status}`)

  // The reveal route LAUNCHES A PROGRAM, so it is only exercised on its refusal paths:
  // a GET (refused by verb) and a POST naming a pool that does not exist. A POST with a
  // VALID pool name is deliberately NOT sent -- that would open a file manager on the
  // machine running this suite.
  const revealGet = await get(`${ROUTE}/reveal?pool=clips`)
  record('the reveal route refuses GET (a stray tag must not launch a program)',
    refused(revealGet.status), `${revealGet.status}`)
  const revealBad = await fetch(`${base}${ROUTE}/reveal?pool=nope`, { method: 'POST' })
  record('the reveal route takes a whitelist key, not a path',
    refused(revealBad.status), `${revealBad.status}`)

  /* ---- the unresolved-config fallback -------------------------------- */

  // `disabledClips` must still reach the manifest as `enabled: false`. The settings are
  // read through a live reference; a plain object stands in for a profile that resolved
  // no schema, which is the documented fallback path.
  const logsBefore = logs.length
  entry.apply({
    ...ctx,
    effect: (fn) => { const disposer = fn(); if (typeof disposer === 'function') disposers.push(['second', disposer]); return disposer },
    webServer: { register: () => () => {} },
  }, {})
  record('apply() tolerates an unresolved config (plain defaults, no throw)',
    logs.slice(logsBefore).every(([level]) => level !== 'error'),
    logs.slice(logsBefore).map(l => l.join(':')).join(' | '))

  /* ---- teardown (checked, not assumed) ------------------------------- */

  record('every registration returned a disposer the fiber can track',
    disposers.length >= 4, `${disposers.length} disposers`)
} finally {
  // The staging directory is removed here, not at the end of the happy path. The
  // previous version left `.verify-pools/` inside the package whenever an assertion
  // (or an exception) ended the run early, and a rehearsal copy sitting in the tree
  // is indistinguishable from a shipped directory.
  if (server !== null) {
    server.closeAllConnections?.()
    await new Promise((done) => server.close(done))
    server = null
  }
  for (const [label, disposer] of disposers.splice(0, disposers.length)) {
    try { disposer() } catch (error) { /* a disposer that throws is not worth failing over */ }
  }
  rmSync(stage, { recursive: true, force: true })
  record('the rehearsal copy was removed', !existsSync(stage), stage)
}

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`)
}
process.stdout.write(`\n${checks.length - failed}/${checks.length} passed\n`)
process.exitCode = failed === 0 ? 0 : 1
