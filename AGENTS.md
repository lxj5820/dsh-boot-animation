# AGENTS.md — dsh-boot-animation

Maintainer briefing. Written for whoever (or whatever) picks this up next: what the
package is, which two facts about DSH it depends on, the invariants that break it
silently, and how to prove a change is safe.

> **Porting note (DSH 0.2.0-rc.2).** The Host settings contract changed: a plugin
> no longer *registers* a settings namespace, it *declares* `Config`. Everything
> below reflects that. The wide `verify-*` set the README names belongs to the
> author's working copy; what actually ships here is the three suites under
> [`verify/`](verify/) — see [Verifying a change](#verifying-a-change).

Human-facing usage lives in [MANUAL.md](MANUAL.md). The long forensic record —
every bug, why it happened, what the evidence was — is [README.md](README.md).
Read this file first; go to README only for the history of a specific symptom.

## What it is

A DSH plugin that replaces the kernel's boot page with a full-window video clip,
then dissolves into the app. No DSH source is modified: it injects a script into
`<head>` ahead of the shell, and contributes a card to Settings → Plugins.

| Half | File | Job |
|---|---|---|
| Host (Node) | `entry.js` | Serves clips over HTTP with Range, declares the `Config` schema the settings namespace is derived from, injects the pre-boot screen into the index |
| Browser (pre-boot) | `src/boot-screen.js` | The overlay itself: framework-free, injected as text, must run before the shell |
| Browser (plugin) | `src/client.js` → `lib/client.js` | Reports activation to the overlay, and renders the settings card |

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
| **Never read/write a CJK-bearing file with PowerShell** — source, data or the user's config alike. Use the file tools; verify with Node `readFileSync(..., 'utf8')`. | PowerShell 5.1 decodes BOM-less UTF-8 as GBK, and a `Set-Content` round-trip destroys every Chinese character — once collapsed `'…'` into `鈥?` and broke the script. The same rule covers files this package does not own: `cordis.patch.yml` carries a provider `displayName`, and the `Get-Content`/`Set-Content` pair in `tools/uninstall.ps1` turned it into mojibake and added a BOM. When a `.ps1` genuinely must rewrite such a file, go through .NET — `[System.IO.File]::ReadAllText($p, $utf8NoBom)` / `WriteAllText($p, $text, $utf8NoBom)` with `New-Object System.Text.UTF8Encoding($false)` — because on 5.1 `Set-Content -Encoding utf8` means *UTF-8 with BOM*, which is still a change to a file that is not the script's to change. **Not `ReadAllLines`/`WriteAllLines`:** `WriteAllLines` terminates every line with `[Environment]::NewLine`, so an LF layer came back all-CRLF — a whole-file rewrite reported as a byte-identical round-trip. |
| **A step that only checks must not repair.** | `tools/install.ps1`'s last step guesses which port dsh is on; when the guess missed it reported FAILED and rolled back a fully working install. A check that cannot tell "broken" from "not measured" has to say which one it is and leave the state alone. |
| **No backtick anywhere inside a CSS blob** (the screen's `style()` string, the card's `CSS` string). | The string ends early and the build keeps the *previous* artifact. It looks like the change had no effect. |
| **An attribute selector with a numeric value must quote it** — `[data-hint="0"]`, never `[data-hint=0]`. | An unquoted value must be a CSS identifier, and one starting with a digit is not, so Chrome drops the ENTIRE rule without a word. The switch looks wired and does nothing. `[data-shown=1]` and both `[data-attention=1]` rules in this package had never applied (only the inline `style.opacity` in `reveal()` hid it). `verify/verify-options.mjs` asserts it with a regex, comments stripped first. |
| **A scratch-copy suite must copy with `dereference: true`.** | Installed, `node_modules/@deepseek-ai/schemastery` is a symlink; `cpSync(..., { recursive: true })` preserves it, so the scratch tree points back at the real library. `verify-degraded.mjs`'s "rename `.volatile()` away" then rewrote the INSTALLED schemastery and silently disarmed every settings card in the deployment. The suites now copy real files and assert the scratch is not a link before rewriting. |
| **Read optional services with `ctx.inject([...], (owner) => owner.get(name))`.** Never `ctx.get(name)`. | `ctx.get` is a one-shot read that races activation and silently answers `undefined`; the card then never registers and there is no error anywhere. Every other client plugin in the deployment uses the `ctx.inject` form. |
| **The client half declares no `inject`.** | A required service leaves the fiber PENDING in a profile that lacks it, `apply` never runs, `clientReady` is never sent, and the animation refuses to hand over. |
| **Every settings field the card edits must be marked `.volatile()`** — and the schema library that resolves beside this package must actually have the method. | `@deepseek-ai/dsh-settings` projects volatile fields and nothing else: a `Config` with none is not described at all, so the namespace is never served, the card's `whileServed` never fires, and the settings row is simply absent with no error. The 3.18.1 build linked next to a workspace checkout has no `.volatile()` at all — calling it would throw while `entry.js` is being evaluated; `LIVE_CAPABLE` probes for it and warns instead. |
| **Read a volatile config field through `.get()`, never directly.** | `.volatile()` puts a stable reference in the applied config, not the value. Reading it directly yields an object, every type guard falls through to the defaults, and the settings page looks like it does nothing at all — while the values it writes are stored correctly. |
| **Serve clips `cache-control: no-store`, always.** | The overlay aborts the media request when it replaces the element; anything cacheable stores a truncated body. The next normal reload decodes the fragment — and a clip with `moov` at the end has no index in a fragment, so it paints nothing. A hard reload hides it. `ETag`/`no-cache` does **not** fix this: an ETag only ever claims the file has not changed, never that the copy in hand is complete. |
| **A clip's first frame must be evidenced by decoded data** (`readyState >= 2`, `loadeddata`, `canplay`, advancing time) — **not** by `requestVideoFrameCallback` alone. | The element starts at `opacity: 0` and reveal is what makes it visible, so waiting for a *composited* frame waits on the style change it is itself blocking. The screen locks on the gradient. |
| **A resolved `play()` promise is not a picture.** Keep the 6-second retry armed until a frame is really there. | A clip that starts and never paints leaves the gradient up forever, with no error and no next attempt. |
| **`faststart.mjs` must assert the RESULT** — that the output has `moov` before `mdat`. | It was written checking only the *plan* and its own payload proof, both of which are vacuously true for a file that did not move. It reported success for two sessions while writing byte-identical copies, so "I remuxed it" changed nothing. |
| **Strip comments before any regex assertion on an artifact.** | The bundles are comment-preserving concatenations, so prose explaining an old approach is matched as if it were the approach. This happened twice. |
| **Do not hardcode a user asset's name in a test.** Read it from the manifest. | The clips get renamed; the suite then fails for a reason that has nothing to do with the code. |
| **Do not `spawnSync` with piped stdio.** Import the module and call the function. | The agent sandbox refuses a child process whose output is captured through a pipe (`EPERM`). `stdio: 'inherit'` works, which is how the author's aggregator spawns its children. |
| **Suites must be runnable together** — no interactive prompts, no fixed ports. | A suite that only passes alone is a defect in the suite. |
| **A PowerShell statement that ends in `+` does not continue onto the next line.** | `$x = 'a' + $y` is already complete, so a following line starting with `+` is parsed as a *unary* plus, throws at runtime, and — under `$ErrorActionPreference = 'Continue'` — the throw is swallowed. The value is then half-built and nothing says so: a split regex assembled this way matched the wrong block and returned a plausible count. One complete statement per line. |
| **The install/uninstall pair edits the patch layer as BYTES, and accounts for them before writing.** | `ReadAllLines`/`WriteAllLines` normalises every terminator, so "the row was removed" came with a whole-file rewrite. `ReadAllText`/`WriteAllText` keeps every other byte as it was; the byte total is asserted before the write, and the one case that cannot round-trip (a layer with no final newline) is stated rather than claimed away. |

## Change → restart matrix

| Changed | To see it |
|---|---|
| `src/boot-screen.js` | **Reload the page.** The Host re-reads this file on every index render, so a plain F5 is enough and no restart is needed. |
| `entry.js` (routes, settings schema, injected rows) | **Restart DSH.** The running process holds the old module. |
| `src/client.js` | Rebuild (`node build-client.mjs`), then reload; if the change does not appear, restart — the initial bundle revision is allocated per process. |
| `assets/videos/*` | Reload. The manifest is read per request and clip URLs carry a content revision. |

Installed state: the package is linked into a DSH profile
(`<profile>/node_modules/dsh-boot-animation` → this directory) with a one-row
`- insert:` block in the profile's `cordis.patch.yml`. `package.json` is not
modified and no `pnpm install` runs. `tools/install.ps1` (Windows) and
`tools/install.sh` (macOS / Linux) do it, and each one's `uninstall.*` reverses
it. The profile to name is the one DSH actually runs (`desktop` for the desktop
app, `web` for `dsh web`), not the script's default.

One thing the link does **not** provide: `@deepseek-ai/schemastery`. The Host half
imports it statically, so it must resolve from this directory — normally that is
`node_modules/@deepseek-ai/schemastery`, and it must be the copy the kernel loads
(>= 3.18.4, the one with `.volatile()`), not the older build that sits beside a
workspace checkout. When it is missing or too old, the plugin still boots and the
settings card does not; `apply` warns with exactly that sentence.

## Verifying a change

```sh
node build-client.mjs          # only if src/client.js changed
node verify/verify-entry.mjs   # Host half: Config, injection, manifest route
node verify/verify-degraded.mjs # the old-schema-library degradation path
node verify/verify-options.mjs  # the three interaction switches, against a stub DOM
```

`verify/` **is** part of this tree, and those three suites are what it can run
offline with no DSH process, no ports and no prompts. `verify-entry.mjs` and
`verify-degraded.mjs` cover the Host half; `verify-options.mjs` runs
`src/boot-screen.js` itself in a minimal DOM, because the screen is a script text
and a grep for `cfg.sound` would pass on a file that greps it and ignores it.

The wider `verify-*` set and the `verify-all.mjs` aggregator named in
[README.md](README.md) belong to the author's working copy and are **not** in this
tree. What `tools/` holds here is the media and preview tooling:

| Tool | What it is for |
|---|---|
| `tools/apply-faststart.mjs` / `.bat` | Plan or perform the lossless `moov` move; backs the original up under `assets/videos/originals/` |
| `tools/faststart.mjs` | The rewrite itself, driven by the two above |
| `tools/box-chain.mjs` | Top-level box order of every clip in the pool |
| `tools/mp4-info.mjs` | Duration and resolution, read from `mvhd` / `tkhd` |
| `tools/mp4-audit.mjs` | Whether each clip's index actually points into its own `mdat` |
| `tools/codec-report.mjs` | The video codec fourcc per clip |
| `tools/preview.mjs` | Local two-server preview of the injection, without restarting DSH |
| `tools/install.ps1` / `tools/uninstall.ps1` | Add or remove the profile link and the patch row. Both name the profile the running DSH uses (`desktop`, not the `web` default) and both must leave `cordis.patch.yml` byte-identical except for the row they own — UTF-8, no BOM, CJK intact. `install.ps1`'s last step only *reports* whether a dsh server answered; it does not repair, and it does not roll back on a port it could not reach. |
| `tools/install.sh` / `tools/uninstall.sh` | The macOS / Linux twins of the pair above: same two changes, same backup, same UTF-8-safe line handling, plus a schema-version probe (≥ 3.18.4 with `.volatile()`). |b1349df (Add macOS/Linux install support (tools/install.sh + tools/uninstall.sh))

For a Host-half change the offline proof that matters is that the module still
evaluates, still exports the schema the settings service looks for, and still
injects the same two head rows:

```sh
node --check entry.js
node -e "import('./entry.js').then(m => console.log(Object.keys(m), m.Config.toJSON()))"
```

[`verify/verify-entry.mjs`](verify/verify-entry.mjs) does exactly that with a stub
Host context and re-implementations of the settings service's own predicates;
[`verify/verify-degraded.mjs`](verify/verify-degraded.mjs) proves the same module
still evaluates when the resolved schema library lacks `.volatile()`.

## When someone reports something

| Report | Look at | Most likely |
|---|---|---|
| "Only the background shows" | The hint line (it names the failed clip and reason), then the card's pool rows | A clip that never paints. The loader skips it after 6s and says so. |
| "It works after a hard reload but not a normal one" | Response headers on the clip route | Something became cacheable. It must all be `no-store`. |
| "No card in Settings" | Console for `boot-animation:` warnings | The `Config` schema was not resolved, no field is volatile (`volatileForm()` drops the entry), or the patch `id` and `SETTINGS_NAMESPACE` disagree. The warning names the first case outright. |
| "No sound" | The audio-policy path in `toggleSound` / `startClip`, then the card's **播放影片声音** switch | Expected until the first click; Chromium will not autoplay unmuted. Confirm the hint says 开声音 — with the switch off there is deliberately no sound hint and no button. |
| "It never enters" | The bound table in README ("启动路径上每个走不下去的地方都有上界") | Every route has a bound; if one fired, the hint line says which. |
| "A new clip does not play" | The card's badges | `未优化` → run `tools/apply-faststart.bat`. |

## House rules for this package

- Comments and docs are English; user-facing copy inside the plugin is Chinese.
- Every tool under `tools/` is named in a root document; the table above is that
  list. (The author's working copy enforces it with a `verify-tree-hygiene.mjs`
  suite, which is not part of this tree.)
- Generated `.ps1` / `.bat` / `.cmd` are **pure ASCII** — content, not filename.
- The three user clips are the only media the pool should hold; rewrites keep their
  originals in `assets/videos/originals/`, which the pool ignores because it lists
  regular files only.
