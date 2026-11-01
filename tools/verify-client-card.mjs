#!/usr/bin/env node
// Verify the settings CARD, by rendering the real client source in a stub DOM.
//
// Why this suite exists: the card is the half that cannot be checked by reading it.
// Every previous defect in this file was found in a browser (a slot keyed wrong, a
// service read with `ctx.get`, a control that wrote nothing), and none of them
// would have shown up in a grep. So this suite loads `src/client.js` for real,
// renders the card through a minimal React stub, and asserts what came OUT — the
// icon element, the folding groups, the summary lines, the save banner.
//
// What it cannot prove: that it LOOKS right. Geometry, colour and the theme's own
// tokens are the browser's business. This suite is about structure and wiring.
//
// Offline, no ports, no prompts. Run: node tools/verify-client-card.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = here + '..'
const SOURCE = root + '/src/client.js'
const BUNDLE = root + '/lib/client.js'

let passed = 0
const failures = []
function record(name, ok, detail) {
  if (ok) { passed++; return }
  failures.push(name + (detail === undefined ? '' : '  [' + detail + ']'))
}

/* ---- a minimal React, enough to render this card ------------------- */

// The card uses exactly three React APIs — createElement, useState and the
// use* hooks for external stores and effects. Rather than pull in a renderer,
// this stub records the element tree so assertions can walk it, and runs the
// component ONCE with a controllable hook runtime.
function makeHarness(seed) {
  const element = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false) })
  // `seed` pre-sets hook slots before the first render: index 0 is the card's
  // `open` flag, so seeding it is how a click is simulated without a click. The
  // array is per-harness and per-render, because a shared one made the second
  // render read the previous render's hook values and report the card as closed.
  const states = seed === undefined ? [] : seed.slice()
  let cursor = 0
  const React = {
    createElement: element,
    useState: (initial) => {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], (next) => {
        states[index] = typeof next === 'function' ? next(states[index]) : next
      }]
    },
    useRef: (initial) => {
      const index = cursor++
      if (!(index in states)) states[index] = { current: initial }
      return states[index]
    },
    useEffect: () => { cursor++ },
    useCallback: (fn) => { cursor++; return fn },
    useMemo: (fn) => { cursor++; return fn() },
    useSyncExternalStore: (subscribe, getSnapshot) => { cursor += 1; return getSnapshot() },
  }
  return { React, states }
}

/** Walk a rendered tree, collecting every node. */
function walk(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  if (typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children || []) walk(child, out)
  return out
}

/** Every text string inside a rendered tree. */
function texts(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (typeof node !== 'object') return out
  for (const child of node.children || []) texts(child, out)
  return out
}

/** Load the card factory from a bundle-compatible evaluation of the source. */
function loadCard() {
  const source = readFileSync(SOURCE, 'utf8')
  if (/^import\s/m.test(source)) throw new Error('src/client.js still has ESM imports')
  const sandbox = {
    console, fetch: () => Promise.reject(new Error('no network in this suite')),
    document: { getElementById: () => null, createElement: () => ({ id: '', textContent: '' }), head: { appendChild() {} } },
    globalThis: {},
    setTimeout, clearTimeout, Promise, Object, Array, String, Number, Math, JSON, Set, Map,
  }
  sandbox.window = sandbox.globalThis
  sandbox.globalThis.location = { reload() {} }
  // The component is a module-private function, so the wrapper hands the ones this
  // suite renders back through `exports` after evaluating the file. Reaching them
  // this way keeps the suite honest: it renders the SHIPPED function, not a copy.
  const exposes = "module.exports.__test = { BootAnimationCard: typeof BootAnimationCard !== 'undefined' ? BootAnimationCard : null, "
    + "cardForm: typeof cardForm !== 'undefined' ? cardForm : null };"
  const wrapped = '(function(require){var module={exports:{}};var exports=module.exports;'
    + source + '\n' + exposes + '\nreturn module.exports;})'
  const factory = vm.runInNewContext(wrapped, sandbox, { filename: 'client.js' })
  return factory((name) => {
    if (name === 'react') return null
    throw new Error('unexpected require: ' + name)
  })
}

/* ---- what the module must export ---------------------------------- */

const cardModule = loadCard()
record('the module evaluates and exports something', cardModule !== null && typeof cardModule === 'object')

/* ---- the bundle must wrap the source, not drift from it ------------ */

const sourceText = readFileSync(SOURCE, 'utf8')
const bundleText = readFileSync(BUNDLE, 'utf8')
record('the bundle carries the loader shell', bundleText.startsWith('window.__ModuleLoader__.load('),
  bundleText.slice(0, 40))
record('the bundle contains the current source verbatim', bundleText.includes(sourceText.trimEnd()))
record('the bundle closes its factory', bundleText.trimEnd().endsWith('} });'),
  bundleText.slice(-20))
record('no ESM import survives inside the factory', !/^import\s/m.test(sourceText))

/* ---- the card, rendered ------------------------------------------- */

// Find the card component on the dedicated test face the loader attached.
const candidate = cardModule.__test && cardModule.__test.BootAnimationCard !== null
  ? ['BootAnimationCard', cardModule.__test.BootAnimationCard]
  : undefined
record('the module exposes its card component', candidate !== undefined,
  Object.keys(cardModule).join(','))

// A settings snapshot shaped like the one the settings service hands over: every
// field the card reads, at its documented default.
const snapshotValue = {
  enabled: true,
  fadeMs: 2000,
  enterMode: 'tail',
  disabledClips: [],
  sound: true,
  clickToEnter: false,
  showHint: true,
  screensaverEnabled: true,
  screensaverIdleMs: 60000,
  screensaverBreakEffect: true,
  screensaverHint: false,
  disabledScreensaver: [],
}

function renderCard(Component, options = {}) {
  const { React } = makeHarness()
  // The page's own configuration form, shaped the way the Plugins page hands it
  // over: an observable snapshot plus the mutating call.
  const state = { status: 'ready', value: snapshotValue, revision: 7, writable: true }
  const form = {
    subscribe() { return function unsubscribe() {} },
    getSnapshot() { return state },
    state,
    mutate: options.mutate || (() => Promise.resolve(true)),
  }
  return Component({ runtime: React, form })
}

/* The assertions below walk the rendered tree for STRUCTURE, which is what this
 * change was about: an icon in the header, three folding groups, a summary line on
 * each closed group, and the save banner. */

let rendered = null
const Component = candidate === undefined ? null : candidate[1]
try {
  if (typeof Component === 'function') rendered = renderCard(Component)
} catch (error) {
  record('the card renders without throwing', false, String(error && error.message))
}

if (rendered !== null && rendered !== undefined) {
  const nodes = walk(rendered)
  const allText = texts(rendered).join(' ')

  record('the card renders as a list item', rendered.type === 'li', String(rendered.type))

  const icon = nodes.find(n => n.type === 'img' && n.props.className === 'dshba-ico')
  record('the header carries an icon element', icon !== undefined)
  record('the icon points at the plugin icon route',
    icon !== undefined && String(icon.props.src).includes('/plugins/dsh-boot-animation/icon/'),
    icon === undefined ? 'no icon' : String(icon.props.src))
  record('the icon is decorative for assistive tech',
    icon !== undefined && icon.props.alt === '' && icon.props['aria-hidden'] === 'true')
  record('the icon hides itself rather than showing a broken glyph when it fails',
    icon !== undefined && typeof icon.props.onError === 'function')

  record('the card starts collapsed', rendered.props['data-open'] === '0',
    String(rendered.props['data-open']))
  record('the collapsed card is a single header row', rendered.children.length === 1,
    String(rendered.children.length))
  record('the one-liner says what the plugin does, in plain words',
    allText.includes('打开页面时先放一段短片'), allText.slice(0, 160))
} else {
  record('the card renders without throwing', false, 'no rendered tree to inspect')
}

/* ---- the OPENED card: the folding must be real --------------------- */

// The collapsed card proves almost nothing: it is one button. Everything this
// change added lives in the opened state, so the card is rendered a second time
// with its first hook pre-set to `true` (the open flag), which is exactly the
// state a click produces.
if (typeof Component === 'function') {
  try {
    // Seed hook slot 0 (`open`) to true — the state one click produces.
    const { React } = makeHarness([true])
    const state = { status: 'ready', value: snapshotValue, revision: 7, writable: true }
    const opened = Component({
      runtime: React,
      form: {
        subscribe() { return function () {} },
        getSnapshot() { return state },
        state,
        mutate: () => Promise.resolve(true),
      },
    })
    const nodes = walk(opened)
    const openedText = texts(opened).join(' ')

    record('the opened card is marked open', opened.props['data-open'] === '1',
      String(opened.props['data-open']))
    record('the opened card still carries the header icon',
      nodes.some(n => n.type === 'img' && n.props.className === 'dshba-ico'))

    const groupNodes = nodes.filter(n => n.props && n.props.className === 'dshba-grp')
    record('the opened card renders three folding groups', groupNodes.length === 3,
      String(groupNodes.length))

    const titles = groupNodes
      .map(n => walk(n).find(c => c.props && c.props.className === 'dshba-grptitle'))
      .map(n => (n === undefined ? '' : texts(n).join('')))
    record('the groups are 常用 / 片头素材池 / 屏保',
      titles[0] === '常用' && titles[1] === '片头素材池' && titles[2] === '屏保',
      titles.join(' | '))

    // Each group's state, read from its own data-open.
    const openFlags = groupNodes.map(n => n.props['data-open'])
    record('only the common group is expanded on open',
      openFlags[0] === '1' && openFlags[1] === '0' && openFlags[2] === '0',
      openFlags.join(','))

    // The closed groups must still SAY something: a row that reads only "更多"
    // forces every visit to open it just to find out what is inside.
    const summaries = groupNodes
      .map(n => walk(n).find(c => c.props && c.props.className === 'dshba-grpsum'))
      .map(n => (n === undefined ? '' : texts(n).join('')))
    record('every group states its current value when closed',
      summaries.every(s => s.length > 0), summaries.join(' | '))
    record('the screensaver summary says whether it is on',
      summaries[2].includes('关闭') || summaries[2].includes('开启'), summaries[2])

    record('the common group shows its controls', openedText.includes('开启启动动画')
      && openedText.includes('淡入时长') && openedText.includes('进入方式'))
    record('the collapsed groups hide their controls',
      !openedText.includes('启用屏保') && !openedText.includes('打开片头文件夹'))

    // The options are tiles now: a name plus a small mark, with the explanation in the tooltip rather
    // than printed under the row. The card asks for a choice; the sentence is available on hover.
    record('the enter modes render as tiles',
      walk(opened).some(n => n.props && n.props.className === 'dshba-tiles'), openedText)
    record('the technical term survives as the tile label',
      openedText.includes('片尾交叉溶解'))
    record('the explanation lives in a tooltip, not in the body',
      /title: hint/.test(sourceText) && sourceText.includes('choice[1],\n              choice[2],'),
      'the tile description is not wired to a tooltip')

    // The save banner is absent until something is stored.
    record('no save banner before anything is written',
      !nodes.some(n => n.props && n.props.className === 'dshba-saved'))
  } catch (error) {
    record('the opened card renders without throwing', false, String(error && error.message))
  }
}

/* ---- the save banner, after a write -------------------------------- */

// The banner is driven by a `useState` inside the card, so it can only appear on a
// SECOND render. This drives that honestly: one harness whose hook state persists
// across both renders (which is what React does), a click on a real switch, the
// promise chain settled, then a re-render read from the same hook state.
if (typeof Component === 'function') {
  try {
    const { React, states } = makeHarness([true])
    const state = { status: 'ready', value: snapshotValue, revision: 7, writable: true }
    const form = {
      subscribe() { return function () {} },
      getSnapshot() { return state },
      state,
      mutate: () => Promise.resolve(true),
    }
    let tree = Component({ runtime: React, form })
    const switches = walk(tree).filter(n => n.type === 'input' && n.props.type === 'checkbox')
    record('the opened card offers switches to click', switches.length >= 3, String(switches.length))

    switches[0].props.onChange({ target: { checked: true } })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Re-render through the same hook state. `makeHarness` is not called again, so
    // `setSaved` from the write landed in `states` and is read back here.
    const reRender = (() => {
      let cursor = 0
      const R = Object.assign({}, React, {
        useState: (initial) => {
          const index = cursor++
          if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
          return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
        },
        useEffect: () => { cursor++ },
        useCallback: (fn) => { cursor++; return fn },
        useSyncExternalStore: (s, get) => { cursor += 1; return get() },
        useRef: (v) => { const i = cursor++; if (!(i in states)) states[i] = { current: v }; return states[i] },
      })
      return Component({ runtime: R, form })
    })()

    const banner = walk(reRender).find(n => n.props && n.props.className === 'dshba-saved')
    record('a successful write raises the save banner', banner !== undefined)
    record('the banner says the change needs a reload',
      banner !== undefined && texts(banner).join(' ').includes('刷新'),
      banner === undefined ? '' : texts(banner).join(' '))
    record('the banner carries a reload control',
      banner !== undefined && walk(banner).some(n => n.type === 'button' && n.props.className === 'dshba-reload'))
  } catch (error) {
    record('the save banner path runs without throwing', false, String(error && error.stack))
  }
}

/* ---- switches stack instead of sharing a line --------------------- */

// Two switches on one line read as a single paragraph that happens to contain two
// checkboxes. The screensaver section shipped that way and was reported as a layout
// bug, so the fix is pinned: the standalone switches carry the block class, and the
// class is actually a block.
record('a stacked-switch class exists and is a block',
  /\.dshba-line\{display:flex;/.test(sourceText))
// TWO now: the hint line, and... that is it. The sound switch used to be the third, and it has
// been merged INTO the volume slider — one control whose left end is off.
record('every screensaver-only switch is stacked',
  (sourceText.match(/dshba-switch dshba-line/g) || []).length === 2,
  String((sourceText.match(/dshba-switch dshba-line/g) || []).length))

/* ---- ONE control for the sound, not a switch plus a slider ----
 *
 * They were two controls and it read badly: a switch with an off state plus a slider that only
 * existed while the switch was on, so the same choice took two gestures and the slider's position
 * meant nothing while the switch said off. The slider's LEFT END is now the off switch, and the
 * position decides both stored fields.
 */
record('the sound is one slider, with no separate on/off switch',
  !/onChange: \(event\) => write\('screensaverSound', event\.target\.checked\)/.test(sourceText)
  && /'屏保声音'/.test(sourceText),
  'a separate switch would mean two gestures for one choice')
record('the left end of the slider is silence',
  /const shouldSound = clampedPct > 0/.test(sourceText)
  && /if \(saverSound\) ops\.push\(\{ op: 'set', path: \['screensaverSound'\], value: false \}\)/.test(sourceText),
  'dragging to zero must store the switch as off')
record('dragging up turns the sound on',
  /if \(!saverSound\) ops\.push\(\{ op: 'set', path: \['screensaverSound'\], value: true \}\)/.test(sourceText),
  'a drag from zero would change the level but leave the switch off')
// ONE operation for both fields. Two calls cannot work: each captures the revision of the render
// it was created in and the card does not re-render between them, so the second presents a
// revision the first just invalidated — refused, with "保存失败" painted over a save that
// half-worked. The document showed exactly that: `screensaverVolume: 0.07` beside
// `screensaverSound: false`.
record('both fields are written in ONE operation, not two calls',
  /const ops = \[\]/.test(sourceText) && /writeMany\(ops,/.test(sourceText)
  && !/write\('screensaverVolume'[\s\S]{0,200}write\('screensaverSound'/.test(sourceText),
  'two sequential writes race for the document revision')
record('write is a thin wrapper over writeMany',
  /const write = \(field, value\) => writeMany\(/.test(sourceText),
  'a second path to mutate would reintroduce the revision race')
record('the displayed position folds both fields',
  /saverSound \? Math\.round\(saverVolume \* 100\) : 0/.test(sourceText),
  'sound-off must read as 0 on the one control')
record('the last level is kept, so turning it back up does not jump to a default',
  !/write\('screensaverVolume', 0\)/.test(sourceText),
  'the level must not be zeroed when the sound is switched off')

/* ---- tables the card references must exist ----
 *
 * A lookup written as MARK[...] with no MARK defined throws at render time, and the card's own
 * try/catch turns that into an error line — every control inside disappears while the card itself
 * still "renders". That is exactly how the tile redesign shipped for one commit, so it is asserted
 * rather than left to a browser.
 */
for (const table of ['MARK', 'BREAK_STYLE_CHOICES', 'POINTER_EFFECT_CHOICES', 'IDLE_CHOICES', 'ENTER_MODES', 'BEHAVIOUR']) {
  const declared = new RegExp('const ' + table + ' = ').test(sourceText)
  const used = new RegExp(table + '\\[').test(sourceText) || new RegExp(table + '\\.filter').test(sourceText)
  record('the card defines ' + table + ' before using it', !used || declared,
    used && !declared ? 'used but never defined' : undefined)
}

/* ---- the custom screensaver minutes ------------------------------- */

// The custom threshold is a control the user asked for by name, so it is asserted by
// name. Two things matter, and both are easy to get silently wrong: the preset list
// must stay intact (a custom entry that REPLACED a preset would remove a fast path),
// and a value outside the Host's accepted range must be clamped rather than sent —
// sending it would surface as "保存失败" for a number somebody typed in good faith.
record('the presets are unchanged', /const IDLE_CHOICES = \[60000, 180000, 300000, 600000\]/.test(sourceText))
record('a custom entry sits beside the presets', /key: 'custom'/.test(sourceText))
record('the custom entry reads as selected for a non-preset value',
  /!IDLE_CHOICES\.includes\(saverIdleMs\) \|\| customOpen \? 1 : 0/.test(sourceText))
record('a whole-minute value is rounded before it is stored',
  /const minutes = Math\.round\(Number\(customText\)\)/.test(sourceText))
record('the custom value is clamped to 1-60 minutes',
  /Math\.min\(60, Math\.max\(1, minutes\)\)/.test(sourceText))
record('a non-numeric entry is refused with a sentence rather than stored',
  /if \(!Number\.isFinite\(minutes\) \|\| minutes <= 0\)/.test(sourceText))
record('the custom box is a number input',
  /type: 'number',\s*className: 'dshba-num'/.test(sourceText))
record('picking a preset closes the custom box',
  /setCustomOpen\(false\); write\('screensaverIdleMs', choice\)/.test(sourceText))

/* ---- the break effect's flight ------------------------------------- */

// The exit effects live in the screensaver module, not the card. These used to assert
// `finishTear` and a single DURATION, back when the screensaver had one effect; it now has
// three, dispatched by `breakApart(style)`, so the assertions follow that structure.
const screensaverText = readFileSync(root + '/src/screensaver.js', 'utf8')
record('the particle effect keeps its tuned flight length', /const DURATION = 1\.4/.test(screensaverText))
record('the particle effect keeps its tuned horizontal travel',
  /flights\[i \+ 1\] = 170 \+ Math\.random\(\) \* 390/.test(screensaverText))
record('every exit effect has a hard stop',
  (screensaverText.match(/setTimeout\(stop, \d+\)/g) || []).length >= 3,
  String((screensaverText.match(/setTimeout\(stop, \d+\)/g) || []).length))
record('the hard stops outlast their effects',
  /setTimeout\(stop, 4500\)/.test(screensaverText) && /setTimeout\(stop, 3600\)/.test(screensaverText))

/* ---- the folding is real, checked against the source --------------- */

// These are source-level assertions, deliberately: driving the expanded card would
// need every hook, an effect runner and a fetch stub, and what matters here is that
// the three groups exist with a summary and start in the intended state.
record('the card declares three folding groups',
  /useState\(\{\s*basic:\s*true,\s*saver:\s*false,\s*pool:\s*false\s*\}\)/.test(sourceText),
  'groups state not found')
record('only the common group starts open', !/basic:\s*false/.test(sourceText))
record('there is a reusable group factory', /const group = \(key, title, summary, children\)/.test(sourceText))
record('a group renders its children only when open',
  /isOpen \? React\.createElement\('div', \{ className: 'dshba-grpbody' \}, children\) : null/.test(sourceText))
record('the group header states the current value', /dshba-grpsum/.test(sourceText))
record('the common group is pushed first', /sections\.push\(group\('basic'/.test(sourceText))
record('the boot pool is inside a group', /sections\.push\(group\('pool'/.test(sourceText))
record('the screensaver is inside a group', /sections\.push\(group\('saver'/.test(sourceText))

/* ---- the save banner --------------------------------------------- */

record('a saved field arms the banner', /const \[saved, setSaved\] = React\.useState\(null\)/.test(sourceText))
record('the banner offers a reload', /className: 'dshba-reload'/.test(sourceText))
record('the banner is only armed when the write really stored',
  /let stored = false/.test(sourceText) && /if \(stored\) \{[\s\S]{0,80}setSaved\(label\)/.test(sourceText))
record('a failed write never arms the banner', !/setSaved\(label\)[\s\S]{0,120}catch/.test(sourceText))
// A success must also CLEAR a stale failure, or a refusal that happened once stays on screen
// under every later control — a card whose document is up to date still showing "保存失败".
record('a successful write clears a stale failure line',
  /if \(stored\) \{[\s\S]{0,700}setFailure\(null\)/.test(sourceText),
  'a stale "保存失败" would survive a later successful save')

/* ---- a saved setting must reach the RUNNING page, not just the document ----
 *
 * `entry.js` injects `globalThis.__DSH_BOOT_ANIM_CFG__` once, as a head row. The screensaver
 * reads every per-appearance setting from that object. Saving the document is therefore not
 * enough: without pushing the new value into the object, the screensaver keeps using whatever the
 * page was loaded with, and the desktop shell has no reload key. The user changed the exit effect
 * to 重力下坠, dismissed the layer, and saw all three effects at random — the previous value was
 * `random`, and the page was still reading it. The same staleness made the pointer effect look
 * dead.
 */
record('a saved value is pushed into the live config object',
  /function pokeLiveConfig\(ops\)/.test(sourceText)
  && /globalThis\.__DSH_BOOT_ANIM_CFG__/.test(sourceText)
  && /cfg\[key\] = op\.value/.test(sourceText),
  'the running page would keep the value it was loaded with until a restart')
record('the push happens only after the document accepted the write',
  /if \(stored\) \{[\s\S]{0,900}pokeLiveConfig\(ops\)/.test(sourceText),
  'a refused write must not change what the page believes')
record('the push mirrors the stored value rather than inventing one',
  /cfg\[key\] = op\.value/.test(sourceText) && !/cfg\[key\] = (?!op\.value)/.test(sourceText),
  'the page and the document could disagree')

/* ---- house rules -------------------------------------------------- */

// The backtick rule has already cost this package one silent build failure: a
// backtick inside a CSS string ends the string early and the PREVIOUS artifact is
// kept, so the change looks like it did nothing.
const cssBlob = sourceText.slice(sourceText.indexOf('const CSS = ['), sourceText.indexOf("].join('')"))
record('the CSS blob contains no backtick', !cssBlob.includes('`'))
record('the CSS blob is not empty', cssBlob.length > 2000, String(cssBlob.length))

console.log('')
if (failures.length === 0) {
  console.log(passed + '/' + passed + ' passed')
  process.exit(0)
}
console.log(passed + ' passed, ' + failures.length + ' FAILED')
for (const line of failures) console.log('  FAIL  ' + line)
process.exit(1)
