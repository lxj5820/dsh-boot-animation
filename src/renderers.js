// Media renderers for the pre-boot screen.
//
// The screen used to be video-only: it built a <video>, called play() on it, and
// read `duration`/`ended`/`volume` off the element. Every one of those is a video
// fact, and the screensaver has to show still images, animated images and Live2D
// models through the same overlay. Rather than teach every call site to ask "what
// kind is this", the screen now asks a RENDERER, and this file is where the
// per-kind knowledge lives.
//
// A renderer is a small object with one required method and several optional
// ones. The contract is deliberately narrow, because everything the screen does
// with media is one of these questions:
//
//   el()            the DOM node to put in the stage                (required)
//   start()         begin playing / show it                          (required)
//   dispose()       release everything this renderer created          (required)
//   onShown(fn)     report that a picture exists (not that play() resolved)
//   onEnded(fn)     report that it finished; absent = it never ends
//   duration()      total length in seconds; absent/Infinity = unknowable
//   currentTime()   playback position in seconds
//   hasAudio()      whether a sound affordance is worth offering
//   setVolume(v)    ramp the level; absent = no audio path at all
//   mute(bool)      silence it without touching level
//   isMuted()       whether it is currently silent
//
// The three timeline questions are answered by ABSENCE, and that is the whole
// design: a still image has no `duration` and no `onEnded`, so the screen's
// existing "unknown length" path bounds it in time, which is exactly right for
// something that would otherwise sit there forever. Nothing needs a new branch
// for "an image cannot end" — the existing branch already means that.
//
// This file is concatenated into the injected screen by entry.js, so it must be
// plain script text: no imports, no exports, no module syntax. It defines
// `globalThis.__DSH_BOOT_ANIM_RENDERERS__` and the screen reads it.

/* eslint-disable */
;(function () {
  'use strict'

  /**
   * Build a renderer for one pool entry.
   *
   * @param entry - `{ kind, src, name, model }` from a pool manifest.
   * @param options - `{ loop, onDiagnostic }`.
   *   `loop` is what the entry is FOR, not a property of the file: the boot clip
   *   plays once because its END is the hand-off signal, while the screensaver loops
   *   because it covers the screen for an unknown length of time. A renderer that
   *   always looped would never let the screen hand over; one that never looped
   *   would freeze the screensaver the moment its clip ran out.
   * @returns a renderer, or undefined when the kind is unknown.
   */
  function create(entry, options) {
    var kind = entry && entry.kind
    var opts = options || {}
    if (kind === 'video') return videoRenderer(entry, opts)
    if (kind === 'image') return imageRenderer(entry)
    if (kind === 'animated') return animatedRenderer(entry)
    if (kind === 'live2d') return live2dRenderer(entry, opts)
    return undefined
  }

  /** Call a callback at most once. */
  function once(fn) {
    var fired = false
    return function () {
      if (fired) return
      fired = true
      if (typeof fn === 'function') fn()
    }
  }

  /* ---------------------------------------------------------------- video */

  /**
   * A video clip.
   *
   * The only kind with a real timeline, and therefore the only kind that can
   * carry a tail dissolve or unlock sound. Its `duration` may be Infinity (a
   * MediaRecorder WebM carries no duration metadata), which the screen already
   * handles as "unknown length" — so that fact is reported faithfully here rather
   * than papered over.
   */
  function videoRenderer(entry, options) {
    var video = document.createElement('video')
    video.className = 'dshba-media'
    video.muted = true
    video.playsInline = true
    video.setAttribute('playsinline', '')
    video.preload = 'auto'
    // The loop flag is the DIFFERENCE between the two uses, and it has to be set
    // before the source is assigned so the element's first play already honours it.
    //
    // A looping element never fires `ended`, which is exactly right for the
    // screensaver (it has no end to report — it is dismissed by the user) and
    // exactly wrong for the boot clip (whose end IS the hand-off signal).
    video.loop = options.loop === true
    video.src = entry.src

    var shownCbs = []
    var endedCbs = []

    // "A frame exists" is not the same fact as "play() resolved": a resolved
    // promise only means the element left the paused state. The screen depends on
    // that distinction to disarm its watchdog at the right moment.
    var fireShown = once(function () {
      for (var i = 0; i < shownCbs.length; i += 1) shownCbs[i]()
    })
    function checkShown() {
      if (video.readyState >= 2) fireShown()
    }
    video.addEventListener('loadeddata', checkShown)
    video.addEventListener('canplay', checkShown)
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(fireShown)
    }
    // Advancing time is the same fact reported by none of the above, and it is the
    // case a MediaRecorder WebM lands in: it may never reach readyState 2 and yet
    // be playing frames.
    video.addEventListener('timeupdate', function () {
      if (video.currentTime > 0) fireShown()
    })
    if (video.readyState >= 2) fireShown()

    video.addEventListener('ended', function () {
      for (var i = 0; i < endedCbs.length; i += 1) endedCbs[i]()
    })

    return {
      kind: 'video',
      el: function () { return video },
      start: function () { return video.play() },
      dispose: function () {
        try { video.pause() } catch (error) { /* never started */ }
        video.removeAttribute('src')
        try { video.load() } catch (error) { /* detaching the source is best effort */ }
      },
      onShown: function (fn) { shownCbs.push(fn) },
      onEnded: function (fn) { endedCbs.push(fn) },
      duration: function () { return video.duration },
      currentTime: function () { return video.currentTime },
      isEnded: function () { return video.ended === true },
      isPaused: function () { return video.paused === true },
      hasAudio: function () { return true },
      // A muted element is already silent, so the ramp has nothing to take down
      // and the screen skips it.
      setVolume: function (value) { video.volume = value },
      getVolume: function () { return video.volume },
      mute: function (value) { video.muted = value === true },
      isMuted: function () { return video.muted === true },
      // Only a video can stall, and only a video has a MediaError.
      onStall: function (fn) {
        video.addEventListener('stalled', fn)
        video.addEventListener('waiting', fn)
      },
      onError: function (fn) {
        video.addEventListener('error', function () { fn(video.error ? video.error.code : 0) }, { once: true })
      },
      mediaError: function () { return video.error ? video.error.code : 0 },
      raw: video,
    }
  }

  /* ---------------------------------------------------------------- image */

  /**
   * A still image.
   *
   * No timeline at all: it is "shown" as soon as it has decoded, it never ends,
   * and it makes no sound. Every one of those is expressed by the ABSENCE of a
   * method, which is what routes it through the screen's existing bounded-wait
   * path instead of needing a branch of its own.
   */
  function imageRenderer(entry) {
    var img = document.createElement('img')
    img.className = 'dshba-media'
    // `alt` is empty on purpose: the overlay is announced by its own aria-label,
    // and a decorative image inside it should not add a second announcement.
    img.alt = ''
    img.decoding = 'async'

    var shownCbs = []
    var errorCbs = []
    var fireShown = once(function () {
      for (var i = 0; i < shownCbs.length; i += 1) shownCbs[i]()
    })
    img.addEventListener('load', fireShown)
    img.addEventListener('error', function () {
      for (var i = 0; i < errorCbs.length; i += 1) errorCbs[i](0)
    })

    img.src = entry.src
    // A cached image is already complete when the handler is attached.
    if (img.complete && img.naturalWidth > 0) fireShown()

    return {
      kind: 'image',
      el: function () { return img },
      // Nothing to start: the load already began. Resolving immediately keeps the
      // screen's `start()` contract uniform.
      start: function () { return undefined },
      dispose: function () { img.removeAttribute('src') },
      onShown: function (fn) { shownCbs.push(fn) },
      // No `onEnded`: a still image never finishes, so the screen bounds it.
      hasAudio: function () { return false },
      onError: function (fn) { errorCbs.push(fn) },
      raw: img,
    }
  }

  /* ------------------------------------------------------ animated image */

  /**
   * An animated image (GIF / WebP).
   *
   * It loops by itself and has no API to observe or control: no duration, no end
   * event, no currentTime. So it is reported as having no timeline, exactly like a
   * still image — the difference between them is only that this one moves. That
   * is also why a STILL `.webp` served under this kind is fine: it simply shows
   * and sits there, which is what the bound it receives expects.
   */
  function animatedRenderer(entry) {
    var base = imageRenderer(entry)
    return {
      kind: 'animated',
      el: base.el,
      start: base.start,
      dispose: base.dispose,
      onShown: base.onShown,
      hasAudio: function () { return false },
      onError: base.onError,
      raw: base.raw,
    }
  }

  /* ---------------------------------------------------------------- live2d */

  /**
   * A Live2D model, rendered through an ADAPTER.
   *
   * The Cubism runtime is not bundled with this plugin: it is proprietary, it is
   * large, and it cannot be shipped inside a decorative boot screen. What ships is
   * the SLOT. An adapter is a function that receives `{ modelUrl, canvas, onReady,
   * onError }` and drives whatever runtime the user has installed; the plugin
   * never sees the runtime's API, only the adapter's.
   *
   * With no adapter registered the renderer reports an error, and the screen moves
   * on to the next entry. That is the honest outcome: a model nobody can render is
   * a pool entry that does not play, which the screen already knows how to survive.
   * It must NOT look like a hang, which is why this fails fast rather than waiting.
   *
   * The adapter contract is stated HERE, not in a separate document: the shape of
   * the function and the optional handle are the body of this renderer below, and
   * the general renderer contract at the top of this file says which methods a
   * kind must answer and which it must leave ABSENT. `AGENTS.md` ("The media-kind
   * abstraction, and why the ABSENCES are the contract") explains the other half:
   * why a live2d entry deliberately has no `duration()` and no `onEnded()`, which
   * is what routes it through the screen's "unknown length" bound.
   *
   * Installing one is a single assignment before the screen runs — put a function
   * on `globalThis.__DSH_BOOT_ANIM_LIVE2D__` — and the settings card is where the
   * user is told when that did not happen: `src/client.js` paints the 无适配器
   * badge on a model row whose page has no adapter.
   */
  function live2dRenderer(entry, options) {
    var adapter = globalThis.__DSH_BOOT_ANIM_LIVE2D__
    var canvas = document.createElement('canvas')
    canvas.className = 'dshba-media dshba-live2d'

    var shownCbs = []
    var errorCbs = []
    var handle = null
    var fireShown = once(function () {
      for (var i = 0; i < shownCbs.length; i += 1) shownCbs[i]()
    })
    function fail(reason) {
      if (options && typeof options.onDiagnostic === 'function') {
        options.onDiagnostic('live2d:' + String(reason))
      }
      for (var i = 0; i < errorCbs.length; i += 1) errorCbs[i](0)
    }

    if (typeof adapter !== 'function') {
      // Deferred by a tick so the screen has attached its error listener before
      // this fires; otherwise the failure happens before anyone is listening and
      // the entry looks like it simply never started.
      globalThis.setTimeout(function () { fail('no-adapter') }, 0)
    } else {
      try {
        handle = adapter({
          modelUrl: entry.src,
          canvas: canvas,
          onReady: fireShown,
          onError: fail,
        })
      } catch (error) {
        globalThis.setTimeout(function () { fail(error && error.message ? error.message : 'adapter-threw') }, 0)
      }
    }

    return {
      kind: 'live2d',
      el: function () { return canvas },
      start: function () {
        if (handle && typeof handle.start === 'function') return handle.start()
        return undefined
      },
      dispose: function () {
        if (handle && typeof handle.dispose === 'function') {
          try { handle.dispose() } catch (error) { /* the adapter owns its own cleanup */ }
        }
      },
      onShown: function (fn) { shownCbs.push(fn) },
      // A model loops indefinitely: no end, so the screen bounds it in time.
      hasAudio: function () { return false },
      onError: function (fn) { errorCbs.push(fn) },
      // Optional extras an adapter may implement, forwarded only when present.
      setExpression: function (name) {
        if (handle && typeof handle.setExpression === 'function') handle.setExpression(name)
      },
      raw: canvas,
    }
  }

  globalThis.__DSH_BOOT_ANIM_RENDERERS__ = { create: create }
})()
