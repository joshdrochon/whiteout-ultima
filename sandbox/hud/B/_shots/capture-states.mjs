// Look-check rig for HUD candidate B: renders the states the gate runner never
// lands on (mid-air trick build, star + chain, award slam, TRICKY, and the two
// extreme viewports) so they can be eyeballed.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import puppeteer from 'puppeteer';
const ROOT = '/Users/joanmiguel/Desktop/Developer/snowboard-gauntlet';
const OUT = join(ROOT, 'sandbox/hud/B/_shots');
const candDir = join(ROOT, 'sandbox/hud/B');
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.glsl':'text/plain','.css':'text/css' };
const server = http.createServer(async (req,res)=>{try{const url=req.url.split('?')[0];let f;
 if(url==='/')f=join(ROOT,'harness','hud-page.html');else if(url.startsWith('/candidate/'))f=join(candDir,url.slice(11));
 else if(url.startsWith('/game/'))f=join(ROOT,'src/game',url.slice(6));else if(url.startsWith('/node_modules/'))f=join(ROOT,url);
 else{res.writeHead(404).end();return;}const b=await readFile(f);res.writeHead(200,{'content-type':MIME[extname(f)]||'application/octet-stream'});res.end(b);}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,r));
const port=server.address().port;
const browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--ignore-gpu-blocklist']});

async function shot(name, w, h, script, waitMs = 0) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction('window.__gauntlet && window.__gauntlet.ready !== false', { timeout: 60000 });
  await page.evaluate(script);
  if (waitMs) { await new Promise(r => setTimeout(r, waitMs)); await page.evaluate('window.__hud.update(1/60)'); }
  await page.screenshot({ path: join(OUT, name) });
  // report any HUD box intruding on the centre 50% rect
  const intruders = await page.evaluate(`(() => {
    const W=innerWidth,H=innerHeight,b={x0:W*.25,x1:W*.75,y0:H*.25,y1:H*.75},out=[];
    document.getElementById('hudroot').querySelectorAll('*').forEach(el=>{
      const r=el.getBoundingClientRect(); if(r.width<2||r.height<2) return;
      const st=getComputedStyle(el); if(st.visibility==='hidden'||Number(st.opacity)<.05) return;
      const paints=st.backgroundColor!=='rgba(0, 0, 0, 0)'||st.backgroundImage!=='none'||
        parseFloat(st.borderTopWidth)>0||parseFloat(st.borderLeftWidth)>0;
      const own=[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim());
      if(!paints&&!own) return;
      if(r.right>b.x0&&r.left<b.x1&&r.bottom>b.y0&&r.top<b.y1)
        out.push((el.id||el.tagName)+':'+Math.round(r.left)+','+Math.round(r.top));
    });
    return out;
  })()`);
  console.log(name.padEnd(24), w + 'x' + h, intruders.length ? 'INTRUDERS ' + intruders.join(' ') : 'centre clear');
  await page.close();
}

// mid-air: uber running, rotation counting up, star + chain live
const AIR = `(()=>{ window.__step(0.42); const t=window.__app.trickState(), r=window.__app.riderState();
  t.score=486300; t.meter=0.55; t.trickyLetters=4; t.tricky=false; t.jumpScore=18400;
  t._star=3; t._jump={completedUbers:['Airwalk'],peakSpin:720,peakFlip:360,grabTime:0.4};
  t.activeTrick={name:'Airwalk',progress:0.62};
  r.onGround=false; r.spinDeg=-545; r.flipDeg=-368; r.airTime=1.9;
  window.__hud.update(1/60); window.__app.render(16.6); })()`;

// the same air, one frame later at full rotation — the callout has grown
const AIR2 = `(()=>{ window.__step(0.42); const t=window.__app.trickState(), r=window.__app.riderState();
  t.score=1284650; t.meter=1; t.trickyLetters=6; t.tricky=true; t.jumpScore=41250;
  t._star=5; t._jump={completedUbers:['SuperMan BarSpin'],peakSpin:900,peakFlip:720,grabTime:0.8};
  t.activeTrick={name:'SuperMan BarSpin',progress:1};
  r.onGround=false; r.spinDeg=905; r.flipDeg=-728; r.airTime=3.4;
  window.__hud.update(1/60); window.__app.render(16.6); })()`;

const AWARD = `(()=>{ window.__step(0.55); const t=window.__app.trickState();
  t.score=486300; t.meter=0.85; t.trickyLetters=4; t._star=5;
  t.awards.push({name:'La La La Lock Step',points:22580});
  window.__hud.update(1/60); window.__app.render(16.6); })()`;

await shot('state-air.png', 1280, 720, AIR);
await shot('state-air-big.png', 1280, 720, AIR2);
await shot('state-award.png', 1280, 720, AWARD, 340);
await shot('state-narrow.png', 500, 900, AIR);
await shot('state-4k.png', 2560, 1440, AWARD, 340);
await browser.close(); server.close();
