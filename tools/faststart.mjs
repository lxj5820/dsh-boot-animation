#!/usr/bin/env node
// Move an mp4's `moov` index to the front, losslessly, without ffmpeg.
//
// Why this matters for a boot animation: a player cannot decode a single frame
// until it has read `moov`. When `moov` sits at the end of the file the browser
// must pull the whole clip down before anything appears, so the overlay shows a
// black window for as long as that takes — a 10 MB clip is 10 MB of black. With
// `moov` up front the first frame is decodable from the first few kilobytes and
// the picture appears immediately. This is the single most common cause of
// "the boot animation is just black".
//
// Only `stco`/`co64` need rewriting: they are the only boxes in a
// non-fragmented mp4 that store absolute file offsets (the sample chunk
// positions inside `mdat`). Every other box is relative or index-based, so
// reordering top-level boxes is a pure byte move.
//
//   node tools/faststart.mjs            # report, write nothing
//   node tools/faststart.mjs --write    # write <name>.faststart.mp4 beside each
//
// The originals are never modified. Deleting `faststart.*.mp4` in the assets
// directory removes the duplicates once you have confirmed playback.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const assetDir = fileURLToPath(new URL('../assets/videos', import.meta.url))
const stagingDir = fileURLToPath(new URL('../assets/videos/faststart', import.meta.url))
const write = process.argv.includes('--write')

/**
 * Walk the top-level box list of an mp4.
 * @param buffer - whole file.
 * @returns boxes in file order.
 */
function topLevelBoxes(buffer) {
  const boxes = []
  let offset = 0
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    let header = 8
    if (size === 1) {
      // 64-bit size: the real length follows the type.
      if (offset + 16 > buffer.length) break
      const high = buffer.readUInt32BE(offset + 8)
      const low = buffer.readUInt32BE(offset + 12)
      size = high * 2 ** 32 + low
      header = 16
    } else if (size === 0) {
      // Extends to end of file.
      size = buffer.length - offset
    }
    if (size < header || offset + size > buffer.length) {
      throw new Error(`malformed box ${type} at ${String(offset)} (size ${String(size)})`)
    }
    boxes.push({ type, start: offset, size, header, payload: offset + header })
    offset += size
  }
  if (offset !== buffer.length) {
    throw new Error(`trailing bytes: parsed ${String(offset)} of ${String(buffer.length)}`)
  }
  return boxes
}

/**
 * Locate every chunk-offset table inside the movie box.
 *
 * The scan is confined to `moov` because `stco` as a byte sequence can also occur
 * inside compressed `mdat` payload by chance; restricting it and then checking
 * that the box length matches its own entry count makes a false positive
 * essentially impossible.
 *
 * @param moov - the movie box bytes.
 * @returns absolute offsets (into the original file) of each table's payload.
 */
function chunkOffsetTables(moov) {
  const tables = []
  const needle = Buffer.from('stco', 'latin1')
  const wide = Buffer.from('co64', 'latin1')
  for (const [marker, width] of [[needle, 4], [wide, 8]]) {
    for (let at = moov.indexOf(marker); at >= 0; at = moov.indexOf(marker, at + 1)) {
      const sizeAt = at - 4
      if (sizeAt < 0) continue
      const declared = moov.readUInt32BE(sizeAt)
      if (at + 8 > moov.length) continue
      const count = moov.readUInt32BE(at + 8)
      if (declared !== 16 + width * count) continue
      if (sizeAt + declared > moov.length) continue
      tables.push({ type: marker.toString('latin1'), dataAt: at + 12, count, width })
    }
  }
  return tables
}

/**
 * Decide the new top-level order and the byte shift applied to chunk offsets.
 * @param boxes - parsed top-level boxes.
 * @returns the planned layout.
 */
function plan(boxes) {
  const moovAt = boxes.findIndex(box => box.type === 'moov')
  if (moovAt < 0) throw new Error('no moov box')
  const moov = boxes[moovAt]
  const mdatCount = boxes.filter(box => box.type === 'mdat').length
  if (mdatCount > 1) throw new Error('multiple mdat boxes are not supported')
  const moovIsFirst = moovAt === 0 || boxes.slice(0, moovAt).every(box => box.type !== 'mdat')
  if (moovIsFirst) return { already: true }

  // `moov` goes immediately after the first box (`ftyp`), which puts it in front
  // of `mdat` — that is the entire point, and the first version of this got it
  // wrong: it dropped `moov` after every box that had preceded it, which for a
  // moov-at-end file is the same position it already occupied. The result was a
  // byte-identical copy reported as a successful rewrite, and the shift those two
  // degenerate cases produced (zero) satisfied the verification below.
  const withoutMoov = boxes.filter(box => box !== moov)
  const insertAt = withoutMoov.findIndex(box => box.type === 'ftyp') + 1
  const ordered = [
    ...withoutMoov.slice(0, insertAt),
    moov,
    ...withoutMoov.slice(insertAt),
  ]
  // The rearrangement has to be a real faststart move, asserted here rather than
  // trusted: `moov` before `mdat` in the new order, and a non-zero shift for the
  // chunk offsets that follow from it.
  const mdatAt = ordered.findIndex(box => box.type === 'mdat')
  const moovOrder = ordered.findIndex(box => box.type === 'moov')
  if (mdatAt >= 0 && moovOrder > mdatAt) {
    throw new Error('planned layout leaves moov after mdat; refusing to write')
  }

  let cursor = 0
  const placed = new Map()
  for (const box of ordered) {
    placed.set(box, cursor)
    cursor += box.size
  }
  if (cursor !== boxes.reduce((sum, box) => sum + box.size, 0)) {
    throw new Error('layout does not conserve length')
  }
  const mdat = boxes.find(box => box.type === 'mdat')
  const shift = (placed.get(mdat) + mdat.header) - mdat.payload
  if (mdat !== undefined && shift <= 0) {
    throw new Error(`moov would not move (shift ${String(shift)}); refusing to write`)
  }
  return { already: false, moov, ordered, placed, shift, mdat }
}

/** Apply a byte shift to every entry of every chunk-offset table. */
function patchOffsets(moovBytes, tables, shift) {
  const out = Buffer.from(moovBytes)
  for (const table of tables) {
    for (let index = 0; index < table.count; index += 1) {
      const at = table.dataAt + index * table.width
      let value = table.width === 4 ? out.readUInt32BE(at) : Number(out.readBigUInt64BE(at))
      const moved = value + shift
      if (table.width === 4) {
        if (moved < 0 || moved > 0xffffffff) {
          throw new Error('a 32-bit chunk offset overflowed; the file needs co64, use ffmpeg')
        }
        out.writeUInt32BE(moved, at)
      } else {
        out.writeBigUInt64BE(BigInt(moved), at)
      }
    }
  }
  return out
}

/**
 * Rewrite one file.
 *
 * Exported, with the write decision as a parameter, so the verification suite can
 * exercise the real transform on a scratch copy. It began as a script-only tool,
 * and the suite that eventually caught its bug had to spawn a child process to
 * reach it — which the agent sandbox refuses over the pipe such a call needs.
 * @param file - absolute path to the source clip.
 * @param target - directory the rewritten copy is written into.
 * @param writeTo - false reports without writing.
 * @returns a human-readable result line.
 */
export function remux(file, target, writeTo) {
  const name = basename(file)
  const buffer = readFileSync(file)
  const boxes = topLevelBoxes(buffer)
  const layout = plan(boxes)
  if (layout.already) return `SKIP  ${name}: moov 已在最前，无需处理`

  const moovBytes = buffer.subarray(layout.moov.start, layout.moov.start + layout.moov.size)
  const tables = chunkOffsetTables(moovBytes)
  if (tables.length === 0) throw new Error('no chunk offset table inside moov')
  const patched = patchOffsets(moovBytes, tables, layout.shift)

  const pieces = []
  for (const box of layout.ordered) {
    if (box === layout.moov) pieces.push(patched)
    else pieces.push(buffer.subarray(box.start, box.start + box.size))
  }
  const output = Buffer.concat(pieces)
  if (output.length !== buffer.length) {
    throw new Error(`length changed: ${String(buffer.length)} -> ${String(output.length)}`)
  }

  // Lossless proof: removing `moov` from both files must leave the same bytes.
  // This is stronger than comparing sizes — it shows the media payload was moved
  // and not rewritten, and that no table was corrupted into the video data.
  const strip = (bytes, boxList) => {
    const parts = boxList.filter(box => box.type !== 'moov')
      .map(box => bytes.subarray(box.start, box.start + box.size))
    return Buffer.concat(parts)
  }
  const before = strip(buffer, boxes)
  const after = strip(output, topLevelBoxes(output))
  if (!before.equals(after)) throw new Error('media payload changed; refusing to write')

  // And the result must actually BE faststart. Checking the output rather than the
  // plan is the point: a layout that left `moov` where it was would otherwise sail
  // through every proof above, because a file that did not move is trivially
  // byte-identical to itself.
  const outBoxes = topLevelBoxes(output)
  const outMoov = outBoxes.findIndex(box => box.type === 'moov')
  const outMdat = outBoxes.findIndex(box => box.type === 'mdat')
  if (outMoov < 0 || (outMdat >= 0 && outMoov > outMdat)) {
    throw new Error('output still places moov after mdat; refusing to write')
  }

  // And the tables must now point at exactly the same chunks, shifted. `moov`
  // sits after `ftyp`, so its position is whatever the layout assigned it.
  const moovStart = layout.placed.get(layout.moov)
  const newMoov = output.subarray(moovStart, moovStart + patched.length)
  const newTables = chunkOffsetTables(newMoov)
  if (newTables.length !== tables.length) throw new Error('table count changed')
  for (let index = 0; index < tables.length; index += 1) {
    const oldAt = tables[index].dataAt
    const newAt = newTables[index].dataAt
    for (let entry = 0; entry < tables[index].count; entry += 1) {
      const delta = tables[index].width
      const was = moovBytes.readUInt32BE(oldAt + entry * delta)
      const now = newMoov.readUInt32BE(newAt + entry * delta)
      if (now !== was + layout.shift) throw new Error(`entry ${String(entry)} not shifted correctly`)
    }
  }

  // Written into a subdirectory on purpose. The clip pool lists only regular
  // files, so a subdirectory is invisible to it — a rewritten copy sitting
  // beside its original would otherwise be picked as a *second* clip and the
  // same footage would turn up twice in the random rotation.
  const out = join(target, `${basename(name, extname(name))}.faststart.mp4`)
  const KiB = (layout.moov.size / 1024).toFixed(0)
  const shouldWrite = writeTo === undefined ? write : writeTo
  if (!shouldWrite) return `TODO  ${name}: moov 在 ${String(layout.moov.start)}，需要前移 ${KiB}KiB（加 --write 输出）`
  mkdirSync(target, { recursive: true })
  writeFileSync(out, output)
  return `WROTE ${name} -> ${basename(out)}（moov 前移 ${KiB}KiB，${String(tables.length)} 张偏移表已重写）`
}

/**
 * Whether `target` is `root` or lies beneath it.
 *
 * Compared through `relative()` rather than a string prefix: `fileURLToPath`
 * yields a root that already ends in a separator, so `root + sep` doubled it and
 * rejected the default asset directory.
 * @param root - containing directory.
 * @param target - path to test.
 * @returns true when no `..` step is needed to reach `target` from `root`.
 */
export function isWithinProject(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Resolve symlinks when the path exists; a path that does not exist stays lexical. */
function realOrSelf(path) {
  try {
    return realpathSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return resolve(path)
    throw error
  }
}

/**
 * Decide which directory the CLI works in and where it writes.
 *
 * Containment is judged on real paths, so a symlink inside the project that points
 * outside it is refused as well, including a pre-existing `faststart` output
 * directory that is itself a link.
 * @param argv - command-line arguments.
 * @param root - project root; a parameter so a suite can use a scratch tree.
 * @param defaults - the default work and output directories.
 * @returns the directories, or a refusal with its message.
 */
export function resolveWorkDir(argv, root, defaults = { workDir: assetDir, outDir: stagingDir }) {
  const dirIndex = argv.indexOf('--dir')
  const custom = dirIndex >= 0
  const workDir = custom && argv[dirIndex + 1] !== undefined ? resolve(argv[dirIndex + 1]) : defaults.workDir
  const outDir = custom ? join(workDir, 'faststart') : defaults.outDir
  const realRoot = realOrSelf(root)
  for (const dir of [workDir, outDir]) {
    if (!isWithinProject(realRoot, realOrSelf(dir))) {
      return { ok: false, message: `--dir must stay inside the project directory (${realRoot}); refusing ${dir}` }
    }
  }
  return { ok: true, workDir, outDir }
}

/**
 * The command-line entry, skipped when this file is imported.
 *
 * `--dir <path>` points the tool at another directory inside the project, which
 * is how the transform is exercised on a scratch copy.
 */
function runCli() {
  const dirs = resolveWorkDir(process.argv, projectRoot)
  if (!dirs.ok) {
    console.log(dirs.message)
    process.exitCode = 1
    return
  }
  const { workDir, outDir } = dirs

  let clips = []
  try {
    clips = readdirSync(workDir).filter(name => extname(name).toLowerCase() === '.mp4'
      && !name.includes('.faststart.'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.log(`no assets directory at ${workDir}`)
      return
    }
    throw error
  }
  if (clips.length === 0) console.log(`no mp4 clips in ${workDir}`)

  for (const clip of clips.sort()) {
    try {
      console.log(remux(join(workDir, clip), outDir))
    } catch (error) {
      console.log(`FAIL  ${clip}: ${error.message}`)
      process.exitCode = 1
    }
  }
  if (!write) console.log('\n这一步没有改动任何文件。加 --write 才会输出 .faststart.mp4。')
}

const invoked = process.argv[1] === undefined
  ? ''
  : pathToFileURL(resolve(process.argv[1])).href
if (import.meta.url === invoked) runCli()
