// Behavioural verification of the three interaction switches — `sound`,
// `clickToEnter`, `showHint` — plus the sound button's label state and the client
// bundle's freshness.
//
// The other two suites stop at the Host half: they prove the schema and the
// injected row carry the values. That is necessary and not sufficient, because
// the values then have to MEAN something inside `src/boot-screen.js`, which is a
// script text evaluated in a browser and cannot be imported by a test. A grep
// for `cfg.sound` would pass on a file that greps it and then ignores it.
//
// So this suite runs the real screen against a minimal DOM: enough of an element,
// document and media element for the overlay to mount, pick a clip, start it, and
// answer a pointer press. Timers are captured and never fired, which is what makes
// it deterministic — every assertion below is about state the screen reaches
// synchronously or in a microtask, and none of it depends on wall time.
//
// Run from the package root:  node verify/verify-options.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const SCREEN = readFileSync(join(root, 'src', 'boot-screen.js'), 'utf8')
const CLIENT = readFileSync(join(root, 'src', 'client.js'), 'utf8')
const BUNDLE = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
// The screen's own comments quote the bugs they explain — including a broken CSS
// selector and the old per-click label writes — so the static checks run against
// the code with comments stripped, which is what the browser sees.
const screenCode = SCREEN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

let failures = 0
let checks = 0
function check(label, condition, detail) {
  checks++
  console.log((condition ? '  ok   ' : '  FAIL ') + label
    + (detail === undefined || detail === '' ? '' : '   [' + detail + ']'))
  if (!condition) failures++
}
function equal(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(label, a === e, a === e ? a : 'actual ' + a + ' != expected ' + e)
}

// ---------------------------------------------------------------------------
// The DOM the screen needs, and nothing more.
//
// `document.querySelector` finds nothing for the kernel's selectors
// (`[data-dsh-boot]`), which is the documented degraded path: the progress and
// failure observers bail out and the screen still mounts.
// ---------------------------------------------------------------------------

function matches(element, selector) {
  if (selector.startsWith('.')) return element.className.split(/\s+/).includes(selector.slice(1))
  if (selector.startsWith('[')) return element.attrs[selector.slice(1, -1)] !== undefined
  return element.tagName === selector.toUpperCase()
}

function find(element, selector) {
  if (element === null || element === undefined) return null
  if (element.matches(selector)) return element
  for (const child of element.children) {
    const hit = find(child, selector)
    if (hit !== null) return hit
  }
  return null
}

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attrs = {}
    this.listeners = {}
    this.style = {}
    this.className = ''
    this.textContent = ''
    // Media element state the screen reads.
    this.muted = false
    this.readyState = 0
    this.currentTime = 0
    this.duration = 8
    this.paused = true
    this.ended = false
    this.loop = false
    this.playsInline = false
    this.preload = ''
    this.src = ''
    this.error = null
    /** Every play() this element was asked for, by the `muted` it was asked with. */
    this.playCalls = []
    /**
     * The document's autoplay state, shared by every element it creates: the
     * browser's rule plus whether the page has seen a user gesture yet. See play().
     */
    this.activation = { policy: 'allow', gesture: false }
  }

  setAttribute(name, value) { this.attrs[name] = String(value) }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node }
  replaceChild(next, old) {
    const index = this.children.indexOf(old)
    if (index >= 0) this.children[index] = next
    next.parentNode = this
    old.parentNode = null
    return old
  }
  removeChild(node) {
    const index = this.children.indexOf(node)
    if (index >= 0) this.children.splice(index, 1)
    node.parentNode = null
    return node
  }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler) }
  removeEventListener() {}
  dispatch(type, event) {
    // A pointer press is the user gesture Chromium records before it runs any
    // handler, which is exactly why the screen's retry can succeed where the
    // unattended unmuted attempt could not.
    if (type === 'pointerdown') this.activation.gesture = true
    for (const handler of this.listeners[type] ?? []) handler(event ?? {})
  }
  matches(selector) { return matches(this, selector) }
  closest(selector) {
    let node = this
    while (node !== null && node !== undefined) {
      if (node.matches(selector)) return node
      node = node.parentNode
    }
    return null
  }
  querySelector(selector) { return find(this, selector) }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720 } }
  play() {
    this.playCalls.push(this.muted)
    // 'refuse-unmuted' is Chromium on an origin it has not seen a gesture from:
    // the unattended unmuted attempt is refused, and the press that follows is the
    // activation that lets the very same call through. 'refuse-always' is the
    // stubborn policy that keeps saying no — the only way to reach the refusal
    // note on the button.
    const { policy, gesture } = this.activation
    const refused = this.muted === false
      && (policy === 'refuse-always' || (policy === 'refuse-unmuted' && !gesture))
    if (refused) {
      return Promise.reject(Object.assign(new Error('play() failed'), { name: 'NotAllowedError' }))
    }
    this.paused = false
    return Promise.resolve()
  }
  pause() { this.paused = true }
  requestVideoFrameCallback(handler) { this.frameHandler = handler }
}

function makeDocument(playPolicy) {
  // One activation record per document: the gesture the page has seen belongs to
  // the page, not to the element that happened to be pressed.
  const activation = { policy: playPolicy ?? 'allow', gesture: false }
  const make = (tag) => {
    const element = new Element(tag)
    element.activation = activation
    return element
  }
  const doc = {
    head: make('head'),
    body: make('body'),
    documentElement: make('html'),
    createElement: (tag) => make(tag),
    querySelector: (selector) => find(doc.body, selector),
    getElementById: () => null,
    addEventListener: () => {},
  }
  return doc
}

/**
 * Mount one instance of the screen with a given config.
 *
 * `playPolicy` models the browser: 'refuse-unmuted' is Chromium on an origin
 * without media engagement, which is the case the two-step press exists for.
 */
function mount(cfg, options = {}) {
  const doc = makeDocument(options.playPolicy)
  const timers = []
  const sandbox = {
    __DSH_BOOT_ANIM_CFG__: { manifest: '/clips.json', holdMs: 15000, ...cfg },
    document: doc,
    location: { search: options.search ?? '' },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    fetch: () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        clips: [{ name: 'clip.mp4', src: '/clip/clip.mp4', enabled: true }],
      }),
    }),
    // Captured, never fired: the hold window, the tail loop, the fade and the
    // skip-advance watchdog are all wall-clock behaviour, and the assertions here
    // are about decisions the screen makes before any of them could run.
    setTimeout: (handler, ms) => { timers.push({ handler, ms }); return timers.length },
    clearTimeout: () => {},
    setInterval: (handler, ms) => { timers.push({ handler, ms }); return timers.length },
    clearInterval: () => {},
    addEventListener: () => {},
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(SCREEN, sandbox, { filename: 'boot-screen.js' })
  return { sandbox, doc, timers }
}

/** Let the manifest fetch, the clip pick and the play() chain settle. */
async function settle() {
  for (let turn = 0; turn < 40; turn++) await Promise.resolve()
}

const video = (bundle) => find(bundle.doc.body, 'video')
const overlay = (bundle) => bundle.sandbox.__DSH_BOOT_ANIM__
const state = (bundle) => overlay(bundle).el.getAttribute('data-state')
const press = (bundle) => video(bundle).parentNode.dispatch('pointerdown', { target: overlay(bundle).el })

// ---------------------------------------------------------------------------
console.log('\n[1] defaults: sound on, two-step press, hint shown')
// ---------------------------------------------------------------------------
const base = mount({ sound: true, clickToEnter: false, showHint: true },
  { playPolicy: 'refuse-unmuted' })
await settle()
equal('the overlay mounted', base.doc.body.children.length, 1)
equal('hint is drawn by default', overlay(base).el.getAttribute('data-hint'), '1')
check('the sound control is built when sound is on', find(base.doc.body, '.dshba-sound') !== null)
equal('the unmuted attempt is refused, so the muted fallback starts it',
  video(base).playCalls, [false, true])
equal('...and the refusal is recorded for the hint', overlay(base).audioBlocked, 'refused')
press(base)
check('the first press unlocks audio instead of entering', state(base) !== 'leaving',
  'state=' + String(state(base)))
equal('...and the hint now promises the entry', find(base.doc.body, '.dshba-hint').textContent,
  '播完自动进入 · 点一下提前进')
equal('audio is not reported as blocked any more', overlay(base).audioBlocked, null)
press(base)
equal('the second press enters', state(base), 'leaving')

// ---------------------------------------------------------------------------
console.log('\n[2] sound off: no audio path at all')
// ---------------------------------------------------------------------------
const silent = mount({ sound: false })
await settle()
equal('no sound control is built', find(silent.doc.body, '.dshba-sound'), null)
equal('the clip is started muted and never unmuted', video(silent).playCalls, [true])
check('the element is muted', video(silent).muted === true, 'muted=' + String(video(silent).muted))
equal('the silent reason is recorded for the diagnostics line',
  overlay(silent).audioBlocked, 'disabled')
equal('the hint does not advertise an unlock', find(silent.doc.body, '.dshba-hint').textContent,
  '播完自动进入 · 点一下提前进')
press(silent)
equal('one press is enough to enter', state(silent), 'leaving')

// `click` mode is the only mode where the clip loops, and the sound-off hint
// there must not mention sound either.
const silentClick = mount({ sound: false, enterMode: 'click' })
await settle()
equal('click mode with sound off says exactly what a press does',
  find(silentClick.doc.body, '.dshba-hint').textContent, '点击进入')

// ---------------------------------------------------------------------------
console.log('\n[3] clickToEnter: the first press is the entry')
// ---------------------------------------------------------------------------
const direct = mount({ sound: true, clickToEnter: true }, { playPolicy: 'refuse-unmuted' })
await settle()
equal('the play attempts are unchanged (an unmuted try, then the muted fallback)',
  video(direct).playCalls, [false, true])
equal('the hint promises a direct entry', find(direct.doc.body, '.dshba-hint').textContent,
  '点一下直接进入')
press(direct)
equal('one press enters', state(direct), 'leaving')
equal('...without spending a play() on the audio retry', video(direct).playCalls, [false, true])

// ---------------------------------------------------------------------------
console.log('\n[4] the sound button describes the clip, not the last click')
// ---------------------------------------------------------------------------
// The reported bug: nothing refuses the unmuted start on a desktop build, so the
// clip plays with sound while the button still shows the muted glyph it was born
// with. The glyph has to come out of the audio state at every transition, because
// the two attempts that make a clip audible are not clicks on this button.
const audible = mount({ sound: true }, { playPolicy: 'allow' })
await settle()
const audibleButton = find(audible.doc.body, '.dshba-sound')
const clickButton = (button) => button.dispatch('click', { preventDefault: () => {}, stopPropagation: () => {} })
const WORDS = /[\u4e00-\u9fa5]/
equal('a clip the policy allows starts with sound', video(audible).playCalls, [false])
equal('...and the button shows the unmuted glyph, not the muted one it was born with',
  audibleButton.textContent, '🔊')
check('...with no wording on its face at all', WORDS.test(audibleButton.textContent) === false,
  'text=' + audibleButton.textContent)
equal('...and the words moved to the tooltip', audibleButton.title, '点一下关闭声音')
equal('...behind a stable accessible name', audibleButton.getAttribute('aria-label'), '影片声音')
equal('...and reports itself pressed', audibleButton.getAttribute('aria-pressed'), 'true')
clickButton(audibleButton)
equal('clicking the button mutes the clip', video(audible).muted, true)
equal('...and the glyph goes back to the muted one', audibleButton.textContent, '🔇')
equal('...with the tooltip now offering the sound', audibleButton.title, '点一下打开声音')
equal('...and stops reporting itself pressed', audibleButton.getAttribute('aria-pressed'), 'false')
clickButton(audibleButton)
equal('clicking it again unmutes the clip', video(audible).muted, false)
equal('...and the glyph follows', audibleButton.textContent, '🔊')

// The two-step case: a refused unmuted start leaves the clip silent and the button
// offering the sound, and the press that unlocks it is not a click on the button —
// so the glyph has to be written by the retry as well.
const unlock = mount({ sound: true }, { playPolicy: 'refuse-unmuted' })
await settle()
const unlockButton = find(unlock.doc.body, '.dshba-sound')
equal('a refused unmuted start falls back to a muted clip', video(unlock).playCalls, [false, true])
equal('...and the button offers the sound', unlockButton.textContent, '🔇')
press(unlock)
await settle()
equal('the press reaches the unmuted retry', video(unlock).playCalls, [false, true, false])
equal('...and the button follows the clip, not the click', unlockButton.textContent, '🔊')
equal('...with the reason cleared', overlay(unlock).audioBlocked, null)

// A policy that refuses even behind the gesture: the button must go back to saying
// the clip is silent rather than keep the optimistic glyph the press wrote.
const stubborn = mount({ sound: true }, { playPolicy: 'refuse-always' })
await settle()
const stubbornButton = find(stubborn.doc.body, '.dshba-sound')
press(stubborn)
await settle()
equal('a retry that is refused anyway leaves the clip silent',
  video(stubborn).playCalls, [false, true, false])
equal('...the element goes back to muted', video(stubborn).muted, true)
equal('...and the button shows the silent glyph again', stubbornButton.textContent, '🔇')
equal('...with the refusal spelled out in the tooltip instead',
  stubbornButton.title, '浏览器拒绝了声音，点一下重试')
equal('...with the reason recorded for the diagnostics line',
  overlay(stubborn).audioBlocked, 'refused')

// The glyph has exactly two writers — the initial state and renderSound — which is
// what keeps a click handler from inventing a state of its own.
const labelWrites = screenCode.match(/(?:parts\.)?sound\.textContent\s*=/g) ?? []
equal('the sound glyph is written from one place', labelWrites.length, 2)

// ---------------------------------------------------------------------------
console.log('\n[5] showHint off: only the sentence goes')
// ---------------------------------------------------------------------------
const noHint = mount({ showHint: false })
await settle()
equal('the hint switch is on the overlay', overlay(noHint).el.getAttribute('data-hint'), '0')
check('the hint element still exists for the state machine to write to',
  find(noHint.doc.body, '.dshba-hint') !== null)
equal('the title is untouched',
  find(noHint.doc.body, '.dshba-title').textContent, 'DeepSeek Harness')
check('the progress bar is untouched', find(noHint.doc.body, '.dshba-bar') !== null)
check('the stylesheet carries the rule that hides it',
  SCREEN.includes('.dshba[data-hint="0"] .dshba-hint{display:none}'))
// `[data-hint=0]` and `[data-attention=1]` look fine and are invalid CSS: an
// unquoted value must be an identifier, and one starting with a digit is not.
// Chrome drops the entire rule without a word, which is why this is asserted
// rather than trusted to review.
const unquotedNumeric = /\[[A-Za-z-]+=\d[^\]]*\]/
check('no attribute selector leaves a numeric value unquoted',
  unquotedNumeric.test(screenCode) === false,
  (screenCode.match(unquotedNumeric) ?? ['none'])[0])

// ---------------------------------------------------------------------------
console.log('\n[6] the card edits exactly these three fields')
// ---------------------------------------------------------------------------
const cardCode = CLIENT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
for (const field of ['sound', 'clickToEnter', 'showHint']) {
  check('the card writes "' + field + '"', cardCode.includes("'" + field + "'"))
}
check('the card offers the three switches', cardCode.includes('const BEHAVIOUR = ['))
check('the card defaults match the Host defaults (absent means on/default)',
  cardCode.includes("stored.sound !== false")
  && cardCode.includes("stored.clickToEnter === true")
  && cardCode.includes("stored.showHint !== false"))

// ---------------------------------------------------------------------------
console.log('\n[7] the settings card renders the three switches and writes them')
// ---------------------------------------------------------------------------
// The card is React, and this package ships no React. But the card must be
// reachable exactly the way the shell reaches it: evaluate `lib/client.js` in a
// stub `window.__ModuleLoader__`, call the captured factory with a stub
// `require('react')`, then call the `apply` it exports. Anything less would test
// the source rather than the artifact the browser actually loads.
//
// The React stub is the minimum the card's hook order needs. It is deliberately
// strict about that order: `useState`/`useCallback`/`useEffect`/
// `useSyncExternalStore` each take the next slot from one cursor, so a card that
// starts calling hooks conditionally corrupts its own state here rather than
// silently in the settings page.
function mountCard(snapshot) {
  const states = []
  let cursor = 0
  let tree = null
  const writes = []
  const React = {
    createElement: (type, props, ...children) => ({
      type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined),
    }),
    useState: (initial) => {
      const index = cursor++
      if (states.length <= index) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], (next) => {
        states[index] = typeof next === 'function' ? next(states[index]) : next
        draw()
      }]
    },
    useCallback: (fn) => { cursor++; return fn },
    useEffect: () => { cursor++ },
    useSyncExternalStore: (subscribe, getSnapshot) => { cursor++; return getSnapshot() },
  }
  const doc = makeDocument()
  const form = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    mutate: (ops, revision) => { writes.push({ ops, revision }); return true },
  }
  let load = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => { load = definition } } },
    document: doc,
    location: { search: '' },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(BUNDLE, sandbox, { filename: 'lib/client.js' })
  const registered = []
  const services = {
    slots: {
      inject: (key, register) => register(),
      register: (entry, component) => { registered.push(component); return () => {} },
    },
    locale: { register: () => {}, bind: () => (key) => key },
    configForms: {
      get: () => ({}),
      whileServed: (namespaces, callback) => { callback(); return () => {} },
    },
  }
  const moduleExports = load.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  const ctx = { inject: (deps, callback) => callback({ get: (name) => services[name], effect: (fn) => fn() }) }
  moduleExports.apply(ctx)

  const draw = () => {
    cursor = 0
    const component = registered[0]
    tree = component({ view: 'page', runtime: React, form })
    return tree
  }
  draw()

  const nodes = []
  const collect = (node) => {
    if (node === null || typeof node !== 'object') return
    nodes.push(node)
    for (const child of node.children ?? []) collect(child)
  }
  const textOf = (node) => (typeof node === 'string'
    ? node
    : (node.children ?? []).map(textOf).join(''))
  const click = (node) => { node.props.onClick() }
  /** Re-read the tree after a state update — the elements are new objects. */
  const refresh = () => { nodes.length = 0; collect(tree); return nodes }

  refresh()
  return {
    React, writes, doc, textOf, click, draw, refresh,
    get nodes() { return nodes },
    get tree() { return tree },
  }
}

const card = mountCard({
  status: 'available', revision: 7, writable: true,
  value: { enabled: true, fadeMs: 2000, enterMode: 'tail', disabledClips: [], sound: false, clickToEnter: true, showHint: false },
})
const header = card.nodes.find((node) => node.type === 'button' && node.props.className === 'dshba-head')
check('the card renders a header that can be expanded', header !== undefined)
card.click(header)
card.refresh()
const inputs = card.nodes.filter((node) => node.type === 'input')

/** The switch whose label text is exactly `label`. */
function switchFor(label) {
  const input = inputs.find((node) => {
    const labelNode = card.nodes.find((candidate) => candidate.type === 'label'
      && (candidate.children ?? []).includes(node))
    return labelNode !== undefined && card.textOf(labelNode) === label
  })
  return input
}

for (const [label, field, initial] of [
  ['播放影片声音', 'sound', false],
  ['点鼠标直接进入', 'clickToEnter', true],
  ['显示底部提示文字', 'showHint', false],
]) {
  const input = switchFor(label)
  check('the card offers the switch "' + label + '"', input !== undefined)
  if (input === undefined) continue
  equal('...reflecting the stored value', input.props.checked, initial)
  input.props.onChange({ target: { checked: !initial } })
  const last = card.writes[card.writes.length - 1]
  equal('...and writes the field on change', last?.ops, [{ op: 'set', path: [field], value: !initial }])
}

// The switch defaults must survive a settings document written before these
// fields existed: absent means the documented default, not `undefined`.
const legacy = mountCard({ status: 'available', revision: 1, writable: true, value: { enabled: true, fadeMs: 2000 } })
legacy.click(legacy.nodes.find((node) => node.type === 'button' && node.props.className === 'dshba-head'))
legacy.refresh()
const legacyInputs = legacy.nodes.filter((node) => node.type === 'input')
equal('an old settings document renders the three switches at their defaults',
  legacyInputs.slice(1).map((node) => node.props.checked), [true, false, true])

// A bundle that is not the current build of the source is the one artifact
// failure this package cannot detect at runtime: the shell serves lib/, the
// repository reads src/, and a stale lib/ looks like "my change did nothing".
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const head = 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(pkg.name)
  + ', factory: (require) => {\n'
  + 'var module = { exports: {} }; var exports = module.exports;\n'
const tail = '\nreturn module.exports; } });\n'
check('lib/client.js is the current build of src/client.js', BUNDLE === head + CLIENT + tail,
  BUNDLE.length + ' vs ' + (head.length + CLIENT.length + tail.length) + ' bytes')

console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + ' — ' + (checks - failures) + '/' + checks + ' checks')
process.exit(failures === 0 ? 0 : 1)
