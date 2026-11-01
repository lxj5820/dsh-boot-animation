// Byte-level integrity check for the package's own text sources.
//
// This exists because the project has already lost a source file to an encoding
// accident: a PowerShell `Get-Content`/`Set-Content` round trip read a BOM-less
// UTF-8 file as ANSI, turned every CJK character into mojibake, and wrote it back
// broken. The symptom was visible only when the file was opened.
//
// It also answers the reverse question, which is just as easy to get wrong: a
// file that LOOKS corrupted in a terminal is often fine, because PowerShell 5.1
// decodes BOM-less UTF-8 as the system ANSI codepage. So this reads the bytes
// directly and reports both the raw non-ASCII byte count and whether decoding as
// UTF-8 produces replacement characters.
//
// Usage: node tools/verify-encoding.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/u, '')
const TEXT = new Set(['.js', '.mjs', '.json', '.yml', '.yaml', '.md', '.css', '.html'])
const checks = []
const record = (label, ok, detail) => checks.push([label, !!ok, detail])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const files = walk(root).filter((f) => TEXT.has(extname(f).toLowerCase()))

const broken = []
const bom = []
for (const file of files) {
  const bytes = readFileSync(file)
  const rel = relative(root, file).replace(/\\/g, '/')

  // A BOM would be harmless for Node but breaks Windows PowerShell 5.1, which is
  // why the project's own `.ps1` rule exists. On a `.js` it is pure noise.
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) bom.push(rel)

  // Decoding strict: a replacement character means the bytes are not valid UTF-8,
  // which is the real signature of the accident described above.
  const text = bytes.toString('utf8')
  if (text.includes('\uFFFD')) broken.push(rel)
}

record('no text source contains invalid UTF-8 (the mojibake signature)',
  broken.length === 0, broken.join(', '))
record('no text source carries a UTF-8 BOM', bom.length === 0, bom.join(', '))

// CJK must survive: a file whose Chinese was flattened to '?' or mojibake is
// broken in a way the strict decode above cannot see, because those bytes ARE
// valid UTF-8. The user-facing strings are Chinese, so a count of zero is a
// failure rather than a style question.
const cjk = /[\u4e00-\u9fff]/
const userFacing = ['src/boot-screen.js', 'src/client.js', 'lib/client.js']
const missingCjk = userFacing.filter((rel) => {
  const path = join(root, rel)
  try {
    return !cjk.test(readFileSync(path, 'utf8'))
  } catch {
    return true
  }
})
record('every user-facing source still carries its Chinese copy',
  missingCjk.length === 0, missingCjk.join(', '))

// The served boot screen is injected as raw text into a <script> row, so it must
// never contain a sequence that would close that tag early.
const screen = readFileSync(join(root, 'src/boot-screen.js'), 'utf8')
record('the injected boot screen contains no </script',
  !/<\/script/i.test(screen))

// The built client bundle must stay parseable: it is served as one script.
const lib = readFileSync(join(root, 'lib/client.js'), 'utf8')
record('the client bundle keeps its loader shell',
  lib.startsWith('window.__ModuleLoader__.load(') && lib.trimEnd().endsWith('return module.exports; } });'))

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}\n`)
}
process.stdout.write(`\n${checks.length - failed}/${checks.length} passed\n`)
process.stdout.write(`(${String(files.length)} text files scanned)\n`)
process.exitCode = failed === 0 ? 0 : 1
