#!/usr/bin/env node
// In-game capture tool (GAME-90): stills and clips of the real game from fixed camera
// shots, for self review and before/after comparisons. See tools/capture/README.md.
import { createRequire } from 'node:module';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const POC = path.resolve(HERE, '../..');
const HOOK = fs.readFileSync(path.join(HERE, 'hook.js'), 'utf8');
const SHOTS = JSON.parse(fs.readFileSync(path.join(HERE, 'shots.json'), 'utf8')).shots;

// ---------------- args ----------------
const argv = process.argv.slice(2);
const cmd = argv[0] === 'compare' || argv[0] === 'list' ? argv.shift() : 'shoot';
const opt = { size: '1280x720', fps: 24, settle: 4, shots: [], at: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], v = () => argv[++i];
  if (a === '--ref') opt.ref = v();
  else if (a === '--url') opt.url = v().replace(/\/$/, '');
  else if (a === '--join') opt.join = true;
  else if (a === '--before') opt.before = v();
  else if (a === '--after') opt.after = v();
  else if (a === '--out') opt.out = v();
  else if (a === '--name') opt.name = v();
  else if (a === '--label') opt.label = v();
  else if (a === '--size') opt.size = v();
  else if (a === '--fps') opt.fps = +v();
  else if (a === '--settle') opt.settle = +v();
  else if (a === '--hud') opt.hud = true;
  else if (a === '--hands') opt.hands = true;
  else if (a === '--no-clips') opt.noClips = true;
  else if (a === '--at') opt.at.push(v());
  else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(path.join(HERE, 'README.md'), 'utf8')); process.exit(0); }
  else if (a.startsWith('--')) die(`unknown option ${a}`);
  else opt.shots.push(a);
}
function die(m) { console.error(`capture: ${m}`); process.exit(1); }
const [W, H] = opt.size.split('x').map(Number);
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const OUT = path.resolve(opt.out || path.join(fs.existsSync('/mnt/project-files') ? '/mnt/project-files/captures' : path.join(POC, 'captures'), opt.name || stamp));

// ---------------- shots ----------------
function pickShots() {
  const list = [];
  const names = opt.shots.length ? opt.shots : (opt.at.length ? [] : Object.keys(SHOTS).filter(n => !SHOTS[n].optional));
  for (const n of names) {
    const s = SHOTS[n]; if (!s) die(`no shot named "${n}" (run: capture.mjs list)`);
    if (s.path && opt.noClips) { list.push({ name: n, ...s, cam: s.path[0], path: undefined }); continue; }
    list.push({ name: n, ...s });
  }
  opt.at.forEach((a, i) => { const c = a.split(',').map(Number); if (c.length !== 5 || c.some(isNaN)) die('--at needs x,y,z,yaw,pitch'); list.push({ name: `at-${i + 1}`, cam: c }); });
  return list;
}
if (cmd === 'list') {
  for (const [n, s] of Object.entries(SHOTS)) console.log(`${n.padEnd(18)} ${s.path ? `clip ${s.seconds || 6}s` : 'still   '}  ${s.optional ? '(optional) ' : ''}${s.note || ''}`);
  process.exit(0);
}

// ---------------- targets: a git ref, the working tree, or a URL ----------------
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const git = (...a) => execFileSync('git', a, { cwd: POC, encoding: 'utf8' }).trim();

async function startTarget(ref) {
  if (opt.url && !ref) return { url: opt.url, label: opt.label || new URL(opt.url).hostname, stop() {} };
  let dir = POC, label = opt.label || 'working-tree', cleanup = () => {};
  if (ref && ref !== 'WORKTREE') {
    const sha = git('rev-parse', '--verify', `${ref}^{commit}`);
    const top = git('rev-parse', '--show-toplevel'), sub = path.relative(top, POC);
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), `tw-cap-${sha.slice(0, 7)}-`));
    execFileSync('git', ['worktree', 'add', '--detach', '--force', wt, sha], { cwd: POC, stdio: 'ignore' });
    dir = path.join(wt, sub);
    if (!fs.existsSync(path.join(dir, 'node_modules'))) fs.symlinkSync(path.join(POC, 'node_modules'), path.join(dir, 'node_modules'));
    label = ref.replace(/[^\w.-]+/g, '_') + '@' + sha.slice(0, 7);
    cleanup = () => { try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: POC, stdio: 'ignore' }); } catch {} };
  }
  if (!fs.existsSync(path.join(POC, 'node_modules'))) die('run `npm install` in poc/ first');
  const port = await freePort();
  const data = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-cap-data-')), 'town.json');   // fresh world every run
  const srv = spawn(process.execPath, ['server.mjs'], { cwd: dir, env: { ...process.env, PORT: String(port), DATA_FILE: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 100 && !/listening/.test(log); i++) { if (srv.exitCode !== null) break; await new Promise(r => setTimeout(r, 100)); }
  if (!/listening/.test(log)) { srv.kill(); cleanup(); die(`server for ${label} did not start:\n${log}`); }
  return { url: `http://127.0.0.1:${port}`, label, srv, stop() { try { srv.kill('SIGCONT'); srv.kill(); } catch {} cleanup(); } };
}

// ---------------- the browser side ----------------
function inject(html) {
  let s = html;
  const camAnchor = "camera.rotation.set(pitch,yaw,0,'YXZ');";
  if (s.includes(camAnchor)) s = s.replace(camAnchor, camAnchor + ' CAP.frame();');
  else if (s.includes('  if(STYLES[curStyle].norm)')) s = s.replace('  if(STYLES[curStyle].norm)', '  CAP.frame();\n  if(STYLES[curStyle].norm)');
  else throw new Error('capture hook: camera anchor not found in index.html (update inject() in capture.mjs)');
  const m = [...s.matchAll(/\ntick\(\);\s*<\/script>/g)].pop();
  if (!m) throw new Error('capture hook: "tick();</script>" anchor not found in index.html');
  return s.slice(0, m.index) + '\n' + HOOK + s.slice(m.index);
}

async function openGame(browser, t) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.route(u => new URL(u).pathname === '/' || new URL(u).pathname === '/index.html', async r => {
    const res = await r.fetch(); r.fulfill({ response: res, body: inject(await res.text()) });
  });
  const remote = !!opt.url && t.url === opt.url;
  if (remote && !opt.join) await page.routeWebSocket(/\/ws$/, ws => ws.close());   // look, don't touch: no Camera vagrant left asleep on the live server
  await page.goto(t.url + '/');
  await page.waitForFunction(() => window.__cap && window.__cap.frames > 2, null, { timeout: 180000 });
  if (!remote || opt.join) {
    if (await page.isVisible('#login').catch(() => false)) { await page.fill('#nameInput', 'Camera'); await page.click('#go'); }
    await page.waitForFunction(() => !window.__net || window.__net.me, null, { timeout: 60000 }).catch(() => console.warn('  (never joined the server; capturing the static town)'));
  }
  await page.evaluate(([hud, hands]) => { __cap.hud(hud); __cap.hands(hands); }, [!!opt.hud, !!opt.hands]);
  await page.waitForTimeout(opt.settle * 1000);
  return { page, ctx, errs };
}

const ease = t => t * t * (3 - 2 * t);
function poseAt(keys, u) {           // Catmull-Rom through the keyframes, eased start and stop
  const n = keys.length - 1; if (n === 0) return keys[0];
  const f = ease(u) * n, i = Math.min(n - 1, Math.floor(f)), t = f - i;
  const P = k => keys[Math.max(0, Math.min(n, k))];
  return P(i).map((_, c) => { const p0 = P(i - 1)[c], p1 = P(i)[c], p2 = P(i + 1)[c], p3 = P(i + 2)[c];
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t); });
}

async function shoot(t, dir) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--disable-features=LocalNetworkAccessChecks', '--ignore-gpu-blocklist'] });
  const out = [];
  try {
    console.log(`[${t.label}] loading ${t.url} ...`);
    const { page, errs } = await openGame(browser, t);
    fs.mkdirSync(dir, { recursive: true });
    for (const s of pickShots()) {
      if (s.setup) await page.evaluate(src => __cap.run(src), s.setup).catch(e => console.warn(`  setup for ${s.name} failed: ${e.message}`));
      if (!s.path) {
        await page.evaluate(c => __cap.cam(...c), s.cam);
        const f0 = await page.evaluate(() => __cap.frames);
        await page.waitForFunction(f => __cap.frames >= f + 3, f0, { timeout: 120000 })
          .catch(e => { throw new Error(`game loop stopped at shot ${s.name}${errs.length ? ': ' + errs.join(' | ') : ''}`); });
        await page.waitForTimeout((s.wait || 0) * 1000);
        const file = path.join(dir, `${s.name}.png`);
        await page.screenshot({ path: file }); out.push(file); console.log(`  still ${file}`);
        continue;
      }
      // Clip: photo mode. The local server is paused so the world holds still, game time
      // advances exactly 1/fps per frame, and every frame is rendered then grabbed.
      const secs = s.seconds || 6, n = Math.round(secs * opt.fps), fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-cap-frames-'));
      if (t.srv) t.srv.kill('SIGSTOP');
      await page.evaluate(c => __cap.cam(...c), s.path[0]);
      await page.evaluate(dt => __cap.stepMode(dt), 1 / opt.fps);
      await page.waitForTimeout(1500);
      for (let i = 0; i < n; i++) {
        const url = await page.evaluate(([c]) => { __cap.cam(...c); return __cap.step(); }, [poseAt(s.path, i / (n - 1))]);
        fs.writeFileSync(path.join(fdir, `f${String(i).padStart(5, '0')}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
        if (i % opt.fps === 0) process.stdout.write(`  ${s.name}: frame ${i}/${n}\r`);
      }
      await page.evaluate(() => __cap.stepMode(0));
      if (t.srv) t.srv.kill('SIGCONT');
      const file = path.join(dir, `${s.name}.mp4`);
      ffmpeg(['-framerate', String(opt.fps), '-i', path.join(fdir, 'f%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', file]);
      fs.copyFileSync(path.join(fdir, 'f00000.jpg'), path.join(dir, `${s.name}.first.jpg`));
      fs.rmSync(fdir, { recursive: true, force: true });
      out.push(file); console.log(`  clip  ${file}            `);
    }
    if (errs.length) console.warn(`  page errors during capture:\n   ${[...new Set(errs)].slice(0, 5).join('\n   ')}`);
  } finally { await browser.close(); }
  return out;
}

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (r.error) die('ffmpeg is needed for clips (apt-get install ffmpeg), or pass --no-clips');
  if (r.status) die(`ffmpeg failed: ${args.join(' ')}`);
}

// ---------------- before/after ----------------
async function sideBySide(bDir, aDir, cDir, bLabel, aLabel) {
  fs.mkdirSync(cDir, { recursive: true });
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W * 2 + 12, height: H + 44 } });
  const font = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find(f => fs.existsSync(f));
  const out = [];
  for (const f of fs.readdirSync(aDir).filter(f => /\.(png|mp4)$/.test(f)).sort()) {
    const b = path.join(bDir, f), a = path.join(aDir, f), c = path.join(cDir, f);
    if (!fs.existsSync(b)) { console.warn(`  ${f}: only in after, skipped`); continue; }
    if (f.endsWith('.png')) {
      const img = p => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
      await page.setContent(`<body style="margin:0;background:#1d1830;font:700 18px system-ui,sans-serif;color:#fff;display:flex;gap:12px">
        ${[[bLabel, b], [aLabel, a]].map(([l, p]) => `<figure style="margin:0"><figcaption style="height:44px;line-height:44px;padding-left:10px">${l}</figcaption><img src="${img(p)}" width="${W}" height="${H}" style="display:block"></figure>`).join('')}</body>`);
      await page.screenshot({ path: c });
    } else {
      const lab = (l, x) => font ? `drawtext=fontfile=${font}:text='${l.replace(/[':\\]/g, ' ')}':x=${x}:y=12:fontsize=24:fontcolor=white:box=1:boxcolor=0x1d1830@0.8:boxborderw=8` : 'null';
      ffmpeg(['-i', b, '-i', a, '-filter_complex', `[0:v]${lab(bLabel, 12)}[l];[1:v]${lab(aLabel, 12)}[r];[l][r]hstack=inputs=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '21', '-movflags', '+faststart', c]);
    }
    out.push(c); console.log(`  compare ${c}`);
  }
  await browser.close();
  return out;
}

// ---------------- main ----------------
const targets = [];
process.on('SIGINT', () => { targets.forEach(t => t.stop()); process.exit(130); });
try {
  if (cmd === 'shoot') {
    const t = await startTarget(opt.ref); targets.push(t);
    const files = await shoot(t, path.join(OUT, opt.label || t.label));
    console.log(`\n${files.length} file(s) in ${path.join(OUT, opt.label || t.label)}`);
  } else {
    if (!opt.before) die('compare needs --before <git-ref> (and optionally --after <git-ref>, default: working tree)');
    const bt = await startTarget(opt.before); targets.push(bt);
    await shoot(bt, path.join(OUT, 'before')); bt.stop();
    const at = await startTarget(opt.after || 'WORKTREE'); targets.push(at);
    await shoot(at, path.join(OUT, 'after')); at.stop();
    const files = await sideBySide(path.join(OUT, 'before'), path.join(OUT, 'after'), path.join(OUT, 'compare'), `BEFORE  ${bt.label}`, `AFTER  ${at.label}`);
    console.log(`\n${files.length} comparison(s) in ${path.join(OUT, 'compare')}`);
  }
} finally { targets.forEach(t => t.stop()); }
