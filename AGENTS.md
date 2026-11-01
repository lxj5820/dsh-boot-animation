# AGENTS.md — dsh-boot-animation

Maintainer briefing. Written for whoever (or whatever) picks this up next: what the
package is, which two facts about DSH it depends on, the invariants that break it
silently, and how to prove a change is safe.

> **Porting note (DSH 0.2.0-rc.2).** The Host settings contract changed: a plugin
> no longer *registers* a settings namespace, it *declares* `Config`. Everything
> below reflects that. The wide `verify-*` set the README names belongs to the
> author's working copy; what actually ships here is the five verify suites and the
> four installer scripts under [`tools/`](tools/) — see
> [Verifying a change](#verifying-a-change).
>
> **Which files this tree actually has.** Two different sets of file names appear
> below, and only one set is present here. `tools/verify-pools.mjs`,
> `tools/verify-encoding.mjs`, `tools/verify-icon-route.mjs`,
> `tools/verify-client-card.mjs` and `tools/verify-exit-effects.mjs` are IN this
> tree and runnable right now, and so are the installers — `tools/install.ps1`,
> `tools/install.sh`, `tools/uninstall.ps1`, `tools/uninstall.sh` — plus
> `INSTALL.md`. The `verify/verify-*.mjs` suites and the media tooling
> (`tools/faststart.mjs`, `tools/apply-faststart.mjs`, `tools/mp4-info.mjs`,
> `tools/mp4-audit.mjs`, `tools/box-chain.mjs`, `tools/codec-report.mjs`,
> `tools/preview.mjs`, `tools/verify-browser.mjs`) belong to the author's working
> copy and are NOT in this tree. The history below is kept either way — it is the
> most valuable part of this document — but do not go looking for a file that was
> never shipped. Each mention of an absent file is marked *(not in this tree)*.

Human-facing usage lives in [MANUAL.md](MANUAL.md). The long forensic record —
every bug, why it happened, what the evidence was — is [README.md](README.md).
Read this file first; go to README only for the history of a specific symptom.

## What it is

A DSH plugin that replaces the kernel's boot page with a full-window video clip,
then dissolves into the app. No DSH source is modified: it injects a script into
`<head>` ahead of the shell, and contributes a card to Settings → Plugins.

It also ships a **screensaver**: a full-window layer that covers the app after the
user has been away, dismissed by a click or a key. It is a separate module with a
separate lifetime — see [Two modules, two lifetimes](#two-modules-two-lifetimes).

| Half | File | Job |
|---|---|---|
| Host (Node) | `entry.js` | Serves TWO pools over HTTP with Range, declares the `Config` schema the settings namespace is derived from, injects the pre-boot screen and the screensaver into the index, and answers the OS idle counter |
| Host (Node) | `src/idle-probe.js` | Reads system-level idle time (Windows `GetLastInputInfo`) through one long-lived child, for the screensaver's trigger |
| Browser (pre-boot) | `src/boot-screen.js` | The overlay itself: framework-free, injected as text, must run before the shell |
| Browser (pre-boot) | `src/screensaver.js` | The screensaver: framework-free, injected as text, installs itself and then lives on its own timer for the whole session |
| Browser (renderers) | `src/renderers.js` | Per-kind media knowledge: what a video is versus an image versus an animated image versus a Live2D model, and the adapter slot for the last one |
| Browser (plugin) | `src/client.js` → `lib/client.js` | Reports activation to the overlay, and renders the settings card |

### Two modules, two lifetimes

The boot screen and the screensaver are deliberately **not** one file:

| | `src/boot-screen.js` | `src/screensaver.js` |
|---|---|---|
| Lifetime | Boot path only; **removes itself** on hand-over | The whole session |
| Why injected early | Must pre-empt the kernel's boot page | Needs to install before anything can cover it |
| Trigger | The clip's `ended` plus kernel readiness | A timer polling two idle conditions |
| Failure mode | Cannot hand over (stuck on the boot page) | Never appears (an INVISIBLE failure) |

Sharing a file would make the screensaver carry the boot screen's "runs before React
exists" constraints for no reason. The screensaver's own header says this too.

**The screensaver's failures are invisible**, which is why it exposes
`__DSH_BOOT_ANIM_SCREENSAVER__.state()`: a layer that declines to appear looks
identical whether it is switched off, waiting for its threshold, blocked by the boot
overlay, or reading a counter that never grows. `verify/verify-screensaver.mjs`
*(not in this tree)* reads that state rather than only looking for the layer.

### The media-kind abstraction, and why the ABSENCES are the contract

An entry from a pool carries a `kind`, decided by its extension in `entry.js`:
`video`, `image`, `animated`, `live2d`. The screen never inspects it — it asks the
renderer a fixed set of questions, and `src/renderers.js` is the only place that
knows the difference.

The load-bearing part is what a renderer **does not have**. The screen's timeline
logic asks "does this have a duration? does it end? does it make a sound?" and each
answer is expressed by a method being absent:

| | `duration()` | `onEnded()` | `setVolume()` |
|---|---|---|---|
| video | yes | yes | yes |
| image | — | — | — |
| animated | — | — | — |
| live2d | — | — | — |

Absence is what routes an entry through the screen's existing "unknown length" bound
(`ENDLESS_MS`), which is exactly right for something that cannot end. **A renderer
that grew a fake `duration` or a no-op `onEnded` would silently change the hand-off
for every kind** — `verify/verify-renderers.mjs` *(not in this tree)* asserts the
absences for this reason.

`loop` is the other half: it is decided by the CALLER, not the file. The boot clip
must not loop (its `ended` is the hand-off signal, and a looping element never fires
it); the screensaver must loop (its job is to cover the screen for an unknown length
of time, and a non-looping element stops dead when its clip runs out). Both were real
bugs found only in a browser.

### The two pools

`assets/videos/` (boot) and `assets/screensaver/` (screensaver) are separate
directories because they have different jobs: the boot clip is watched once and hands
over, the screensaver covers the screen until the user comes back. One pool with a
flag would make adding a screensaver loop silently change the boot rotation. `POOLS`
in `entry.js` is the single list; every route, manifest and settings field is derived
from it. The screensaver pool's key is `screensaver`, and the directory carries a
`.gitkeep` so a fresh clone has it even while empty.

> The package once had an **idle layer** that filled the gap between the boot clip
> ending and the kernel becoming ready. It was **removed entirely** by request: the
> boot screen now holds the clip's last frame, as every version before it did. Its
> pool was renamed to the screensaver's, and the settings it owned
> (`idleEnabled`/`idleHoldMs`/`disabledIdle`) are gone. Nothing in this tree should
> refer to it except as history.

### The screensaver's trigger: two conditions, ORed

Neither condition alone covers what was asked for, so `shouldShow()` ORs them:

- **System idle** (`src/idle-probe.js`, read by the Host half) catches "walked
  away", *including while DSH is still the foreground window* — which no page-side
  signal can see.
- **Window blur** (the page's own `blur`/`focus` events) catches "switched to
  another program", which the system counter misses while the user keeps typing over
  there.

Why the Host half owns the first one: a renderer sees only input that reaches its own
window, and "has the user touched the computer" is an OS fact. The plugin **cannot**
reach Electron's `powerMonitor` — the desktop app runs the harness as a **child Node
process** (`lib/main.js` spawns `@deepseek-ai/dsh-desktop-host`), which has no
Electron bindings. So `idle-probe.js` reads the same underlying counter directly.

**Windows only, honestly so.** `GetLastInputInfo` has no cross-platform twin; there
`read()` answers `undefined`, `status()` answers `unavailable`, and the screensaver
falls back to the blur trigger alone. A real degradation, reported rather than
hidden.

**A long-lived child, not a spawn per read**: a spawn costs ~200ms and this is polled
every few seconds, while the child costs one syscall per tick. It starts lazily, so a
profile with the screensaver off never pays for one, and `dispose()` kills it.

The route answers `{ ok, idleMs, status, reason }`, where `status` is one of
`ok` / `starting` / `unavailable` and `idleMs` is `null` **unless the status is
`ok`**. The three states are load-bearing and conflating them is a bug: `starting`
means "ask again shortly", `unavailable` means "never going to work here, use the
fallback", and a caller that cannot tell them apart either gives up on a slow start
or polls forever on a permanent failure. `verify/verify-screensaver.mjs`
*(not in this tree)* guards this explicitly.

### Is anybody looking? Two halves, only one of them answerable

The screensaver declines to cover a window nobody can see — but that question splits,
and the split is the point:

- **Answerable, and handled: a minimized window or a switched-away tab.**
  `visibilityState` becomes `'hidden'`, so `shouldShow()` returns false; an
  already-visible layer also retreats **immediately** on `visibilitychange` rather
  than waiting for the next poll. It retreats with `hide(false)` — **no break
  effect** — because tearing the picture would animate a dismissal the user never
  performed, and they would come back to a torn screen.
- **NOT answerable, and NOT attempted: a window merely COVERED by another window.**
  `visibilityState` still reports `'visible'`, because that is an OS-level fact the
  renderer cannot reach. **The screensaver does fire in that case.** This is an honest
  limit, not a defect: doing better would mean reading the OS foreground-window handle
  from the Host half, which is beyond what the plugin should reach for. `src/screensaver.js`
  says so in its own comment so the next reader does not file it as a bug.

### The two DSH facts everything rests on

1. **`webserver/index-inject` is the only moment early enough.** Rows pushed into
   that table render into `<head>`, ahead of the shell module. Anything later
   cannot pre-empt the boot page. `entry.js` subscribes to it.
2. **A settings namespace is a plugin entry, and a field is served only if it is
   volatile.** The Host declares `Config` on the module namespace object; the
   entry id in the profile patch (`- insert: id: boot-animation`) *is* the
   namespace; the browser card reaches that same id through the client
   `configForms` service. `@deepseek-ai/dsh-settings` describes only an entry
   whose `Config` projects a non-empty form, and that projection keeps only
   fields marked `.volatile()` — so a schema with no volatile field yields no
   namespace, no card, and no error anywhere. `src/client.js` holds the other end
   of the pairing in `SETTINGS_NAMESPACE`, and nothing in the harness checks that
   the two strings agree.

### What `.volatile()` costs on the Host side

A volatile field does not arrive in `apply(ctx, config)` as a value: it arrives as
a stable reference (`{ get() }`) whose snapshot the loader commits in place, so
`entry.js` reads every field through `readField()` rather than directly. That is
also why a settings edit needs no restart — when only volatile values change,
`@deepseek-ai/cordis-plugin-loader` calls `updateVolatile` on the existing
reference and emits `loader/volatile-update` instead of restarting the fiber, so
the next index render already sees the stored value.

## Rules that were each learned the hard way

Every line here cost a real debugging session. They are not style preferences.

| Rule | What happens if it is broken |
|---|---|
| **A route that LAUNCHES A PROGRAM takes a whitelist key, never a path — and POST only.** | The `reveal` route runs `explorer` / `open` / `xdg-open` on the user's machine, because a page cannot do it. A route that took a path would be remote program-launching for any page on this origin; a GET that launches would be fireable by a stray `<img>` tag on some other page. Both refusals are the feature, not the paperwork. A refused call must also name no directory, or the refusal itself leaks the install path. |
| **A route that only READS is GET-only, and is named so it cannot be mistaken for a pool.** | The mirror of the rule above: `system-idle.json` returns a number and touches nothing, so there is no side effect for a stray request to trigger and it must be cheap enough to poll — it refuses anything but GET/HEAD with a 405. It is deliberately NOT called `idle.json`, because that name was the retired idle POOL's manifest and would be read as one by anyone who remembers it. It answers `{ ok, idleMs, status, reason }` with `status` one of `ok` / `starting` / `unavailable`, and `idleMs: null` unless the status is `ok`. Those three states must not be collapsed: `starting` means "ask again shortly" and `unavailable` means "never going to work here, use the fallback", and a caller that conflates them either abandons a slow start or polls a permanent failure forever. |
| **Never read/write a CJK-bearing file with PowerShell** — source, data or the user's config alike. Use the file tools; verify with Node `readFileSync(..., 'utf8')`. | PowerShell 5.1 decodes BOM-less UTF-8 as GBK, and a `Set-Content` round-trip destroys every Chinese character — once collapsed `'…'` into `鈥?` and broke the script. The same rule covers files this package does not own: `cordis.patch.yml` carries a provider `displayName`, and the `Get-Content`/`Set-Content` pair in `tools/uninstall.ps1` turned it into mojibake and added a BOM. When a `.ps1` genuinely must rewrite such a file, go through .NET — `[System.IO.File]::ReadAllText($p, $utf8NoBom)` / `WriteAllText($p, $text, $utf8NoBom)` with `New-Object System.Text.UTF8Encoding($false)` — because on 5.1 `Set-Content -Encoding utf8` means *UTF-8 with BOM*, which is still a change to a file that is not the script's to change. **Not `ReadAllLines`/`WriteAllLines`:** `WriteAllLines` terminates every line with `[Environment]::NewLine`, so an LF layer came back all-CRLF — a whole-file rewrite reported as a byte-identical round-trip. |
| **A step that only checks must not repair.** | `tools/install.ps1`'s last step guesses which port dsh is on; when the guess missed it reported FAILED and rolled back a fully working install. A check that cannot tell "broken" from "not measured" has to say which one it is and leave the state alone. |
| **The loop flag is the difference between the boot clip and the screensaver, and it is set by the CALLER.** | The boot clip must NOT loop — its `ended` event is the hand-off signal, and a looping element never fires `ended`, so a looping clip holds the screen until the user presses something. The screensaver MUST loop — a non-looping clip reaches its end and stops, leaving a frozen frame on a layer that is supposed to cover an unknown length of time. Both were shipped and both were caught only in a browser. |
| **A layer's reveal belongs on the LAYER, not on the element inside it — and a reused element carries the OTHER module's hiding rule.** | Two versions of one mistake. (a) `.dshba-idle` carried `opacity: 0` until it had something to show; revealing the media element inside it did nothing visible, because the child was `opacity: 1` behind a transparent parent — the layer ran, reported itself shown, and was invisible, with every offline assertion passing. (b) The screensaver reuses `src/renderers.js`, whose elements carry the BOOT screen's `dshba-media` class — and that rule holds them at `opacity: 0` until `data-shown="1"`. A screensaver built on it is a black rectangle that looks exactly like an empty pool. `src/screensaver.js` therefore states the visibility rule for its OWN class too, in the descendant form `.dshsaver .dshsaver-media`, because the boot screen's sheet is injected AFTER it and wins at equal specificity. Both cases were found by the browser check, which could see the element's size and not its pixels. |
| **A model directory is ONE pool entry, and its files travel together.** | A Live2D model is a `.model3.json` plus a `.moc3` plus textures whose internal references are relative. Publishing the JSON alone gives the browser a manifest it cannot use, so the DIRECTORY is the entry and the bytes route serves anything inside it. That also means the pool can no longer be a flat file list — see `resolvePoolFile`, which validates segment by segment and only allows model-file extensions inside a model directory. |
| **`Array.prototype.find` answers `undefined`, not `null`.** | Testing `model === null` let every model-less directory through and then threw on `.name`, which turned the whole clips manifest into a 500 — while the other pool's manifest, whose directories all held models, stayed green. A guard written against the wrong absent value fails on exactly the input the guard exists for. |
| **A path built from two roots that already share a prefix doubles it.** | `POOLS.dir` was `'assets/videos'` against a root that was already `.../assets`, resolving to `assets/assets/videos`. Every pool came back EMPTY while the manifests still answered 200 — an empty pool is a legitimate state, so nothing failed; the screen just showed its background. |
| **A test's fake response object must be a real `Writable`.** | The media route streams with `createReadStream(...).pipe(res)`, and `pipe` calls `res.write`. A hand-rolled stub with only an `end` method threw inside the handler and surfaced as a **500 from the plugin** — a defect in the SUITE that reads as a defect in the code. |
| **No backtick anywhere inside a CSS blob** (the screen's `style()` string, the card's `CSS` string). | The string ends early and the build keeps the *previous* artifact. It looks like the change had no effect. **This covers COMMENTS inside the array too**: the suite scans the blob's text, not the parsed CSS, so a backtick in a prose comment fails the check exactly like a stray one in a declaration. |
| **A later visual layer must re-state `background-size` whenever the rule it overrides uses the `background` SHORTHAND.** | The card's sea rail is a 3px `background-image` on `.dshba-card`, sized by `background-size`. The older rule for the same element in its open state used the `background` shorthand, which resets `background-size` to `auto` — so expanding the card turned the rail into a full-bleed gradient and painted the whole card solid blue, burying every label. Only visible in a browser. |
| **A flex child moved into a grid still carries its old `flex` shorthand.** | `.dshba-nm` had `flex:1 1 60px` for the one-line material row. After the row became a two-row grid the `flex` basis still applied, so the badges were pulled back onto the name's line and the two-row layout collapsed into one crowded line. `flex:none` had to be stated in the grid rule. |
| **An attribute selector with a numeric value must quote it** — `[data-hint="0"]`, never `[data-hint=0]`. | An unquoted value must be a CSS identifier, and one starting with a digit is not, so Chrome drops the ENTIRE rule without a word. The switch looks wired and does nothing. `[data-shown=1]` and both `[data-attention=1]` rules in this package had never applied (only the inline `style.opacity` in `reveal()` hid it). `verify/verify-options.mjs` *(not in this tree)* asserts it with a regex, comments stripped first; `tools/verify-exit-effects.mjs` strips comments before every regex it runs against an artifact. |
| **A config field the caller passes must be PROVEN to be stored, not merely passed.** | `installScreensaver` accepted `breakStyle` and `pointerEffect`, and then assembled a `config` object that omitted both. The readers therefore saw `undefined` on every appearance and silently fell back to `'random'` / `'none'`: the pointer decoration the user had selected (菱形涟漪) never drew a single pixel, and the exit-style picker was equally dead. It survived every offline check because each of them asserted that the CALLER forwarded the value — `entry.js` did, the call site did, the reader existed — and none asserted that the object in between KEPT it. When a value travels caller → config → reader, assert the middle hop.** |
| **A `bodyOf`-style brace counter cannot be pointed at a function with a default parameter object.** | `installScreensaver(options = {})` has a brace pair inside its parameter list, and a helper that starts counting at the first `{` it finds returns that empty object as the "body". Assertions written against it read the wrong text and pass or fail for the wrong reason. Walk the parameter list first, then count braces. |
| **A deliberately-raised layer is still subject to every automatic stand-down, and `tick()` runs every 2 seconds.** | The preview raised the screensaver layer and was taken down again within one poll: `tick()` calls `hide(false)` whenever the boot overlay is in the DOM or the window has been hidden for the grace period, and it has no idea the layer was raised on purpose. The user's report was exactly "the preview dismisses itself". A layer raised by an explicit user act must be exempt from the automatic paths — `tick()` now returns early while `previewing`, and the user's own click is what ends it. **A preview that raises a layer must also be exempt from the poll that manages it.** |
| **A media element is BUILT muted, so a sound setting must UNMUTE it — not merely stop muting it.** | `videoRenderer` sets `muted = true` before assigning the source, because that is the only state an unattended layer may start in. The screensaver's `sound` switch therefore has to call `renderer.mute(false)` when it builds an entry; reading the flag and doing nothing leaves the element silent no matter what the user chose. The renderer's `mute` is absent on every non-video kind, so the call is inert for them rather than a branch that has to know kinds. |
| **A refusal that protects an invariant can still delete the feature that asked for the exception.** | `preview()` refused whenever the boot overlay was in the DOM, on the sound principle that the screensaver must never cover the boot animation. But the overlay stays in the DOM for the whole boot path — often the first minute of a session — so the preview button did NOTHING for exactly as long, and the user read it as "the mouse interaction is gone". A deliberate, momentary act by a present user is not the same event as the layer appearing on its own; it now PARKS the overlay (`bootOverlayParked`) and `hide()` puts the same node back, so the boot screen keeps its children and its state. The regression is guarded by an assertion that reads the INSIDE of `preview()`, because `shouldShow()` and `tick()` test for the overlay legitimately and a file-wide regex matches those instead. |
| **A scratch-copy suite must copy with `dereference: true`.** | Installed, `node_modules/@deepseek-ai/schemastery` is a symlink; `cpSync(..., { recursive: true })` preserves it, so the scratch tree points back at the real library. `verify-degraded.mjs`'s "rename `.volatile()` away" then rewrote the INSTALLED schemastery and silently disarmed every settings card in the deployment. The suites now copy real files and assert the scratch is not a link before rewriting. |
| **A picker that reads a SNAPSHOT taken at install time will look like the setting was ignored.** | `installScreensaver` copies its options into `config` once, when the injected script first runs, and `pointerEffect()` / `breakStyle()` then read that copy. So a user who switched 菱形涟漪 to 星屑吸附 saw the card report the save, saw the value stored correctly in `cordis.patch.yml`, and still got diamonds on the next appearance — the snapshot predated the write. Both pickers now read the LIVE `CFG` global first, which the Host rebuilds on every index render, so the newest stored value wins as soon as the page reloads. Anything resolved per appearance must read `CFG`, not `config`. |
| **A displacement effect's patch size is the whole effect.** | The lens has been rewritten twice from "why does this look so bad". v1 tiled the disc with 30px cells and read as a mosaic; v2 drew concentric rings, which removed the grid but made a static grey magnifier, and on a dark picture a magnifier is a smudge; v3 displaces the picture radially with a travelling wave. What separates v3 from v1 is only the ratio: 4px patches under a 16px amplitude land at visibly different offsets, so the wave is smooth — 6px under 11px produced broken glass. The soft edge matters as much: a circular `clip()` is a disc stuck on the picture, while `destination-in` with a radial gradient is what fades it out. |
| **Read optional services with `ctx.inject([...], (owner) => owner.get(name))`.** Never `ctx.get(name)`. | `ctx.get` is a one-shot read that races activation and silently answers `undefined`; the card then never registers and there is no error anywhere. Every other client plugin in the deployment uses the `ctx.inject` form. |
| **The client half declares no `inject`.** | A required service leaves the fiber PENDING in a profile that lacks it, `apply` never runs, `clientReady` is never sent, and the animation refuses to hand over. |
| **A slider that writes the settings document on every `onChange` fights the hand dragging it.** | `write()` sets `busy`, which DISABLES the input mid-gesture, then awaits the document and re-renders the card. The volume thumb therefore moved in jumps and stopped responding — reported as "滑动非常不跟手". `step: 5` made it worse by leaving only 20 positions. The fix is the same shape as the custom-minutes box: `onChange` moves a LOCAL draft and nothing else, and one commit happens on `pointerup` / `keyup` / `blur`. Any continuous control over a persisted value needs the draft-then-commit split. |
| **A volume slider must not be linear.** | `video.volume` is a LINEAR amplitude multiplier; loudness is roughly logarithmic. Copying the slider position straight into it spends almost all the travel where it sounds the same and leaves the bottom end audible — the user reported "拖到 2% 了，声音还是不小", and 2% linear is -34dB, which is quiet but plainly audible. `volumeToGain()` squares the position: 2% becomes -68dB (inaudible), 50% becomes -12dB, 100% stays 1.0. The stored value and the schema stay 0..1. |
| **Two controls for one choice is a gesture tax.** | The screensaver sound was a switch plus a slider that only existed while the switch was on. They are one slider now, whose LEFT END is off: `clampedPct > 0` decides `screensaverSound`, and the level is kept separately so dragging back up returns to where the user left it. |
| **One control writing two fields cannot use two `write()` calls.** | Each call captures `snapshot.revision` from the render it was created in, and the card does not re-render between them, so the second presents a revision the first just invalidated — refused, with "保存失败" painted over a save that half-worked. The document showed exactly that: `screensaverVolume: 0.07` beside `screensaverSound: false`. `writeMany(ops, label)` sends one atomic `SettingsPathOp` list instead. |
| **A pointer effect must be caused by the pointer — and "make it visible" is not "make it autonomous".** | 水波涟漪 has now been wrong in BOTH directions, and the second was caused by fixing the first. v1 drew nothing until a `mousemove`, and on a real screensaver the window is typically unfocused, so it was never TRIGGERED — "我一直没看到效果". v2 seeded a ring every 320ms unconditionally so it would exist without input, which made it play on a layer nobody was touching — "我鼠标都没有放进来，它自己就在中间一直生效". The rule: an effect that reacts to the pointer may only run while the pointer is over the layer (`state.inside`); a ring every 260ms while inside keeps it from looking dead when the mouse is held still, and the loop parks when it leaves. Visibility is a separate problem from causation, and solving the first by removing the second is not a fix. |
| **A decorative wave has a size, and "too small to see" and "too big" are the same dial.** | The ripple radius went 92px/s -> 190px/s chasing "基本看不见", which reached a ~300px radius and was reported as "水波太大了" — the ring grew wider than the face it was drawn over. It is 96px/s over a one-second life now, so it tops out near 96px and stays around the hand. Stroke weight and alpha carry visibility; the radius carries taste, and mixing the two is how the dial gets turned the wrong way. |
| **Listen for the pointer on the DOCUMENT, not on the layer that draws the effect.** | The listener was on `root`, which looks correct: the layer is full-screen and carries `pointer-events: auto`. But the layer also holds a full-bleed `dshsaver-catch` above it, so whether a `mousemove` reaches the layer depends on where the event lands — and measured on the running app it never did. The symptom was a mounted canvas with `pointerRunning: false` and `pointerStrokes: 0`: the loop had never started, because no event had ever arrived, while every other reading looked healthy. `document.addEventListener('mousemove', onMove)` plus a coordinate box test is immune to the ordering of children, and it works over the media, the catcher and the hint alike. **When an effect is driven by input, verify the input arrives before verifying the drawing.** |
| **A visible layer must not WAIT on the network before it finishes coming up.** | `show()` was `refreshLiveSettings().then(beginAppearance)`. That is a deadlock with a delay: `visible` is already true, so `tick()` never calls `show()` again, and if the fetch is slow or never settles the appearance never completes — the pointer decoration registers its listeners inside `beginAppearance`, so the effect simply does not exist. The reported symptom was intermittent and looked random: "这两次重启后屏保出现，鼠标特效就不生效了", the same build working on other runs. The layer is raised synchronously and the fetch only refreshes `CFG` for the NEXT read; `pointerEffect()` and `breakStyle()` resolve per use, so the newer values are picked up without anything blocking. **A function that makes a layer visible must finish the job before awaiting anything.** |
| **Alpha scaled by `presence` makes a self-started effect invisible.** | `presence` tracks whether the pointer is inside, which on an untouched screensaver is 0. Multiplying a ring's alpha by it left 0.17 — drawn, measured as non-zero pixels, and visually absent. |
| **The FIRST rAF tick can have a NEGATIVE `dt`, and integrating it kills the loop on frame one.** | `startLoop()` seeded `state.last` from `performance.now()`, which is a TIME-ORIGIN reading; a `requestAnimationFrame` callback is handed the FRAME-START timestamp instead, and that can precede the `performance.now()` that scheduled it — measured at `scheduledAt 181.0` / `frameTs 180.9`, a delta of -0.038ms. Every effect integrates `dt` into a size, and `tickRipples` does `g.r += 96 * dpr * dt`, so the first ring got a radius of -0.038 and `CanvasRenderingContext2D.arc()` **throws** on a negative radius. The throw left `tick` before it could schedule the next frame, so 水波涟漪 drew nothing at all — while `state()` still reported `pointerRunning: true`, `pointerStrokes: 0`, zero painted pixels. Clamping `dt` at 0 before the `|| 0.016` fallback fixes it. **A stub canvas accepts any radius, so every offline suite passed this** — only a real browser could see it, and the diagnostic that proved it was `pointerRunning: true` with `pointerStrokes: 0`, the same pair the pointer-listener bug produced. When an effect still draws nothing, instrument the canvas API and read the exception rather than guessing at alpha or density. |
| **A rotation must swap the media in place, not `hide()` + `show()`.** | Re-running the appearance would play the exit effect and re-mount the caption buttons, hint and pointer art — a dismissal nobody asked for. `rotateEntry()` takes a snapshot for the dissolve, releases the old renderer, sets `forcedEntryName`, calls `pickAndPlace()`, then cross-dissolves. It also avoids the entry currently on screen: with two clips, a plain random pick lands on the same one half the time and looks broken. **The order of those three steps is not arbitrary** — the snapshot needs the old pixels, and `pickAndPlace` only adds, so releasing later stacks two entries and releasing earlier loses the dissolve picture. |
| **An interval for switching content is when the switch becomes ALLOWED, not when it happens — and the switch itself must run from the `ended` event.** | Two wrong versions, and the second was subtler than the first. v1 swapped the moment the timer fired, cutting clips mid-phrase. v2 polled `currentTime()` from the timer and returned early if the clip was still playing — which is correct about causality and wrong about latency: with a 15s interval and a clip ending at 15.2s the switch lands at 30s, because the answer "close enough" only exists at the next tick. The user said exactly that: "当前播完再换，不是下次再检查". The due time now ARMS `renderer.onEnded(...)` and `rotateNow()` runs from that event, so the replacement begins on the last frame. The three-way answer still comes from the renderer's absences: no `onEnded` (a still, an animated image, a Live2D model) means there is nothing to wait for and the tick itself switches; `isEnded()` already true means the clip finished before the due time and the tick switches; otherwise the listener waits — but only for the entry it watched (`media === watched`), because a dismissed or replaced layer must not be switched by a stale callback. `rotationDue` is cleared by the switch and reset by `stopRotation`, so one period cannot switch twice and the next appearance does not start pre-armed. |
| **A cross dissolve of two pictures cannot be a CSS opacity ramp on the media element.** | The old entry stops existing as an element the moment the new one mounts, so there is nothing left to fade. The transition is a downsampled canvas snapshot of the old picture, appended above the media and below the catcher's z-index, ramped out over ~420ms. Three details are load-bearing: `pointer-events: none` or the full-screen canvas makes the layer undismissable; a `setTimeout` removal as well as the rAF ramp, because rAF does not run in a hidden window and the snapshot would sit at full opacity forever; and `prefers-reduced-motion` skips the fade entirely rather than shortening it. |
| **A `screensaver*` setting the page reads per appearance must come from `CFG`, not `config`.** | `installScreensaver` copies its options once, when the injected script first runs. A picker or an interval read from that copy ignores every later edit — the user switched 菱形涟漪 to 星屑吸附, the value was stored correctly, and the next appearance still drew diamonds. |
| **Saving the document is not the same as changing the running page — and patching a shared global is not a fix.** | `entry.js` injects `globalThis.__DSH_BOOT_ANIM_CFG__` ONCE, as a head row, and the screensaver reads every per-appearance setting from that object. A volatile field updates in place on the HOST, which is why "a settings edit needs no restart" was believed — but nothing carried the new value to the browser, and the desktop shell has no reload key. The first fix had the client card patch that object after each save (`pokeLiveConfig`). It does not work: whether the card and the injected script share one `globalThis` is a property of the host shell, not of this code. Observed directly — the document held `screensaverPointerEffect: ripples`, the card highlighted 水波涟漪, and `state()` still resolved `attract`. The authoritative value is now FETCHED: `entry.js` serves `/live-settings.json` from the live config (the same source the head row is built from), and `show()` refreshes `CFG` from it before anything resolves a style. One small GET per appearance, on a route the script already calls for its manifest. **A setting the page must act on has to be read from its owner, not copied into it.** |
| **Two field lists for one diagnostic is worse than none.** | `saverState()` (sent to the Host every 10s) and a hand-written `state:` literal (what a person or a test reads) both described the screensaver, and they drifted: the reported one grew `breakStyleRaw` / `pointerRaw` while the literal kept the old list. So every diagnosis through `__DSH_BOOT_ANIM_SCREENSAVER__.state()` was blind to WHICH effect the page was about to play, and "the setting never reached the page" was indistinguishable from "the page has it and draws the wrong thing". Four rounds of fixes were guesses because of this. `state()` now returns `saverState()`, and the object carries both spellings of the fields whose names had already diverged (`idleMs`/`thresholdMs`, `systemStatus`/`probeStatus`). **A diagnostic that cannot see the value it is asked about is a broken instrument, not a missing feature.** |
| **Do not cache the setting a user is about to look at.** | The live-settings refresh was given a 60s window to avoid re-requesting when the preview was flipped on and off. That window is exactly wrong for the one moment it matters: pressing 预览 is what a user does right AFTER changing a picker, so a cached answer is the value from before their edit. The route answers a few hundred bytes from the Host's own config, so there was nothing to save. It is fetched on every appearance now. **A cache in front of a control the user just touched is a bug with a delay.** |
| **"Mounted" and "drawing" are different facts, and only the second is visible.** | `pointerArtMounted` reported a canvas that existed, which read as healthy while the layer showed nothing — an effect can attach, run its loop, and put no strokes into the canvas (empty ring list, zero-size layer, a missing source). `state()` now also reports `pointerStrokes` (a running total incremented inside the effect) and `pointerRunning`, so "selected, attached, drawing nothing" cannot be confused with "drawing fine, and the user is looking at something else". |
| **A banner that says "reload to apply" for everything teaches the user to distrust the save.** | The card painted 已保存。刷新页面后生效 after every write, including the screensaver fields that had just been made live. The user's question — "为什么每次都要刷新，立即生效不行吗" — is the correct response to a message that is wrong most of the time. It now branches on a `LIVE_FIELDS` set: a screensaver field says it is already in effect, a boot field says the NEXT launch uses it (which is true — the Host rebuilds the head rows from the current document on every index render) and offers 刷新 only as "watch it now". The set is written in `src/client.js` and the route's field list in `entry.js`, so `verify-exit-effects.mjs` compares them rather than trusting them. **A status message must describe the actual mechanism, or it becomes noise the user has to learn to ignore.** |
| **An effect that IS drawing can still be invisible, and the fix is density and stroke, not alpha.** | 水波涟漪 was reported twice as "基本看不见" about code that measured as non-empty pixels. Two separate causes, both arithmetic: one ring per 1400ms whose life expired in 1.8s meant at most two rings were ever alive, each already faded; and a 1-2px stroke between 0.45 and 0.85 alpha disappears into real artwork. It now seeds a ring every 320ms (four or five alive), draws at 5.5px and 0.95 alpha, and eases the fade so the first half of the travel stays bright. The measurement that proves it is `painted pixels > 20000 && maxAlpha > 150` on a mid-tone picture — a black fixture makes any hairline read as bright and hides the problem. |
| **An exit effect must not paint its own background.** | `breakFall` filled the canvas with `#04060a` before drawing the pieces, "so the gaps read as depth". The gaps are the APP underneath, and a user who asked to see it got a black card dissolving instead of a screensaver breaking up. The canvas is created with no fill and only `clearRect` per frame; the pieces carry their own pixels and nothing else. The same is true of the other two — check for `fillRect(0, 0, width, height)` before adding anything to an effect. |
| **Every settings field the card edits must be marked `.volatile()`** — and the schema library that resolves beside this package must actually have the method. | `@deepseek-ai/dsh-settings` projects volatile fields and nothing else: a `Config` with none is not described at all, so the namespace is never served, the card's `whileServed` never fires, and the settings row is simply absent with no error. The 3.18.1 build linked next to a workspace checkout has no `.volatile()` at all — calling it would throw while `entry.js` is being evaluated; `LIVE_CAPABLE` probes for it and warns instead. |
| **Read a volatile config field through `.get()`, never directly.** | `.volatile()` puts a stable reference in the applied config, not the value. Reading it directly yields an object, every type guard falls through to the defaults, and the settings page looks like it does nothing at all — while the values it writes are stored correctly. |
| **Serve clips `cache-control: no-store`, always.** | The overlay aborts the media request when it replaces the element; anything cacheable stores a truncated body. The next normal reload decodes the fragment — and a clip with `moov` at the end has no index in a fragment, so it paints nothing. A hard reload hides it. `ETag`/`no-cache` does **not** fix this: an ETag only ever claims the file has not changed, never that the copy in hand is complete. |
| **A clip's first frame must be evidenced by decoded data** (`readyState >= 2`, `loadeddata`, `canplay`, advancing time) — **not** by `requestVideoFrameCallback` alone. | The element starts at `opacity: 0` and reveal is what makes it visible, so waiting for a *composited* frame waits on the style change it is itself blocking. The screen locks on the gradient. |
| **A resolved `play()` promise is not a picture.** Keep the 6-second retry armed until a frame is really there. | A clip that starts and never paints leaves the gradient up forever, with no error and no next attempt. |
| **`faststart.mjs` must assert the RESULT** — that the output has `moov` before `mdat`. | It was written checking only the *plan* and its own payload proof, both of which are vacuously true for a file that did not move. It reported success for two sessions while writing byte-identical copies, so "I remuxed it" changed nothing. |
| **Strip comments before any regex assertion on an artifact.** | The bundles are comment-preserving concatenations, so prose explaining an old approach is matched as if it were the approach. This happened twice. |
| **The exit's audio fade must reuse the exit's own `span`** — plus `AUDIO_GRACE_MS` only for a clip that is detached and still playing, whose stop deadline stays `span + 1300`. | A fixed fade duration drifts away from a tail dissolve, whose span is the clip's remaining time; and handing the grace to the tail path leaves the track audible after the clip itself has ended. |
| **Do not hardcode a user asset's name in a test.** Read it from the manifest. | The clips get renamed; the suite then fails for a reason that has nothing to do with the code. |
| **Do not `spawnSync` with piped stdio.** Import the module and call the function. | The agent sandbox refuses a child process whose output is captured through a pipe (`EPERM`). `stdio: 'inherit'` works, which is how the author's aggregator spawns its children. |
| **Suites must be runnable together** — no interactive prompts, no fixed ports. | A suite that only passes alone is a defect in the suite. |
| **A PowerShell statement that ends in `+` does not continue onto the next line.** | `$x = 'a' + $y` is already complete, so a following line starting with `+` is parsed as a *unary* plus, throws at runtime, and — under `$ErrorActionPreference = 'Continue'` — the throw is swallowed. The value is then half-built and nothing says so: a split regex assembled this way matched the wrong block and returned a plausible count. One complete statement per line. |
| **The install/uninstall pair edits the patch layer as BYTES, and accounts for them before writing.** | `ReadAllLines`/`WriteAllLines` normalises every terminator, so "the row was removed" came with a whole-file rewrite. `ReadAllText`/`WriteAllText` keeps every other byte as it was; the byte total is asserted before the write, and the one case that cannot round-trip (a layer with no final newline) is stated rather than claimed away. |

## Change → restart matrix

| Changed | To see it |
|---|---|
| `src/boot-screen.js` | **Reload the page.** The Host re-reads this file on every index render, so a plain F5 is enough and no restart is needed. |
| `src/screensaver.js` | **Reload the page.** Re-read on every index render, same as the boot screen. |
| `entry.js` (routes, settings schema, injected rows) | **Restart DSH.** The running process holds the old module. |
| `src/idle-probe.js` | **Restart DSH.** It is imported by `entry.js`, so it is part of the Host module graph, not a file re-read per render. |
| `src/client.js` | Rebuild (`node build-client.mjs`), then reload; if the change does not appear, restart — the initial bundle revision is allocated per process. |
| `src/renderers.js` | **Reload the page.** Injected as a head row, re-read per render; both the boot screen and the screensaver build their media through it. |
| `assets/videos/*` | Reload. The manifest is read per request and clip URLs carry a content revision. |
| `assets/screensaver/*` | Reload. Same manifest-per-request rule as the boot pool. |

Installed state: the package is linked into a DSH profile
(`<profile>/node_modules/dsh-boot-animation` → this directory) with a one-row
`- insert:` block in the profile's `cordis.patch.yml`. `package.json` is not
modified and no `pnpm install` runs. The pair that does this — `tools/install.ps1`
(Windows) and `tools/install.sh` (macOS / Linux), each with its own `uninstall.*`
— **ships in this tree**, so the link does not have to be made by hand. The profile
to name is the one DSH actually runs (`desktop` for the desktop app, `web` for
`dsh web`), not the script's default.

One thing the link does **not** provide: `@deepseek-ai/schemastery`. The Host half
imports it statically, so it must resolve from this directory — normally that is
`node_modules/@deepseek-ai/schemastery`, and it must be the copy the kernel loads
(>= 3.18.4, the one with `.volatile()`), not the older build that sits beside a
workspace checkout. When it is missing or too old, the plugin still boots and the
settings card does not; `apply` warns with exactly that sentence.

## Verifying a change

**The suites that are IN this tree, and run right now:**

```sh
node build-client.mjs            # only if src/client.js changed
node tools/verify-pools.mjs      # Host half: both pool manifests, their byte routes, and the whole route table
node tools/verify-encoding.mjs   # UTF-8 with no BOM, CJK intact, the injected screen has no </script
node tools/verify-icon-route.mjs # the card's icon route and its whitelist
node tools/verify-client-card.mjs # the settings card, against a stub DOM
node tools/verify-exit-effects.mjs # the screensaver's exit effects, styles, pointer decoration and LIVE readers
```

Those five run offline with no DSH process, no ports and no prompts, and each one
creates and removes its own staging directory. `verify-pools.mjs` mounts the REAL
`apply()` from a scratch copy of the package and drives the registered routes over
real HTTP, so a route that answers the wrong thing fails there rather than in a
browser. `verify-exit-effects.mjs` is the one that compares `src/client.js`'s
`LIVE_FIELDS` against `entry.js`'s live-settings route, and that asserts every one
of those nine fields is read from the `CFG` global at the decision site that consumes
it — the check that catches "the setting was saved and the layer ignored it".

**The suites named below are NOT in this tree.** They belong to the author's working
copy, and the commands are kept here only so the history in
[README.md](README.md) stays readable:

```sh
node verify/verify-entry.mjs      # (not in this tree)
node verify/verify-degraded.mjs   # (not in this tree)
node verify/verify-options.mjs    # (not in this tree)
node verify/verify-renderers.mjs  # (not in this tree)
node verify/verify-screensaver.mjs # (not in this tree)
```

What those five covered, and what covers it here instead: `verify-entry.mjs` and
`verify-degraded.mjs` covered the Host half — `tools/verify-pools.mjs` does that now,
though it does NOT re-implement the settings service's predicates and does not
exercise the "schema library without `.volatile()`" path at all, so the degradation
behaviour is currently unproven in this tree. `verify-options.mjs` ran
`src/boot-screen.js` itself in a minimal DOM, because the screen is a script text and
a grep for `cfg.sound` would pass on a file that greps it and ignores it;
`verify-renderers.mjs` did the same for the media factory and asserted the ABSENCES
(no `duration`, no `onEnded`, no audio) that route each kind through the right bound.
Neither has a replacement here — the closest is `tools/verify-exit-effects.mjs`, which
does read `src/screensaver.js` rather than only grepping it, but it does not run the
boot screen. `verify-screensaver.mjs` covered the screensaver's two triggers, its
dismissal semantics (movement is activity but NOT dismissal), the hidden-window
decline and its break-free retreat, the three-state idle route, and the break effect;
`tools/verify-exit-effects.mjs` covers the effects and the live readers,
`tools/verify-pools.mjs` covers the idle route's three states, and the triggers and
dismissal semantics are unproven offline here.

**What none of them can prove: that a picture appears.** A renderer that returns an
element nobody can decode passes every offline check. `tools/verify-browser.mjs`
*(not in this tree)* is the only check that mounts the real Host routes and the real
injected rows and lets a real browser decode real bytes — it has already caught
defects that no stub could (a clip that did not loop, a reveal that landed on the
child instead of the layer, and a screensaver whose media was held invisible by the
boot screen's own CSS). Its modes, for reference:

| Harness mode | What it does |
|---|---|
| (no query) | The plain boot path: the real screen runs |
| `?mode=preview&name=<entry>&pool=<pool>` | Renders one named entry full-screen, the way the card's 预览 does |
| `?mode=app` | Takes the boot overlay OUT of the DOM, which is the state after hand-over — and the only way to see the screensaver, because it deliberately stands down while that overlay is up |
| `?adapter=stub` | Installs a stub Live2D adapter, so a model can be exercised without the proprietary runtime |
| `--screensaver <ms>` | Mounts with the screensaver ON at that threshold. Without it the screensaver is off, which is its default, so the harness would never exercise it |

`?mode=idle` and the boot-wait idle layer it exercised are **gone** with the layer.

The wider `verify-*` set and the `verify-all.mjs` aggregator named in
[README.md](README.md) also belong to the author's working copy and are **not** in
this tree.

**What `tools/` holds here — nine files, all present: the five verify suites, then
the four installers.**

| Tool | What it is for |
|---|---|
| `tools/verify-pools.mjs` | Mounts the real `apply()` from a scratch copy and drives every registered route over real HTTP: both pool manifests, the byte prefixes and every media kind, containment, Range, and the auxiliary routes. Route assertions are by IDENTITY (kind + path), never by count, so adding a route cannot turn it red. |
| `tools/verify-encoding.mjs` | Byte-level integrity of the package's own text sources: no invalid UTF-8, no BOM, the user-facing Chinese still present, no `</script` in the injected screen. This is the check the PowerShell lesson above is verified with. |
| `tools/verify-icon-route.mjs` | The card's icon route and its file-name whitelist. |
| `tools/verify-client-card.mjs` | The settings card against a stub DOM: the controls, their labels and their write paths. |
| `tools/verify-exit-effects.mjs` | The screensaver's three exit effects, the style and pointer pickers, the teardown order, the cross dissolve, and — the load-bearing part — that all nine `LIVE_FIELDS` are read from the live `CFG` global at the decision site that consumes them, not from the install-time `config` snapshot. |
| `tools/install.ps1` / `install.sh` | Link the package into a DSH profile and append the patch row, without touching `package.json` or running pnpm. See `INSTALL.md`. |
| `tools/uninstall.ps1` / `uninstall.sh` | The exact reverse: remove the row they own and the link, asserting `cordis.patch.yml` comes back byte-identical. |

**The media tooling named in the rest of this document is NOT here.** These are in
the author's working copy only, and no command in this tree runs them:
`tools/apply-faststart.mjs` / `.bat`, `tools/faststart.mjs` (the lossless `moov` move
and its driver — the in-process copy of that rewrite that ships here is
`src/remux.js`, behind the card's 优化 button), `tools/box-chain.mjs`,
`tools/mp4-info.mjs`, `tools/mp4-audit.mjs`, `tools/codec-report.mjs`,
`tools/preview.mjs`, `tools/verify-browser.mjs`.

**The install pair DOES ship here** — `tools/install.ps1` / `tools/uninstall.ps1` /
`tools/install.sh` / `tools/uninstall.sh`, documented in `INSTALL.md`. Its contract:
both name the profile the running DSH uses (`desktop`, not the `web` default), both
must leave `cordis.patch.yml` byte-identical except for the row they own — UTF-8,
no BOM, CJK intact — and `install.ps1`'s last step only *reports* whether a dsh
server answered; it does not repair, and it does not roll back on a port it could
not reach.

For a Host-half change the offline proof that matters is that the module still
evaluates, still exports the schema the settings service looks for, and still
injects the same four head rows (config, renderers, screensaver, boot screen — in
that order):

```sh
node --check entry.js
node -e "import('./entry.js').then(m => console.log(Object.keys(m), m.Config.toJSON()))"
```

[`verify/verify-entry.mjs`](verify/verify-entry.mjs) *(not in this tree)* does exactly
that with a stub Host context and re-implementations of the settings service's own
predicates; [`verify/verify-degraded.mjs`](verify/verify-degraded.mjs) *(not in this
tree)* proves the same module still evaluates when the resolved schema library lacks
`.volatile()`. The nearest check that IS here is `tools/verify-pools.mjs`, which calls
the real `apply()` with a stub context and drives the routes it registers — it covers
the "still evaluates and still registers" half, and not the schema predicates.

## When someone reports something

| Report | Look at | Most likely |
|---|---|---|
| "Only the background shows" | The hint line (it names the failed clip and reason), then the card's pool rows | A clip that never paints. The loader skips it after 6s and says so. |
| "It works after a hard reload but not a normal one" | Response headers on the clip route | Something became cacheable. It must all be `no-store`. |
| "No card in Settings" | Console for `boot-animation:` warnings | The `Config` schema was not resolved, no field is volatile (`volatileForm()` drops the entry), or the patch `id` and `SETTINGS_NAMESPACE` disagree. The warning names the first case outright. |
| "No sound" | The audio-policy path in `toggleSound` / `startClip`, then the card's **播放影片声音** switch | Expected until the first click; Chromium will not autoplay unmuted. Confirm the hint says 开声音 — with the switch off there is deliberately no sound hint and no button. |
| "The sound drags on after the picture is gone" or "the audio cuts off mid-phrase on the way out" | `fadeOutClipAudio` and the span `enter()` computed | The ramp is not running: the element was already paused/ended (nothing left to fade), it is muted (nothing audible), or the overlay was removed before the ramp finished. |
| "It never enters" | The bound table in README ("启动路径上每个走不下去的地方都有上界") | Every route has a bound; if one fired, the hint line says which. |
| "A new clip does not play" | The card's badges | `未优化` → press the card's 优化 button (it runs `src/remux.js` in process). The older `tools/apply-faststart.bat` did the same rewrite from a shell, and is *(not in this tree)*. |
| "The screensaver never appears" | `__DSH_BOOT_ANIM_SCREENSAVER__.state()` — it reports `blockedBy`, the threshold, both idle readings and the probe's `systemStatus` | Almost always one of: it is **off by default**; the threshold has not elapsed; the boot overlay is still up (`blockedBy: 'boot-overlay'`); or the OS probe is `unavailable` and the user has not blurred the window. The state call is what separates these, because all four look identical on screen. |
| "The screensaver will not go away when I move the mouse" | `hide()` and the dismissal listeners | **By design.** Movement is activity, not dismissal — only a click or a key hides it. The hint line says so. |
| "The screensaver is black / shows nothing" | The pool's manifest, then the media element's computed `opacity` | Most likely an empty `assets/screensaver/`, or a Live2D entry with no adapter installed. If the element has size but no pixels, check the CSS ordering note in the reveal rule above. |

## House rules for this package

- Comments and docs are English; user-facing copy inside the plugin is Chinese.
- Every tool under `tools/` is named in a root document; the table above is that
  list. It names all nine files that exist here — five verify suites and four
  installers — and marks the author's working-copy tooling as absent, so the list
  and the tree agree. (The author's working copy enforces the rule with a
  `verify-tree-hygiene.mjs` suite, which is not part of this tree.)
- Generated `.ps1` / `.bat` / `.cmd` are **pure ASCII** — content, not filename.
  This covers the probe script inside `src/idle-probe.js`, which is piped to
  PowerShell as a command: a CJK byte in it would be decoded as the system code
  page and break the parser.
- The user's own clips are the only media the boot pool should hold; rewrites keep
  their originals in `assets/videos/originals/`, which the pool ignores because it
  lists regular files only. The screensaver pool follows the same rule under
  `assets/screensaver/originals/`.
