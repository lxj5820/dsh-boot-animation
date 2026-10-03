# AGENTS.md — dsh-boot-animation

Maintainer briefing. Written for whoever (or whatever) picks this up next: what the
package is, which two facts about DSH it depends on, the invariants that break it
silently, and how to prove a change is safe.

> **Porting note (DSH 0.2.0-rc.2).** The Host settings contract changed: a plugin
> no longer *registers* a settings namespace, it *declares* `Config`. Everything
> below reflects that. The `verify-*` suites this file names belong to the
> author's working copy and do **not** ship with this package — see
> [Verifying a change](#verifying-a-change) for what can be run here.

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
| **Never read/write a CJK-bearing source file with PowerShell.** Use the file tools; verify with Node `readFileSync(..., 'utf8')`. | PowerShell 5.1 decodes BOM-less UTF-8 as GBK, and a `Set-Content` round-trip destroys every Chinese character — once collapsed `'…'` into `鈥?` and broke the script. |
| **No backtick anywhere inside a CSS blob** (the screen's `style()` string, the card's `CSS` string). | The string ends early and the build keeps the *previous* artifact. It looks like the change had no effect. |
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
node build-client.mjs      # only if src/client.js changed
```

The `verify-*` suites and the `verify-all.mjs` aggregator belong to the author's
working copy and are **not part of this tree** (the banner at the top of
[README.md](README.md) says the same). What `tools/` holds here is the media and
preview tooling:

| Tool | What it is for |
|---|---|
| `tools/apply-faststart.mjs` / `.bat` | Plan or perform the lossless `moov` move; backs the original up under `assets/videos/originals/` |
| `tools/faststart.mjs` | The rewrite itself, driven by the two above |
| `tools/box-chain.mjs` | Top-level box order of every clip in the pool |
| `tools/mp4-info.mjs` | Duration and resolution, read from `mvhd` / `tkhd` |
| `tools/mp4-audit.mjs` | Whether each clip's index actually points into its own `mdat` |
| `tools/codec-report.mjs` | The video codec fourcc per clip |
| `tools/preview.mjs` | Local two-server preview of the injection, without restarting DSH |
| `tools/install.ps1` / `tools/install.sh` and their `uninstall.*` | Add or remove the profile link and the patch row |

For a Host-half change the offline proof that matters is that the module still
evaluates, still exports the schema the settings service looks for, and still
injects the same two head rows:

```sh
node --check entry.js
node -e "import('./entry.js').then(m => console.log(Object.keys(m), m.Config.toJSON()))"
```

`verify-entry.mjs` and `verify-degraded.mjs` from the porting session (kept in the
workspace copy of this package, not here) do exactly that with a stub Host context
and re-implementations of the settings service's own predicates.

## When someone reports something

| Report | Look at | Most likely |
|---|---|---|
| "Only the background shows" | The hint line (it names the failed clip and reason), then the card's pool rows | A clip that never paints. The loader skips it after 6s and says so. |
| "It works after a hard reload but not a normal one" | Response headers on the clip route | Something became cacheable. It must all be `no-store`. |
| "No card in Settings" | Console for `boot-animation:` warnings | The `Config` schema was not resolved, no field is volatile (`volatileForm()` drops the entry), or the patch `id` and `SETTINGS_NAMESPACE` disagree. The warning names the first case outright. |
| "No sound" | The audio-policy path in `toggleSound` / `startClip` | Expected until the first click; Chromium will not autoplay unmuted. Confirm the hint says 开声音. |
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
