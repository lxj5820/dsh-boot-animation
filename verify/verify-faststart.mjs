// Verification of the directory-containment guard in tools/faststart.mjs.
//
// The guard once compared `workDir.startsWith(projectRoot + sep)` where the root
// already ended in a separator, so the DEFAULT invocation (`node tools/faststart.mjs`,
// no --dir) was refused. Every case below is about that decision: the default and
// in-project directories pass, anything that resolves outside — lexically or
// through a symlink — is refused, and a refused `--write` leaves nothing behind.
//
// Imports the module rather than spawning it (the agent sandbox refuses a child
// process with piped stdio). Scratch trees come from mkdtemp, so no fixed paths.
//
// Run from the package root:  node verify/verify-faststart.mjs

import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isWithinProject, resolveWorkDir } from '../tools/faststart.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')

let failures = 0
let checks = 0
function check(label, condition, detail) {
  checks++
  console.log((condition ? '  ok   ' : '  FAIL ') + label
    + (detail === undefined || detail === '' ? '' : '   [' + detail + ']'))
  if (!condition) failures++
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faststart-guard-')))
try {
  const project = join(scratch, 'project')
  const sibling = join(scratch, 'project-evil')
  const outside = join(scratch, 'outside')
  const assets = join(project, 'assets', 'videos')
  for (const dir of [assets, join(project, 'nested', 'deeper'), sibling, outside]) {
    mkdirSync(dir, { recursive: true })
  }
  const defaults = { workDir: assets, outDir: join(assets, 'faststart') }
  const guard = (argv) => resolveWorkDir(argv, project, defaults)

  // The predicate, including the exact shape that broke: a root with a trailing slash.
  check('root itself is inside', isWithinProject(project, project))
  check('root with trailing separator is inside', isWithinProject(project + sep, project))
  check('asset directory is inside', isWithinProject(project + sep, assets))
  check('nested directory is inside', isWithinProject(project, join(project, 'nested', 'deeper')))
  check('outside directory is refused', !isWithinProject(project, outside))
  check('.. traversal is refused', !isWithinProject(project, join(project, '..', 'outside')))
  check('sibling sharing the name prefix is refused', !isWithinProject(project, sibling))
  check('parent of the root is refused', !isWithinProject(project, scratch))

  // The decision the CLI makes.
  const dflt = guard(['node', 'faststart.mjs'])
  check('default invocation is accepted', dflt.ok === true)
  check('default invocation uses the default directories',
    dflt.workDir === defaults.workDir && dflt.outDir === defaults.outDir)
  check('--write alone is accepted', guard(['node', 'faststart.mjs', '--write']).ok === true)
  check('--dir at the project root is accepted', guard(['n', 'f', '--dir', project]).ok === true)
  check('--dir nested is accepted', guard(['n', 'f', '--dir', join(project, 'nested')]).ok === true)
  check('--dir with a relative in-project hop is accepted',
    guard(['n', 'f', '--dir', join(project, 'nested', '..', 'assets')]).ok === true)
  check('--dir outside is refused', guard(['n', 'f', '--dir', outside]).ok === false)
  check('--dir ../outside is refused',
    guard(['n', 'f', '--dir', join(project, '..', 'outside')]).ok === false)
  check('--dir sibling with shared prefix is refused', guard(['n', 'f', '--dir', sibling]).ok === false)
  check('refusal explains itself', /must stay inside the project/.test(guard(['n', 'f', '--dir', outside]).message ?? ''))
  check('a --dir that does not exist yet is judged lexically',
    guard(['n', 'f', '--dir', join(project, 'not-there')]).ok === true
    && guard(['n', 'f', '--dir', join(scratch, 'not-there')]).ok === false)

  // Symlinks: the lexical path says "inside", the real one does not.
  symlinkSync(outside, join(project, 'escape'), 'dir')
  check('symlinked --dir pointing outside is refused', guard(['n', 'f', '--dir', join(project, 'escape')]).ok === false)
  symlinkSync(outside, join(project, 'nested', 'faststart'), 'dir')
  check('a symlinked output directory pointing outside is refused',
    guard(['n', 'f', '--dir', join(project, 'nested'), '--write']).ok === false)

  // A refused --write must not have produced anything outside.
  check('nothing was written outside the project', readdirSync(outside).length === 0
    && readdirSync(sibling).length === 0)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// The real default invocation, against the real tree. Report-only: nothing is written.
const real = resolveWorkDir(['node', 'faststart.mjs'], packageRoot)
check('real default invocation is accepted for this package', real.ok === true, real.message)

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + ' — ' + (checks - failures) + '/' + checks + ' checks')
process.exit(failures === 0 ? 0 : 1)
