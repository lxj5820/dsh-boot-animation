// Offline proof of the degradation path: an older @deepseek-ai/schemastery
// without `Schema.prototype.volatile` must not take the whole plugin down with
// the settings card.
//
// The copy beside a workspace checkout really is 3.18.1, and 3.18.1 has no
// `volatile` in either lib/index.mjs or lib/index.cjs (measured, 0 occurrences).
// Rather than depend on that checkout, this suite reproduces the condition
// exactly — same library, method renamed away — in a scratch directory.
//
// Run from the package root:  node verify/verify-degraded.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, lstatSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const scratch = join(root, '.verify-degraded')

let failures = 0
let checks = 0
function check(label, condition, detail) {
  checks++
  console.log((condition ? '  ok   ' : '  FAIL ') + label
    + (detail === undefined || detail === '' ? '' : '   [' + detail + ']'))
  if (!condition) failures++
}

function rewrite(path) {
  const before = readFileSync(path, 'utf8')
  const after = before.replace(/Schema\.prototype\.volatile =/g, 'Schema.prototype.volatileUnavailable =')
  if (after === before) throw new Error('nothing to rename in ' + path)
  writeFileSync(path, after)
}

rmSync(scratch, { recursive: true, force: true })
mkdirSync(join(scratch, 'node_modules', '@deepseek-ai'), { recursive: true })
cpSync(join(root, 'entry.js'), join(scratch, 'entry.js'))
cpSync(join(root, 'package.json'), join(scratch, 'package.json'))
cpSync(join(root, 'src'), join(scratch, 'src'), { recursive: true })
// `dereference: true` is load-bearing, not tidiness. Installed, this package's
// node_modules entries are SYMLINKS (a profile links the bundle in), and a
// recursive copy that preserves symlinks makes the scratch tree point back at the
// real library — so the rename below edits the library DSH itself loads. That
// happened: it silently removed `.volatile()` from the installed schemastery.
for (const name of ['schemastery', 'cosmokit']) {
  cpSync(join(root, 'node_modules', '@deepseek-ai', name),
    join(scratch, 'node_modules', '@deepseek-ai', name), { recursive: true, dereference: true })
}
const scratchSchema = join(scratch, 'node_modules', '@deepseek-ai', 'schemastery')
check('the scratch schema library is a real copy, not a link back to the installed one',
  lstatSync(scratchSchema).isSymbolicLink() === false, lstatSync(scratchSchema).isSymbolicLink() ? 'symlink' : 'directory')
rewrite(join(scratchSchema, 'lib', 'index.mjs'))
rewrite(join(scratchSchema, 'lib', 'index.cjs'))

console.log('\n[1] an older schema library')
const mod = await import(new URL('.verify-degraded/entry.js', new URL('../', import.meta.url)).href)
const z = (await import(pathToFileURL(join(scratch, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')).href)).default
check('the scratch library really lacks .volatile()', typeof z.boolean().volatile !== 'function')
check('the module still evaluates', typeof mod.apply === 'function')
check('Config is still exported', 'toJSON' in mod.Config)
equal('every field degrades to non-volatile',
  Object.keys(mod.Config.dict).map((key) => mod.Config.dict[key].meta.volatile ?? null),
  [null, null, null, null, null, null, null])

function equal(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(label, a === e, a === e ? a : 'actual ' + a + ' != expected ' + e)
}

console.log('\n[2] the plugin still boots')
const routes = []
const listeners = new Map()
const log = []
const ctx = {
  logger: { warn: (...args) => log.push(String(args[0])), error: (...args) => log.push(String(args[0])) },
  effect: (callback) => { const disposer = callback(); return () => { if (typeof disposer === 'function') disposer() } },
  on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event) },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
}
mod.apply(ctx, mod.Config({}))
check('both routes are registered', routes.length === 2, routes.map((r) => r.path).join(', '))
const table = []
check('the injection listener is subscribed', typeof listeners.get('webserver/index-inject') === 'function')
listeners.get('webserver/index-inject')(table)
equal('the pre-boot screen is still injected', table.length, 2)
check('the config row still parses',
  table[0].text.startsWith('globalThis.__DSH_BOOT_ANIM_CFG__={'), table[0].text.slice(0, 40))
equal('warnings recorded', log.length, 1)
check('the warning names the cause and the fix',
  log[0].includes('volatile') && log[0].includes('3.18.4') && log[0].startsWith('boot-animation:'), log[0])

rmSync(scratch, { recursive: true, force: true })

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + ' — ' + (checks - failures) + '/' + checks + ' checks')
process.exit(failures === 0 ? 0 : 1)
