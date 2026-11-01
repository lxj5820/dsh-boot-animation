// dsh-boot-animation — browser half.
//
// Two jobs, in this order and with this priority:
//
//   1. Report the browser roster's activation to the injected pre-boot screen
//      (`clientReady`). That call is part of the screen's hand-off condition, so
//      it happens first, unconditionally, and cannot be delayed or prevented by
//      anything below it.
//   2. Contribute the settings card to the Plugins settings page.
//
// Everything about job 2 is optional by construction. This package does not
// declare `inject`, because a required service would leave the fiber PENDING in
// a profile that lacks it — and then job 1 would never run, the screen would
// never learn the kernel is ready, and the animation would sit there refusing to
// hand over. The services are therefore reached with the dynamic
// `ctx.inject(deps, callback)` form, which waits for them without gating `apply`:
// the callback fires once both arrive, and simply never fires if they do not.
//
// NOT `ctx.get(name)`. That was the first attempt and it silently found nothing
// in this deployment: `dsh-boot-animation` was the only client bundle in the whole
// profile reaching for `ctx.get('slots')` and `ctx.get('settingsScope')`, while
// every other plugin — dsh-image-gen, git-graph, genui, better-sidebar, and the
// harness's own packages — uses exactly the `ctx.inject` form below, and reads the
// awaited services with `owner.get(name)`. A missing service read as
// "unavailable", the registration was skipped without a word, and the card never
// appeared. `verify-client-bundle.mjs` now fails if this file goes back to it.
//
// Bundle artifact contract: the shell materializes this file as a closure
// factory (`window.__ModuleLoader__.load({ id, factory })`), so `require` is a
// parameter supplied by the shell's module table. `react` is one of the baseline
// modules every dynamic bundle may request (packages/client/web/src/platform.ts),
// so asking for it needs no declaration in package.json.

const OVERLAY = '__DSH_BOOT_ANIM__'

/** Settings namespace the Host half registers; also this card's slot key. */
const SETTINGS_NAMESPACE = 'boot-animation'

/**
 * The fields that are in effect as soon as they are saved.
 *
 * The screensaver half re-reads these from the Host before every appearance (`show()` calls
 * `/live-settings.json`, which answers from the same live config the head row is built from), so
 * a saved value needs no reload. Everything NOT in this list is baked into the page's head rows
 * when the page loads — the boot screen's clip list, its fade, its entry mode — and does need one.
 *
 * THIS LIST MUST MATCH THE ROUTE. `entry.js`'s `live-settings.json` handler names the same fields;
 * if the two drift, the banner either promises an instant effect that does not happen or demands
 * a reload that was not necessary. `verify-exit-effects.mjs` compares them.
 */
const LIVE_FIELDS = new Set([
  'screensaverEnabled',
  'screensaverIdleMs',
  'screensaverBreakEffect',
  'screensaverBreakStyle',
  'screensaverHint',
  'screensaverPointerEffect',
  'screensaverSound',
  'screensaverVolume',
  'screensaverRotateMs',
])

/**
 * The Plugins settings page dispatches cards by slot name. It was
 * `settings.plugin.item` in the API this plugin was first written against;
 * current builds (verified against 0.2.0-rc.2) register into `plugins.item`.
 */
const SLOT = 'plugins.item'

/** Client dictionary namespace this card's tab label is read from. */
const LOCALE_NAMESPACE = 'bootAnimation'

/** Tab label, in the two dictionaries the locale service takes. */
const DICTIONARY_ZH = { title: '启动动画' }

/** English half of the same dictionary. */
const DICTIONARY_EN = { title: 'Boot animation' }

/** Where each pool is published, relative to the page. */
const MANIFEST = '/plugins/dsh-boot-animation/clips.json'
const SCREENSAVER_MANIFEST = '/plugins/dsh-boot-animation/screensaver.json'

/**
 * Where one clip's index table is moved to the front of its file.
 *
 * The file name travels in the query string rather than a body: the Host's own
 * handler is handed the raw request, and a query parameter needs no body parsing
 * to be certain of.
 */
const OPTIMIZE = '/plugins/dsh-boot-animation/optimize'

/**
 * Where a pool directory is opened in the system file manager.
 *
 * This goes through the Host because a page cannot do it: browsers deny a web page
 * the ability to launch a local program or reveal a path. The Host runs in Node and
 * has that privilege, so the button asks it to act on the user's behalf. The pool
 * travels as a whitelist key, never as a path — see the route in `entry.js`.
 */
const REVEAL = '/plugins/dsh-boot-animation/reveal'

/** Offered dissolve lengths, in milliseconds. */
const FADE_CHOICES = [1000, 1500, 2000, 3000, 4000]

/** The three hand-off styles, with the sentence that explains each one. */
const ENTER_MODES = [
  ['tail', '片尾交叉溶解', '片子快放完就开始淡，放完正好进界面'],
  ['end', '放完再淡', '片子放完停住，然后再淡出'],
  ['click', '点击才进', '一直循环播放，直到你点一下'],
]

/**
 * The exit effects the screensaver can play, in card order.
 *
 * Each entry is the stored value, its button label, and the sentence that explains what it does.
 * The first is `random`, because that is the default and the point: the effect is a flourish and
 * the same flourish every time stops being one.
 *
 * These names are the contract with the Host (`BREAK_STYLES` in entry.js) and with the
 * screensaver (`breakStyle()` in src/screensaver.js). Renaming one here alone would leave the
 * card writing a value the other two reject — which degrades to a plain dissolve, so it fails
 * quietly rather than loudly. Keep the three lists in step.
 */
/**
 * The pointer decorations the screensaver can play, in card order.
 *
 * These names are the contract with the Host (POINTER_EFFECTS in entry.js) and with the screensaver
 * (pointerEffect() in src/screensaver.js). Keep the three lists in step: a name that drifts is
 * rejected by the Host schema and silently falls back to 不显示.
 */
/**
 * A small abstract mark for each option, as [width, height] bar pairs.
 *
 * These are not decoration: each says what the option DOES, which is what lets a selection be read at
 * a glance. A grid of identical pills tells you which one is chosen only by comparing borders.
 */
const MARK = {
  // Ripples: bars centred and growing, like a wave front seen edge-on.
  ripples: [[4, 4], [7, 7], [10, 10], [7, 7], [4, 4]],
  // Attract: a narrow column widening toward the middle, i.e. drawn inward.
  attract: [[2, 2], [3, 5], [4, 8], [3, 5], [2, 2]],
  // Lens: a diamond lattice — equal bars offset.
  lens: [[5, 5], [5, 9], [5, 5]],
  // Particles: a left-heavy scatter.
  particles: [[6, 6], [4, 4], [3, 3], [2, 2]],
  // Fall: stacked blocks, the lowest and largest last.
  fall: [[5, 3], [5, 3], [5, 6]],
  // Glitch: bars broken out of alignment.
  glitch: [[6, 3], [3, 3], [6, 3]],
  // Random: an uneven scatter standing in for a pick.
  random: [[3, 6], [3, 3], [3, 6]],
  // Off: one flat bar.
  none: [[10, 2]],
  // Fade: a short bar growing into a long one — the dissolve, seen as width.
  fade: [[3, 4], [6, 4], [10, 4]],
  // Tail dissolve: two bars meeting, i.e. the clip handing over.
  tail: [[6, 4], [3, 4], [6, 4]],
  // "After it ends": a bar that has stopped, then a gap.
  end: [[8, 4], [2, 4]],
  // "Click to enter": a pointer, as a dot above a bar.
  click: [[4, 4], [4, 8]],
}

/**
 * The pointer effects the card OFFERED, back when it offered them.
 *
 * The picker is HIDDEN by request (see the note in the screensaver section below), so nothing
 * in this file renders these names and this table currently has no reader in shipped code.
 *
 * It is kept anyway, and deliberately, for two reasons:
 *
 *   1. `tools/verify-exit-effects.mjs` reads it as its ANCHOR: it asserts that the card offers
 *      exactly the three kept styles and none of the retired ones, and it finds that block by
 *      searching for these declarations. A constant consumed by a suite is not dead code — deleting
 *      it would turn two assertions red for a change that is about dead code, which is the wrong
 *      kind of green.
 *   2. Restoring the picker is the one-line change the hidden note promises. This table plus the
 *      `MARK.ripples` / `MARK.attract` / `MARK.lens` marks are exactly what that line needs.
 *
 * The retired names (lens, random) stay in the schema and in src/screensaver.js, so a profile that
 * still stores one keeps working; they are absent from this table because the card no longer offers
 * a choice the user asked to retire.
 */
const POINTER_EFFECT_CHOICES = [
  // The description is used only as the button's `title` (a tooltip), never rendered as a line of
  // text in the card — the card asks for the choice, not for a paragraph about it.
  //
  // THREE, by request. 菱形涟漪 and 随机 were removed: the first never read as water and the
  // second was only ever a way to see the first. The implementations are still in
  // src/screensaver.js, so a profile that still stores one of them keeps working — but the card
  // no longer offers a choice the user asked to retire.
  ['none', '不显示', '屏保是一张静止的画面，鼠标划过不会有任何变化'],
  ['ripples', '水波涟漪', '一圈圈波纹从画面中间往外扩，鼠标在哪就从哪扩'],
  ['attract', '星屑吸附', '满屏的星尘被鼠标吸过去，移开就散回原处'],
]

/**
 * The pointer effects the card can offer, in card order.
 *
 * Kept as a list rather than inlined so the stored value can be checked against it: a profile
 * holding a retired name (lens, random) would otherwise render a picker with NOTHING selected,
 * which reads as "the setting was lost".
 *
 * Retained even though the card currently has no picker to feed (see the note above) because
 * `tools/verify-exit-effects.mjs` uses these two declarations as its anchor for "the card offers
 * exactly the three kept styles". A constant a suite consumes is not dead code.
 */
const POINTER_EFFECT_NAMES = POINTER_EFFECT_CHOICES.map(entry => entry[0])

const BREAK_STYLE_CHOICES = [
  ['random', '随机', '每次退出随机挑一个'],
  ['particles', '粒子消散', '画面碎成小块，往右飘散消失'],
  ['fall', '重力下坠', '画面碎成方块，加速往下掉出屏幕'],
  ['glitch', 'Glitch 宽带位移', '画面横向错位、马赛克、红蓝色散'],
]

/**
 * The three behaviour switches, in card order.
 *
 * Each entry is the field name, its label, and the pair of sentences under it —
 * the one for "on" and the one for "off" — because a switch whose explanation
 * does not change with its state is the reason people leave it alone.
 */
const BEHAVIOUR = [
  ['sound', '播放影片声音',
    '会尝试带声音播放，右下角出现开声音按钮',
    '已彻底静音：不尝试开声音，按钮也不出现'],
  ['clickToEnter', '点鼠标直接进入',
    '按一下画面就直接进界面',
    '按一下先开声音，再按一下才进（默认）'],
  ['showHint', '显示底部提示文字',
    '底部显示「点击进入」这类提示',
    '底部不显示提示，标题和进度条保留'],
]

/** Offered screensaver thresholds, in milliseconds. */
const IDLE_CHOICES = [60000, 180000, 300000, 600000]

/**
 * How long each screensaver entry stays before the next one takes over, in seconds.
 *
 * The first entry is 0 = no rotation, and it is the default. Each row is
 * `[seconds, label, tooltip]`; the card multiplies by 1000 before storing, because the stored
 * unit is milliseconds while the setting people reason about is seconds.
 *
 * Four values rather than a number field: a free box invites two seconds (a flicker) or two hours
 * (a rotation nobody sees), and neither is worth the freedom.
 */
const ROTATE_CHOICES = [
  [0, '不轮换', '屏保挑一条就一直放着，直到你回来（默认）'],
  [15, '15 秒', '每 15 秒换一条'],
  [30, '30 秒', '每 30 秒换一条'],
  [60, '1 分钟', '每 1 分钟换一条'],
  [300, '5 分钟', '每 5 分钟换一条'],
]

/**
 * Human labels for the media kinds the manifest publishes.
 *
 * The kind is what the screen picks a renderer by, and it is also the answer to
 * "why does this row have no 优化 button" — so it is shown rather than left as a
 * field only the code reads.
 */
const KIND_LABEL = {
  video: '视频',
  image: '静态图',
  animated: '动图',
  live2d: 'Live2D',
}

/**
 * The card's icon, and where it comes from.
 *
 * `plugins.item` publishes only `id` / `order` / `label` — there is no icon field
 * in the slot's registration face, so a picture cannot be handed to the harness's
 * own header row. The card therefore draws the icon ITSELF, inside the header it
 * renders: a 40px rounded thumbnail on the left of the title. Two sources, in
 * order of preference:
 *
 *   1. `assets/icon/icon-80.png`, served by the Host's own media route. Preferred
 *      because swapping the picture then needs no code change at all.
 *   2. The inline data URI below, used when that fetch fails. Without a fallback a
 *      card whose asset went missing would render a broken-image glyph in the
 *      settings page — the one place a missing file is least forgivable.
 */
const ICON_ROUTE = '/plugins/dsh-boot-animation/icon/icon-80.png'

/** Stable empty snapshot, so `getSnapshot` never returns a fresh object. */
const NO_SNAPSHOT = Object.freeze({
  status: 'unavailable', value: undefined, base: undefined, user: undefined,
  revision: undefined, writable: false, mode: 'host',
})

const STYLE_ID = 'dsh-boot-animation-card-style'

// No backticks in this sheet: it is a plain string, but the surrounding project
// convention is that a stray backtick in a CSS blob has already cost this plugin
// one silent build failure.
//
// The token names and the geometry are copied from the harness's own plugin card
// (ui-settings-plugins/src/client/PluginCard.module.css) so this card reads as a
// shipped one rather than a guest: same border, radius, layer colours, header
// metrics and chevron motion. Each token keeps a literal fallback for a page that
// has no theme loaded.
const CSS = [
  '.dshba-card{list-style:none;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.28));',
  'border-radius:16px;background:var(--dsw-alias-bg-layer-3,transparent);',
  'transition:border-color .16s,background .16s;font-family:inherit}',
  '.dshba-card:hover{border-color:var(--dsw-alias-label-dimmed,rgba(127,127,127,.5))}',
  '.dshba-card[data-open="1"]{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));',
  'border-color:var(--dsw-alias-label-dimmed,rgba(127,127,127,.5))}',
  '.dshba-head{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;',
  'text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}',
  '.dshba-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f9dd9);outline-offset:-2px}',
  '.dshba-headtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}',
  // The icon. An <img> inside the card's own header, because the slot offers no
  // icon field. The background colour is the fallback for a picture that has not
  // loaded yet, so the row never collapses to an empty box.
  '.dshba-ico{flex:none;width:40px;height:40px;border-radius:11px;object-fit:cover;display:block;',
  'background:rgba(127,127,127,.16)}',
  // A collapsible group INSIDE the opened card. The card itself is one folding
  // layer; this is the second. Both are needed because twelve settings and two
  // media pools do not fit on one screen, and the sections people actually touch
  // (the two switches) should not be buried under the pools they rarely open.
  '.dshba-grp{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));',
  'border-radius:10px;margin:0 0 10px;overflow:hidden}',
  '.dshba-grp:last-child{margin-bottom:0}',
  '.dshba-grphead{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;',
  'text-align:left;cursor:pointer;display:flex;align-items:center;gap:8px;padding:10px 12px}',
  '.dshba-grphead:hover{background:rgba(127,127,127,.09)}',
  '.dshba-grphead:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f9dd9);outline-offset:-2px}',
  '.dshba-grptitle{flex:1;min-width:0;font-size:12.5px;font-weight:600;',
  'color:var(--dsw-alias-label-primary,inherit)}',
  '.dshba-grpsum{font-size:11.5px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.85));',
  'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:52%}',
  '.dshba-grpchev{flex:none;width:6px;height:6px;margin-right:2px;',
  'border-right:1.5px solid var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));',
  'border-bottom:1.5px solid var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));',
  'transform:rotate(-45deg);transition:transform .16s}',
  '.dshba-grp[data-open="1"] .dshba-grpchev{transform:rotate(45deg)}',
  '.dshba-grpbody{padding:2px 12px 12px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16))}',
  // The save banner. What it says depends on WHICH field was stored, because the two
  // halves differ: a screensaver field is re-read by the layer before every appearance,
  // and a boot field is rebuilt into the head rows on every index render. Neither
  // promise is "reload or it did not happen" — see the two messages themselves.
  '.dshba-saved{display:flex;align-items:center;gap:10px;margin:0 0 12px;padding:8px 11px;',
  'border-radius:9px;font-size:12px;line-height:1.5;',
  'background:rgba(7,150,90,.1);border:.5px solid rgba(7,150,90,.32);',
  'color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95))}',
  '.dshba-saved span{flex:1;min-width:0}',
  '.dshba-reload{flex:none;border:1px solid rgba(7,150,90,.5);background:none;color:#07974b;',
  'border-radius:7px;padding:3px 10px;font:inherit;font-size:11.5px;cursor:pointer}',
  '.dshba-reload:hover{background:rgba(7,150,90,.14)}',
  '.dshba-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,inherit)}',
  '.dshba-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9))}',
  '.dshba-chev{flex:none;width:7px;height:7px;margin-right:3px;',
  'border-right:1.5px solid var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));',
  'border-bottom:1.5px solid var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));',
  'transform:rotate(45deg);transition:transform .16s}',
  '.dshba-card[data-open="1"] .dshba-chev{transform:rotate(225deg)}',
  '.dshba-body{border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));',
  'margin:0 16px;padding:14px 0 10px}',
  '.dshba-sec{margin:0 0 18px}',
  '.dshba-sec:last-child{margin-bottom:4px}',
  '.dshba-h{font-size:13px;font-weight:600;line-height:1.5;margin:0 0 3px;',
  'color:var(--dsw-alias-label-primary,inherit)}',
  '.dshba-p{margin:0 0 10px;font-size:12px;line-height:1.5;',
  'color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9))}',
  '.dshba-row{display:flex;flex-wrap:wrap;gap:6px}',
  '.dshba-switch{display:inline-flex;align-items:center;gap:9px;cursor:pointer}',
  // One switch per line. inline-flex is right for a control that follows text on the
  // same line, but a LIST of switches sharing a line reads as one paragraph with two
  // checkboxes in it — which is exactly what the screensaver section looked like.
  //
  // The BOTTOM margin is what stopped it crushing whatever follows. With only a top margin the
  // row's box ended at the text baseline, so a slider placed under it sat 8px from that box and
  // appeared to overlap the label.
  '.dshba-line{display:flex;margin:12px 0 4px}',
  // The hint switch closes the settings list, so it gets room above it instead of a tight gap.
  '.dshba-hintline{margin:18px 0 2px}',
  '.dshba-switch input{margin:0;flex:none}',
  '.dshba-opt{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));background:none;',
  'color:inherit;border-radius:8px;padding:5px 12px;font:inherit;font-size:12.5px;cursor:pointer}',
  '.dshba-opt:hover:not(:disabled){background:rgba(127,127,127,.14)}',
  '.dshba-opt[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#07974b);',
  'color:var(--dsw-alias-brand-primary,#07974b);font-weight:600;background:rgba(7,193,96,.1)}',
  // A control TILE rather than a pill: room for a mark above the label, and a raised, lit state
  // for the selection. The mark is what makes a choice readable at a glance — a row of pills with
  // one outlined tells you which is on only by comparing borders.
  '.dshba-tile{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;gap:5px;',
  'padding:9px 6px 8px;border-radius:11px;cursor:pointer;font:inherit;color:inherit;',
  'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.26));',
  'background:rgba(127,127,127,.05);transition:border-color .16s,background .16s,transform .16s}',
  '.dshba-tile:hover{border-color:var(--dsw-alias-label-dimmed,rgba(127,127,127,.5));',
  'background:rgba(127,127,127,.09)}',
  '.dshba-tile[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#4f9dd9);',
  'background:rgba(79,157,217,.13);box-shadow:0 0 0 1px rgba(79,157,217,.22) inset}',
  '.dshba-tile:disabled{opacity:.45;cursor:default}',
  '.dshba-tile-name{font-size:11.5px;line-height:1.25;text-align:center;',
  'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
  '.dshba-tile[data-on="1"] .dshba-tile-name{font-weight:600}',
  // The mark: a tiny abstract diagram of what the option does. Drawn with spans so it needs no
  // images and inherits the text colour.
  '.dshba-mark{position:relative;width:100%;height:16px;display:flex;align-items:center;',
  'justify-content:center;gap:3px;opacity:.6;transition:opacity .16s}',
  '.dshba-tile[data-on="1"] .dshba-mark{opacity:1}',
  '.dshba-mark i{display:block;background:currentColor;border-radius:1px;font-style:normal}',
  // The tiles sit in a grid that keeps them equal, so a long label cannot make one wider.
  '.dshba-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));',
  'gap:7px;margin:8px 0 0}',
  // The display number: the one value worth reading at a glance.
  '.dshba-display{display:flex;align-items:baseline;gap:6px;margin:2px 0 0}',
  '.dshba-display b{font-size:26px;line-height:1;font-weight:600;',
  'font-variant-numeric:tabular-nums;letter-spacing:-.02em}',
  '.dshba-display span{font-size:11.5px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.85))}',
  // The motion layer. Three small motions, CSS only: nothing here can stall the card, and all of it
  // is suppressed for a user who asked for reduced motion.
  '@keyframes dshba-mark-pulse{0%{transform:scale(1)}45%{transform:scale(1.22)}100%{transform:scale(1)}}',
  '@keyframes dshba-num-in{0%{opacity:0;transform:translateY(4px)}100%{opacity:1;transform:translateY(0)}}',
  '.dshba-tile{transition:border-color .16s,background .16s,transform .16s,box-shadow .16s}',
  '.dshba-tile:not(:disabled):hover{transform:translateY(-1px)}',
  '.dshba-tile:not(:disabled):active{transform:translateY(0) scale(.985)}',
  '.dshba-tile[data-on="1"] .dshba-mark{animation:dshba-mark-pulse .42s cubic-bezier(.3,.8,.4,1)}',
  '.dshba-display b{animation:dshba-num-in .28s ease-out}',
  '@media (prefers-reduced-motion: reduce){',
  '.dshba-tile,.dshba-tile:not(:disabled):hover,.dshba-tile:not(:disabled):active{transition:none;transform:none}',
  '.dshba-tile[data-on="1"] .dshba-mark,.dshba-display b{animation:none}}',
  '.dshba-opt:disabled{opacity:.45;cursor:default}',
  // The custom-minutes box. Narrow because it holds at most two digits, and
  // monospace-ish alignment so the number does not shift as it is typed.
  '.dshba-num{width:64px;box-sizing:border-box;font:inherit;font-size:12.5px;padding:5px 8px;',
  'border-radius:8px;text-align:center;color:inherit;',
  'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.34));background:rgba(127,127,127,.1)}',
  '.dshba-num:focus{outline:2px solid var(--dsw-alias-brand-primary,#4f9dd9);outline-offset:-2px}',
  // The volume slider. accent-color is the whole styling, for the same reason the switches use
  // it: a hand-built track loses the platform's own focus ring and keyboard behaviour.
  '.dshba-vol{margin:12px 0 0}',
  '.dshba-range{flex:1;min-width:0;accent-color:var(--dshba-sea-2);cursor:pointer}',
  '.dshba-range:disabled{opacity:.45;cursor:default}',
  '.dshba-range:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f9dd9);',
  'outline-offset:2px;border-radius:4px}',
  // overflow:hidden + min-width:0 are what stop the row pushing past the card. Without them a
  // row of badges + a button + a size can exceed the width, and the FIRST thing to go off the
  // left edge is the checkbox — which is the control the row exists for.
  // The same radius and hover tint as a tile, so the two sections feel like one panel.
  '.dshba-clip{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:10px;',
  'transition:background .14s;min-width:0;overflow:hidden}',
  '.dshba-clip:hover{background:rgba(127,127,127,.07)}',
  '.dshba-clip input{margin:0;flex:none;cursor:pointer}',
  '.dshba-nm{flex:1 1 60px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dshba-badge{font-size:11px;line-height:1.5;padding:1px 7px;border-radius:999px;white-space:nowrap;',
  'font-variant-numeric:tabular-nums;',
  'background:rgba(127,127,127,.18);color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95))}',
  '.dshba-badge.warn{background:rgba(210,120,40,.18);color:#b46214}',
  '.dshba-badge.bad{background:rgba(210,74,67,.18);color:#d24a43}',
  '.dshba-badge.ok{background:rgba(7,150,90,.18);color:#07974b}',
  // flex-wrap lets the badges drop to a second line instead of forcing the row wider. At the
  // card's width that is what keeps the checkbox and the size on screen.
  '.dshba-clipline{display:flex;align-items:center;gap:6px;flex:1;min-width:0;cursor:pointer;',
  'flex-wrap:wrap;row-gap:3px}',
  // The badge strip. It is a container rather than loose siblings so the material
  // row can put every fact on ONE line under the file name; without it the badges
  // were siblings of the checkbox and wrapped around it.
  '.dshba-badges{display:flex;flex-wrap:wrap;align-items:center;gap:5px;min-width:0}',
  '.dshba-mini{flex:none;padding:3px 10px;font-size:11.5px;white-space:nowrap}',
  '.dshba-meta{font-size:11.5px;color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8));white-space:nowrap}',
  '.dshba-msg{margin-top:8px;font-size:11.5px;line-height:1.5;',
  'color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8))}',
  '.dshba-msg.err{color:var(--dsw-alias-label-error,#d24a43)}',
  // The folder dialog. A fixed overlay rather than an in-card panel, because the
  // settings page is a scrolling list and a path the user may want to copy should
  // not scroll away underneath them.
  '.dshba-modal{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;',
  'justify-content:center;background:rgba(0,0,0,.45);padding:24px}',
  '.dshba-sheet{width:min(520px,92vw);max-height:80vh;overflow:auto;border-radius:14px;',
  'background:var(--dsw-alias-bg-layer-3,#1c1c1e);',
  'border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.3));',
  'box-shadow:0 18px 48px rgba(0,0,0,.45);padding:18px 18px 14px;font-family:inherit}',
  '.dshba-sheet-h{margin:0 0 4px;font-size:14px;font-weight:600;',
  'color:var(--dsw-alias-label-primary,inherit)}',
  '.dshba-sheet-p{margin:0 0 12px;font-size:12px;line-height:1.6;',
  'color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9))}',
  // The path is monospace and selectable: copying it is the fallback when the
  // launcher is unavailable, so it must not be styled like prose.
  '.dshba-path{display:block;width:100%;box-sizing:border-box;font-family:ui-monospace,Consolas,monospace;',
  'font-size:12px;line-height:1.6;padding:9px 11px;border-radius:8px;word-break:break-all;',
  'background:rgba(127,127,127,.13);border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));',
  'color:var(--dsw-alias-label-primary,inherit);-webkit-user-select:all;user-select:all}',
  '.dshba-sheet-acts{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}',
  '.dshba-sheet-note{margin:12px 0 0;font-size:11.5px;line-height:1.6;',
  'color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.8))}',
  '.dshba-sheet-note.err{color:var(--dsw-alias-label-error,#d24a43)}',

  /* ---- the visual layer ---------------------------------------------------
   *
   * Applied AFTER the base geometry above, on purpose: it re-states the same class
   * names at equal specificity, so the rules above stay as the record of what this
   * card inherits from the harness's own plugin card, and everything that makes it
   * RECOGNISABLE lives here in one place.
   *
   * The identity is one borrowed colour pair, taken from the boot screen this
   * plugin plays: a cold deep-sea rail down the left edge, a wash across the
   * header, a lit rim on the icon, and the same sea accent on every chosen control.
   * Nothing in the settings list looks like it, and nothing here needs a font, an
   * image or a network request.
   *
   * Dark mode is keyed on body[data-ds-dark-theme] — the selector the shipped
   * ui-theme bundle actually writes on the body — rather than on a media query: a
   * user who picks Dark on a light machine must still get the dark card.
   */
  '.dshba-card{--dshba-sea-1:#2b7fb8;--dshba-sea-2:#4f9dd9;--dshba-sea-3:#8fd8ff;',
  '--dshba-sea-soft:rgba(79,157,217,.1);--dshba-sea-line:rgba(79,157,217,.42);',
  '--dshba-sea-glow:rgba(79,157,217,.2);',
  'position:relative;background-color:var(--dsw-alias-bg-layer-3,transparent);',
  // The rail is a BACKGROUND rather than an absolutely positioned child: a
  // background is clipped by the border radius for free, while a child would poke
  // out of the rounded corner and need overflow:hidden — which would also clip
  // the folder sheet this card renders inside itself.
  'background-image:linear-gradient(180deg,var(--dshba-sea-line),var(--dshba-sea-soft));',
  'background-size:3px 100%;background-position:left top;background-repeat:no-repeat;',
  'transition:border-color .16s,background-color .16s,box-shadow .16s}',
  'body[data-ds-dark-theme] .dshba-card{--dshba-sea-1:#4f9dd9;--dshba-sea-2:#8fd8ff;',
  '--dshba-sea-3:#c6ecff;--dshba-sea-soft:rgba(143,216,255,.12);',
  '--dshba-sea-line:rgba(143,216,255,.4);--dshba-sea-glow:rgba(143,216,255,.18)}',
  '.dshba-card[data-open="1"]{background-color:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));',
  'border-color:var(--dshba-sea-line);',
  'background-image:linear-gradient(180deg,var(--dshba-sea-2),var(--dshba-sea-3));',
  // Re-stated, and it is load-bearing: the base rule above carries this size at a
  // LOWER specificity than this selector, and the older card rule for the same
  // state uses the background SHORTHAND, which resets background-size to auto.
  // Without this line the rail gradient fills the whole card — a solid blue card
  // that looks nothing like the design and hides every label on it.
  'background-size:3px 100%;background-position:left top;background-repeat:no-repeat;',
  'box-shadow:0 2px 18px var(--dshba-sea-glow)}',
  // The header wash: a radial from the top-left corner, so the row reads as LIT
  // from one side rather than tinted all over.
  '.dshba-head{background-color:transparent;',
  'background-image:radial-gradient(ellipse 130% 170% at 0% 0%,var(--dshba-sea-soft),transparent 58%);',
  'transition:background-image .18s}',
  '.dshba-head:hover{background-image:radial-gradient(ellipse 130% 170% at 0% 0%,',
  'rgba(79,157,217,.19),transparent 62%)}',
  'body[data-ds-dark-theme] .dshba-head:hover{background-image:radial-gradient(ellipse 130% 170% at 0% 0%,',
  'rgba(143,216,255,.16),transparent 62%)}',
  '.dshba-head:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f9dd9);',
  'outline-offset:-2px}',
  // A lit rim, not a drop shadow: the icon sits on a dark picture, and a rim is
  // what reads as "a light behind it" at 40px.
  '.dshba-ico{box-shadow:0 0 0 1px var(--dshba-sea-line),0 3px 12px var(--dshba-sea-glow)}',
  // The state pill. Rendered ONLY when the animation is switched off (see the
  // header in the card): a disabled card otherwise looks identical to a working
  // one in the plugin list, and "why is nothing playing" is the report that
  // follows. No pill when it is on — a badge saying "normal" on every card is noise.
  '.dshba-pill{flex:none;font-size:11px;line-height:1.6;padding:2px 9px;border-radius:999px;',
  'border:.5px solid var(--dshba-sea-line);background-color:var(--dshba-sea-soft);',
  'color:var(--dshba-sea-1);white-space:nowrap}',
  '.dshba-pill.off{border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.35));',
  'background-color:rgba(127,127,127,.12);color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.85))}',
  // The groups. An open group is tinted and carries a cold bar on its left edge:
  // one mark that answers "which section am I inside" without a second background.
  '.dshba-grp{border-radius:12px;background-color:transparent;',
  'transition:border-color .16s,background-color .16s}',
  '.dshba-grp[data-open="1"]{border-color:var(--dshba-sea-line);background-color:var(--dshba-sea-soft)}',
  '.dshba-grphead{background-color:transparent;gap:10px;padding:11px 13px}',
  '.dshba-grphead:hover{background-color:rgba(127,127,127,.08)}',
  '.dshba-grp[data-open="1"] .dshba-grphead{box-shadow:inset 3px 0 0 var(--dshba-sea-2)}',
  // The summary is a CHIP, not loose grey text: loose text beside a bold title
  // competes with it, and the max-width:52% it used to carry truncated it to an
  // ellipsis the moment a pool held more than a couple of clips.
  '.dshba-grpsum{flex:none;max-width:58%;padding:1px 9px;border-radius:999px;',
  'background-color:rgba(127,127,127,.13);',
  'color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95));font-size:11px;line-height:1.6}',
  '.dshba-grp[data-open="1"] .dshba-grpsum{background-color:var(--dshba-sea-soft);color:var(--dshba-sea-1)}',
  '.dshba-grpbody{padding:4px 13px 13px}',
  // Every native control takes the sea accent. accent-color is the whole switch
  // styling: a hand-built switch would lose the platform's own focus and keyboard
  // behaviour for a look that is not worth that.
  '.dshba-switch input{accent-color:var(--dshba-sea-2);cursor:pointer}',
  '.dshba-opt{background-color:transparent;transition:background-color .14s,border-color .14s,color .14s}',
  '.dshba-opt:hover:not(:disabled){background-color:var(--dshba-sea-soft);border-color:var(--dshba-sea-line)}',
  '.dshba-opt[data-on="1"]{border-color:var(--dshba-sea-2);background-color:var(--dshba-sea-soft);',
  'color:var(--dshba-sea-1);font-weight:600}',
  '.dshba-tile{background-color:rgba(127,127,127,.05)}',
  '.dshba-tile:hover{border-color:var(--dshba-sea-line);background-color:var(--dshba-sea-soft)}',
  '.dshba-tile[data-on="1"]{border-color:var(--dshba-sea-2);background-color:var(--dshba-sea-soft);',
  'box-shadow:0 0 0 1px var(--dshba-sea-line) inset,0 3px 14px var(--dshba-sea-glow)}',
  '.dshba-tile[data-on="1"] .dshba-tile-name{color:var(--dshba-sea-1)}',
  // The one number worth reading at a glance, in the card's own colour. Guarded by
  // @supports because a text clip with a transparent fill is a text that is
  // INVISIBLE on an engine that honours the clip but not the paint.
  '@supports ((-webkit-background-clip:text) or (background-clip:text)){',
  '.dshba-display b{background-image:linear-gradient(180deg,var(--dshba-sea-1),var(--dshba-sea-3));',
  '-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}}',
  // A material row is TWO lines now: the file name on top, its facts underneath.
  // One line could not hold a name, a duration, three badges, two buttons and a
  // size at this width — and the thing that fell off the edge was the checkbox,
  // i.e. the only control the row exists for. The grid inside the label is what
  // lets the NAME truncate while the row stays put.
  '.dshba-clip{gap:6px;padding:8px 9px;transition:background-color .14s}',
  '.dshba-clip:hover{background-color:var(--dshba-sea-soft)}',
  '.dshba-clip input{accent-color:var(--dshba-sea-2)}',
  '.dshba-clipline{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:8px;row-gap:4px;',
  'align-items:center;flex:1;min-width:0;cursor:pointer}',
  '.dshba-clipline input{grid-column:1;grid-row:1 / span 2}',
  // The name and the badge strip each take their own row. The base rule above gives
  // the name flex:1 1 60px, which inside a GRID is inert for sizing but still
  // applies as a flex item's basis — the badges then sat on the name's row and the
  // two-line layout collapsed back into one crowded line.
  '.dshba-nm{grid-column:2;grid-row:1;min-width:0;flex:none;font-size:12.5px}',
  '.dshba-badges{grid-column:2;grid-row:2;display:flex;flex-wrap:wrap;align-items:center;gap:5px;',
  'min-width:0}',
  // A row with no badges must not reserve a second line for them: the :empty rule
  // below is what collapses it, so a clip whose length is not known yet reads as one
  // clean line instead of a line plus a gap where a badge would have been.
  '.dshba-badges:empty{display:none}',
  '.dshba-badge{font-size:10.5px;line-height:1.6;background-color:rgba(127,127,127,.15)}',
  // The three badge colours, stated per theme. The base rules used a single dark
  // amber and a single dark green, which read as mud on the dark background.
  '.dshba-badge.warn{background-color:rgba(245,158,11,.16);color:#a85c0a}',
  '.dshba-badge.bad{background-color:rgba(236,19,19,.14);color:#c81e1e}',
  '.dshba-badge.ok{background-color:rgba(34,197,94,.16);color:#0a7a3d}',
  'body[data-ds-dark-theme] .dshba-badge.warn{background-color:rgba(245,158,11,.2);color:#ffd79a}',
  'body[data-ds-dark-theme] .dshba-badge.bad{background-color:rgba(236,19,19,.2);color:#f25a5a}',
  'body[data-ds-dark-theme] .dshba-badge.ok{background-color:rgba(34,197,94,.2);color:#5ee08c}',
  '.dshba-meta{flex:none;font-size:11px;font-variant-numeric:tabular-nums;',
  'color:var(--dsw-alias-label-caption,rgba(127,127,127,.8))}',
  // The motion above is CSS-only and small; this extends the reduced-motion opt-out
  // to the two new transitions rather than leaving them running.
  '@media (prefers-reduced-motion: reduce){',
  '.dshba-card,.dshba-head,.dshba-grp,.dshba-clip,.dshba-opt{transition:none}}',
].join('')

/** Install the card's stylesheet once per document. */
function ensureStyle() {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/** Human-readable byte count. */
function formatBytes(value) {
  if (typeof value !== 'number' || !isFinite(value) || value <= 0) return '-'
  if (value < 1024) return String(value) + ' B'
  if (value < 1024 * 1024) return (value / 1024).toFixed(0) + ' KB'
  return (value / 1024 / 1024).toFixed(2) + ' MB'
}

/** Human-readable clip length, or a status word while it is unknown. */
function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds)) return '…'
  return seconds.toFixed(2) + 's'
}

/**
 * The Plugins page asks every `plugins.item` entry twice: `view: "summary"` for
 * the row's one-liner and `view: "page"` for the configuration section.
 *
 * They are two COMPONENTS rather than two branches of one, because the summary
 * answer uses no hooks at all and the page answer uses nine. One component that
 * returned early for the summary view would call a different number of hooks
 * depending on its props — a conditional hook call. React throws on that the
 * moment one instance is rendered with the other view, and what a user sees then
 * is a card that is present but dead: the page's own error boundary unmounts the
 * subtree, and every control inside stops responding.
 *
 * Being two separate FUNCTIONS is not enough on its own — the dispatcher below has
 * to RENDER one of them as an element. See the note on `BootAnimationEntry`.
 */

/**
 * The summary answer: one line, as a string.
 *
 * The page puts it inside a clamped `<span class="cardDesc">`
 * (-webkit-line-clamp:1) on the list and inside a `<p>` on the detail page, so
 * returning the card element here nested an `<li>` inside that span/p — invalid
 * list markup, clipped to one line. The three shipped pages (web-search,
 * agent-loop, shell) all answer this view with one line; this is the same
 * sentence the card's own header carries.
 * @returns the one-line description.
 */
function BootAnimationSummary() {
  return '短片、声音、进入方式与素材池'
}

/**
 * The registered entry: pick the shape the page asked for.
 *
 * The two shapes are RENDERED as elements, not CALLED as functions. That distinction
 * is the whole fix. Calling a function component from inside another component does
 * not start a new component instance: every hook it calls is recorded on the
 * CALLER's fiber. So `BootAnimationSummary()` (no hooks) and `BootAnimationCard()`
 * (nine) used to share one fiber, and switching an instance from `view: "summary"`
 * to `view: "page"` — which the Plugins page does — changed its hook count under
 * React, which throws and leaves a card that is present but dead.
 *
 * `React.createElement(...)` gives each shape its own fiber, so each keeps its own
 * hook list and the two cannot affect each other. That is the real mechanism; "they
 * are two components" was never sufficient while both were called as plain functions.
 *
 * This component itself takes no hooks, deliberately: a dispatcher that called a
 * hook could not switch branches safely either. `props.runtime` is the React object
 * the slot's inject face hands over (`inject: () => ({ runtime: React, ... })`), and
 * it is read here rather than through a hook for the same reason. A deployment that
 * does not supply it falls back to the old direct call: the two shapes then share
 * this fiber exactly as before, which is the pre-existing behaviour rather than a
 * crash on a page where the card still renders.
 * @param props - the slot's inject face plus the page's owner props.
 * @returns the card, or the one-line summary.
 */
function BootAnimationEntry(props) {
  const React = props.runtime
  if (React !== undefined && React !== null && typeof React.createElement === 'function') {
    return React.createElement(
      props.view === 'summary' ? BootAnimationSummary : BootAnimationCard,
      props,
    )
  }
  // No renderer on the inject face: fall back to calling them directly, which is
  // the behaviour this had before the fix. Degraded, not broken.
  return props.view === 'summary'
    ? BootAnimationSummary()
    : BootAnimationCard(props)
}

/**
 * The page's own configuration form, as an observable the card can read.
 *
 * The Plugins page hands every `plugins.item` entry a `form` prop — `{ state,
 * mutate }`, the same face the shipped configuration pages consume — in addition
 * to whatever the entry's own inject face returns. Reaching for it first is what
 * makes the controls work: on the desktop build this is the channel the kernel
 * actually wires up, and a card that writes only through `configForms` produces
 * exactly the symptom this one had — a card that renders, opens, closes, and
 * whose every setting control does nothing at all, with no error anywhere.
 *
 * Reads need a subscribe/getSnapshot pair for `useSyncExternalStore`. The page's
 * `state` is a snapshot at render time, so a form that cannot be observed falls
 * back to the injected scope, which always can. The write path needs `mutate`.
 * @param props - the slot's inject face plus the page's owner props.
 * @returns the reader/writer pair for this card.
 */
function cardForm(props) {
  const pageForm = props.form
  const scope = props.scope
  const observable = pageForm !== undefined && pageForm !== null
    && typeof pageForm.subscribe === 'function' && typeof pageForm.getSnapshot === 'function'
  const observableScope = scope !== undefined && scope !== null
    && typeof scope.subscribe === 'function' && typeof scope.getSnapshot === 'function'

  // The page's own form first, then the injected scope, then the page's static
  // snapshot: the first two can be observed, the third cannot, and a card with no
  // events at all still renders its current values instead of nothing.
  const source = observable ? pageForm : (observableScope ? scope : null)
  let fallback = NO_SNAPSHOT
  if (pageForm !== undefined && pageForm !== null && pageForm.state !== undefined) fallback = pageForm.state
  else if (scope !== undefined && scope !== null && typeof scope.getSnapshot === 'function') fallback = scope.getSnapshot()
  else if (observableScope) fallback = scope.getSnapshot()

  const mutate = (() => {
    if (pageForm !== undefined && pageForm !== null && typeof pageForm.mutate === 'function') {
      return (ops, revision) => pageForm.mutate(ops, revision)
    }
    if (scope !== undefined && scope !== null && typeof scope.mutate === 'function') {
      return (ops, revision) => scope.mutate(ops, revision)
    }
    return null
  })()

  // The RPC itself, reached directly when the form does not expose it. The kernel's
  // `mutate` answers `false` for every rejected write and swallows the reason, so
  // the only way to tell a stale-revision conflict from a refused operation is to
  // issue the same call and read the remote failure. `undefined` when this bundle
  // cannot see the service, in which case the card reports what it can.
  const remoteMutate = (() => {
    const remote = props.remote
    const settings = remote !== undefined && remote !== null ? remote.settings : undefined
    if (settings !== undefined && settings !== null && typeof settings.mutate === 'function') {
      return (namespace, ops, revision) => settings.mutate(namespace, ops, revision)
    }
    return null
  })()

  return { source, fallback, mutate, remoteMutate }
}

/**
 * The card.
 *
 * Collapsed by default, like every other card on this page: the Plugins section
 * is a list of plugins, and one that unfolds its controls on arrival pushes
 * everything below it out of view. Disclosure is card-local state — which card a
 * user has open is a reading gesture that neither the Host nor the section has
 * any stake in.
 *
 * Reads ride an observable source (see `cardForm`), whose snapshot reference is
 * stable until the fact moves, which is the contract React needs. The
 * subscription is taken directly with `useSyncExternalStore` rather than through
 * the renderer's `use<Name>` binding, because a package outside this repository
 * cannot depend on that binding existing for it.
 * @param props - the slot's inject face plus the page's owner props.
 * @returns the card element.
 */
function BootAnimationCard(props) {
  const React = props.runtime
  const [open, setOpen] = React.useState(false)
  const [pool, setPool] = React.useState(null)
  // The screensaver pool, fetched the same way and listed below the boot pool. Kept
  // as its own state rather than merged into `pool` because the two have different
  // settings behind them (`disabledClips` vs `disabledScreensaver`) and a merged
  // list would need the pool name threaded through every row.
  const [saverPool, setSaverPool] = React.useState(null)
  // Each pool's absolute directory, published by its manifest. Kept as state
  // because the folder dialog shows it and the card cannot compute it: where the
  // plugin is installed is a Host fact.
  const [poolDirs, setPoolDirs] = React.useState({})
  const [lengths, setLengths] = React.useState({})
  const [failure, setFailure] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  // Which field was last stored, or `null`. Drives the saved banner, whose wording
  // branches on `LIVE_FIELDS`: a screensaver field is already in effect, a boot field
  // reaches the next launch on its own and offers 刷新 only to WATCH it now.
  const [saved, setSaved] = React.useState(null)
  // Which of the opened card's groups are expanded. The card is one folding layer;
  // this is the second. Only "常用" starts open: the pools are opened on purpose,
  // not by accident, because each row in them runs a media probe.
  const [groups, setGroups] = React.useState({ basic: true, saver: false, pool: false })
  // Per-clip rewrite state, keyed by file name: absent means untouched, 'busy'
  // while the Host is working, 'done' once the file in the pool is the rewritten
  // one, 'error' when it refused and the row should stay pressable.
  const [fixing, setFixing] = React.useState({})
  // The folder dialog: `null` when closed, otherwise the pool whose directory is
  // being shown. It carries its own progress and error state because the Host has
  // to be asked to open the folder, and that round trip can fail.
  const [folder, setFolder] = React.useState(null)
  // The clip whose full-screen preview is on screen right now, or null. A preview
  // covers the whole page, so this is what tells the card to stop offering another
  // one — and what the overlay's own `onDone` clears.
  const [previewing, setPreviewing] = React.useState(null)

  ensureStyle()

  const form = cardForm(props)
  const source = form.source
  const subscribe = React.useCallback(
    (listener) => (source === null ? function () {} : source.subscribe(listener)),
    [source],
  )
  const readSnapshot = React.useCallback(
    () => (source === null ? form.fallback : source.getSnapshot()),
    [source, form.fallback],
  )
  const snapshot = React.useSyncExternalStore(subscribe, readSnapshot)
  const stored = (snapshot && snapshot.value) || {}
  const enabled = stored.enabled !== false
  const fadeMs = typeof stored.fadeMs === 'number' ? stored.fadeMs : 2000
  const enterMode = typeof stored.enterMode === 'string' ? stored.enterMode : 'tail'
  const disabled = Array.isArray(stored.disabledClips) ? stored.disabledClips : []
  // Each switch is read the way the Host reads it: absent means the documented
  // default, so a profile written before these fields existed renders them on.
  const sound = stored.sound !== false
  const clickToEnter = stored.clickToEnter === true
  const showHint = stored.showHint !== false
  const behaviour = { sound, clickToEnter, showHint }
  // The screensaver. Read the way the Host reads it: absent means the documented
  // default — which for the enable switch is OFF, because this feature covers the
  // screen and a feature that interrupts has to be opted into.
  const saverEnabled = stored.screensaverEnabled === true
  const saverIdleMs = typeof stored.screensaverIdleMs === 'number' ? stored.screensaverIdleMs : 180000
  const saverBreak = stored.screensaverBreakEffect !== false
  // Which exit effect. Read with the same tolerant fallback as everything else: an absent or
  // unknown value lands on 'random', which is the documented default.
  const BREAK_STYLES = ['random', 'particles', 'fall', 'glitch']
  const saverBreakStyle = BREAK_STYLES.includes(stored.screensaverBreakStyle)
    ? stored.screensaverBreakStyle
    : 'random'
  const saverHint = stored.screensaverHint !== false
  // Whether the screensaver's media may make a sound. Read the way the Host reads it: absent
  // means the documented default, which is OFF.
  const saverSound = stored.screensaverSound === true
  // How loud the screensaver plays, 0..1. Read with the same tolerant fallback as everything
  // else: an absent or out-of-range value lands on the documented default.
  const saverVolume = typeof stored.screensaverVolume === 'number' && isFinite(stored.screensaverVolume)
    ? Math.min(1, Math.max(0, stored.screensaverVolume))
    : 0.35
  // How long each entry stays before the next one takes over, in whole seconds. 0 means "do not
  // rotate", which is the behaviour every version before this one had.
  const saverRotateSec = typeof stored.screensaverRotateMs === 'number' && isFinite(stored.screensaverRotateMs)
    ? Math.round(Math.min(600000, Math.max(0, stored.screensaverRotateMs)) / 1000)
    : 0
  // The pointer decoration is deliberately NOT resolved into a local. The picker that would
  // show it is hidden by request (see the note in the screensaver section below), so this file
  // has no control to draw it in and no other reader for it — the local that used to hold it
  // (`saverPointer`) was computed on every render and never read by anything. The field, its
  // schema entry and the three implementations in src/screensaver.js all stay, so an existing
  // profile keeps its stored value and nothing has to be migrated.
  const disabledSaver = Array.isArray(stored.disabledScreensaver) ? stored.disabledScreensaver : []
  // The custom minutes box. It opens on demand rather than standing open: four
  // presets cover almost every case, and a number field that is always visible
  // invites a threshold somebody then has to think about.
  //
  // `customText` stays a STRING while the user types. "1" is a legitimate
  // intermediate state on the way to "15", and a number field that fought values
  // mid-typing would be unusable.
  const [customOpen, setCustomOpen] = React.useState(false)
  const [customText, setCustomText] = React.useState('')
  // The volume slider's DRAFT position, as a whole percent, or null when the stored value is
  // what should be shown. Same shape as `customText` above and for the same reason: a control
  // that fights the stored value mid-gesture is unusable. Written by `onChange`, cleared when the
  // value is committed, so afterwards the slider follows the document again.
  const [volumeDraft, setVolumeDraft] = React.useState(null)
  // Whether this page has a Live2D adapter installed. The overlay reads the same
  // global, so the card reports the state the screen will actually be in rather
  // than warning about a model that might work fine.
  const saverHasNoRenderer = typeof globalThis.__DSH_BOOT_ANIM_LIVE2D__ !== 'function'


  // The pool, and each clip's real length. The length comes from a throwaway media
  // element rather than parsed out of the file: the browser's own decode is the
  // only answer that also tells the user whether this clip can play at all.
  //
  // Both effects are gated on `open` so a collapsed card costs nothing. A manifest
  // read plus three media probes per card, on a settings page that lists every
  // plugin, is not worth paying for a row nobody has opened.
  React.useEffect(() => {
    if (!open || pool !== null) return undefined
    let live = true
    fetch(MANIFEST, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((payload) => {
        if (!live) return
        setPool(Array.isArray(payload.items) ? payload.items : [])
        if (typeof payload.dir === 'string') {
          setPoolDirs((current) => Object.assign({}, current, { clips: payload.dir }))
        }
      })
      .catch((error) => { if (live) setFailure('读取素材池失败：' + String(error)) })
    return () => { live = false }
  }, [open, pool])

  React.useEffect(() => {
    if (!open || saverPool !== null) return undefined
    let live = true
    fetch(SCREENSAVER_MANIFEST, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((payload) => {
        if (!live) return
        setSaverPool(Array.isArray(payload.items) ? payload.items : [])
        if (typeof payload.dir === 'string') {
          setPoolDirs((current) => Object.assign({}, current, { screensaver: payload.dir }))
        }
      })
      // A screensaver pool that cannot be read is not a card failure: the pool is
      // optional, and a profile that never created `assets/screensaver/` is normal.
      .catch(() => { if (live) setSaverPool([]) })
    return () => { live = false }
  }, [open, saverPool])

  React.useEffect(() => {
    if (!open || pool === null) return undefined
    const probes = pool.map((clip) => {
      // Only a video can be probed this way. The probe measures whether a PICTURE
      // appears and how long the entry runs, both of which are questions about a
      // timeline — and a still image, an animated image and a Live2D model have
      // none. Running a <video> against an image URL would report every one of
      // them as unplayable, which is the reassuring-answer problem inverted: a
      // false failure instead of a false success.
      if (clip.kind !== 'video') {
        setLengths((current) => Object.assign({}, current, {
          [clip.name]: { nonVideo: clip.kind },
        }))
        return undefined
      }
      const element = document.createElement('video')
      element.muted = true
      element.preload = 'auto'
      const settle = (patch) => setLengths((current) => Object.assign({}, current, { [clip.name]: patch }))

      // The probe PLAYS the clip, because reading metadata proves nothing about
      // whether a picture ever appears. The first version of this only listened
      // for `loadedmetadata`, so a clip whose frames never arrive reported a
      // perfectly healthy duration — the reassuring answer this card exists to
      // not give. A presented frame is the only proof, and a clip that starts and
      // then paints nothing is reported as exactly that.
      let decided = false
      let timer = null
      const finish = (patch) => {
        if (decided) return
        decided = true
        if (timer !== null) clearTimeout(timer)
        settle(patch)
        try {
          if (typeof element.pause === 'function') element.pause()
        } catch (error) {
          /* a probe that cannot pause is already stopped */
        }
      }
      const onRefused = () => finish({ refused: true })
      const onPlayed = () => finish({ played: true })
      // Metadata first: the duration is what the row is for, and it is known long
      // before a frame is. Kept even while playability is still undecided.
      const onMeta = () => settle({ seconds: element.duration })

      element.addEventListener('error', onRefused)
      element.addEventListener('loadedmetadata', onMeta)
      timer = setTimeout(() => finish({ noFrame: true }), 8000)

      if (typeof element.requestVideoFrameCallback === 'function') {
        element.requestVideoFrameCallback(onPlayed)
      } else {
        element.addEventListener('timeupdate', () => {
          if (element.currentTime > 0) onPlayed()
        })
      }

      // `src` BEFORE `play()`. With no source, `play()` rejects with
      // NotSupportedError — which this probe reads as "the browser refused this
      // clip", so every clip came back unplayable while the animation was in fact
      // playing them perfectly well.
      element.src = clip.src
      try {
        const attempt = element.play()
        if (attempt !== undefined && typeof attempt.catch === 'function') attempt.catch(onRefused)
      } catch (error) {
        onRefused()
      }

      // Detached on purpose: nothing enters the document, so the probe costs no
      // layout and no visible element. It does play silently until it settles.
      return () => {
        decided = true
        if (timer !== null) clearTimeout(timer)
        element.removeEventListener('error', onRefused)
        try {
          if (typeof element.pause === 'function') element.pause()
        } catch (error) {
          /* already stopped */
        }
        element.removeAttribute('src')
      }
    })
    // A probe that returned `undefined` (a non-video entry) contributes nothing to
    // tear down, so it is filtered rather than called.
    return () => { for (const dispose of probes) { if (typeof dispose === 'function') dispose() } }
  }, [open, pool])

  /**
   * Stage one field write.
   *
   * The operation is the settings service's own `SettingsPathOp` shape — one
   * atomic `set` at a top-level path — so the same call works whether the page
   * handed us its configuration form or we fell back to the injected scope.
   *
   * The revision travels with the write because the Host refuses a mutation
   * composed against a document it has since replaced, and `mutate` reports that
   * refusal as a bare `false` — it swallows the reason. So a refusal is retried
   * once through the remote service with the SAME operation and no revision fence:
   * if the operation itself is acceptable the retry lands, and if it is not, the
   * remote failure text is shown. Either way the user sees why, instead of a
   * control that quietly does nothing — which is the failure this card was
   * reported for.
   * @param field - config field name.
   * @param value - the value to store.
   */
  const write = (field, value) => writeMany([{ op: 'set', path: [field], value }], field)

  /**
   * Store several fields in ONE operation.
   *
   * This exists because one control can need two fields: the screensaver volume slider is also
   * the on/off switch, so dragging off the left end writes `screensaverVolume` AND
   * `screensaverSound`. Writing them as two calls looks harmless and is not — each call captures
   * `snapshot.revision` from the render it was created in, and the card does not re-render between
   * the two, so the second call presents a revision the first one just invalidated. The document
   * then refuses it and the card paints "保存失败" over a save that half-worked: the volume
   * arrived, the switch did not. That is exactly the state the user photographed
   * (`screensaverVolume: 0.07` beside `screensaverSound: false`).
   *
   * A `SettingsPathOp` list is atomic, so one call is also the correct fix: either both fields
   * land or neither does.
   * @param ops - the operation list.
   * @param label - which field to name in the "saved" banner.
   */
  /**
   * Push stored values into the page's LIVE config object, so the screensaver sees them at once.
   *
   * WHY THIS IS NEEDED. `entry.js` injects `globalThis.__DSH_BOOT_ANIM_CFG__` once, as a row in
   * the document `<head>`, and `src/screensaver.js` reads every per-appearance setting from that
   * object. The settings document is saved correctly on every edit — but the OBJECT in the running
   * page is not rebuilt until the page reloads, and the desktop shell has no reload key. So a user
   * who changed the exit effect to 重力下坠 and then dismissed the screensaver got the OLD value,
   * saw all three effects at random (the previous setting was `random`), and reported it as "退出
   * 特效并没有按选择的来". The same freeze made 水波涟漪 look dead: the effect was fine, the
   * setting the page was reading was stale.
   *
   * A settings edit was supposed to need no restart because volatile fields update in place on the
   * Host — and they do, on the HOST. Nothing carried that to the browser. This does: apply the
   * exact values just accepted by the document to the object the screensaver already reads.
   *
   * Only the fields this card can write are handled, and only with the value that was stored, so
   * this cannot invent a setting — it mirrors the document.
   * @param ops - the `SettingsPathOp` list that was just accepted.
   */
  function pokeLiveConfig(ops) {
    const cfg = globalThis.__DSH_BOOT_ANIM_CFG__
    if (cfg === null || typeof cfg !== 'object') return
    for (const op of ops) {
      const key = Array.isArray(op.path) ? op.path[0] : undefined
      if (typeof key !== 'string' || key === '') continue
      cfg[key] = op.value
    }
  }

  function writeMany(ops, label) {
    if (form.mutate === null) {
      setFailure('这一页没有连上设置文档，改动不会保存。')
      return Promise.resolve(false)
    }
    setBusy(true)
    setFailure(null)
    const revision = snapshot === undefined || snapshot === null ? undefined : snapshot.revision
    // Set to true only on the path that really stored the value. The banner is
    // armed from this flag rather than from "no failure was set", so a refusal
    // can never sit next to a cheerful "已保存".
    let stored = false
    return Promise.resolve(form.mutate(ops, revision))
      .then(async (accepted) => {
        if (accepted !== false) {
          stored = true
          return
        }
        if (form.remoteMutate === null) {
          setFailure('保存失败：本部署没有接受这次修改。')
          return
        }
        // Retry through the service, unfenced, to learn WHY it was refused.
        try {
          const answer = await form.remoteMutate(SETTINGS_NAMESPACE, ops, undefined)
          if (answer !== null && typeof answer === 'object' && answer.ok === false) {
            const reason = answer.error === undefined || answer.error === null
              ? '未说明原因'
              : String(answer.error.message ?? answer.error)
            setFailure('保存失败：' + reason)
            return
          }
          setFailure('保存失败：本部署没有接受这次修改。')
        } catch (error) {
          setFailure('保存失败：' + String(error))
        }
      })
      .catch((error) => setFailure('保存失败：' + String(error)))
      .then(() => {
        if (stored) {
          setSaved(label)
          // A successful write also clears any failure left by an earlier one. Without this, a
          // refusal that happened once stayed on screen under every later control, so a card
          // whose document was perfectly up to date could still be showing "保存失败".
          setFailure(null)
          // …and the running page's config object gets the same values, so the screensaver
          // behaves according to the choice immediately rather than after a restart.
          pokeLiveConfig(ops)
        }
        setBusy(false)
      })
  }

  /**
   * Store the custom screensaver threshold.
   *
   * Minutes only, whole numbers. The stored unit is milliseconds, but the setting
   * people reason about is minutes and a fractional minute is a threshold nobody
   * asked for — so the value is rounded, then clamped to the range the Host's own
   * schema accepts. Clamping here rather than letting the writer refuse it keeps the
   * control from putting the document into a state the schema rejects, which would
   * surface as "保存失败" for a number the user typed in good faith.
   */
  const commitCustom = () => {
    const minutes = Math.round(Number(customText))
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setFailure('请输入整数分钟（1–60）。')
      return
    }
    const clamped = Math.min(60, Math.max(1, minutes))
    write('screensaverIdleMs', clamped * 60000)
    setCustomOpen(false)
    setCustomText('')
  }

  /**
   * Store the volume once, at the end of a drag.
   *
   * ONE operation for both fields. They are written together because a drag off the left end
   * changes both, and two calls cannot work: each captures the revision of the render it was
   * created in and the card does not re-render between them, so the second presents a revision
   * the first just invalidated — refused, with "保存失败" painted over a save that half-worked.
   *
   * Two guards, both about not writing for nothing:
   *   - a gesture already being written is skipped, because `pointerup`, `blur` and `keyup` can
   *     all fire from one drag;
   *   - a value that has not changed is skipped, compared against what is DISPLAYED rather than
   *     the stored level: with sound off the slider reads 0 whatever is stored.
   * @param percent - whole percent from the range input.
   */
  const commitVolume = (percent) => {
    if (!Number.isFinite(percent)) { setVolumeDraft(null); return }
    if (busy) { return }
    const clampedPct = Math.min(100, Math.max(0, Math.round(percent)))
    const shouldSound = clampedPct > 0

    const shownNow = saverSound ? Math.round(saverVolume * 100) : 0
    if (clampedPct === shownNow) {
      setVolumeDraft(null)
      return
    }

    setVolumeDraft(clampedPct)
    const storedPct = Math.round(saverVolume * 100)
    const ops = []
    if (!shouldSound) {
      // Left end: silence. The level is left alone, so the next drag right returns to it.
      if (saverSound) ops.push({ op: 'set', path: ['screensaverSound'], value: false })
    } else {
      if (clampedPct !== storedPct) ops.push({ op: 'set', path: ['screensaverVolume'], value: clampedPct / 100 })
      if (!saverSound) ops.push({ op: 'set', path: ['screensaverSound'], value: true })
    }
    if (ops.length === 0) {
      setVolumeDraft(null)
      return
    }
    writeMany(ops, ops.length > 1 ? 'screensaverVolume' : ops[0].path[0])
  }

  const toggleClip = (name, enabled) => {
    const next = enabled ? disabled.filter(entry => entry !== name) : disabled.concat([name])
    // Switching every clip off would leave the screen with nothing to play, so the
    // last enabled one cannot be turned off from here.
    if (pool !== null && next.length >= pool.length) {
      setFailure('至少要留一条素材参与随机。')
      return
    }
    write('disabledClips', next)
  }

  /**
   * Turn one screensaver entry on or off.
   *
   * Unlike the boot pool there is no "at least one" rule: a screensaver pool that is
   * entirely switched off is a legitimate configuration — the screensaver then has
   * nothing to show and stays away — so a user emptying it is choosing not to have a
   * screensaver rather than breaking anything.
   */
  const toggleSaver = (name, enabled) => {
    const next = enabled ? disabledSaver.filter(entry => entry !== name) : disabledSaver.concat([name])
    write('disabledScreensaver', next)
  }

  /**
   * Ask the Host to open a pool directory in the system file manager.
   *
   * The page cannot do this itself — browsers deny a web page the ability to launch
   * a local program or reveal a path — so the button is a request to the Host, which
   * runs in Node. The Host answers with the resolved path either way, which is what
   * lets the dialog show it even when the launch failed: copying the path and
   * pasting it into a file manager is the fallback that always works.
   *
   * The path is not known client-side beforehand and is not guessed here. Asking the
   * Host is the only way to learn it, and it is also the only way to open it, so one
   * request does both.
   * @param which - 'clips' or 'screensaver'.
   */
  const openFolder = (which) => {
    setFolder({ which, status: 'opening', dir: null, error: null })
    fetch(REVEAL + '?pool=' + encodeURIComponent(which), { method: 'POST', cache: 'no-store' })
      .then((response) => response.json()
        .catch(() => ({ ok: false, error: 'Host 回答了 HTTP ' + String(response.status) })))
      .then((answer) => {
        const dir = answer !== null && typeof answer === 'object' && typeof answer.dir === 'string'
          ? answer.dir
          : null
        if (answer !== null && typeof answer === 'object' && answer.ok === true) {
          // Opened. The dialog stays up rather than closing itself: it is also the
          // place that says what to put in the folder, and a window that vanishes on
          // success leaves the user with a file manager and no idea what for.
          setFolder({ which, status: 'opened', dir, error: null })
          return
        }
        const why = answer !== null && typeof answer === 'object' && answer.error !== undefined
          ? String(answer.error)
          : 'Host 没有说明原因'
        setFolder({ which, status: 'failed', dir, error: why })
      })
      .catch((error) => {
        setFolder({ which, status: 'failed', dir: null, error: String(error) })
      })
  }

  /** Close the folder dialog. */
  const closeFolder = () => setFolder(null)

  /**
   * Ask the Host to move one clip's index table to the front of its file.
   *
   * Nothing is refetched afterwards. The manifest's per-clip `faststart` flag is
   * patched in place instead, because re-reading the pool would re-run every media
   * probe in the effect above — each one plays its clip for up to eight seconds —
   * to learn a fact this call already knows. The clip's `src` keeps its old `?v=`
   * revision, which is right: the bytes the probe judged are the bytes the card
   * still holds, and the boot screen reads the manifest afresh on the next page
   * load, where the revision will be the new one.
   *
   * A refusal is reported with the Host's own sentence rather than a generic
   * failure: those sentences say which of the three reasons it was (too big, not
   * an mp4, self-check failed and the original was restored), and that is the part
   * the user can act on.
   * @param name - the clip's file name, exactly as the manifest published it.
   */
  const optimize = (name) => {
    setFailure(null)
    setFixing((current) => Object.assign({}, current, { [name]: 'busy' }))
    fetch(OPTIMIZE + '?name=' + encodeURIComponent(name), { method: 'POST', cache: 'no-store' })
      .then((response) => response.json()
        .catch(() => ({ ok: false, error: 'Host 回答了 HTTP ' + String(response.status) })))
      .then((answer) => {
        if (answer !== null && typeof answer === 'object' && answer.ok === true) {
          setFixing((current) => Object.assign({}, current, { [name]: 'done' }))
          setPool((current) => (current === null ? current : current.map((clip) => (
            clip.name === name ? Object.assign({}, clip, { faststart: true }) : clip
          ))))
          return
        }
        setFixing((current) => Object.assign({}, current, { [name]: 'error' }))
        const why = answer !== null && typeof answer === 'object' && answer.error !== undefined
          ? String(answer.error)
          : 'Host 没有说明原因'
        setFailure('优化 ' + name + ' 失败：' + why)
      })
      .catch((error) => {
        setFixing((current) => Object.assign({}, current, { [name]: 'error' }))
        setFailure('优化 ' + name + ' 失败：' + String(error))
      })
  }

  /**
   * Play this clip as the real boot animation, full screen, right now.
   *
   * The overlay is the one the page already carries (`__DSH_BOOT_ANIM__`, installed
   * by the injected head script): it is asked to run a second time, for this clip,
   * with the settings the card is showing at this moment — so the fade, the enter
   * mode, the hint line and the sound behaviour are the live ones rather than the
   * ones this page happened to be served with. It leaves by the same dissolve a real
   * start uses, then calls back, which is when the button becomes pressable again.
   *
   * The one failure worth naming: a page loaded BEFORE this feature existed has the
   * old overlay in memory, whose namespace has no `preview`. Saying so beats a
   * button that appears to do nothing.
   * @param name - the entry's file name, exactly as its manifest published it.
   * @param pool - which pool the name belongs to. A preview of a screensaver entry
   *   has to look in the screensaver manifest, because the two pools are separate
   *   directories and the same name can exist in both.
   */
  /**
   * Preview the screensaver: raise the real layer and leave it up.
   *
   * Distinct from `preview(name, pool)` above, which drives the boot overlay. The screensaver's
   * own `preview()` raises its REAL layer and stops there, so what the user sees is the whole
   * thing — the picture, the hint line, and the pointer decoration if one is selected. They
   * dismiss it with a click or a key, exactly like a real one, and that dismissal plays the exit
   * effect through the real path.
   *
   * This used to dismiss itself as soon as the media was ready, which meant the preview showed
   * ONLY the exit effect: the layer was gone within a second, so the pointer decoration — the
   * thing most worth previewing, because it is the one setting whose effect cannot be imagined —
   * never got a chance to draw. That is why this no longer takes a "which effect" argument.
   *
   * A failure here is reported rather than swallowed: the reasons it can decline (the layer is
   * already up, the boot overlay is up) are all states the user can see and do something about,
   * so the message says which one it was.
   */
  const previewScreensaver = (entryName) => {
    const saver = globalThis.__DSH_BOOT_ANIM_SCREENSAVER__
    if (saver === undefined || saver === null || typeof saver.preview !== 'function') {
      setFailure('这一页的屏保还没有预览接口（页面是在这次改动之前加载的）：刷新页面后再点。')
      return
    }
    if (saverEnabled !== true) {
      setFailure('屏保现在是关闭的：先打开「启用屏保」，预览才有意义。')
      return
    }
    setFailure(null)
    let started = false
    try {
      // The row's own file. The screensaver matches it by name; a name it cannot find falls back to
      // a random pick, which beats refusing to preview when the pool changed after the card read it.
      // No effect argument any more: the preview shows the whole layer and lets the user's own
      // dismissal play whatever exit effect is configured.
      started = saver.preview(null, typeof entryName === 'string' ? entryName : null) === true
    } catch (error) {
      setFailure('屏保预览没能启动：' + String(error))
      return
    }
    if (!started) {
      setFailure('屏保预览没能启动：入场层正在演，或者屏保层已经在了，等它们结束再点。')
    }
  }

  const preview = (name, pool = 'clips') => {
    const overlay = globalThis[OVERLAY]
    if (overlay === null || overlay === undefined || typeof overlay.preview !== 'function') {
      setFailure('这一页的入场层还没有预览接口（页面是在这次改动之前加载的）：刷新页面后再点。')
      return
    }
    setFailure(null)
    setPreviewing(name)
    let started = false
    try {
      started = overlay.preview({
        name,
        pool,
        fadeMs,
        enterMode,
        sound,
        clickToEnter,
        showHint,
        onDone: () => setPreviewing(null),
      }) === true
    } catch (error) {
      setPreviewing(null)
      setFailure('预览没能启动：' + String(error))
      return
    }
    if (!started) {
      setPreviewing(null)
      setFailure('已经有一个预览在跑了，等它结束再点。')
    }
  }

  /**
   * One behaviour switch: label, checkbox, and the sentence for the state it is
   * currently in. A plain factory rather than a component — it calls no hooks,
   * which is what lets the card's hook count stay the same for every render.
   */
  const switchRow = (field, label, onNote, offNote) => React.createElement('div', {
    className: 'dshba-sec',
    key: field,
  },
  // One line. The explanation of the current state lives in the tooltip: worth reading once, noise
  // after that, and it was the main thing making this section taller than the ones below it.
  React.createElement('label', {
    className: 'dshba-switch',
    title: behaviour[field] ? onNote : offNote,
  },
    React.createElement('input', {
      type: 'checkbox',
      checked: behaviour[field],
      disabled: busy,
      onChange: (event) => write(field, event.target.checked),
    }),
    React.createElement('span', { className: 'dshba-h', style: { margin: '0' } }, label)))

  /**
   * One collapsible group inside the opened card.
   *
   * A plain factory like `switchRow`: no hooks, so the card's hook count stays
   * fixed. The summary on the closed header is what lets the user decide whether
   * to open it at all — a section whose closed state says only "更多" forces every
   * visit to open it to find out what is inside.
   *
   * @param {string} key - state key in `groups`.
   * @param {string} title - group heading.
   * @param {string} summary - what the closed row says about the current state.
   * @param {Array} children - the rows, rendered only when expanded.
   */
  const group = (key, title, summary, children) => {
    const isOpen = groups[key] === true
    return React.createElement('div', { className: 'dshba-grp', key, 'data-open': isOpen ? '1' : '0' },
      React.createElement('button', {
        type: 'button',
        className: 'dshba-grphead',
        'aria-expanded': isOpen,
        onClick: () => setGroups(Object.assign({}, groups, { [key]: !isOpen })),
      },
      React.createElement('span', { className: 'dshba-grptitle' }, title),
      React.createElement('span', { className: 'dshba-grpsum' }, summary),
      React.createElement('span', { className: 'dshba-grpchev' })),
      isOpen ? React.createElement('div', { className: 'dshba-grpbody' }, children) : null)
  }

  /**
   * One option tile: a mark, a name, and a raised state when chosen.
   *
   * A factory like `group` and `switchRow`, so the card's hook count stays fixed. The mark is passed
   * as a list of span widths, which is enough to draw the six abstract diagrams used here without
   * any images.
   *
   * @param {string} key - React key.
   * @param {string} name - visible label.
   * @param {string} hint - tooltip; the card no longer prints explanations, so this is where they live.
   * @param {Array<[number, number]>} marks - [width, height] pairs for the mark's bars.
   * @param {boolean} on - whether this tile is the chosen one.
   * @param {Function} onPick - called on click.
   * @param {boolean} off - disabled state.
   */
  const tile = (key, name, hint, marks, on, onPick, off) => React.createElement('button', {
    key,
    type: 'button',
    className: 'dshba-tile',
    'data-on': on ? '1' : '0',
    disabled: off === true,
    title: hint,
    onClick: onPick,
  },
  React.createElement('span', { className: 'dshba-mark', 'aria-hidden': 'true' },
    marks.map((m, i) => React.createElement('i', { key: i, style: { width: m[0] + 'px', height: m[1] + 'px' } }))),
  React.createElement('span', { className: 'dshba-tile-name' }, name))

  const header = React.createElement('button', {
    type: 'button',
    className: 'dshba-head',
    'aria-expanded': open,
    'aria-label': (open ? '收起' : '展开') + '：启动动画',
    onClick: () => { setOpen(!open) },
  },
  React.createElement('img', {
    className: 'dshba-ico',
    src: ICON_ROUTE,
    alt: '',
    'aria-hidden': 'true',
    draggable: false,
    // A missing asset must not become a broken-image glyph in the settings list.
    onError: (event) => { event.currentTarget.style.visibility = 'hidden' },
  }),
  React.createElement('span', { className: 'dshba-headtext' },
    React.createElement('span', { className: 'dshba-name' }, '启动动画'),
    // The one-liner says what the plugin DOES, not which files it owns: a reader
    // scanning the plugin list decides from this line whether to open it.
    React.createElement('span', { className: 'dshba-desc' }, '打开页面时先放一段短片，然后淡进界面')),
  // A state pill, rendered ONLY when the animation is off. A disabled card used to
  // look identical to a working one in the plugin list, and "why is nothing
  // playing" is the report that follows; a pill that said "normal" on every card
  // would be noise, so only the exception is marked.
  enabled ? null : React.createElement('span', { className: 'dshba-pill off' }, '已关闭'),
  React.createElement('span', { className: 'dshba-chev' }))

  try {
    if (!open) {
      return React.createElement('li', { className: 'dshba-card', 'data-open': '0' }, header)
    }

    const sections = []

    // The saved banner goes first, above every control: it answers "did that
    // click do anything", which is the question a reader has immediately after
    // clicking, before looking at anything else.
    //
    // TWO MESSAGES, because the two halves genuinely differ and the old blanket wording was
    // wrong for both.
    //
    // The screensaver re-reads its settings from the Host before every appearance, so a saved
    // value there is already in effect — telling that user to reload is simply false, and after a
    // few rounds of it they asked whether the reload was necessary at all.
    //
    // The boot half is not "not saved until you reload": the Host rebuilds its head rows from the
    // current document on every index render, so the next launch uses the new value with no action
    // from anybody. What the button is actually for is seeing that value NOW — a reload re-runs the
    // boot overlay, which is the only way to watch a fade or an entry mode you just changed.
    if (saved !== null) {
      const live = LIVE_FIELDS.has(saved)
      sections.push(React.createElement('div', { className: 'dshba-saved', key: 'saved' },
        React.createElement('span', null, live
          ? '已保存，已经生效。下次屏保出现就按新的走。'
          : '已保存，下次启动就用新的。想现在看效果就刷新页面，会重新播一遍启动动画。'),
        live
          ? null
          : React.createElement('button', {
            type: 'button',
            className: 'dshba-reload',
            onClick: () => { globalThis.location.reload() },
          }, '刷新')))
    }

    /* ---- 常用 ---- */
    const basic = []

    // The switch comes first because it is the only setting that changes whether
    // any of the others run at all.
    basic.push(React.createElement('div', { className: 'dshba-sec', key: 'enabled' },
      React.createElement('label', {
        className: 'dshba-switch',
        title: enabled
          ? '关掉并刷新，就回到 DSH 原来的启动页'
          : '已关闭：刷新后就回到 DSH 原来的启动页，下面这些暂时不生效',
      },
        React.createElement('input', {
          type: 'checkbox',
          checked: enabled,
          disabled: busy,
          onChange: (event) => write('enabled', event.target.checked),
        }),
        React.createElement('span', { className: 'dshba-h', style: { margin: '0' } }, '开启启动动画')),
      ))

    for (const entry of BEHAVIOUR) {
      basic.push(switchRow(entry[0], entry[1], entry[2], entry[3]))
    }

    basic.push(React.createElement('div', { className: 'dshba-sec', key: 'fade' },
      React.createElement('div', { className: 'dshba-h' }, '淡入时长'),
      // The chosen length at display size, then the choices as tiles.
      React.createElement('div', { className: 'dshba-display' },
        React.createElement('b', null, String(fadeMs / 1000)),
        React.createElement('span', null, '秒淡进界面')),
      React.createElement('div', { className: 'dshba-tiles', style: { marginTop: '10px' } },
        FADE_CHOICES.map(choice => tile(
          String(choice),
          (choice / 1000) + ' 秒',
          '片子用 ' + (choice / 1000) + ' 秒淡进界面',
          MARK.fade,
          choice === fadeMs,
          () => write('fadeMs', choice),
          busy,
        )))))

    basic.push(React.createElement('div', { className: 'dshba-sec', key: 'mode' },
      React.createElement('div', { className: 'dshba-h' }, '进入方式'),
      React.createElement('div', { className: 'dshba-tiles', style: { marginTop: '8px' } },
        ENTER_MODES.map(entry => tile(
          entry[0],
          entry[1],
          entry[2],
          MARK[entry[0]] || MARK.tail,
          entry[0] === enterMode,
          () => write('enterMode', entry[0]),
          busy,
        )))))

    sections.push(group('basic', '常用',
      enterMode === 'tail' ? '淡入 ' + (fadeMs / 1000) + ' 秒' : '进入方式已改', basic))

    const clipNodes = []
    if (pool === null) {
      clipNodes.push(React.createElement('div', { className: 'dshba-msg', key: 'loading' }, '正在读取…'))
    } else if (pool.length === 0) {
      clipNodes.push(React.createElement('div', { className: 'dshba-msg', key: 'empty' },
        '素材池是空的。把 mp4 放进 assets/videos/ 再刷新这一页。'))
    } else {
      for (const clip of pool) {
        const known = lengths[clip.name] || {}
        const state = fixing[clip.name]
        // The duration is the row's primary fact, so it is shown whenever the
        // probe has it; a problem is an ADDITIONAL badge rather than a replacement
        // for it. Reporting "unplayable" in place of the length meant a probe bug
        // cost the user the information they actually came for.
        //
        // NO PLACEHOLDER while the length is still unknown. This used to push a badge
        // that read "…" for every clip whose probe had not settled yet, which is what a
        // freshly opened card looked like: four rows of identical grey ellipses that
        // carried no information and read as broken. A row with nothing to report shows
        // nothing; the badge appears when the probe actually knows something.
        const badges = []
        if (typeof known.seconds === 'number' && isFinite(known.seconds)) {
          badges.push(React.createElement('span', { className: 'dshba-badge', key: 'len' },
            formatDuration(known.seconds)))
        }
        if (known.refused === true) {
          badges.push(React.createElement('span', {
            className: 'dshba-badge bad',
            key: 'refused',
            title: '浏览器拒绝解码这一段：可能是编码档次不被支持，或文件不完整。',
          }, '浏览器播不了'))
        } else if (known.noFrame === true) {
          // Started, then never painted: the failure that leaves the boot screen on
          // its background. Distinct from a refused clip, and worth saying so.
          badges.push(React.createElement('span', {
            className: 'dshba-badge warn',
            key: 'noframe',
            title: '在这台浏览器里能开始播放，但 8 秒内一帧画面都没出来。'
              + '这种片子放启动动画时只会看到背景色。',
          }, '一直没有画面'))
        }
        if (clip.faststart === false) {
          badges.push(React.createElement('span', {
            className: 'dshba-badge warn',
            key: 'moov',
            title: '索引表(moov)在文件末尾：浏览器要整段下载完才出画面。'
              + '点这一行右边的「优化」可以无损前移。',
          }, '未优化'))
        }
        if (state === 'done') {
          badges.push(React.createElement('span', { className: 'dshba-badge ok', key: 'fixed' }, '已重排'))
        }
        // The button is a SIBLING of the label, never a child of it: a button
        // nested in a label is an interactive element inside a control, and a click
        // on it then becomes a question about label activation rather than about
        // the button.
        clipNodes.push(React.createElement('div', { className: 'dshba-clip', key: clip.name },
          React.createElement('label', { className: 'dshba-clipline', title: clip.name },
            React.createElement('input', {
              type: 'checkbox',
              // Read from the SETTINGS, not from the manifest field. The manifest is
              // fetched once when the card opens, so binding the box to its `enabled`
              // value meant a write never changed what the box displayed: the change
              // persisted and only appeared after the dialog was reopened, which is
              // exactly how that was reported.
              checked: !disabled.includes(clip.name),
              disabled: busy,
              onChange: (event) => toggleClip(clip.name, event.target.checked),
            }),
            React.createElement('span', { className: 'dshba-nm' }, clip.name),
            React.createElement('span', { className: 'dshba-badges' }, badges)),
          // 预览 on EVERY row: whether a clip's index sits at the front has nothing
          // to do with how it looks as the boot animation, and the preview is the
          // only way to judge that without restarting DSH.
          React.createElement('button', {
            type: 'button',
            className: 'dshba-opt dshba-mini',
            disabled: previewing !== null,
            title: '现在就把这一段当作启动动画满屏跑一遍：按当前设置演一遍真实的入场过渡。',
            onClick: () => preview(clip.name),
          }, previewing === clip.name ? '预览中…' : '预览'),
          // Only a clip the Host reported as unoptimised offers the rewrite, and it
          // stays offered after a refusal so the user can retry once they have dealt
          // with the reason. `busy` is the settings-write flag: a rewrite running
          // while the settings document is being written is not worth allowing.
          clip.faststart === false
            ? React.createElement('button', {
              type: 'button',
              className: 'dshba-opt dshba-mini',
              disabled: busy || state === 'busy' || previewing !== null,
              title: '把这一段的索引表(moov)移到文件最前：无损、长度不变，'
                + '原片留在 assets/videos/originals/ 里。',
              onClick: () => optimize(clip.name),
            }, state === 'busy' ? '处理中…' : '优化')
            : null,
          React.createElement('span', { className: 'dshba-meta' }, formatBytes(clip.bytes))))
      }
    }

    // The screensaver rows. Same shape as the boot rows, minus the two controls that
    // only make sense for a video: the duration probe (an image has no timeline)
    // and the 优化 rewrite (`moov` is an mp4 box). What replaces them is a kind
    // badge, because "why does this row look different" is the question a user
    // will actually have when they drop a GIF in.
    const saverNodes = []
    if (saverPool === null) {
      saverNodes.push(React.createElement('div', { className: 'dshba-msg', key: 'loading' }, '正在读取…'))
    } else if (saverPool.length === 0) {
      saverNodes.push(React.createElement('div', { className: 'dshba-msg', key: 'empty' },
        '还没有屏保素材。在 assets/screensaver/ 里放一段循环短片、一张动图，'
        + '或一个 Live2D 模型文件夹，然后刷新这一页。'))
    } else {
      for (const item of saverPool) {
        saverNodes.push(React.createElement('div', { className: 'dshba-clip', key: item.name },
          React.createElement('label', { className: 'dshba-clipline', title: item.name },
            React.createElement('input', {
              type: 'checkbox',
              checked: !disabledSaver.includes(item.name),
              disabled: busy,
              onChange: (event) => toggleSaver(item.name, event.target.checked),
            }),
            React.createElement('span', { className: 'dshba-nm' }, item.name),
            React.createElement('span', { className: 'dshba-badges' },
              React.createElement('span', { className: 'dshba-badge' },
                KIND_LABEL[item.kind] || item.kind || '?'),
              item.model === true
                ? React.createElement('span', {
                  className: 'dshba-badge',
                  key: 'model',
                  title: '这是一个 Live2D 模型文件夹。它需要页面上装有适配器才能渲染；'
                    + '没有适配器时这一条会被跳过。',
                }, '模型')
                : null,
              // The "no adapter" warning applies ONLY to a Live2D model. It used to be gated on the
              // page-level flag alone, so every row — videos, stills, animated images — carried it,
              // which read as "this file has a problem" for files that have none. A model is the one
              // kind that needs an adapter; everything else renders with or without one.
              item.model === true && saverHasNoRenderer
                ? React.createElement('span', {
                  className: 'dshba-badge warn',
                  key: 'noadapter',
                  title: '这一页没有装 Live2D 适配器，这个模型现在放不出来。',
                }, '无适配器')
                : null)),
          React.createElement('button', {
            type: 'button',
            className: 'dshba-opt dshba-mini',
            // Not gated on `previewing`: that flag belongs to the boot overlay's preview. The
            // screensaver preview manages its own layer and refuses politely if one is already up.
            title: '预览这一条：真的盖上屏保层，鼠标划过能试互动特效，点一下或按个键才收回'
              + '（收回时按当前设定播退出特效）。',
            onClick: () => previewScreensaver(item.name),
          }, '预览'),
          React.createElement('span', { className: 'dshba-meta' }, formatBytes(item.bytes))))
      }
    }

    // The boot pool, folded away. Every row here runs a media probe when the card
    // opens, and the pool is the thing a user touches least often — so it starts
    // closed and says how many clips it holds, which is the one fact worth knowing
    // without opening it.
    sections.push(group('pool', '片头素材池',
      pool === null ? '读取中…' : (pool.length + ' 段，已选 ' + (pool.length - disabled.filter(n => pool.some(c => c.name === n)).length)),
      [React.createElement('div', { className: 'dshba-sec', key: 'pool' },
        React.createElement('div', { className: 'dshba-p' },
          '勾选的参与随机轮播；取消的只留在文件夹里，不再被抽中。'),
        // The folder button. Placed under the description rather than in the header
        // row so it reads as an action on the pool, and worded with the folder name it
        // opens, because "打开文件夹" alone leaves the user unsure WHICH folder.
        React.createElement('div', { className: 'dshba-row', style: { marginBottom: '8px' } },
          React.createElement('button', {
            type: 'button',
            className: 'dshba-opt dshba-mini',
            title: '在系统文件管理器里打开 assets/videos/ 这个目录',
            onClick: () => openFolder('clips'),
          }, '打开片头文件夹')),
        clipNodes)]))

    // The screensaver. Its own section because it is a separate directory, separate
    // settings, and a separate moment in time: what covers the app when the user has
    // walked away is a different decision from what plays during boot.
    //
    // THE SOUND CONTROL in this section is ONE SLIDER, not a switch plus a slider. It sits
    // after the rotation picker and before the hint switch (the note above the control itself
    // says why it is shaped that way). Its left end IS the off switch: dragging to 0% stores
    // `screensaverSound` as false, anything above 0% stores that level and the switch as true.
    // The alternative — a separate on/off switch gating a slider that only existed while it was
    // on — took two gestures for one choice and let the slider's position mean nothing whenever
    // the switch said off, so it was replaced rather than kept alongside.
    //
    // The default is SILENT (`screensaverSound` defaults to false), and that is the point
    // rather than an oversight: the layer appears when nobody is at the machine, so a
    // screensaver that starts making noise on its own is the setting nobody wants. Sound is
    // something the user turns UP, so the control starts where it is safe and a drag is what
    // adds audio.
    sections.push(group('saver', '屏保',
      saverEnabled ? ('已开启，闲置 ' + (saverIdleMs / 60000) + ' 分钟后出现') : '已关闭（默认）',
      [React.createElement('div', { className: 'dshba-sec', key: 'screensaver' }, ...[
        React.createElement('label', { className: 'dshba-switch' },
          React.createElement('input', {
            type: 'checkbox',
            checked: saverEnabled,
            disabled: busy,
            onChange: (event) => write('screensaverEnabled', event.target.checked),
          }),
          React.createElement('span', null, '启用屏保')),
        // The threshold, as a set of choices rather than a number box: the useful range
        // is four values, and a free number field invites a threshold that fires while
        // somebody is still reading.
        // The chosen threshold at display size: the one number in this card worth reading at a
        // glance. The presets below it are tiles, not pills, so the four choices read as objects.
        React.createElement('div', { className: 'dshba-display' },
          React.createElement('b', null, String(Math.round(saverIdleMs / 60000))),
          React.createElement('span', null, '分钟后出现')),
        React.createElement('div', { className: 'dshba-tiles', style: { marginTop: '10px' } },
          IDLE_CHOICES.map(choice => tile(
            String(choice),
            (choice / 60000) + ' 分钟',
            '闲置 ' + (choice / 60000) + ' 分钟后出现，用屏保素材盖住界面',
            [[10, 2]],
            choice === saverIdleMs,
            () => { setCustomOpen(false); write('screensaverIdleMs', choice) },
            busy || !saverEnabled,
          )),
          // The custom entry. It is marked selected when the stored threshold is not
          // one of the presets, so a value set here still reads as "custom" after a
          // reload — a control that resets to "none of these" would look like the
          // setting had been lost.
          React.createElement('button', {
            key: 'custom',
            type: 'button',
            className: 'dshba-opt',
            'data-on': !IDLE_CHOICES.includes(saverIdleMs) || customOpen ? 1 : 0,
            disabled: busy || !saverEnabled,
            onClick: () => {
              setCustomOpen(true)
              setCustomText(String(Math.round(saverIdleMs / 60000)))
            },
          }, !IDLE_CHOICES.includes(saverIdleMs) ? ((saverIdleMs / 60000) + ' 分钟（自定义）') : '自定义')),
        // The custom box. Minutes only, whole numbers: the stored unit is
        // milliseconds but the setting people reason about is minutes, and a
        // fractional minute is a threshold nobody asked for. Clamped to the range
        // the Host accepts (1–60 minutes) rather than sending a value it will
        // reject, so the control cannot put the document in a state the schema
        // refuses.
        customOpen
          ? React.createElement('div', { className: 'dshba-row', style: { marginTop: '8px', alignItems: 'center' } },
            React.createElement('input', {
              type: 'number',
              className: 'dshba-num',
              min: 1,
              max: 60,
              step: 1,
              value: customText,
              disabled: busy || !saverEnabled,
              placeholder: '分钟',
              onChange: (event) => setCustomText(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') { commitCustom() } },
            }),
            React.createElement('span', { className: 'dshba-meta' }, '分钟'),
            React.createElement('button', {
              type: 'button',
              className: 'dshba-opt dshba-mini',
              disabled: busy || !saverEnabled,
              onClick: () => commitCustom(),
            }, '确定'),
            React.createElement('button', {
              type: 'button',
              className: 'dshba-opt dshba-mini',
              disabled: busy,
              onClick: () => { setCustomOpen(false); setCustomText('') },
            }, '取消'))
          : null,
        // The two switches sit in the section flow, one per line, NOT side by side.
        //
        // A `label` is inline by default, and a row of inline labels wraps only when it
        // runs out of width — so these two shared a line, which read as one paragraph
        // that happened to have two checkboxes in it. `.dshba-line` makes each its own
        // block, which is what a list of independent switches should look like.
        React.createElement('label', { className: 'dshba-switch dshba-line' },
          React.createElement('input', {
            type: 'checkbox',
            checked: saverBreak,
            disabled: busy || !saverEnabled,
            onChange: (event) => write('screensaverBreakEffect', event.target.checked),
          }),
          React.createElement('span', null, '退出时播放特效')),
        // The effect picker. Shown only when the effect switch is on — offering a choice of
        // effect while effects are switched off would be a control that cannot do anything.
        //
        // '随机' is listed first because it is the default, and it is genuinely random per
        // dismissal: the screensaver resolves it at the moment it is dismissed, so a session
        // does not keep showing one "random" pick for hours.
        saverBreak
          ? React.createElement('div', { className: 'dshba-tiles', style: { marginTop: '10px' } },
            BREAK_STYLE_CHOICES.map(choice => tile(
              choice[0],
              choice[1],
              choice[2],
              MARK[choice[0]] || MARK.random,
              choice[0] === saverBreakStyle,
              () => write('screensaverBreakStyle', choice[0]),
              busy || !saverEnabled,
            )))
          : null,
        saverBreak
          ? React.createElement('div', { className: 'dshba-p', style: { marginTop: '6px' } },
            (BREAK_STYLE_CHOICES.filter(choice => choice[0] === saverBreakStyle)[0] || ['', '', ''])[2])
          : null,
        // The rotation interval. Its own block under the exit effect, because it answers a
        // different question: the exit effect is how the layer GOES, this is how long one entry
        // STAYS before the next takes over.
        //
        // A row of choices rather than a free number field: the useful range is four values, and
        // a number box invites a rotation nobody wants (two seconds, or two hours). "不轮换" is
        // the first choice and the default — rotation CHANGES what an existing profile does, so
        // it is opted into rather than inherited.
        React.createElement('div', { className: 'dshba-p', style: { marginTop: '14px', marginBottom: '0' } },
          '随机切换（屏保挂着时，每隔多久换一条）'),
        React.createElement('div', { className: 'dshba-tiles', style: { marginTop: '8px' } },
          ROTATE_CHOICES.map(choice => tile(
            String(choice[0]),
            choice[1],
            choice[2],
            MARK[choice[0] === 0 ? 'none' : 'fade'] || MARK.none,
            choice[0] === saverRotateSec,
            () => write('screensaverRotateMs', choice[0] * 1000),
            busy || !saverEnabled,
          ))),
        saverRotateSec > 0 && saverPool !== null && saverPool.length < 2
          ? React.createElement('div', { className: 'dshba-p', style: { marginTop: '6px' } },
            '屏保素材只有 ' + saverPool.length + ' 条，轮换要至少两条才看得出变化。')
          : null,
        // The pointer decoration is HIDDEN, by request: "在卡片中把鼠标特效隐藏了".
        //
        // Not deleted — the settings field, the schema and the three implementations all stay, so
        // an existing profile keeps its stored value and nothing has to be migrated. Only the
        // picker is gone, because the effect could not be made to work reliably in the desktop
        // shell (a window that does not deliver `mousemove` cannot drive a pointer-reactive
        // decoration), and a control that does nothing is worse than no control.
        //
        // Restoring it is one line: add the two elements back to the returned tree.
        // THE SOUND CONTROL: one slider, not a switch plus a slider.
        //
        // They were two controls and that read badly: a switch with an "off" state plus a slider
        // that only existed while the switch was on, so the same choice took two gestures. They
        // are now ONE control whose position IS the answer:
        //   0%      -> silent (the `screensaverSound` switch is stored as off)
        //   1..100% -> that volume, with sound on
        // The two stored fields are unchanged, so nothing in the schema, the Host or the
        // screensaver moves — only this control's shape.
        //
        // The displayed position combines both fields: sound off shows 0%, and the last volume is
        // kept in `screensaverVolume`, so turning it back up returns to where the user left it.
        React.createElement('div', { className: 'dshba-vol', key: 'vol' },
          React.createElement('div', { className: 'dshba-row', style: { alignItems: 'center', gap: '10px' } },
            React.createElement('span', { className: 'dshba-h', style: { margin: '0', flex: 'none' } }, '屏保声音'),
            React.createElement('input', {
              type: 'range',
              className: 'dshba-range',
              min: 0,
              max: 100,
              // A CONTINUOUS control, not a stepped one: 101 positions. `step: 5` left only 20 and
              // was reported as "滑动非常不跟手" together with the write-per-change bug below.
              step: 1,
              // Sound off reads as 0% even though the stored volume may still be 35 — that is
              // what "off" means on a one-control design. While dragging, the draft wins.
              value: String(volumeDraft === null
                ? (saverSound ? Math.round(saverVolume * 100) : 0)
                : volumeDraft),
              disabled: busy || !saverEnabled,
              'aria-label': '屏保音量（最左为静音）',
              // The DRAFT only. Writing on every change sets `busy`, which DISABLES this input
              // mid-gesture, awaits the document and re-renders the card — a thumb that jumps and
              // fights the pointer. One commit happens at the end of the gesture instead.
              onChange: (event) => setVolumeDraft(Number(event.target.value)),
              onPointerUp: (event) => commitVolume(Number(event.target.value)),
              onTouchEnd: (event) => commitVolume(Number(event.currentTarget.value)),
              onKeyUp: (event) => commitVolume(Number(event.target.value)),
              onBlur: (event) => commitVolume(Number(event.target.value)),
            }),
            React.createElement('span', { className: 'dshba-meta', style: { minWidth: '46px', textAlign: 'right' } },
              volumeDraft === null
                ? (saverSound ? Math.round(saverVolume * 100) + '%' : '静音')
                : (volumeDraft === 0 ? '静音' : volumeDraft + '%')))),
        // The hint switch, LAST among the settings. It is the only control here that does not
        // change what the layer IS — it only adds a line explaining how to leave it — so it sits
        // after everything that does.
        React.createElement('label', { className: 'dshba-switch dshba-line dshba-hintline' },
          React.createElement('input', {
            type: 'checkbox',
            checked: saverHint,
            disabled: busy || !saverEnabled,
            onChange: (event) => write('screensaverHint', event.target.checked),
          }),
          React.createElement('span', null, '显示「点击或按任意键继续」提示')),
        React.createElement('div', { className: 'dshba-row', style: { marginTop: '12px', marginBottom: '8px' } },
          React.createElement('button', {
            type: 'button',
            className: 'dshba-opt dshba-mini',
            title: '在系统文件管理器里打开 assets/screensaver/ 这个目录（不存在就建一个）',
            onClick: () => openFolder('screensaver'),
          }, '打开屏保文件夹')),
        ...saverNodes])]))

    if (failure !== null) {
      sections.push(React.createElement('div', { className: 'dshba-msg err', key: 'failure' }, failure))
    }
    if (snapshot && snapshot.status === 'unavailable') {
      sections.push(React.createElement('div', { className: 'dshba-msg', key: 'unavailable' },
        '这一页连不上设置文档，改动不会保存。'))
    }
    if (snapshot && snapshot.writable === false) {
      sections.push(React.createElement('div', { className: 'dshba-msg', key: 'readonly' },
        '当前页面不允许写入设置文档。'))
    }

    return React.createElement('li', { className: 'dshba-card', 'data-open': '1' },
      header,
      React.createElement('div', { className: 'dshba-body' }, sections),
      folder === null ? null : folderDialog(React, folder, poolDirs, closeFolder, openFolder))
  } catch (error) {
    // A card that cannot draw itself must still leave the settings page usable.
    return React.createElement('li', { className: 'dshba-card', 'data-open': '1' },
      header,
      React.createElement('div', { className: 'dshba-body' },
        '启动动画设置面板渲染失败：' + String(error && error.message ? error.message : error)))
  }
}

/**
 * The folder dialog: the pool's absolute path, and a button that opens it.
 *
 * A plain factory rather than a component, for the same reason `switchRow` is: it
 * calls no hooks, so the card's hook count does not change when the dialog opens.
 *
 * The path is shown BEFORE anything is attempted and stays on screen afterwards,
 * because it is the fallback. Browsers cannot open a folder, and this plugin asks
 * the Host to do it — but if that request fails (no file manager, a locked-down
 * machine), a copyable path is the one route that still works, and the user has to
 * be able to see it to use it.
 *
 * @param React - the renderer handed to the card.
 * @param folder - `{ which, status, dir, error }`.
 * @param poolDirs - absolute directories published by the manifests, keyed by pool.
 * @param onClose - closes the dialog.
 * @param onOpen - asks the Host to open the folder.
 */
function folderDialog(React, folder, poolDirs, onClose, onOpen) {
  const isSaver = folder.which === 'screensaver'
  const title = isSaver ? '屏保素材文件夹' : '片头素材文件夹'
  const dir = folder.dir || poolDirs[folder.which] || null
  const contents = isSaver
    ? '放 mp4 / webm 视频、gif / webp 动图、png / jpg 图片，或一个 Live2D 模型文件夹'
      + '（文件夹里要有 .model3.json）。屏保会循环播放，所以短片越短越省资源。'
    : '只放视频：mp4 / webm / m4v / mov。图片请放到屏保文件夹。'

  const children = [
    React.createElement('div', { className: 'dshba-sheet-h', key: 'h' }, title),
    React.createElement('div', { className: 'dshba-sheet-p', key: 'p' },
      '把素材放进这个文件夹，然后刷新页面就生效——不用重启 DSH。'),
    // The path, or a placeholder while the Host is still answering. It is rendered
    // as selectable text rather than a copy button: selecting is what every user
    // already knows how to do, and a copy button needs clipboard permission that a
    // settings page may not have.
    React.createElement('code', { className: 'dshba-path', key: 'path' },
      dir === null
        ? (folder.status === 'opening' ? '正在向 Host 询问路径…' : '（路径未知：Host 没有回应）')
        : dir),
    React.createElement('div', { className: 'dshba-sheet-note', key: 'note' }, contents),
  ]

  // One status line, which is the only place the outcome is reported. Success says
  // so rather than silently closing: the user needs to know the folder opened, and
  // that a window appearing on another screen is the answer rather than a glitch.
  if (folder.status === 'opened') {
    children.push(React.createElement('div', { className: 'dshba-sheet-note', key: 'st' },
      '已经打开文件管理器。如果没看到，它可能在其它窗口后面。'))
  } else if (folder.status === 'failed') {
    children.push(React.createElement('div', { className: 'dshba-sheet-note err', key: 'st' },
      '打不开文件管理器：' + String(folder.error) + '。可以把上面的路径复制出来，'
      + '在文件管理器地址栏粘贴打开。'))
  } else if (folder.status === 'opening') {
    children.push(React.createElement('div', { className: 'dshba-sheet-note', key: 'st' },
      '正在打开…'))
  }

  children.push(React.createElement('div', { className: 'dshba-sheet-acts', key: 'acts' },
    // The dialog always offers the open action, and re-labels it after a failure:
    // retrying is the obvious next move once the reason is on screen.
    React.createElement('button', {
      type: 'button',
      className: 'dshba-opt',
      disabled: folder.status === 'opening',
      onClick: () => onOpen(folder.which),
    }, folder.status === 'failed' ? '再试一次' : '打开文件夹'),
    React.createElement('button', {
      type: 'button',
      className: 'dshba-opt',
      onClick: onClose,
    }, '关闭')))

  // The backdrop closes on click, which is the gesture people expect from a modal.
  // The sheet itself stops propagation so a click INSIDE it does not dismiss it —
  // without that, selecting the path text would close the dialog the user is
  // trying to copy from.
  return React.createElement('div', {
    className: 'dshba-modal',
    key: 'folder-modal',
    role: 'dialog',
    'aria-label': title,
    onClick: onClose,
  }, React.createElement('div', {
    className: 'dshba-sheet',
    onClick: (event) => event.stopPropagation(),
  }, children))
}

/**
 * Read one awaited service from the injected owner context.
 *
 * `get` first, because that is the form every working plugin in this deployment
 * uses and the property proxy is topology-sensitive; the property is the fallback
 * for a context that has the service declared.
 * @param owner - the context passed to the inject callback.
 * @param name - service name.
 * @returns the service, or undefined when it is not reachable.
 */
function serviceAt(owner, name) {
  try {
    if (owner !== null && owner !== undefined && typeof owner.get === 'function') {
      const value = owner.get(name)
      if (value !== undefined && value !== null) return value
    }
  } catch (error) {
    // A global-store miss is the expected miss; the property may still answer.
  }
  try {
    return owner === null || owner === undefined ? undefined : owner[name]
  } catch (error) {
    return undefined
  }
}

/**
 * Report activation, then contribute the settings card if the shell is willing.
 * @param ctx - Client plugin context.
 */
exports.apply = function apply(ctx) {
  // 1. Priority one, and it must not be able to fail for any other reason.
  try {
    const overlay = globalThis[OVERLAY]
    // A missing overlay means the Host half contributed nothing (for example a
    // static deployment whose boot payload carries no injection), in which case
    // the kernel boot page is the only screen and there is nothing to hand over.
    if (overlay !== undefined && typeof overlay.clientReady === 'function') {
      overlay.clientReady()
    }
  } catch (error) {
    // Never break the client roster over a decorative overlay.
    console.warn('boot-animation: client half failed', error)
  }

  // 2. Optional, and reached with the dynamic `ctx.inject` rather than `ctx.get`
  //    or a declared `inject`; see the module header for both reasons.
  try {
    let React = null
    try {
      React = require('react')
    } catch (error) {
      React = null
    }
    if (React === null || typeof React.createElement !== 'function') return
    if (ctx === undefined || ctx === null || typeof ctx.inject !== 'function') return

    ctx.inject(['slots', 'locale', 'configForms'], (owner) => {
      try {
        const slots = serviceAt(owner, 'slots')
        const locale = serviceAt(owner, 'locale')
        const forms = serviceAt(owner, 'configForms')
        if (slots === undefined || slots === null || typeof slots.inject !== 'function') return
        // `configForms` replaced the older `settingsScope` service and owns both
        // the per-namespace scope and the "is the Host serving it at all" gate.
        if (forms === undefined || forms === null || typeof forms.get !== 'function') return
        if (typeof forms.whileServed !== 'function') return

        if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
          const dictionaries = () => locale.register(LOCALE_NAMESPACE, {
            zh: DICTIONARY_ZH,
            en: DICTIONARY_EN,
          })
          if (typeof owner.effect === 'function') owner.effect(dictionaries, 'boot-animation: dictionaries')
          else dictionaries()
        }
        const t = locale !== undefined && locale !== null && typeof locale.bind === 'function'
          ? locale.bind(LOCALE_NAMESPACE)
          : function (key) { return DICTIONARY_ZH[key] === undefined ? key : DICTIONARY_ZH[key] }

        // `whileServed` is the modern gate: the tab is contributed only while the
        // Host actually serves this namespace, so a profile with no settings
        // provider (or one whose schema package is missing) shows no tab at all
        // rather than an inert one.
        //
        // The registered component is a dispatcher, because the page asks for two
        // different things through the same entry: `view: "summary"` for the row's
        // one-liner and `view: "page"` for the configuration section. The view is an
        // owner prop, not part of this face — `runInject` calls `inject` with only
        // `(bindingKey, actions)`, so it cannot be read here — and the two render
        // shapes use a different number of hooks, so they are two components and
        // the dispatcher picks between them at render time.
        //
        // Registration is IDEMPOTENT, and that is load-bearing. `slots.register`
        // throws when a list slot already holds an entry with the same id and
        // priority:
        //
        //   list slot "plugins.item" already has an entry with id "boot-animation"
        //
        // and that throw lands inside the slot ledger's store notification. React's
        // own subscription rides the same notification, so a duplicate registration
        // does not merely log a line: it kills the card's updates while leaving the
        // rendered DOM in place — a card that is visible and completely dead to both
        // the mouse and the keyboard, with every control still enabled. Measured on
        // the live desktop build: the header's click handler ran (a capture-phase
        // listener saw the event) and the state never moved.
        //
        // `slots.inject(key, …)` only forbids a duplicate KEY, not a duplicate ENTRY,
        // so it cannot provide this. Disposing the previous registration before
        // registering again, plus owning the failure so it never reaches the store,
        // is what makes a re-entry harmless.
        let registration = null
        const contribute = function () {
          if (registration !== null) return
          try {
            registration = slots.inject(SLOT, () => slots.register(
              {
                name: SLOT,
                id: SETTINGS_NAMESPACE,
                order: 60,
                label: () => t('title'),
                locale: LOCALE_NAMESPACE,
                // Read lazily: the scope binds when the slot actually renders.
                inject: () => ({ runtime: React, scope: forms.get(SETTINGS_NAMESPACE) }),
              },
              BootAnimationEntry,
            ))
          } catch (error) {
            // A racing registration must not become an exception in the ledger's
            // notification: drop our handle and log, so the card that IS mounted
            // keeps its updates.
            registration = null
            console.warn('boot-animation: settings card not registered', error)
          }
        }
        const withdraw = function () {
          if (registration === null) return
          const dispose = registration
          registration = null
          try {
            if (typeof dispose === 'function') dispose()
          } catch (error) {
            console.warn('boot-animation: settings card not withdrawn', error)
          }
        }
        const serve = function () {
          return forms.whileServed([SETTINGS_NAMESPACE], function () {
            contribute()
            return withdraw
          })
        }
        if (typeof owner.effect === 'function') owner.effect(serve, 'boot-animation: settings page')
        else serve()

        // The card is silent when it works, which is exactly the state that used to
        // be indistinguishable from "the services never arrived". Diagnostic mode
        // says which one happened.
        if (typeof location !== 'undefined' && String(location.search).indexOf('dshbootdiag=1') >= 0) {
          console.info('[boot-animation] settings card registered into ' + SLOT)
        }
      } catch (error) {
        console.warn('boot-animation: settings card not registered', error)
      }
    })
  } catch (error) {
    // The card is a convenience; the animation is the feature.
    console.warn('boot-animation: settings card wiring failed', error)
  }
}
