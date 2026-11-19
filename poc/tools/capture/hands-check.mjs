// GAME-98 check: first-person hands during interaction animations, knockouts and ragdoll.
// Usage: node tools/capture/hands-check.mjs <poc dir> <out dir>
// Runs that poc dir's server and client, steps game time with the capture hook, and fakes the
// server's 'ko' / 'hit' messages for your own player so the states can be shot on demand.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = fs.readFileSync(path.join(HERE, 'hook.js'), 'utf8');
const [dir, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });

function inject(s) {
  s = s.replace('  NET.knockedCamera(dt);', '  NET.knockedCamera(dt); CAP.frame();');
  const m = [...s.matchAll(/\ntick\(\);\s*<\/script>/g)].pop();
  return s.slice(0, m.index) + '\n' + HOOK + s.slice(m.index);
}

const port = 9100 + Math.floor(Math.random() * 500);
const srv = spawn(process.execPath, ['server.mjs'], { cwd: dir, env: { ...process.env, PORT: String(port), DATA_FILE: path.join(out, 'save.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
for (let i = 0; i < 100 && !/listening/.test(log); i++) await new Promise(r => setTimeout(r, 100));

const { chromium } = require('playwright');
const browser = await chromium.launch({ args: ['--disable-features=LocalNetworkAccessChecks', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.addInitScript(() => { const W = window.WebSocket; window.WebSocket = class extends W { constructor(...a) { super(...a); window.__ws = this; } }; });
await page.route(u => ['/', '/index.html'].includes(new URL(u).pathname), async r => { const res = await r.fetch(); r.fulfill({ response: res, body: inject(await res.text()) }); });
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => window.__cap && window.__cap.frames > 2, null, { timeout: 180000 });
if (await page.isVisible('#login').catch(() => false)) { await page.fill('#nameInput', 'Camera'); await page.click('#go'); }
await page.waitForFunction(() => window.__net && window.__net.me, null, { timeout: 60000 }).catch(async e => { console.log('JOIN FAIL', JSON.stringify(errs), await page.evaluate(() => JSON.stringify({ net: !!window.__net, me: window.__net && window.__net.me, ws: window.__ws && window.__ws.readyState, login: document.querySelector('#login') && getComputedStyle(document.querySelector('#login')).display })), log.slice(-1500)); process.exit(1); });
await page.evaluate(() => __cap.hud(false));
await page.waitForTimeout(3000);

const CAM = [4, 1.6, 1.6, 0.12, 0.1];   // the "store" shot
const fake = m => page.evaluate(m => { m.id = m.id || __net.me; __ws.onmessage({ data: JSON.stringify(m) }); }, m);
async function steps(n) { await page.evaluate(() => __cap.stepMode(1 / 30)); for (let i = 0; i < n; i++) await page.evaluate(() => __cap.step()); await page.evaluate(() => __cap.stepMode(0)); }
async function shot(name, fn, n) {
  await page.evaluate(c => __cap.cam(...c), CAM);
  if (fn) await fn();
  await steps(n);
  await page.evaluate(() => __cap.stepMode(1 / 30));   // hold the frame still for the screenshot
  await page.evaluate(() => __cap.step());
  await page.screenshot({ path: path.join(out, name + '.png') });
  await page.evaluate(() => __cap.stepMode(0));
  console.log('shot', name);
}
const ONLY = process.env.ONLY;
if (!ONLY) {
await shot('1-idle', null, 10);
await shot('2-panhandle', () => page.evaluate(() => __cap.run("ANIM.play('panhandle')")), 24);
await steps(60);
await shot('3-warm', () => page.evaluate(() => __cap.run("ANIM.play('warm')")), 24);
await steps(90);
}
if (!ONLY || ONLY === 'ko') await shot('4-knocked-out', async () => { await page.evaluate(() => __cap.free()); await fake({ t: 'fx', kind: 'ko', ms: 600000 }); }, 40);
if (!ONLY) { await fake({ t: 'fx', kind: 'koup' }); await steps(60); }
if (!ONLY) await shot('5-ragdoll', async () => { await page.evaluate(() => __cap.free()); await fake({ t: 'fx', kind: 'hit', v: [4, 5, 2], spin: [3, 1, 2], cause: 'car' }); }, 30);
console.log('errors:', JSON.stringify(errs));
await browser.close(); srv.kill();
if (/Error|at .*\.mjs/.test(log)) console.log('server log:', log.slice(-2000));
