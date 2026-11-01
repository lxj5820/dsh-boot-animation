// System-level idle time, for the screensaver's inactivity trigger.
//
// Why the Host half owns this: a renderer can only see input that reaches ITS OWN
// window. "Has the user touched the computer at all" is an operating-system fact, and
// the OS has been recording it the whole time — `GetLastInputInfo` on Windows, which
// is what Electron's `powerMonitor` wraps. The plugin cannot reach `powerMonitor`
// (the desktop app runs the harness as a CHILD Node process, with no Electron
// bindings), so it reads the same underlying counter directly.
//
// How: ONE long-lived child that prints a value on a timer, and a cache this module
// reads. The alternative — spawning a process per request — costs ~200ms of process
// creation each time, and this is polled every few seconds; the child costs one
// syscall per tick (measured at 0.051ms).
//
// Nothing here starts until the first read. A profile with the screensaver switched
// off never asks, so it never pays for a child process, and the child is killed when
// the plugin unloads.
//
// Windows only, and honestly so: `GetLastInputInfo` has no cross-platform twin, and
// inventing one for macOS/Linux without being able to test it would be a guess
// presented as a feature. Elsewhere `read()` answers `undefined`, and the screensaver
// falls back to the window-focus trigger alone — which is a real degradation rather
// than a silent failure.

import { spawn, spawnSync } from 'node:child_process'

/**
 * The probe script. Pure ASCII, per this package's rule for generated scripts: the
 * text is piped to PowerShell as a command, and a CJK byte in a comment is enough to
 * break a parser that decodes it as the system code page.
 */
const PROBE_SCRIPT = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class DshIdleProbe {',
  '    [StructLayout(LayoutKind.Sequential)]',
  '    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
  '    [DllImport("user32.dll")]',
  '    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
  '    public static long Ms() {',
  '        LASTINPUTINFO lii = new LASTINPUTINFO();',
  '        lii.cbSize = (uint)Marshal.SizeOf(lii);',
  '        if (!GetLastInputInfo(ref lii)) return -1;',
  '        return (long)((uint)Environment.TickCount - lii.dwTime);',
  '    }',
  '}',
  '"@',
  'while ($true) {',
  '    Write-Output ("DSHIDLE " + [DshIdleProbe]::Ms())',
  '    Start-Sleep -Milliseconds 1000',
  '}',
].join('\n')

/** How long a reading stays usable. The child ticks every second; this allows for a
 *  few missed ticks before the value is treated as unknown rather than stale. */
const READING_TTL_MS = 5000

/** How long to wait for the child to produce its first line before giving up. */
const FIRST_LINE_TIMEOUT_MS = 8000

/**
 * How long to wait before trying again after a failure.
 *
 * A failure is rarely permanent — a child can fail to spawn under load, or die hours in —
 * so giving up for the rest of the session is the wrong default. Long enough that a machine
 * which genuinely cannot run the probe is not spawning a process every few seconds, short
 * enough that a transient failure repairs itself within a poll or two.
 */
const RETRY_MS = 30000

/**
 * Every probe that has a live child, so process exit can reap them all.
 *
 * The disposer is not guaranteed to run — measured on a real machine, a DSH restart left
 * the previous probe alive holding ~110MB, with a parent pid that no longer existed. So a
 * single exit hook covers every probe in the process, and it is registered ONCE at module
 * load rather than per child: a hook registered per spawn would accumulate one closure per
 * retry, which is a leak of its own.
 */
const liveProbes = new Set()

function reapAll() {
  for (const probe of liveProbes) {
    try {
      const pid = probe.childPid()
      if (pid === null) continue
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      }
    } catch (error) {
      /* the child may already be gone */
    }
  }
  liveProbes.clear()
}

if (process.platform === 'win32') {
  process.once('exit', reapAll)
}

/**
 * A lazily-started system idle probe.
 *
 * @param options - `{ logger, intervalMs }`. `logger` is the Host context's, used to
 *   report why the probe is unavailable rather than failing silently.
 */
export function createIdleProbe(options = {}) {
  const logger = options.logger
  const supported = process.platform === 'win32'

  let child = null
  let buffer = ''
  let reading = null
  /**
   * The reason the probe is PERMANENTLY unavailable — a platform without the API.
   * Distinct from `lastFailure`, which is a transient reason a retry may clear.
   */
  let unavailable = supported ? null : `platform ${process.platform}`
  /** Why the most recent attempt failed, kept for the diagnostics line. */
  let lastFailure = null
  /** When the next attempt is allowed, so a failing probe backs off instead of looping. */
  let nextAttemptAt = 0
  let starting = null
  let disposed = false

  /** Kill the child, if there is one. Safe to call repeatedly. */
  function stop() {
    if (child === null) return
    const dying = child
    child = null
    // `kill()` on Windows terminates only the process it names, and PowerShell may have
    // spawned children of its own. A survivor is not harmless: each one holds ~110MB, and
    // measured on a real machine two were alive at once — started eight minutes apart,
    // because a DSH restart did not clean the previous one up. So the whole TREE goes,
    // and `taskkill /T` is the only reliable way to do that on Windows.
    try {
      if (process.platform === 'win32' && typeof dying.pid === 'number') {
        spawn('taskkill', ['/pid', String(dying.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        }).on('error', () => {
          // If taskkill is unavailable, fall back to the plain kill below.
          try { dying.kill() } catch (error) { /* already gone */ }
        })
      } else {
        dying.kill()
      }
    } catch (error) {
      /* an already-exited child needs no killing */
    }
  }

  /**
   * Start the child, and resolve when it has produced a first reading.
   *
   * A failed attempt does NOT latch: `finish(false, ...)` records the reason and
   * schedules a retry, so a probe that failed once can still come good. Only the
   * platform check is permanent.
   */
  function start() {
    if (starting !== null) return starting
    // A failure schedules the next attempt rather than forbidding it.
    if (Date.now() < nextAttemptAt) return Promise.resolve(false)
    // Any previous child must be gone before a new one is spawned. Measured on a real
    // machine: two probe children alive at once, started sixteen minutes apart, 203MB
    // between them. A retry that spawns without reaping leaves the old process running
    // forever — it holds a pipe nobody reads and a timer nobody stops.
    stop()
    starting = new Promise((resolve) => {
      let settled = false
      const finish = (ok, why) => {
        if (settled) return
        settled = true
        if (ok) {
          // A success clears both the failure record and the backoff, so the probe
          // reports 'ok' rather than remembering a failure that is over.
          lastFailure = null
          nextAttemptAt = 0
        } else {
          lastFailure = why
          stop()
          nextAttemptAt = Date.now() + RETRY_MS
        }
        resolve(ok)
      }

      let spawned
      try {
        spawned = spawn('powershell', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-Command', PROBE_SCRIPT,
        ], {
          // Piped stdout is the point: the values arrive on it. stderr is captured
          // so a PowerShell parse error can be reported instead of looking like a
          // probe that simply never answers.
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        finish(false, `spawn failed: ${String(error.message)}`)
        return
      }

      child = spawned
      let stderr = ''


      spawned.stdout.setEncoding('utf8')
      spawned.stdout.on('data', (chunk) => {
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line.startsWith('DSHIDLE ')) continue
          const value = Number(line.slice('DSHIDLE '.length))
          if (!Number.isFinite(value) || value < 0) continue
          reading = { idleMs: value, at: Date.now() }
          finish(true)
        }
      })

      spawned.stderr.setEncoding('utf8')
      spawned.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-2000)
      })

      spawned.on('error', (error) => {
        finish(false, `child error: ${String(error.message)}`)
      })
      spawned.on('exit', (code) => {
        // An exit before the first reading is a failure; an exit later is the child
        // dying under us, which makes the cached value stale rather than wrong.
        if (reading === null) {
          finish(false, `exited early (code ${String(code)})${stderr ? ': ' + stderr.trim().slice(0, 300) : ''}`)
          return
        }
        child = null
        // A child that dies AFTER working is not a permanent verdict, and treating it
        // as one is a real bug this used to have: `unavailable` was never cleared, so
        // one crash — at startup, or hours in — disabled the OS half of the trigger for
        // the rest of the session. The screensaver then depended on the window-focus
        // half alone, which never fires for somebody who stays in DSH, so it silently
        // stopped appearing altogether. `lastFailure` records why, and `nextAttemptAt`
        // makes the retry a backoff rather than a spawn storm.
        lastFailure = `child exited (code ${String(code)})`
        unavailable = null
        reading = null
        starting = null
        nextAttemptAt = Date.now() + RETRY_MS
        logger?.warn?.(`boot-animation: idle probe exited (code ${String(code)}); retrying in `
          + Math.round(RETRY_MS / 1000) + 's')
      })

      setTimeout(() => {
        finish(false, stderr ? `no reading; ${stderr.trim().slice(0, 300)}` : 'no reading within 8s')
      }, FIRST_LINE_TIMEOUT_MS).unref?.()
    })
    // Cleared once settled, so a retry after the backoff creates a fresh attempt
    // instead of re-awaiting the promise from the attempt that already failed.
    starting.then(() => { starting = null })
    return starting
  }

  const handle = {
    /**
     * The system idle time in milliseconds, or `undefined` when it cannot be known.
     *
     * Never throws and never blocks: a caller that polls this on a timer gets an
     * answer immediately, and an unavailable probe degrades the screensaver to its
     * focus trigger rather than stalling anything.
     */
    read() {
      if (disposed) return undefined
      if (!supported) return undefined
      if (reading === null) {
        // Kick the start off and answer "not yet". The caller polls, so the next
        // tick gets the value. `start()` itself refuses while the backoff is running,
        // so this is also what makes a failed probe try again once the wait is over.
        void start()
        return undefined
      }
      if (Date.now() - reading.at > READING_TTL_MS) {
        // The value went stale, which means the child stopped reporting. Ask for a
        // restart rather than serving a reading that no longer describes anything.
        if (child === null) void start()
        return undefined
      }
      return reading.idleMs
    },

    /**
     * What state the probe is in, as one of three values.
     *
     * The distinction matters to a caller: `starting` means "ask again shortly",
     * while `unavailable` means "this will never work here, use the fallback". Both
     * make `read()` answer undefined, so a caller that only sees the value cannot
     * tell a slow start from a permanent failure — and would either give up too early
     * or keep polling a probe that is never going to answer.
     *
     * Only a platform without the API is `unavailable` for good. A failed attempt is
     * reported as `starting`, because that is what it is: a retry is already scheduled
     * and may well succeed. Reporting it as `unavailable` would tell the caller to give
     * up on a probe that is about to come back.
     *
     * @returns 'ok' | 'starting' | 'unavailable'.
     */
    status() {
      if (disposed || !supported) return 'unavailable'
      if (reading !== null && Date.now() - reading.at <= READING_TTL_MS) return 'ok'
      return unavailable === null ? 'starting' : 'unavailable'
    },

    /**
     * Why the probe is not answering.
     *
     * `reason` is the PERMANENT verdict (a platform without the API) and is null while
     * the probe is working, starting, or merely between retries. `failure` is the most
     * recent attempt's error and is what a diagnostics line wants, since "it failed and
     * will retry" and "it can never work" are different answers to the same question.
     */
    unavailableReason() {
      return unavailable
    },

    /** The most recent transient failure, or null. */
    failureReason() {
      return lastFailure
    },

    /** When the next attempt is allowed, for the diagnostics line. */
    nextAttemptIn() {
      return Math.max(0, nextAttemptAt - Date.now())
    },

    /** Whether a child is currently running. */
    running() {
      return child !== null
    },

    /**
     * The child's process id, so a leaked one can be found and cleaned up.
     *
     * Exposed because the disposer is not guaranteed to run: measured on a real machine,
     * a DSH restart left the previous probe alive, holding ~110MB. This is what lets a
     * supervisor notice and reap it.
     */
    childPid() {
      return child === null ? null : child.pid ?? null
    },

    /** Stop the child. Registered as a disposer so unloading the plugin cleans up. */
    dispose() {
      disposed = true
      stop()
      liveProbes.delete(handle)
    },
  }

  // Registered so a process exit that never runs disposers still reaps the child. See
  // `liveProbes` for why that is necessary rather than belt-and-braces.
  liveProbes.add(handle)
  return handle
}
