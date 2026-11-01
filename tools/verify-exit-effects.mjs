#!/usr/bin/env node
// Verify the screensaver's THREE exit effects and the style selector.
//
// What this guards, and why each assertion exists:
//
//   * The three effect names are spelled the same in three places -- entry.js's schema, the
//     card's buttons, and screensaver.js's resolver. If one drifts, the card writes a value the
//     screensaver ignores, and the effect silently disappears. Nothing else in the harness
//     checks that the three strings agree.
//
//   * `random` must resolve PER DISMISSAL. A resolver that ran at load time would keep showing
//     the same "random" effect all session.
//
//   * An unknown style must fall back to the plain dissolve, not to a guess, so a bad settings
//     write degrades to "no flourish" instead of to the wrong flourish.
//
//   * Each effect must actually clean up: the canvas is removed and the media released. A leak
//     here leaves a full-screen canvas over the app.
//
// Run: node tools/verify-exit-effects.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
const failures = []
function record(name, ok, detail) {
  if (ok) { passed++; return }
  failures.push(name + (detail === undefined ? '' : '  [' + detail + ']'))
}

const entry = readFileSync(root + 'entry.js', 'utf8')
const client = readFileSync(root + 'src/client.js', 'utf8')
const saver = readFileSync(root + 'src/screensaver.js', 'utf8')

/* ---- the three lists must agree ---- */
const STYLES = ['random', 'particles', 'fall', 'glitch']

record('entry.js declares BREAK_STYLES',
  /const BREAK_STYLES = \['random', 'particles', 'fall', 'glitch'\]/.test(entry),
  (entry.match(/const BREAK_STYLES = \[[^\]]*\]/) || [''])[0])

record('entry.js schema accepts exactly the four styles',
  STYLES.every(v => entry.includes("z.const('" + v + "')")),
  STYLES.filter(v => !entry.includes("z.const('" + v + "')")).join(','))

record('entry.js validates an unknown style back to the default',
  /BREAK_STYLES\.includes\(screensaverBreakStyle\)/.test(entry))

record('entry.js forwards the style to the page',
  /screensaverBreakStyle: settings\.screensaverBreakStyle/.test(entry))

record('the card offers exactly the four styles',
  STYLES.every(v => client.includes("['" + v + "',")),
  STYLES.filter(v => !client.includes("['" + v + "',")).join(','))

record('the screensaver resolves each style by name',
  STYLES.filter(v => v !== 'random').every(v => saver.includes("'" + v + "'")))

/* ---- random resolves per dismissal ---- */
record('the random pick happens inside breakStyle()',
  /if \(source === 'random'\) \{[\s\S]{0,220}Math\.random\(\)/.test(saver),
  'the random branch does not call Math.random')

// Both pickers read the LIVE config global first. `config` is a snapshot taken when the script
// first ran, so a settings edit made afterwards looked ignored until the page was rebuilt — the
// user switched 菱形涟漪 to 星屑吸附 and still saw diamonds. Reading CFG means the newest stored
// value wins as soon as the page reloads.
record('breakStyle reads the live config global before its snapshot',
  /function breakStyle\(\)[\s\S]{0,400}CFG\?\.screensaverBreakStyle/.test(saver),
  'a settings edit would look ignored until the page was rebuilt')
record('pointerEffect reads the live config global before its snapshot',
  /function pointerEffect\(\)[\s\S]{0,500}CFG\?\.screensaverPointerEffect/.test(saver),
  'a settings edit would look ignored until the page was rebuilt')

// The call site resolves the style at dismissal. A preview may force one, so the expression is
// `breakApart(<forced> ?? breakStyle())` -- the assertion checks that `breakStyle()` is reached from
// inside `hide()`, which is the dismissal path, rather than only that one exact spelling exists.
record('breakStyle is called at dismissal, not at load',
  /breakApart\([^)]*breakStyle\(\)/.test(saver) || /breakApart\(breakStyle\(\)\)/.test(saver),
  'the call site does not resolve the style at dismissal')

/** Pull a function's body out by brace counting, so assertions can look inside it. */
function bodyOf(source, signature) {
  const start = source.indexOf(signature)
  if (start === -1) return ''
  let depth = 0
  let i = source.indexOf('{', start)
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return ''
}

const resolveBody = bodyOf(saver, 'function breakStyle()')
record('an unknown style resolves to null (plain dissolve)', /return null/.test(resolveBody))
record('the resolver never returns a name it does not implement',
  !/return '(?!particles'|fall'|glitch')[a-z]+'/.test(resolveBody))

/* ---- each effect exists and tears down ----
 *
 * The labels are the card's own effect names, in Chinese, so a failure line names the
 * effect the user would see rather than a function name. (These three used to be mojibake:
 * a PowerShell round-trip had turned them into garbage before this file was written to
 * disk, and the suite printed the garbage as its own diagnosis.)
 */
for (const [fn, label] of [['breakParticles', '粒子消散'], ['breakFall', '重力下坠'], ['breakGlitch', 'Glitch 宽带位移']]) {
  const body = bodyOf(saver, 'function ' + fn + '(')
  record('the ' + label + ' effect exists', body.length > 400, String(body.length))
  record('the ' + label + ' effect tears down on every path',
    (body.match(/finish\(\)/g) || []).length >= 2,
    String((body.match(/finish\(\)/g) || []).length) + ' finish() calls')
  record('the ' + label + ' effect has a hard stop',
    /setTimeout\(stop, \d+\)/.test(body))
  record('the ' + label + ' effect cancels its frame on stop',
    /cancelAnimationFrame/.test(body))
}

/* ---- the dispatcher ---- */
const dispatchBody = bodyOf(saver, 'function breakApart(style)')
record('the dispatcher takes a style argument', /breakApart\(style\)/.test(dispatchBody))
record('the dispatcher routes all three styles',
  ['particles', 'fall', 'glitch'].every(v => dispatchBody.includes("style === '" + v + "'")))
record('the dispatcher handles a null style without crashing',
  /if \(style === null\)/.test(dispatchBody))
record('the layer comes down before the effect runs',
  dispatchBody.indexOf("setAttribute('data-leaving', '1')") < dispatchBody.indexOf('breakParticles'),
  'the layer is hidden after the effect starts')

/* ---- chroma must not drain the frame ----
 *
 * A single-channel tinted copy is black in the channels it does not keep. Drawn with source-over
 * it covers the picture and dims it; only 'lighter' adds light. This was a real regression once.
 */
const glitchBody = bodyOf(saver, 'function breakGlitch(')
record('the chroma split uses single-channel tints',
  glitchBody.includes("'rgb(255,0,0)'") && glitchBody.includes("'rgb(0,150,255)'"))
record('the chroma split is additive, not covering',
  /globalCompositeOperation = 'lighter'/.test(glitchBody))
record('the chroma alpha is capped low', /globalAlpha = fade \* 0\.\d+/.test(glitchBody))

/* ---- the config reaches the page ---- */
record('the screensaver config reads the style',
  /breakStyle: CFG && typeof CFG\.screensaverBreakStyle === 'string'/.test(saver))

/* ---- EVERY LIVE FIELD MUST BE READ LIVE ------------------------------------
 *
 * THE DEFECT THIS SECTION EXISTS FOR. Two assertions used to stand here:
 *
 *     record('reduced motion still bypasses the effect',
 *       /config\.breakEffect && !prefersReducedMotion\(\)/.test(saver))
 *     record('the effect switch still gates the effect', /config\.breakEffect/.test(saver))
 *
 * Both described `if (withBreak && config.breakEffect && ...)` as the CORRECT shape. It is
 * the wrong shape, and it is the same mistake AGENTS.md records under "A picker that reads a
 * SNAPSHOT taken at install time will look like the setting was ignored": `config` is copied
 * once, when the injected script first runs, so every later edit of 退出特效 was stored, served
 * by `/live-settings.json`, and then ignored by the layer. A suite that pins the snapshot as
 * correct does not merely fail to catch that — it actively blocks the fix, and turns red when
 * somebody delivers it.
 *
 * So the rule here is about the READER, not about the spelling: for every field the card
 * promises is "already in effect" (`LIVE_FIELDS` in src/client.js), this suite requires a
 * reachable path that reads it from the CFG global — and at the decision site that consumes it,
 * requires the live path to be consulted rather than the snapshot alone.
 *
 * WHY THE ASSERTIONS ARE NAME-AGNOSTIC. The fix may be spelled as a resolver
 * (`breakEffectOn()`, `saverEnabled()`, …) or inline (`CFG?.screensaverBreakEffect`); the
 * colleagues delivering it own that choice. Nothing below hardcodes a helper name. What it
 * does instead is DISCOVER the carriers: every function whose body reads the field from CFG is
 * a live resolver, and a resolver counts only if something else in the file calls it. That is
 * the difference between "this field is read live" and "this field is mentioned live".
 *
 * Comments are stripped first, per this package's own rule: prose explaining the OLD approach
 * is otherwise matched as if it were the approach.
 */

/** Strip comments, so a comment describing an old read is not counted as that read. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
}

const code = stripComments(saver)

/** Whether `text` reads `field` off the CFG global, in any of the shapes used here. */
function readsLive(text, field) {
  const dotted = new RegExp('CFG\\s*\\??\\.\\s*' + field + '\\b')
  const guarded = new RegExp('CFG\\s*&&[^;\\n]{0,90}' + field + '\\b')
  return dotted.test(text) || guarded.test(text)
}

// A field reported by the DIAGNOSTIC is not a field the layer consumes. `saverState()` reads
// several of these straight off CFG to report the raw value, and counting that as "the page
// reads the newest value" would let a field keep a snapshot reader everywhere it actually
// matters while the suite stayed green. So the diagnostic bodies are blanked out before the
// per-field search, and the on-screen diagnostics line is blanked with them.
const DIAGNOSTICS = ['function saverState()', 'function startSaverDiagnostics(']
let consumerCode = code
for (const signature of DIAGNOSTICS) {
  const body = bodyOf(code, signature)
  if (body.length > 0) consumerCode = consumerCode.split(body).join(' ')
}

// The INSTALL block is excluded for the same reason, and it is the sharper case of it: it runs
// ONCE, when the injected script first evaluates, so a CFG read there is a snapshot by
// construction — it is the very thing this section exists to catch. Counting it would let a
// field pass with `installScreensaver({ breakStyle: CFG.screensaverBreakStyle })` and a snapshot
// reader at the decision site, which is precisely the shipped bug.
const installAt = consumerCode.indexOf('if (!disposed) {')
if (installAt >= 0) consumerCode = consumerCode.slice(0, installAt)

/** Every named function in `consumerCode` whose body reads `field` from CFG. */
function liveResolvers(field) {
  const names = []
  const declarations = consumerCode.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)
  for (const declaration of declarations) {
    const name = declaration[1]
    if (readsLive(bodyOf(consumerCode, 'function ' + name + '('), field)) names.push(name)
  }
  return names
}

/** How many times a function is referenced, its own definition included. */
function callCount(name) {
  return (consumerCode.match(new RegExp('\\b' + name + '\\s*\\(', 'g') || []).length)
}

/** A resolver that is actually reached: defined once and called somewhere else. */
function calledResolvers(field) {
  return liveResolvers(field).filter((name) => callCount(name) >= 2)
}

/** Whether one function body consults the live value for `field`, directly or via a resolver. */
function consultsLive(functionBody, field) {
  if (functionBody.length === 0) return false
  if (readsLive(functionBody, field)) return true
  return calledResolvers(field).some((name) => new RegExp('\\b' + name + '\\s*\\(').test(functionBody))
}

// The nine fields, taken from the card's own promise rather than retyped here: if somebody
// adds a tenth field to LIVE_FIELDS, this loop starts demanding a live reader for it too.
const liveNames = (client.match(/const LIVE_FIELDS = new Set\(\[([\s\S]*?)\]\)/) || [])[1] || ''
const liveFields = [...liveNames.matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1])

record('the card declares the nine screensaver fields as live',
  liveFields.length === 9 && liveFields.every((name) => name.startsWith('screensaver')),
  liveFields.join(',') || 'LIVE_FIELDS not found')

for (const field of liveFields) {
  const direct = readsLive(consumerCode, field)
  const resolvers = liveResolvers(field)
  const reached = calledResolvers(field)
  // A read inside a named function only counts if that function is CALLED somewhere else; a
  // read outside one (inline in the code that acts on it) counts on its own. This is what stops
  // "there is a dead helper that reads it" from passing as "the page reads the newest value".
  const ok = direct && (resolvers.length === 0 || reached.length > 0)
  record('src/screensaver.js has a live CFG read path for ' + field,
    ok,
    direct
      ? 'carrier=' + (reached.join('|') || '(inline)')
      : 'the field is never read from CFG outside the diagnostic, so a saved edit cannot reach the running layer')
}

/* ---- the decision sites must consult the LIVE value -----------------------
 *
 * Reading the live value somewhere is not the same as deciding with it. These pair each
 * consumer with the fields it acts on, and accept EITHER an inline live read or a call to a
 * discovered live resolver — so a rename of the helper keeps this green, while going back to
 * `config.<field>` at the decision turns it red.
 */
const DECISIONS = [
  ['function shouldShow()', ['screensaverEnabled', 'screensaverIdleMs'], 'whether the layer may appear'],
  ['function hide(', ['screensaverBreakEffect'], 'whether a dismissal tears the picture'],
  ['function beginAppearance()', ['screensaverHint'], 'whether the hint line is shown'],
  ['function pickAndPlace(', ['screensaverSound', 'screensaverVolume'], 'whether the media is unmuted and at what level'],
]

for (const [signature, fields, what] of DECISIONS) {
  const body = bodyOf(code, signature)
  const fnName = signature.replace(/^function\s+/, '').replace(/\(.*$/, '')
  for (const field of fields) {
    record(fnName + '() decides ' + what + ' from the live ' + field,
      consultsLive(body, field),
      body.length === 0
        ? signature + ' not found'
        : 'the decision site never consults CFG for ' + field + ', so a saved edit would be ignored')
  }
}

// The specific regression, spelled out: a bare snapshot read is what the OLD code did at the
// dismissal, and it must not come back. `config` may still be the documented FALLBACK inside a
// `liveSetting(...)` chain — that is the "snapshot -> default" half of a three-step resolution —
// but it must not be the thing the `if` is decided on.
const hideBody = bodyOf(code, 'function hide(')
record('the dismissal gate does not decide on the install-time snapshot',
  hideBody.length > 0 && !/if\s*\([^)]*\bconfig\.breakEffect\b/.test(hideBody),
  'a bare config.breakEffect in the gate is the snapshot bug: the setting looks ignored')
record('reduced motion still bypasses the effect',
  /prefersReducedMotion\(\)/.test(hideBody),
  'a user who asked for less motion would get the full effect')
record('the effect switch still gates the effect, live',
  consultsLive(hideBody, 'screensaverBreakEffect'),
  'the switch would not gate the effect at all, or would gate it on a stale value')

/* ---- the preview ----
 *
 * The card's 预览 raises the REAL layer, and the USER dismisses it — a click or a key, the same
 * gesture a real screensaver needs. That is what makes the pointer decoration previewable: the
 * previous version dismissed itself as soon as the media was ready, so the layer was gone within
 * a second and the decoration never drew a pixel. The user reported exactly that.
 *
 * It must also not leave the dismissal latch set: `hide(true)` latches the screensaver off until
 * the machine is used again, and a preview that left it set would silently disable the feature
 * for the rest of the session.
 */
record('the screensaver exposes a preview', /preview: function \(style, entryName\)/.test(saver))
record('the preview raises the layer and stops there',
  !/hide\(true, chosen\)/.test(saver) && !/dismissWhenReady/.test(saver),
  'the preview still dismisses itself, so the pointer decoration is unreachable')
record('the preview marks the layer as a preview before showing it',
  /previewing = true\s*\n\s*\n?\s*show\(\)/.test(saver)
  || /previewing = true[\s\S]{0,120}show\(\)/.test(saver),
  'a dismissal in the same tick could read the stale flag')
record('a preview dismissal does not latch the screensaver off',
  /if \(withBreak && !previewing\) dismissedUntilActive = true/.test(saver),
  'a preview would leave the screensaver latched off')
// The check must look INSIDE preview(), not at the whole file: `shouldShow()` and `tick()`
// legitimately test for the overlay, and a file-wide regex matches those instead.
const previewBody = bodyOf(saver, 'preview: function (style, entryName)')
record('the preview does NOT refuse just because the boot overlay is in the DOM',
  previewBody.length > 0
  && !/__DSH_BOOT_ANIM__[\s\S]{0,160}return false/.test(previewBody),
  previewBody.length === 0
    ? 'preview() body not found'
    : 'the preview still returns false when the boot overlay is present, which is what the user reported')
record('the preview PARKS the boot overlay instead of refusing',
  /bootOverlayParked = \{ el: overlay\.el, parent: overlay\.el\.parentNode/.test(previewBody)
  && /removeChild\(overlay\.el\)/.test(previewBody),
  'the overlay is never moved aside, so the two layers cannot coexist')
record('the parked overlay is restored on dismissal',
  /if \(bootOverlayParked !== null\)[\s\S]{0,400}insertBefore\(parked\.el, parked\.next\)/.test(saver),
  'a preview would permanently destroy the boot animation node')
record('the restore keeps the same node, so the animation state survives',
  /insertBefore\(parked\.el, parked\.next\)/.test(saver)
  && !/parked\.el\.cloneNode/.test(saver),
  'cloning the overlay would lose its state')
record('the card calls the screensaver preview with the row name',
  /previewScreensaver\(item\.name\)/.test(client))
record('the card forwards the name to the screensaver',
  /saver\.preview\(null, typeof entryName/.test(client))
record('the card no longer asks the preview for a specific effect',
  !/saver\.preview\(saverBreakStyle/.test(client),
  'the preview would still be pinned to one effect instead of the configured one')
record('the screensaver honours a forced entry',
  /published\.find\(\(item\) => item !== null && item\.name === forcedEntryName\)/.test(saver),
  'the preview would play a random entry instead of the clicked row')
record('the forced entry is one-shot',
  /let chosen = null[\s\S]{0,400}forcedEntryName = null/.test(saver))
record('a named preview matches disabled rows too',
  /published\.find/.test(saver) && !/items\.find\(\(item\) => item\.name === forcedEntryName/.test(saver),
  'a row whose checkbox is off would fail to preview')
record('the card no longer routes screensaver rows through the boot overlay',
  !/preview\(item\.name, 'screensaver'\)/.test(client))
record('the row button says 预览, not 预览 + 特效',
  /'预览'\)/.test(client) && !/预览 \+ 特效/.test(client),
  'the label would promise something the preview no longer does on its own')

/* ---- a preview may still force an exit effect, and it is one-shot ----
 *
 * `previewForcedStyle` exists for a caller that wants a specific flourish. It has to be consumed
 * by the dismissal, or the next real appearance — minutes later — would keep playing it.
 */
record('the forced preview style is consumed by the dismissal',
  /const forcedForPreview = previewForcedStyle[\s\S]{0,120}previewForcedStyle = null/.test(saver),
  'a forced style would leak into the next real appearance')
record('the dismissal prefers an explicit style, then the preview one, then the setting',
  /explicit = typeof forcedStyle === 'string'/.test(saver)
  && /forcedForPreview/.test(saver)
  && /breakStyle\(\)/.test(saver))

/* ---- the pointer decoration ----
 *
 * Same three-list contract as the exit effects: a name in one list and not the others means the
 * card writes a value the Host rejects, which falls back to 不显示 in silence.
 */
const POINTER = ['none', 'random', 'ripples', 'attract', 'lens']
record('entry.js declares the pointer styles',
  /const POINTER_EFFECTS = \['none', 'random', 'ripples', 'attract', 'lens'\]/.test(entry))
record('entry.js schema accepts exactly those',
  POINTER.every(v => entry.includes("z.const('" + v + "')")),
  POINTER.filter(v => !entry.includes("z.const('" + v + "')")).join(','))
record('entry.js validates an unknown pointer style to the default',
  /POINTER_EFFECTS\.includes\(screensaverPointerEffect\)/.test(entry))
record('entry.js forwards the pointer style', /screensaverPointerEffect: settings\.screensaverPointerEffect/.test(entry))

/* ---- the card offers THREE, and the schema still accepts the retired two ----
 *
 * 菱形涟漪 (lens) and 随机 were retired from the picker by request. The distinction matters:
 *   - the CARD must not offer them any more, and must not render an empty picker for a profile
 *     that still stores one;
 *   - the SCHEMA and the screensaver must still ACCEPT them, because the stored value lives in
 *     the profile and an enum that dropped a member would reject the whole config document.
 */
const OFFERED = ['none', 'ripples', 'attract']
// The check has to look INSIDE the pointer block: `['random',` also appears in the EXIT style
// list, so a file-wide search matches the wrong table.
const pointerBlock = client.slice(
  client.indexOf('const POINTER_EFFECT_CHOICES'),
  client.indexOf('const POINTER_EFFECT_NAMES'))
record('the card offers exactly the three kept styles',
  pointerBlock.length > 0
  && OFFERED.every(v => pointerBlock.includes("['" + v + "',"))
  && !pointerBlock.includes("['lens',") && !pointerBlock.includes("['random',"),
  pointerBlock.length === 0
    ? 'POINTER_EFFECT_CHOICES not found'
    : 'the card still offers a retired style, or dropped a kept one')
// THE USAGE SITE IS GONE, AND THAT IS CORRECT.
//
// This assertion used to read:
//
//     record('the card checks the stored value against the OFFERED list',
//       /POINTER_EFFECT_NAMES\.includes\(stored\.screensaverPointerEffect\)/.test(client))
//
// It matched the USE of `POINTER_EFFECT_NAMES` inside `saverPointer`, and `saverPointer` was
// a dead local (zero readers) that the pointer picker's removal was supposed to take with it:
// the picker is HIDDEN by request, because the decoration could not be made reliable in the
// desktop shell. So the old assertion demanded that a deleted dead variable still exist — it
// went red precisely when the correct change landed.
//
// What the old assertion actually WANTED to guard is drift: the card must not offer a name the
// Host's whitelist does not accept, and must not offer a name the schema would reject. That is
// kept below, in a form that survives the picker being hidden — the DECLARATION is checked, and
// its contents are compared against `entry.js`'s `POINTER_EFFECTS`. The removal of the picker is
// also asserted, so nobody mistakes "the picker is gone" for a regression and puts it back.
const pointerNames = (client.match(/const POINTER_EFFECT_NAMES = POINTER_EFFECT_CHOICES\.map\(entry => entry\[0\]\)/) || [])[0] || ''
const pointerChoiceNames = [...pointerBlock.matchAll(/\[(?:'([a-z]+)')/g)].map((match) => match[1])
const hostPointerNames = (entry.match(/const POINTER_EFFECTS = \[([^\]]*)\]/) || [])[1] || ''
const hostPointerList = [...hostPointerNames.matchAll(/'([a-z]+)'/g)].map((match) => match[1])

record('the card still declares POINTER_EFFECT_NAMES, derived from its choices',
  pointerNames !== '',
  pointerNames || 'POINTER_EFFECT_NAMES declaration not found')
record('the card offers exactly the three kept names, none of the retired two',
  JSON.stringify(pointerChoiceNames) === JSON.stringify(OFFERED),
  'choices=' + (pointerChoiceNames.join(',') || '(none)'))
// The drift guard the old assertion was reaching for: every name the card can offer must be a
// member of the Host's whitelist. A card-only name is a value the schema rejects on save.
record('every name the card can offer is accepted by the Host whitelist',
  pointerChoiceNames.length > 0 && pointerChoiceNames.every((name) => hostPointerList.includes(name)),
  'card=' + pointerChoiceNames.join(',') + ' host=' + hostPointerList.join(','))
record('the Host whitelist keeps the retired names, so an old profile still validates',
  ['lens', 'random'].every((name) => hostPointerList.includes(name)),
  hostPointerList.join(','))
// The picker's absence is DELIBERATE, and this pins the reason so a later reader does not
// restore it believing it was dropped by accident. Either the dead local is still gone (the
// code change) or the note explaining the removal is still there (the intent) — both must hold.
record('the pointer picker is hidden by request, not by accident',
  !/saverPointer\b/.test(stripComments(client)) && /picker is HIDDEN|HIDDEN, by request/.test(client),
  /saverPointer\b/.test(stripComments(client))
    ? 'saverPointer is back: the dead local the removal was meant to delete'
    : 'the note explaining why the picker is hidden has been deleted')
record('the schema still accepts the retired names',
  POINTER.every(v => entry.includes("z.const('" + v + "')")),
  'dropping a member from the enum would reject the stored config document')
record('the screensaver still implements every named effect',
  ['tickRipples', 'tickAttract', 'tickLens'].every(f => saver.includes('const ' + f)))
record('the screensaver resolves the style by name', /function pointerEffect\(\)/.test(saver))

/* ---- THE HANDOFF ITSELF: the caller passes it, and installScreensaver KEEPS it ----
 *
 * Every check above asserts that a value is PASSED in (entry.js forwards it, the call site
 * names it, the reader exists). None of them asserted that `installScreensaver` STORES it in
 * `config` — and for a while it did not: the function assembled a four-field config that
 * omitted `breakStyle` and `pointerEffect` entirely, so both readers saw `undefined` forever
 * and silently fell back to 'random' / 'none'.
 *
 * The symptom the user reported was "the pointer effect does nothing": they had picked 菱形涟漪
 * in the card, the value was stored correctly, forwarded correctly, and then dropped one line
 * before the code that would have used it. The exit style was broken the same way, which went
 * unnoticed because 'random' is also the default.
 *
 * `bodyOf` cannot be used here: `installScreensaver(options = {})` has a brace pair INSIDE its
 * parameter list, and the helper starts counting at the first `{` it finds — so it returns the
 * empty default object instead of the body. This walks the parameter list first.
 */
function bodyAfterParams(source, signature) {
  const start = source.indexOf(signature)
  if (start === -1) return ''
  let i = source.indexOf('(', start)
  let parens = 0
  for (; i < source.length; i += 1) {
    if (source[i] === '(') parens += 1
    else if (source[i] === ')') {
      parens -= 1
      if (parens === 0) break
    }
  }
  let depth = 0
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return ''
}

const installBody = bodyAfterParams(saver, 'function installScreensaver(')
record('installScreensaver stores the pointer effect in config',
  /pointerEffect:\s*typeof options\.pointerEffect/.test(installBody),
  'the pointer effect is dropped before it can be used')
record('installScreensaver stores the exit style in config',
  /breakStyle:\s*typeof options\.breakStyle/.test(installBody),
  'the exit style is dropped before it can be used')
record('the defaults carry both pickers',
  /breakStyle:\s*'random'/.test(bodyOf(saver, 'var DEFAULTS = {'))
  && /pointerEffect:\s*'none'/.test(bodyOf(saver, 'var DEFAULTS = {')),
  'config would be incomplete on the defaults route')
record('the lens keeps the radius the user picked', /LENS_RADIUS = 170/.test(saver),
  'the lens disc changed size')
// The lens has been rewritten twice, both times from "why does this look so bad":
//   v1 tiled the disc with 30px cells — a mosaic of little squares;
//   v2 drew concentric rings — no grid, but a static grey magnifier, which on a dark picture is
//      just a smudge;
//   v3 (current) DISPLACES the picture radially with a travelling wave, so it reads as water.
// The assertions follow v3, and they pin the two things that decide whether it looks like water
// or like broken glass: a patch size small relative to the amplitude, and a soft radial mask
// instead of a hard circular clip.
record('the lens displaces radially instead of magnifying',
  /Math\.hypot\(dx, dy\)/.test(saver) && /const sx = px - nx \* amp/.test(saver),
  'the ripple is not a radial displacement')
record('the lens patch is small relative to the wave amplitude',
  /const PATCH = 4 \* dpr/.test(saver) && /const amp = 16 \* dpr/.test(saver),
  'a patch close to the amplitude steps visibly, which is the mosaic that was reported')
record('the lens wave travels outward with time',
  /Math\.sin\(dist \* 0\.052 - t \* 4\.4\)/.test(saver),
  'a static wave reads as a frozen distortion')
record('the lens edge is a soft radial mask, not a hard clip',
  /destination-in/.test(saver) && !/ctx\.arc\(cx, cy, R, 0, Math\.PI \* 2\)\s*\n\s*ctx\.clip\(\)/.test(saver),
  'a hard clip is what made the old version look like a disc stuck on the picture')
record('the lens no longer tiles cells or draws rings',
  !/LENS_CELL/.test(saver) && !/RING_STEP/.test(saver),
  'the old mosaic / magnifier implementation is still in the file')

/* ---- the volume curve ----
 *
 * `video.volume` is a LINEAR amplitude multiplier while loudness is roughly logarithmic, so a
 * linear slider spends almost all its travel where it sounds the same and cannot get quiet at the
 * bottom. The user reported it directly: "拖到 2% 了，声音还是不小". The mapping is a square, and
 * what matters is that the BOTTOM is quiet and the TOP is untouched.
 */
record('the slider position is mapped to a gain, not copied',
  /function volumeToGain\(position\)/.test(saver)
  && /renderer\.setVolume\(volumeToGain\(/.test(saver),
  'a linear copy leaves the bottom of the slider audible')
record('the curve is a square, so 2% is inaudible and 100% is full',
  /return p \* p/.test(saver) && /Math\.min\(1, Math\.max\(0, position\)\)/.test(saver),
  'the curve would either clip above 1 or fail to silence the bottom')

/* ---- ripples react to the pointer, and stay small ----
 *
 * This rule has been wrong twice, in opposite directions, so both halves are pinned here.
 *
 * v1: the effect drew nothing until a `mousemove`. On a real screensaver the window is typically
 * unfocused and may never deliver one, so it was never TRIGGERED — reported as "我一直没看到效果".
 *
 * v2: the fix for that was to seed a ring every 320ms unconditionally. That made it play on a
 * screensaver nobody was touching, reported as "我鼠标都没有放进来，它自己就在中间一直生效". A
 * decoration that reacts to the pointer has to be CAUSED by the pointer. The 190px/s radius over a
 * 1.6s life was also reported as "水波太大了" — the ring grew wider than the face it was drawn over.
 */
record('ripples only draw while the pointer is over the layer',
  /const insideStream = state\.inside && sinceLast > \d+/.test(saver),
  'a ring with no pointer behind it is the exact complaint the user made')
record('there is no unconditional ring seed',
  !/const idleSeed = sinceLast >/.test(saver),
  'a timer seed makes the effect play on a layer nobody is touching')
record('the ripple stream is dense enough to read as waves',
  /const insideStream = state\.inside && sinceLast > 260/.test(saver),
  'gating on movement alone leaves the layer blank while the mouse is held still')
record('the wave stays small — about a hundred pixels, not three hundred',
  /g\.r \+= 96 \* dpr \* dt/.test(saver) && /g\.life -= dt \* 1\.0/.test(saver),
  '96px/s over 1s tops out near 96px; 190px/s over 1.6s reached 300px and was reported as too big')
record('the ripple ring is still thick enough to see',
  /ctx\.lineWidth = Math\.max\(1\.6, 3\.2 \* dpr \* fade\)/.test(saver),
  'a hairline fades into any real picture')
record('the ripple loop parks once there is nothing left to draw',
  /return state\.rings\.length > 0 \|\| state\.inside/.test(saver),
  'returning true unconditionally burns frames on an idle layer')
record('the decoration loop starts only when it has work to do',
  /if \(state\.inside \|\| which === 'attract'\) startLoop\(\)/.test(saver),
  'starting unconditionally runs a loop that draws nothing until the pointer arrives')

/* ---- the pointer must be tracked on the DOCUMENT, not on the layer ----
 *
 * Measured on the running app after the effect was "fixed" to react to the pointer: a mounted
 * canvas, `pointerRunning` false, `pointerStrokes` 0 — the loop had never started because no event
 * had ever arrived. The listener was on `root`, which looks right (the layer is full-screen with
 * `pointer-events: auto`) but the layer also holds a full-bleed `dshsaver-catch` above it, so
 * whether a `mousemove` reaches the layer depends on where the event lands. Every other reading
 * looked healthy, which is why this took a report to find.
 */
record('pointer events are tracked on the document, not the layer',
  /document\.addEventListener\('mousemove', onMove/.test(saver)
  && !/root\.addEventListener\('mousemove', onMove/.test(saver),
  'a catcher above the layer can swallow the event and the effect never starts')
record('the box test replaces hit-testing',
  /const insideBox = event\.clientX >= rect\.left/.test(saver),
  'without a coordinate test the document listener would fire outside the layer too')
record('state() reports whether any pointer event arrived',
  /pointerMoves:/.test(saver) && /pointerInside:/.test(saver),
  'a mounted canvas with zero moves is indistinguishable from a working one')

/* ---- the falling exit must not paint its own background ----
 *
 * It filled the canvas with a near-black before drawing the pieces, "so the gaps read as depth".
 * The gaps are not depth, they are the app underneath — and the user asked to see it: the pieces
 * fall away and the conversation is revealed through them. An opaque fill reads as a black card
 * dissolving instead of as the screensaver breaking up.
 */
record('the falling exit leaves its canvas transparent',
  !/function breakFall[\s\S]{0,1400}fillStyle\s*=\s*'#[\s\S]{0,60}fillRect\(0,\s*0,\s*width/.test(saver),
  'a full-canvas fill hides the app behind the falling pieces')
record('the falling exit still clears the previous frame',
  /function breakFall[\s\S]{0,1400}clearRect\(0, 0, width, height\)/.test(saver),
  'without clearRect the pieces would smear into trails')

/* ---- the diagnostic must report WHAT THE EFFECTS WILL USE ----
 *
 * This is the rule that would have saved four rounds. The stored document could be read from the
 * Host, but the PAGE's own view of it could not: `state()` answered a hand-written literal of the
 * old field list while `saverState()` (the one sent to the Host) had grown the settings readout.
 * So "the setting never reached the page" and "the page has it and draws the wrong thing" looked
 * identical from outside, and every attempt was a guess.
 */
record('state() reports the raw and resolved exit style',
  /breakStyleRaw:/.test(saver) && /breakStyleNow: breakStyle\(\)/.test(saver),
  'a wrong-looking effect could not be traced to the setting or to the drawing')
record('state() reports the raw and resolved pointer effect',
  /pointerRaw:/.test(saver) && /pointerNow: pointerEffect\(\)/.test(saver),
  'same for the mouse decoration')
record('state() reports whether the decoration is actually mounted',
  /pointerArtMounted: pointerArt !== null/.test(saver),
  'the effect could be selected, resolve correctly, and still never attach')
// ONE state function. A second literal copy is what drifted.
record('the public state() reads saverState(), not its own field list',
  /state: function \(\) \{[\s\S]{0,900}return saverState\(\)/.test(saver),
  'a hand-written copy of the field list drifts away from the reported one')
record('there is exactly one saverState definition',
  (saver.match(/function saverState\(/g) || []).length === 1)
// Both spellings must be present, and BOTH must carry the LIVE resolution.
//
// The old version asserted `idleMs: config.idleMs` / `thresholdMs: config.idleMs` — the install-
// time snapshot — so it went red the moment the threshold started being resolved live, which is
// the fix rather than a regression. The aliasing contract it was guarding is real and is kept
// (two callers grew up reading different names, so both must exist); what changed is the SOURCE.
// A field reported from `config` is a diagnostic that lies: it would say the layer is waiting for
// the threshold the page was LOADED with, which is the number the user's edit just replaced.
record('the threshold and idle answer are readable under both old and new names',
  /idleMs:/.test(saver) && /thresholdMs:/.test(saver)
  && /systemStatus: idleStatus/.test(saver) && /probeStatus: idleStatus/.test(saver),
  'renaming would silently break whichever caller used the other spelling')
record('the threshold it reports is the LIVE threshold, not the install-time snapshot',
  !/thresholdMs: config\.idleMs/.test(saver) && !/idleMs: config\.idleMs/.test(saver)
  && consultsLive(bodyOf(code, 'function saverState()'), 'screensaverIdleMs'),
  'a diagnostic reporting the snapshot says "waiting for the old threshold" after a live edit')
record('the on/off switches it reports are the LIVE ones',
  ['screensaverEnabled', 'screensaverBreakEffect', 'screensaverHint', 'screensaverSound']
    .every((field) => consultsLive(bodyOf(code, 'function saverState()'), field)),
  'a diagnostic reporting the snapshot says "on" for a layer that was just switched off')

/* ---- the appearance must NOT wait on the settings fetch ----
 *
 * `show()` was `refreshLiveSettings().then(beginAppearance)`. That is a deadlock: `visible` is
 * already true so `tick()` never calls `show()` again, and if the fetch is slow or never settles
 * the whole appearance — including the pointer decoration, which registers its own listeners
 * inside `beginAppearance` — never happens. The reported symptom was exactly this shape: "这两次
 * 重启后屏保出现，鼠标特效就不生效了", the same build working on other runs depending on whether
 * the request came back. The layer is raised synchronously now and the fetch only refreshes the
 * values for the NEXT appearance.
 */
record('show() raises the layer without waiting for the settings fetch',
  /beginAppearance\(\)\n  refreshLiveSettings\(\)/.test(saver)
  && !/refreshLiveSettings\(\)\.then\(function \(\) \{ beginAppearance\(\) \}\)/.test(saver),
  'a hanging fetch would leave the layer up with no decoration and no listeners')

/* ---- a changed setting must reach the RUNNING screensaver ----
 *
 * The injected `CFG` object is a snapshot taken when the page loads. Saving the document does not
 * rebuild it and the desktop shell has no reload key, so three reports of "the chosen effect is
 * not the one that plays" all came from the same place: the document held `ripples`, the card
 * highlighted 水波涟漪, and the screensaver still resolved `attract`. The client card patched the
 * same global after each save, and whether that is dependable depends on the host shell sharing
 * one `globalThis` between the card and the injected script — which it evidently does not.
 *
 * The fix is to ask the Host, on the route the script already calls for its manifest. These
 * assertions pin the three parts that make it work: the route exists, the script refreshes before
 * it resolves a style, and a failed refresh keeps the injected values rather than blanking them.
 */
record('the Host serves the live settings the screensaver acts on',
  /live-settings\.json/.test(entry) && /screensaverPointerEffect: live\.screensaverPointerEffect/.test(entry),
  'without the route the page can only ever use its load-time snapshot')
record('the live route is GET-only',
  /path: `\$\{ROUTE\}\/live-settings\.json`[\s\S]{0,300}req\.method !== 'GET'/.test(entry),
  'a state-changing verb on a read-only route is the wrong contract')
record('the refresh is still kicked off on every appearance',
  /function show\(\)[\s\S]{0,1400}refreshLiveSettings\(\)/.test(saver),
  'without it the page would keep the values it was loaded with')
record('the styles are resolved per use, not captured at install',
  /function pointerEffect\(\)[\s\S]{0,400}CFG\?\.screensaverPointerEffect/.test(saver)
  && /function breakStyle\(\)[\s\S]{0,400}CFG\?\.screensaverBreakStyle/.test(saver),
  'a cached resolution would ignore the value the refresh just brought in')
record('the refresh merges into CFG instead of replacing it',
  /CFG\[key\] = next\[key\]/.test(saver),
  'replacing the object would drop the route URLs the script needs')
record('a failed refresh keeps the injected values',
  /\.catch\(function \(\) \{\s*\/\* an unreachable route leaves the injected values in place \*\//.test(saver),
  'a screensaver that cannot reach the Host must still be a screensaver')
record('the appearance is guarded against a second show() during the fetch',
  /function show\(\) \{\n  if \(visible \|\| root === null\) return[\s\S]{0,900}visible = true\n/.test(saver),
  'two layers could be raised by one idle transition')
// NO CACHE on the refresh. A window was tried and it is wrong here: the moment the user presses
// 预览 is the moment they have most likely just changed a picker, so a cached answer is the value
// from before their edit — which is exactly the state they reported.
record('the settings are refreshed on every appearance, with no time window',
  !/liveSettingsAt > 60000/.test(saver) && !/Date\.now\(\) - liveSettingsAt/.test(saver),
  'a cache would serve the pre-edit value on the first preview after a change')
record('state() reports how much the decoration has drawn',
  /pointerStrokes:/.test(saver) && /pointerRunning:/.test(saver),
  'a mounted-but-empty canvas looks identical to no effect at all')
// THE FIRST TICK'S `dt` MUST BE CLAMPED, or the loop dies on frame one.
//
// `startLoop()` seeds `state.last` from `performance.now()` (a TIME-ORIGIN reading), while a
// requestAnimationFrame callback is handed the FRAME-START timestamp — and that can PRECEDE the
// `performance.now()` that scheduled it. Measured in a real browser: scheduledAt 181.0,
// frameTs 180.9, delta -0.038ms. Every effect integrates `dt` into a size, `tickRipples` does
// `g.r += 96 * dpr * dt`, so the first ring got a radius of -0.038 and `arc()` THROWS on a
// negative radius. The throw left `tick` before it could schedule the next frame, so the
// decoration drew nothing while `state()` still said `pointerRunning: true` with
// `pointerStrokes: 0` — the same signature the pointer-listener bug produced, for a different
// reason, which is why it took a real browser to tell them apart.
//
// A stub canvas accepts any radius, so no offline suite could observe the SYMPTOM — but the
// CAUSE is pure arithmetic and is assertable here: the `dt` expression must clamp at zero. `code`
// is already comment-stripped, which matters because the fix's own prose quotes `Math.max(0, ...)`
// and an unstripped scan would pass on the comment alone.
record('the per-frame delta is clamped at zero, so a first tick cannot integrate backwards',
  /const elapsed = \(now - state\.last\) \/ 1000/.test(code)
  && /Math\.max\(0,\s*elapsed\) \|\| 0\.016/.test(code),
  'a negative first delta makes arc() throw and kills the rAF loop on frame one')

/* ---- the card's "in effect now" list must equal the route's answer ----
 *
 * The banner used to say 刷新页面后生效 for EVERY save, including the screensaver fields that had
 * just been made live. That is how the user ended up asking whether the reload was really
 * necessary. Now the card names a set of live fields and the Host route answers a set, and the two
 * are written in different files — so they are compared here rather than trusted.
 */
const liveInCard = (client.match(/const LIVE_FIELDS = new Set\(\[([\s\S]*?)\]\)/) || [])[1] || ''
const liveInRoute = (entry.match(/settings: \{([\s\S]*?)\},\n\s*\}\)/) || [])[1] || ''
const cardNames = [...liveInCard.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort()
const routeNames = [...liveInRoute.matchAll(/([A-Za-z]+): live\./g)].map((m) => m[1]).sort()
record('the card and the route agree on which fields are live',
  cardNames.length > 0 && routeNames.length > 0
  && JSON.stringify(cardNames) === JSON.stringify(routeNames),
  'card=' + cardNames.join(',') + ' route=' + routeNames.join(','))
record('every live field is a screensaver field',
  cardNames.every((n) => n.startsWith('screensaver')),
  'a boot field cannot be live: it is baked into the head rows at load')
record('the banner offers a reload for a boot field, worded as "next launch", not "not saved"',
  /已保存，下次启动就用新的/.test(client) && /className: 'dshba-reload'/.test(client),
  'a boot change that never appears reads as a failed save')
record('the banner claims instant effect for a live field',
  /已保存，已经生效/.test(client) && !/已保存。刷新页面后生效。/.test(client),
  'the old blanket wording is what made the user distrust the save')

/* ---- the rotation ----
 *
 * A screensaver left up for an hour used to show one clip for the whole hour. The rotation swaps
 * entries on an interval, and the requirements that make it not-terrible are all negative ones:
 * it must not look like a dismissal, it must not repeat, and it must stop with the layer.
 */
record('the rotation swaps the media in place, not hide() + show()',
  /function rotateNow\(\)[\s\S]{0,2200}pickAndPlace\(\)/.test(saver)
  && !/function rotateNow\(\)[\s\S]{0,2200}hide\(/.test(saver),
  'a hide+show would play the exit effect and re-run the appearance')
record('the old entry is released after the snapshot and before the new one mounts',
  /const before = captureForDissolve\(\)[\s\S]{0,120}releaseMedia\(\)[\s\S]{0,80}pickAndPlace\(\)/.test(saver),
  'releasing first loses the dissolve picture; releasing later stacks two entries')
/* ---- the switch happens the INSTANT the clip ends, not at the next tick ----
 *
 * The first version polled `currentTime()` from the rotation interval, which answers "close enough"
 * one tick late: with a 15s interval and a clip ending at 15.2s the switch would land at 30s. The
 * user was explicit — "当前播完再换，不是下次再检查". The due time therefore ARMS a listener and the
 * replacement runs from the `ended` event itself.
 */
record('the due time arms an ended listener rather than polling the playhead',
  /renderer\.onEnded\(\(\) => \{/.test(saver),
  'polling from the interval can only ever switch one tick late')
record('the ended listener only fires for the entry it watched',
  /if \(media === watched && visible && rotationDue\) rotateNow\(\)/.test(saver),
  'a stale listener would switch a layer that has already been replaced or dismissed')
record('a clip that ended before the due time switches immediately',
  /alreadyEnded[\s\S]{0,400}rotateNow\(\)/.test(saver),
  'a clip shorter than the interval would wait a whole extra period after its final frame')
record('an entry with no timeline switches on the tick itself',
  /typeof renderer\.onEnded === 'function'[\s\S]{0,900}rotateNow\(\)/.test(saver),
  'a still image has no end event and would never switch')
record('the due flag is cleared by the switch, so one period cannot switch twice',
  /function rotateNow\(\) \{[\s\S]{0,200}rotationDue = false/.test(saver),
  'a renderer that fires `ended` twice would switch twice')
record('the due flag is reset with the rotation, not carried into the next appearance',
  /function stopRotation\(\)[\s\S]{0,300}rotationDue = false/.test(saver),
  'the next appearance would switch a clip the user had only just started watching')
record('the switch plays a cross dissolve',
  /function crossDissolve\(before\)/.test(saver) && /crossDissolve\(before\)/.test(saver),
  'swapping instantly is the "cut" the user asked to replace')
record('the dissolve honours reduced motion',
  /function crossDissolve\(before\) \{\n  if \(before === null \|\| root === null\) return\n  if \(prefersReducedMotion\(\)\) return/.test(saver),
  'an animated fade must not run for somebody who asked for less motion')
record('the dissolve canvas is removed even if frames stop running',
  /setTimeout\(\(\) => \{ if \(canvas\.parentNode\) canvas\.remove\(\) \}/.test(saver),
  'a hidden window stops rAF and would leave an opaque snapshot on top forever')
record('the dissolve layer never takes input',
  /PREFIX \+ '-dissolve'[\s\S]{0,200}pointer-events:none/.test(saver),
  'a full-screen canvas over the catcher would make the layer undismissable')
record('the rotation never picks the entry already on screen',
  /pool\.filter\(\(name\) => name !== current/.test(saver),
  'with two clips the same one lands twice in a row half the time')
record('the rotation cycles through the pool before repeating',
  /!rotationSeen\.includes\(name\)/.test(saver),
  'the pool would be sampled with replacement and look random-but-stuck')
record('the rotation clock is armed on appearance and disarmed on dismissal',
  /if \(pointer !== null\) startPointerArt\(pointer\)[\s\S]{0,200}startRotation\(\)/.test(saver)
  && /stopPointerArt\(\)[\s\S]{0,300}stopRotation\(\)/.test(saver),
  'a timer would keep rebuilding media for a layer nobody can see')
record('the interval is read from the live config, not the install-time snapshot',
  /CFG\?\.screensaverRotateMs/.test(saver),
  'an interval the user just set would not apply until a rebuild')
record('an interval under a second is refused',
  /if \(!\(ms >= 1000\)\) return/.test(saver),
  'a hand-edited document could arm a timer that fires every frame')
record('the lens re-takes its snapshot after a swap',
  /state\.refreshSource[\s\S]{0,200}captureSource\(\)/.test(saver),
  'the lens would keep displacing the discarded picture')
// The Host side has to carry the field, or the card writes something the schema rejects.
record('entry.js declares the rotation interval and bounds it',
  /screensaverRotateMs: live\(z\.number\(\)\.min\(0\)\.max\(600000\)/.test(entry),
  'the field is missing from the schema, or unbounded')
record('entry.js defaults the rotation to OFF',
  /screensaverRotateMs: 0,/.test(entry),
  'rotation would start on profiles that never asked for it')
record('entry.js forwards the interval to the page',
  /screensaverRotateMs: settings\.screensaverRotateMs/.test(entry),
  'the page would never see the setting')
record('the card offers the interval and stores milliseconds',
  /ROTATE_CHOICES/.test(client) && /write\('screensaverRotateMs', choice\[0\] \* 1000\)/.test(client),
  'the card would store seconds where milliseconds are expected')

// The loop must be able to stop, or a screensaver left up overnight runs an animation forever.
record('the loop parks when idle',
  /state\.running = false/.test(saver) && /const keep = busy \|\| state\.inside/.test(saver),
  'the pointer loop has no idle exit')
record('a pointer move restarts it', /if \(!state\.running\) startLoop\(\)/.test(saver))

// Teardown: the canvas sits above the media and would ghost over the app.
//
// The anchor used to be the literal text `if (withBreak && config.breakEffect`, which was both
// fragile (any rewrite of the gate broke it) and WRONG (it pinned the snapshot read). It now
// looks inside `hide()` and asks the question that matters — is the decoration taken down
// before the exit effect starts? — by locating the dispatcher call rather than the gate.
const hideBodyForTeardown = bodyOf(code, 'function hide(')
const breakCallAt = hideBodyForTeardown.search(/breakApart\s*\(/)
const teardownAt = hideBodyForTeardown.search(/stopPointerArt\s*\(\s*\)/)
record('the decoration is torn down on hide',
  hideBodyForTeardown.length > 0 && teardownAt >= 0
  && (breakCallAt < 0 || teardownAt < breakCallAt),
  hideBodyForTeardown.length === 0
    ? 'hide() body not found'
    : `stopPointerArt at ${String(teardownAt)}, breakApart at ${String(breakCallAt)}: the decoration is torn down after the layer starts leaving`)
record('teardown removes its canvas and listeners',
  /pointerArt\.canvas\.remove\(\)/.test(saver) && /pointerArt\.detach/.test(saver))
record('the decoration never takes input',
  /pointer-events:none/.test(saver),
  'the pointer canvas would block the click that dismisses the screensaver')

/* ---- the snapshot resolution each effect needs ----
 *
 * breakFall and breakGlitch index the source with WINDOW coordinates (width / COLS, rect(0, b.y,
 * width, b.h)), so they need a full-size frame. breakParticles draws one block per source pixel, so
 * it needs the downsampled one. Handing either family the other's snapshot produces an effect running
 * on the wrong pixels — a stretched smear — with no error anywhere, which is exactly how this shipped.
 */
record('a full-resolution snapshot exists', /function snapshotFull\(width, height\)/.test(saver))
record('the capture is chosen by effect',
  /style === 'particles'[\s\S]{0,80}\? snapshotFrame\(width, height\)[\s\S]{0,40}: snapshotFull\(width, height\)/.test(saver),
  'both effects are not given different snapshots')
record('the block effect keeps the downsampled snapshot',
  /\? snapshotFrame\(width, height\)/.test(saver))
record('the fall effect indexes with window coordinates', /width \/ COLS/.test(saver))

console.log('')
if (failures.length === 0) {
  console.log(passed + '/' + passed + ' passed')
  process.exit(0)
}
console.log(passed + ' passed, ' + failures.length + ' FAILED')
for (const line of failures) console.log('  FAIL  ' + line)
process.exit(1)
