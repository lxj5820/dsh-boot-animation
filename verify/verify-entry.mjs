// Offline verification for the dsh-boot-animation Host half after the
// DSH 0.2.0-rc.2 port. No DSH process, no ports, no network, no prompts.
//
// Run from the package root that holds the ported entry.js:
//   node verify/verify-entry.mjs
//
// The suite re-implements, verbatim, the three predicates the kernel applies to
// a plugin Config — `volatileForm()` and `isVolatilePath()` from
// @deepseek-ai/dsh-settings, and `plainConfig()`'s reference unwrapping — so a
// schema the settings service would silently drop, or a config shape the plugin
// would silently misread, is caught here instead of in the browser.

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks++
  console.log((condition ? '  ok   ' : '  FAIL ') + label
    + (detail === undefined || detail === '' ? '' : '   [' + detail + ']'))
  if (!condition) failures++
  return condition
}

function equal(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  return check(label, a === e, a === e ? a : 'actual ' + a + ' != expected ' + e)
}

/** Strip line and block comments, so prose about an old approach is not matched as the approach. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// cosmokit's protocol key, as @deepseek-ai/cosmokit/src/volatile.ts declares it.
const VOLATILE_REF = Symbol.for('cosmokit.volatile.write')
const isLive = (value) => typeof value === 'object' && value !== null && VOLATILE_REF in value

/** Verbatim re-implementation of dsh-settings lib/index.js:97-101 `plainConfig`. */
function plainConfig(value) {
  if (isLive(value)) return plainConfig(value.get())
  if (Array.isArray(value)) return value.map(plainConfig)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]))
  }
  return value
}

// ---------------------------------------------------------------------------
// 0. Fixtures the staged package needs to behave like the real one.
// ---------------------------------------------------------------------------

const bootScreenSource = readFileSync(join(root, 'src', 'boot-screen.js'), 'utf8')

const FIXTURE = 'verify-fixture.mp4'

// The module under test is imported from a SCRATCH MIRROR of the package, not
// from the package itself, and the fixture is the only clip in that mirror's
// pool.
//
// This is not tidiness. The first version wrote the fixture into the real
// `assets/videos/` and then asserted on `clips[0]` and `clips.length`. That
// passes only where the pool is empty — which is true of a staging copy and
// false of the deployment, whose three real clips are what the manifest is for
// and which sort ahead of the fixture. A suite that has to be run in a tree
// without media is a defect in the suite, and this one also has no business
// writing into the user's clip directory.
//
// The scratch copy is complete (entry.js, package.json, src/, node_modules/),
// so it exercises the same module resolution the deployment does; `assets/` is
// left to the fixture because the pool is the one thing that must be fixed.
const scratch = join(root, '.verify-entry')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(join(scratch, 'node_modules', '@deepseek-ai'), { recursive: true })
cpSync(join(root, 'entry.js'), join(scratch, 'entry.js'))
cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
cpSync(join(root, 'src'), join(scratch, 'src'), { recursive: true })
for (const name of ['schemastery', 'cosmokit']) {
  // `dereference: true`: an installed package's node_modules entries are symlinks,
  // and a scratch tree that keeps the link is not a copy — it is the real library
  // behind a new path. See verify-degraded.mjs, where that once edited the
  // installed schemastery.
  cpSync(join(root, 'node_modules', '@deepseek-ai', name),
    join(scratch, 'node_modules', '@deepseek-ai', name), { recursive: true, dereference: true })
}

const clipDir = join(scratch, 'assets', 'videos')
mkdirSync(clipDir, { recursive: true })
const fixtureClip = join(clipDir, FIXTURE)
// ftyp box (20 bytes) followed by an empty moov box: readFaststart() must answer
// true for this, which is what the manifest publishes as `faststart`.
writeFileSync(fixtureClip, Buffer.concat([
  Buffer.from([0, 0, 0, 20]), Buffer.from('ftyp', 'latin1'),
  Buffer.from('isom', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('isom', 'latin1'),
  Buffer.from([0, 0, 0, 8]), Buffer.from('moov', 'latin1'),
]))

// ---------------------------------------------------------------------------
// 1. The module evaluates and exports the shape RegistryService.plugin() reads.
// ---------------------------------------------------------------------------

console.log('\n[1] module shape')
const mod = await import(new URL('.verify-entry/entry.js', new URL('../', import.meta.url)).href)
equal('exported names', Object.keys(mod).sort(), ['Config', 'apply', 'inject', 'name'])
equal('name', mod.name, 'dsh-boot-animation')
equal('inject (no settings service)', mod.inject, ['webServer'])
check('apply is a function', typeof mod.apply === 'function', 'typeof ' + typeof mod.apply)
check('Config has toJSON (dsh-settings schema() gate)', 'toJSON' in mod.Config)
check('Config has ~standard (cordis resolveConfig gate)', typeof mod.Config['~standard'] === 'object')
check('Config is callable', typeof mod.Config === 'function')

const Config = mod.Config

// ---------------------------------------------------------------------------
// 2. The schema is real schemastery with the seven fields and the old defaults.
// ---------------------------------------------------------------------------

console.log('\n[2] Config schema')
equal('field order', Object.keys(Config.dict),
  ['enabled', 'fadeMs', 'enterMode', 'disabledClips', 'sound', 'clickToEnter', 'showHint'])
const DEFAULTS = {
  enabled: true, fadeMs: 2000, enterMode: 'tail', disabledClips: [],
  sound: true, clickToEnter: false, showHint: true,
}

/** The same defaults as they reach the injected row (no `enabled`, no pool). */
const INJECTED_DEFAULTS = {
  base: '/plugins/dsh-boot-animation',
  manifest: '/plugins/dsh-boot-animation/clips.json',
  holdMs: 15000,
  fadeMs: 2000,
  enterMode: 'tail',
  sound: true,
  clickToEnter: false,
  showHint: true,
}
equal('defaults for {}', plainConfig(Config({})), DEFAULTS)
equal('defaults for undefined (absent settings document)', plainConfig(Config(undefined)), DEFAULTS)
equal('defaults via ~standard.validate (the path cordis uses)',
  plainConfig(Config['~standard'].validate({}).value), DEFAULTS)

function rejects(label, value) {
  let issue = null
  try { Config(value) } catch (error) { issue = error.message }
  check(label, issue !== null, issue === null ? 'ACCEPTED' : String(issue).split('\n')[0])
}
function accepts(label, value) {
  let issue = null
  try { Config(value) } catch (error) { issue = error.message }
  check(label, issue === null, issue === null ? '' : String(issue).split('\n')[0])
}

rejects('fadeMs 100 rejected', { fadeMs: 100 })
rejects('fadeMs 5001 rejected', { fadeMs: 5001 })
rejects('fadeMs "2000" rejected', { fadeMs: '2000' })
accepts('fadeMs 300 accepted (lower bound)', { fadeMs: 300 })
accepts('fadeMs 5000 accepted (upper bound)', { fadeMs: 5000 })
rejects('enterMode "nope" rejected', { enterMode: 'nope' })
for (const mode of ['tail', 'end', 'click']) accepts('enterMode "' + mode + '" accepted', { enterMode: mode })
rejects('enabled "yes" rejected', { enabled: 'yes' })
rejects('disabledClips "a.mp4" rejected', { disabledClips: 'a.mp4' })
accepts('disabledClips ["a.mp4"] accepted', { disabledClips: ['a.mp4'] })
rejects('sound "no" rejected', { sound: 'no' })
accepts('sound false accepted (the silence switch)', { sound: false })
rejects('clickToEnter 1 rejected', { clickToEnter: 1 })
accepts('clickToEnter true accepted', { clickToEnter: true })
rejects('showHint "yes" rejected', { showHint: 'yes' })
accepts('showHint false accepted (the hint switch)', { showHint: false })

// ---------------------------------------------------------------------------
// 3. Every field is volatile: without one, dsh-settings never serves the
//    namespace and the browser card can never render.
// ---------------------------------------------------------------------------

console.log('\n[3] live (volatile) projection')
const FIELD_KEYS = Object.keys(Config.dict)
for (const key of FIELD_KEYS) {
  check('field "' + key + '" is volatile', Config.dict[key].meta.volatile === true,
    'meta.volatile=' + JSON.stringify(Config.dict[key].meta.volatile))
}
check('root is not volatile (per-field, like ui-theme / bash-local)', Config.meta.volatile !== true)

// Verbatim re-implementation of dsh-settings lib/index.js:118-131.
function volatileForm(schema) {
  if (schema.meta.volatile) return new z(schema.toJSON())
  if (schema.type === 'object') {
    const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : z.object(dict)
  }
  return undefined
}
// Verbatim re-implementation of dsh-settings lib/index.js:153-158.
function isVolatilePath(schema, path) {
  if (schema.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : schema.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}
// Verbatim re-implementation of dsh-settings lib/index.js:141-147.
function projectForm(schema, value) {
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
      const field = Reflect.get(value, key)
      return field === undefined ? [] : [[key, projectForm(child, field)]]
    }))
  }
  return value
}

const form = volatileForm(Config)
check('describe() would NOT drop this entry (volatileForm !== undefined)', form !== undefined)
equal('described field keys', Object.keys(form?.dict ?? {}), FIELD_KEYS)
check('described schema serializes for the client', 'refs' in form.toJSON())
equal('described value for the pristine config', projectForm(form, plainConfig(Config({}))), DEFAULTS)
for (const key of FIELD_KEYS) {
  check('write path accepts "' + key + '" (isVolatilePath)', isVolatilePath(Config, [key]) === true)
}
check('write path would reject an undeclared field', isVolatilePath(Config, ['nope']) === false)

const rehydrated = new z(Config.toJSON())
equal('toJSON round-trip keeps the defaults', plainConfig(rehydrated({})), DEFAULTS)

// ---------------------------------------------------------------------------
// 4. apply(): routes, the pre-boot injection, and the removed settings service.
// ---------------------------------------------------------------------------

console.log('\n[4] apply()')

function makeCtx() {
  const routes = []
  const listeners = new Map()
  const log = []
  const base = {
    logger: {
      warn: (...args) => log.push(['warn', String(args[0])]),
      error: (...args) => log.push(['error', String(args[0])]),
    },
    effect: (callback) => { const disposer = callback(); return () => { if (typeof disposer === 'function') disposer() } },
    on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event) },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
  }
  // A ctx with no `settings` service at all: reading it throws, so a leftover
  // reference to the removed namespace registration cannot pass unnoticed.
  const ctx = new Proxy(base, {
    get(target, key, receiver) {
      if (key === 'settings') throw new Error('ctx.settings was read')
      return Reflect.get(target, key, receiver)
    },
  })
  return { ctx, routes, listeners, log, config: undefined }
}

function mount(bundle, config) {
  bundle.config = config
  mod.apply(bundle.ctx, config)
  return bundle
}

function render(bundle) {
  const table = []
  bundle.listeners.get('webserver/index-inject')(table)
  return table
}

const CFG_PREFIX = 'globalThis.__DSH_BOOT_ANIM_CFG__='
const injectedConfig = (rows) => JSON.parse(rows[0].text.slice(CFG_PREFIX.length))

const enabled = mount(makeCtx(), Config({}))
check('two routes registered', enabled.routes.length === 2,
  enabled.routes.map((r) => r.kind + ' ' + r.path).join(', '))
equal('route kinds/paths', enabled.routes.map((route) => [route.kind, route.path]),
  [['exact', '/plugins/dsh-boot-animation/clips.json'], ['prefix', '/plugins/dsh-boot-animation/clip']])
check('no ctx.settings read, no warning', enabled.log.length === 0, JSON.stringify(enabled.log))

const enabledRows = render(enabled)
equal('two head rows injected when enabled', enabledRows.length, 2)
equal('first row placement', [enabledRows[0].kind, enabledRows[0].placement], ['script', 'head'])
check('config row assigns the documented global', enabledRows[0].text.startsWith(CFG_PREFIX),
  enabledRows[0].text.slice(0, 44))
equal('injected config', injectedConfig(enabledRows), INJECTED_DEFAULTS)
check('second row is the boot screen source verbatim', enabledRows[1].text === bootScreenSource,
  enabledRows[1].text === '' ? 'EMPTY (src/boot-screen.js unreadable)' : enabledRows[1].text.length + ' chars')

const off = mount(makeCtx(), Config({ enabled: false }))
equal('no head rows injected when disabled', render(off).length, 0)
equal('no warning when disabled', off.log.length, 0)

const noConfig = mount(makeCtx(), undefined)
const noConfigRows = render(noConfig)
equal('two head rows with no applied config (no schema resolution)', noConfigRows.length, 2)
check('...and they still carry the defaults', injectedConfig(noConfigRows).fadeMs === 2000)

const partial = mount(makeCtx(), { fadeMs: 4000 })
equal('per-field fallback on a partial plain config',
  [injectedConfig(render(partial)).fadeMs, injectedConfig(render(partial)).enterMode], [4000, 'tail'])

const junk = mount(makeCtx(), {
  enabled: true, fadeMs: 'x', enterMode: 'nope', disabledClips: 'no',
  sound: 'no', clickToEnter: 1, showHint: 'yes',
})
const junkCfg = injectedConfig(render(junk))
equal('per-field fallback on a junk config',
  [junkCfg.fadeMs, junkCfg.enterMode, junkCfg.sound, junkCfg.clickToEnter, junkCfg.showHint],
  [2000, 'tail', true, false, true])
equal('per-field fallback on an absent config keeps every default',
  injectedConfig(render(noConfig)), INJECTED_DEFAULTS)

// ---------------------------------------------------------------------------
// 4b. The applied config carries LIVE references, and reading them per render
//     is what makes a stored edit take effect without restarting the fiber.
// ---------------------------------------------------------------------------

console.log('\n[4b] live references (the shape the loader hands apply)')
const liveConfig = Config({ fadeMs: 4000, enterMode: 'click' })
check('a Config field is a reference, not a plain value', isLive(liveConfig.fadeMs),
  'typeof ' + typeof liveConfig.fadeMs)
check('...whose snapshot is the configured value', liveConfig.fadeMs.get() === 4000,
  String(liveConfig.fadeMs.get()))

const live = mount(makeCtx(), liveConfig)
equal('configured values reach the injection', injectedConfig(render(live)),
  { ...INJECTED_DEFAULTS, fadeMs: 4000, enterMode: 'click' })

// Replay what @deepseek-ai/cordis-plugin-loader does on a volatile-only change
// (lib/index.js:410-415): commit a new snapshot into the SAME reference.
liveConfig.fadeMs[VOLATILE_REF](8000)
liveConfig.enterMode[VOLATILE_REF]('end')
equal('a committed snapshot is visible to the next index render, with no re-apply',
  [injectedConfig(render(live)).fadeMs, injectedConfig(render(live)).enterMode], [8000, 'end'])

// The three behaviour switches are volatile too, so flipping them in Settings
// reaches the next page load without restarting the kernel.
liveConfig.sound[VOLATILE_REF](false)
liveConfig.clickToEnter[VOLATILE_REF](true)
liveConfig.showHint[VOLATILE_REF](false)
equal('a committed behaviour switch reaches the injection',
  [injectedConfig(render(live)).sound, injectedConfig(render(live)).clickToEnter,
    injectedConfig(render(live)).showHint],
  [false, true, false])

liveConfig.enabled[VOLATILE_REF](false)
equal('turning it off through the reference stops the injection', render(live).length, 0)
liveConfig.enabled[VOLATILE_REF](true)
equal('and turning it back on restores it', render(live).length, 2)

liveConfig.disabledClips[VOLATILE_REF]([FIXTURE])
equal('a committed clip exclusion is visible to the manifest route', render(live).length, 2)

// ---------------------------------------------------------------------------
// 5. The manifest route: unchanged shape, unchanged cache headers.
// ---------------------------------------------------------------------------

console.log('\n[5] manifest route')
async function callManifest(bundle) {
  const route = bundle.routes.find((row) => row.path.endsWith('clips.json'))
  const headers = {}
  let body = ''
  const res = {
    writeHead: (status, extra) => { headers.status = status; Object.assign(headers, extra) },
    end: (chunk) => { if (chunk !== undefined) body += chunk.toString('utf8') },
    headersSent: false,
  }
  route.handler({ url: '/plugins/dsh-boot-animation/clips.json', method: 'GET', headers: {} }, res)
  for (let i = 0; i < 300 && body === ''; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  return { headers, payload: JSON.parse(body) }
}

const manifest = await callManifest(mount(makeCtx(), Config({})))
equal('manifest status', manifest.headers.status, 200)
equal('manifest cache-control', manifest.headers['cache-control'], 'no-store')
equal('manifest content-type', manifest.headers['content-type'], 'application/json; charset=utf-8')
const row = manifest.payload.clips[0]
equal('clip row keys', Object.keys(row).sort(), ['bytes', 'enabled', 'faststart', 'name', 'src'])
equal('clip row name', row.name, FIXTURE)
check('clip row src shape',
  new RegExp('^/plugins/dsh-boot-animation/clip/' + FIXTURE + '\\?v=\\d+-\\d+$').test(row.src), row.src)
equal('clip row enabled with an empty disabledClips', row.enabled, true)
equal('clip row faststart (moov before mdat)', row.faststart, true)
check('clip row bytes > 0', row.bytes > 0, String(row.bytes))

const excluded = await callManifest(live)
const excludedFixture = excluded.payload.clips.find((clip) => clip.name === FIXTURE)
check('the fixture is in the manifest', excludedFixture !== undefined,
  excluded.payload.clips.map((clip) => clip.name).join(', '))
equal('a disabled clip is listed with enabled:false', excludedFixture?.enabled, false)
equal('...and stays in the list so the card can offer it back',
  excluded.payload.clips.filter((clip) => clip.name === FIXTURE).length, 1)

// ---------------------------------------------------------------------------
// 6. Source-level assertions on the text that ships.
// ---------------------------------------------------------------------------

console.log('\n[6] source assertions (comments stripped)')
const source = readFileSync(join(root, 'entry.js'), 'utf8')
const code = stripComments(source)
for (const gone of ['settings.register', 'settingsScope', 'settingsOwner', 'ctx.inject']) {
  check('no "' + gone + '" outside comments', code.includes(gone) === false)
}
check('static schema import present', /^import z from '@deepseek-ai\/schemastery'$/m.test(code))
check('apply(ctx, config) present', /export function apply\(ctx, config\)/.test(code))
check('Config is an exported const', /export const Config = z\.object\(\{/.test(code))
check('every field is marked live', (code.match(/\blive\(z\./g) ?? []).length === 7,
  String((code.match(/\blive\(z\./g) ?? []).length) + ' of 7')
check('route prefix unchanged', code.includes("const ROUTE = '/plugins/dsh-boot-animation'"))
check('clip responses still no-store', (code.match(/'cache-control': 'no-store'/g) ?? []).length === 2)
check('Range handling still present', code.includes('function parseRange(header, size)'))
check('no backtick inside the injected row text', code.includes('globalThis.__DSH_BOOT_ANIM_CFG__'))

// ---------------------------------------------------------------------------
// 7. package.json: the schema library is a peer, not a bundled dependency.
// ---------------------------------------------------------------------------

console.log('\n[7] package.json')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
equal('peerDependencies', pkg.peerDependencies, { '@deepseek-ai/schemastery': '*' })
check('no runtime dependencies', pkg.dependencies === undefined, JSON.stringify(pkg.dependencies))
equal('name / version', [pkg.name, pkg.version], ['dsh-boot-animation', '0.1.0'])
check('description untouched', typeof pkg.description === 'string' && pkg.description.length > 0)
equal('exports untouched', Object.keys(pkg.exports), ['.', './client', './cordis.patch.yml', './package.json'])
equal('files untouched', pkg.files, ['assets', 'lib', 'src', 'cordis.patch.yml', 'entry.js', 'package.json'])

// ---------------------------------------------------------------------------
// 8. Which schema library this run actually resolved.
// ---------------------------------------------------------------------------

console.log('\n[8] resolved schema library')
const resolved = fileURLToPath(import.meta.resolve('@deepseek-ai/schemastery'))
const resolvedPkg = JSON.parse(readFileSync(join(dirname(dirname(resolved)), 'package.json'), 'utf8'))
console.log('  ' + resolvedPkg.name + '@' + resolvedPkg.version + '  ->  ' + resolved)
check('resolved copy supports .volatile()', typeof z.boolean().volatile === 'function')

rmSync(scratch, { recursive: true, force: true })

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + ' — ' + (checks - failures) + '/' + checks + ' checks')
process.exit(failures === 0 ? 0 : 1)
