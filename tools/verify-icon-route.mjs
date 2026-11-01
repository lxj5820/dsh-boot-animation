#!/usr/bin/env node
// Verify the ICON route: the card's picture is served, and only the shipped names.
//
// The card draws its icon from this route. A 404 there is not fatal — the card
// hides the image rather than showing a broken glyph — which is exactly why it
// needs a test: the failure is silent on screen and the settings row would simply
// lose its picture with nothing anywhere saying why.
//
// The route's containment rule is asserted too. It is a prefix route on `${ROUTE}/
// icon`, so the interesting cases are the ones that try to walk out of its
// directory: `..`, an absolute path, and a sibling pool file.
//
// Offline, no ports kept open, no prompts. Run: node tools/verify-icon-route.mjs

import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
// A path built by string concatenation is not importable on Windows: the ESM loader
// needs a file:// URL there. `new URL` handles both platforms.
const root = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
const failures = []
function record(name, ok, detail) {
  if (ok) { passed++; return }
  failures.push(name + (detail === undefined ? '' : '  [' + detail + ']'))
}

/* ---- collect the routes the Host registers ------------------------- */

const routes = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(fn, label) { return fn() },
  inject() {},
  get() { return undefined },
  on() { return () => {} },
  emit() {},
  set() {},
  provide() {},
}

// A webserver stub shaped like the one `entry.js` registers against.
const server = {
  register(route) { routes.push(route); return () => {} },
}

const module = await import(new URL('../entry.js', import.meta.url).href)
record('the Host module evaluates', typeof module.apply === 'function', Object.keys(module).join(','))

const hosts = new Map()
try {
  // The service key is `webServer` (capital S) — that is what `entry.js` reads.
  module.apply({ ...ctx, webServer: server }, module.Config({}))
} catch (error) {
  // A real DSH context offers more than this stub; the routing registrations happen
  // before anything that needs them, so a throw here is reported rather than hidden.
  record('apply runs against the stub context', false, String(error && error.message))
}

const iconRoute = routes.find(r => typeof r.path === 'string' && r.path.endsWith('/icon'))
record('the icon route is registered', iconRoute !== undefined, routes.map(r => r.path).join(' '))
record('the icon route is a prefix route', iconRoute !== undefined && iconRoute.kind === 'prefix',
  iconRoute === undefined ? '' : String(iconRoute.kind))

/* ---- the shipped icon files exist ---------------------------------- */

const ICONS = ['icon-40.png', 'icon-80.png', 'icon-160.png']
for (const name of ICONS) {
  const path = root + '/assets/icon/' + name
  record('the shipped icon exists: ' + name, existsSync(path), path)
}

/* ---- drive the route over real HTTP -------------------------------- */

if (iconRoute !== undefined) {
  const table = [iconRoute]
  const http = createServer((req, res) => {
    const path = req.url.split('?')[0]
    const hit = table.find(r => (r.kind === 'exact' ? path === r.path : path.startsWith(r.path)))
    if (hit === undefined) { res.writeHead(404).end('unrouted'); return }
    hit.handler(req, res)
  })
  await new Promise((done) => http.listen(0, '127.0.0.1', done))
  const base = 'http://127.0.0.1:' + http.address().port
  const BASE_PATH = '/plugins/dsh-boot-animation/icon'

  const get = async (path, method = 'GET') => {
    const res = await fetch(base + path, { method })
    const body = Buffer.from(await res.arrayBuffer())
    return { status: res.status, type: res.headers.get('content-type'), body, cache: res.headers.get('cache-control') }
  }

  const ok = await get(BASE_PATH + '/icon-40.png')
  record('the icon answers 200', ok.status === 200, String(ok.status))
  record('the icon is served as image/png', String(ok.type).startsWith('image/png'), String(ok.type))
  record('the icon bytes are a real PNG',
    ok.body.length > 8 && ok.body[0] === 0x89 && ok.body[1] === 0x50 && ok.body[2] === 0x4e && ok.body[3] === 0x47,
    ok.body.slice(0, 4).toString('hex'))
  // The overlay aborts media requests when it replaces an element, and a cacheable
  // truncated body then decodes as nothing. The same rule applies to the icon.
  record('the icon is not cacheable', String(ok.cache).includes('no-store'), String(ok.cache))

  const head = await get(BASE_PATH + '/icon-80.png', 'HEAD')
  record('HEAD is allowed for the icon', head.status === 200, String(head.status))

  const post = await get(BASE_PATH + '/icon-80.png', 'POST')
  record('the icon route refuses anything but GET/HEAD', post.status === 405, String(post.status))

  // Containment. Each of these must fail, and must fail without revealing a path.
  for (const [label, path] of [
    ['a traversal attempt', BASE_PATH + '/../client.js'],
    ['an absolute path', BASE_PATH + '/C:/Windows/win.ini'],
    ['an unlisted file name', BASE_PATH + '/secret.png'],
    ['a sibling pool file', BASE_PATH + '/1.mp4'],
  ]) {
    const attempt = await get(path)
    const refused = attempt.status === 404 || attempt.status === 400
    record('the icon route refuses ' + label, refused, String(attempt.status))
    record('the refusal for ' + label + ' reveals no directory',
      refused && !attempt.body.toString().includes('assets') && !attempt.body.toString().includes(':\\'),
      attempt.body.toString().slice(0, 60))
  }

  await new Promise((done) => http.close(done))
}

console.log('')
if (failures.length === 0) {
  console.log(passed + '/' + passed + ' passed')
  process.exit(0)
}
console.log(passed + ' passed, ' + failures.length + ' FAILED')
for (const line of failures) console.log('  FAIL  ' + line)
process.exit(1)
