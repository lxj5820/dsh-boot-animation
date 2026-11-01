// dsh-boot-animation — client bundle build.
//
// The browser half ships as TWO files: `src/client.js` (readable source) and
// `lib/client.js` (the same text wrapped in the harness module-loader shell). The
// shell is what makes the file loadable as a dynamic bundle: it hands the factory a
// `require` bound to the baseline module table, so `require('react')` resolves
// without this package declaring anything.
//
// This script exists so the pairing cannot drift by hand. It:
//
//   1. reads `src/client.js`,
//   2. refuses to proceed if that file still contains an ESM `import` — the shell
//      supplies `require`, and a leftover import would be a syntax error inside the
//      factory, i.e. a bundle that fails at load on the settings page and nowhere
//      earlier,
//   3. wraps the source and writes `lib/client.js`,
//   4. re-reads the output and syntax-checks it, so a broken artifact cannot be
//      left on disk for the next reload to discover.
//
// Run: node build-client.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SOURCE = fileURLToPath(new URL('./src/client.js', import.meta.url))
const TARGET = fileURLToPath(new URL('./lib/client.js', import.meta.url))

const HEAD = 'window.__ModuleLoader__.load({ id: "dsh-boot-animation", factory: (require) => {\n'
  + 'var module = { exports: {} }; var exports = module.exports;\n'
const TAIL = 'return module.exports; } });\n'

const source = readFileSync(SOURCE, 'utf8')

const imports = source.match(/^import\s.+$/gm)
if (imports !== null) {
  console.error('src/client.js still contains ESM imports, which the factory cannot take:')
  for (const line of imports) console.error('  ' + line)
  process.exit(1)
}

writeFileSync(TARGET, HEAD + source + TAIL)

// Verify the RESULT, not the intention: `node --check` parses the file exactly as
// the browser will, so a shell that was assembled wrong fails here rather than at
// the settings page.
execFileSync(process.execPath, ['--check', TARGET], { stdio: 'inherit' })

const written = readFileSync(TARGET, 'utf8')
if (!written.startsWith('window.__ModuleLoader__.load(')) {
  console.error('lib/client.js does not start with the loader shell')
  process.exit(1)
}
console.log('lib/client.js written: ' + written.length + ' bytes')
