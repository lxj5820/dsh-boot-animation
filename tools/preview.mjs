#!/usr/bin/env node
// Local static preview for the boot screen.
//
// Renders the exact script injection the Host serves, against a stand-in for the
// kernel boot page, so the visual treatment and interaction can be checked
// without restarting DSH. Two local servers are started because the clip pool is
// fetched cross-origin from the page:
//
//   - page server  : http://127.0.0.1:8877/  (this preview + a fake kernel boot page)
//   - clip server  : http://127.0.0.1:8878/  (the real pool directory, CORS-enabled)
//
// Drop any .mp4/.webm into assets/videos and reload to judge the edge fade
// against a real clip.

import { createServer } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, extname, join, resolve, sep } from 'node:path'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const VIDEO_DIR = join(PACKAGE, 'assets', 'videos')
const VIDEO_EXT = new Set(['.mp4', '.webm', '.m4v', '.mov'])
const PAGE_PORT = 8877
const CLIP_PORT = 8878

const MIME = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

async function listClips() {
  try {
    const entries = await readdir(VIDEO_DIR, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && VIDEO_EXT.has(extname(entry.name).toLowerCase()))
      .map(entry => entry.name)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

/** The clip pool server: same layout the Host half exposes under its route. */
const clipServer = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  void (async () => {
    if (url === '/clips.json') {
      const clips = await listClips()
      res.writeHead(200, {
        'content-type': MIME['.json'],
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify({
        clips: clips.map(name => ({ src: `http://127.0.0.1:${String(CLIP_PORT)}/clip/${encodeURIComponent(name)}`, name })),
      }))
      return
    }
    if (url.startsWith('/clip/')) {
      const name = basename(url.slice('/clip/'.length))
      const absolute = resolve(VIDEO_DIR, name)
      if (!VIDEO_EXT.has(extname(name).toLowerCase()) || !absolute.startsWith(VIDEO_DIR + sep)) {
        res.writeHead(404).end()
        return
      }
      try {
        const info = await stat(absolute)
        const body = await readFile(absolute)
        res.writeHead(200, {
          'content-type': MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
          'content-length': String(info.size),
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch (error) {
        res.writeHead(error?.code === 'ENOENT' ? 404 : 500).end()
      }
      return
    }
    res.writeHead(404).end()
  })().catch(() => { if (!res.headersSent) res.writeHead(500).end() })
})

/** The page server: a fake kernel boot page plus the injected screen script. */
const pageServer = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  void (async () => {
    if (url === '/' || url === '/index.html') {
      const screen = await readFile(join(PACKAGE, 'src', 'boot-screen.js'), 'utf8')
      // The screen's settings come from the query string, so the injection the
      // Host would emit can be reproduced exactly — `?sound=0` is the silence
      // switch, `?clickToEnter=1` the direct entry, `?hint=0` the hidden hint,
      // and `?enterMode=click` / `?fadeMs=4000` the other two fields. Anything
      // absent falls back to the Host's own default rather than being sent.
      const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
      const cfg = JSON.stringify({
        base: '',
        manifest: `http://127.0.0.1:${String(CLIP_PORT)}/clips.json`,
        holdMs: 15000,
        ...(query.get('fadeMs') === null ? {} : { fadeMs: Number(query.get('fadeMs')) }),
        ...(query.get('enterMode') === null ? {} : { enterMode: query.get('enterMode') }),
        ...(query.get('sound') === null ? {} : { sound: query.get('sound') !== '0' }),
        ...(query.get('clickToEnter') === null ? {} : { clickToEnter: query.get('clickToEnter') === '1' }),
        ...(query.get('hint') === null ? {} : { showHint: query.get('hint') !== '0' }),
      })
      // The fake boot page mirrors the kernel's DOM contract: `[data-dsh-boot]`,
      // `[data-dsh-boot-spinner]`, and the `--dsh-boot-arc` custom property the
      // real page writes as entries activate.
      const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>boot screen preview</title>
<script>globalThis.__DSH_BOOT_ANIM_CFG__=${cfg}</script>
<script>${screen}</script>
<style>
  html,body{margin:0;height:100%;background:#fff}
  body[data-ds-dark-theme]{background:#151517}
  #root{height:100%;display:grid;place-items:center}
  [data-dsh-boot]{display:flex;flex-direction:column;align-items:center;gap:16px;font:600 16px system-ui}
  [data-dsh-boot-spinner]{width:20px;height:20px;border-radius:50%;border:2px solid rgba(0,0,0,.12)}
  .devbar{position:fixed;left:12px;top:12px;z-index:2147483647;display:flex;gap:6px;font:12px system-ui;isolation:isolate}
  .dshba{z-index:2147483000 !important}
  /* ?raw=1 strips the vignette and the dimming so the clip itself can be
     inspected: without this there is no way to tell a hidden clip from a clip
     whose own pixels are too dark to see through the mask. */
  .dshba[data-raw="1"] .dshba-video{opacity:1 !important;-webkit-mask-image:none !important;mask-image:none !important}
  .dshba[data-raw="1"] .dshba-veil{display:none !important}
  .devbar button{cursor:pointer;padding:5px 9px;border-radius:6px;border:1px solid rgba(120,160,200,.5);background:rgba(10,20,32,.72);color:#cfe4f6}
</style></head>
<body>
  <div class="devbar">
    <button onclick="document.body.toggleAttribute('data-ds-dark-theme')">明/暗主题</button>
    <button onclick="bootFail()">模拟启动失败</button>
    <button onclick="simulateMount()">模拟应用挂载</button>
    <button onclick="syntheticClip()">合成测试片段</button>
    <label style="cursor:pointer;padding:5px 9px;border-radius:6px;border:1px solid rgba(120,160,200,.5);background:rgba(10,20,32,.72);color:#cfe4f6">
      选我的视频<input type="file" accept="video/*" style="display:none" onchange="if(this.files[0])useVideo(this.files[0])">
    </label>
    <button onclick="location.reload()">重载</button>
  </div>
  <div id="root"><div data-dsh-boot><div>HARNESS</div><div data-dsh-boot-spinner style="--dsh-boot-arc:72deg"></div><div>Loading plugins…</div></div></div>
  <script>
    var arc=72, timer=setInterval(function(){
      arc=Math.min(arc+9,288);
      document.querySelector('[data-dsh-boot-spinner]').style.setProperty('--dsh-boot-arc',arc+'deg');
      if(arc>=288){clearInterval(timer);setTimeout(function(){ if(globalThis.__DSH_BOOT_ANIM__) globalThis.__DSH_BOOT_ANIM__.clientReady() },900)}
    },120);
    function bootFail(){
      clearInterval(timer);
      document.querySelector('[data-dsh-boot]').innerHTML='<div>Failed to load plugins</div><div>x: pending</div>';
    }
    // Stand-in for the real application taking the mount point: this is what the
    // UI renderer does once the client roster settles, one frame after the boot
    // page is hydrated.
    function simulateMount(){
      document.querySelector('.devbar').style.display='none';
      document.getElementById('root').innerHTML='<div style="display:grid;place-items:center;height:100%;'
        +'font:14px system-ui;color:#5b6b7d;background:var(--mock-bg,#fff)" id="mockapp">'
        +'<div style="text-align:center"><div style="font-size:22px;font-weight:600;color:#0f1115">应用已就绪</div>'
        +'<div style="margin-top:8px">这就是点击进入之后你应该看到的界面</div></div></div>';
    }
    // Local clip for judging the edge fade: the user's own file, or a synthetic
    // one painted on a canvas when the pool directory is still empty.
    function diag(message){
      var hint=document.querySelector('.dshba-hint');
      if(hint) hint.textContent='诊断：'+message;
    }
    function useVideo(file){
      var video=document.querySelector('.dshba-video');
      if(!video){diag('入场层已退场（先点重载）');return}
      video.addEventListener('error',function(){diag('video error code='+(video.error&&video.error.code))});
      video.addEventListener('loadeddata',function(){diag('loaded bytes='+file.size)});
      video.src=URL.createObjectURL(file);
      video.setAttribute('data-shown','1');
      var p=video.play();
      if(p&&p.catch)p.catch(function(e){diag('play 被拒：'+e.name)});
    }
    // The pool is 16:9 while the overlay is the whole viewport, so the clip's
    // aspect ratio and the fit mode are exactly what decides whether the subject
    // survives. ?ar=16:9 makes the synthetic clip match the real ones.
    function syntheticClip(){
      var ar=(location.search.match(/ar=(\d+):(\d+)/)||[]);
      var W=960,H=960;
      if(ar.length===3){ var a=parseInt(ar[1],10), b=parseInt(ar[2],10); H=Math.round(W*b/a) }
      var c=document.createElement('canvas');c.width=W;c.height=H;
      var g=c.getContext('2d'),t=0;
      var stream=c.captureStream(30);
      var chunks=[],rec=new MediaRecorder(stream,{mimeType:'video/webm'});
      rec.ondataavailable=function(e){if(e.data.size)chunks.push(e.data)};
      rec.onstop=function(){useVideo(new Blob(chunks,{type:'video/webm'}))};
      rec.start();
      var cx=W*0.5, cy=H*0.5;
      var id=setInterval(function(){
        t+=0.03;
        var grad=g.createRadialGradient(cx,cy*0.9,40,cx,cy,Math.max(W,H)*0.6);
        grad.addColorStop(0,'#123a5e');grad.addColorStop(0.55,'#08182b');grad.addColorStop(1,'#01050a');
        g.fillStyle=grad;g.fillRect(0,0,W,H);
        // A subject deliberately near the edges: if the fit crops, it disappears.
        g.fillStyle='rgba(150,220,255,0.85)';
        g.beginPath();g.ellipse(cx+Math.sin(t)*W*0.06,cy+Math.cos(t*0.8)*H*0.04,W*0.15,H*0.2,0,0,Math.PI*2);g.fill();
        g.fillStyle='rgba(220,245,255,0.9)';
        g.beginPath();g.ellipse(cx+Math.sin(t)*W*0.06,cy-H*0.06,W*0.052,H*0.08,0,0,Math.PI*2);g.fill();
        g.fillStyle='rgba(255,230,150,0.9)';
        g.fillRect(W*0.04,H*0.06,26,26);
        g.fillRect(W*0.96-26,H*0.06,26,26);
        g.fillRect(W*0.04,H*0.94-26,26,26);
        g.fillRect(W*0.96-26,H*0.94-26,26,26);
        for(var i=0;i<26;i++){var p=(t*40+i*37)%H;g.globalAlpha=0.5-((p/H)*0.4);g.beginPath();g.arc(W*0.12+i*W*0.03,H-p,3,0,Math.PI*2);g.fill()}
        g.globalAlpha=1;
      },33);
      setTimeout(function(){clearInterval(id);rec.stop()},2600);
    }
    // Diagnostic channel: the accessibility tree exposes the hint line, so the
    // boot screen's own hint doubles as an observation surface while iterating.
    function reportVideo(){
      var hint=document.querySelector('.dshba-hint');
      var v=document.querySelector('.dshba-video');
      if(!hint) return;
      if(!v){ hint.textContent='诊断：没有 video 元素'; return }
      setInterval(function(){
        // Plain concatenation on purpose: this block is itself inside a template
        // literal, so a backtick here would close the outer template.
        var cs=getComputedStyle(v);
        hint.textContent='诊断 shown='+(v.getAttribute('data-shown')||'-')
          +' ready='+v.readyState
          +' op='+cs.opacity
          +' inlineOp='+(v.style.opacity||'-')
          +' mask='+(cs.maskImage||cs.webkitMaskImage||'none').slice(0,26);
      },400);
    }
    // ?opacity=<0..1>&veil=<0..1> sweep the two knobs that decide whether the
    // subject survives the vignette. Guessing them produced a clip that played
    // correctly but was effectively invisible, so they are swept by eye instead.
    var vp=0.96, vl=0.62;
    var q=new URLSearchParams(location.search);
    if(q.get('opacity')) vp=parseFloat(q.get('opacity'));
    if(q.get('veil')) vl=parseFloat(q.get('veil'));
    if(vp!==0.96||vl!==0.62){
      var waitKnobs=setInterval(function(){
        var v=document.querySelector('.dshba-video');
        var veil=document.querySelector('.dshba-veil');
        if(v&&veil){
          clearInterval(waitKnobs);
          v.style.opacity=String(vp);
          veil.style.background='radial-gradient(ellipse 74% 70% at 50% 45%,transparent 34%,rgba(4,10,18,'+vl+') 72%,rgba(2,6,12,'+Math.min(1,vl*1.5)+') 100%)';
        }
      },80);
    }
    // ?fit=contain|cover switches the fit mode so the crop can be compared side
    // by side; the shipped value is contain. No backticks in this block: it sits
    // inside a template literal.
    var fitMatch=location.search.match(/fit=(contain|cover)/);
    if(fitMatch){
      var waitFit=setInterval(function(){
        var v=document.querySelector('.dshba-video');
        if(v){clearInterval(waitFit);v.style.objectFit=fitMatch[1]}
      },80);
    }
    // ?raw=1 disables the vignette and dimming for clip inspection.
    if(location.search.indexOf('raw=1')>=0){
      var waitRaw=setInterval(function(){
        var el=document.querySelector('.dshba');
        if(el){clearInterval(waitRaw);el.setAttribute('data-raw','1')}
      },100);
    }
    // ?diag=1 turns the hint line into a live readout (no backticks here: this
    // block sits inside a template literal).
    if(location.search.indexOf('diag=1')>=0){
      var waitDiag=setInterval(function(){
        if(document.querySelector('.dshba')){clearInterval(waitDiag);reportVideo()}
      },100);
    }
    // ?clip=synthetic renders a clip automatically so the edge fade can be
    // judged without clicking through the overlay that owns the viewport.
    if(location.search.indexOf('clip=synthetic')>=0){
      var wait=setInterval(function(){
        if(document.querySelector('.dshba-video')){clearInterval(wait);syntheticClip()}
      },100);
    }
  </script>
</body></html>`
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
      res.end(html)
      return
    }
    res.writeHead(404).end()
  })().catch(() => { if (!res.headersSent) res.writeHead(500).end() })
})

clipServer.listen(CLIP_PORT, '127.0.0.1', () => {
  process.stdout.write(`clips : http://127.0.0.1:${String(CLIP_PORT)}/\n`)
  pageServer.listen(PAGE_PORT, '127.0.0.1', () => {
    process.stdout.write(`page  : http://127.0.0.1:${String(PAGE_PORT)}/\n`)
    process.stdout.write(`pool  : ${VIDEO_DIR}\n`)
  })
})
