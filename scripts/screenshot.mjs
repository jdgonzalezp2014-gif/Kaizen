/**
 * Screenshot a screen of the running app (§80) — how phone and desktop
 * layouts are checked against live data.
 *
 *   node scripts/screenshot.mjs <Tab> <out.png> [width=1300] [SubTab] [click]
 *
 * Needs the app served locally (wrangler pages dev on :8799) and Chrome.
 * width ≤ 720 emulates a phone (mobile, 2× pixels). `click` is a button's
 * text, or `css:<selector>` to click an element; several are joined by " >> ". Prints the page width and
 * anything wider than the viewport — the page width must equal the viewport.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [,, tab, out, w = '1300', sub, click] = process.argv;
const W = Number(w), phone = W <= 720, port = phone ? 9334 : 9335;
const chrome = spawn('google-chrome', ['--headless=new', `--remote-debugging-port=${port}`, '--no-first-run',
  `--window-size=${W},900`, `--user-data-dir=/tmp/kaizen-shot-${phone ? 'm' : 'd'}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let t; for (let i = 0; i < 50; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async x => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
const metrics = h => send('Emulation.setDeviceMetricsOverride', { width: W, height: h, deviceScaleFactor: phone ? 2 : 1, mobile: phone });
await metrics(900);
await send('Page.enable'); await send('Page.navigate', { url: 'http://127.0.0.1:8799/' });
const clickText = async (sel, text) => { for (let i = 0; i < 60; i++) { if (await ev(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(sel)})].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)})); if(b){b.click();return true} return false})()`)) return true; await sleep(500); } return false; };
await clickText('nav button', tab);
if (sub) await clickText('.subtabs button', sub);
for (let i = 0; i < 90; i++) { await sleep(1000); if (!(await ev(`!!document.querySelector('.loading-dot, .loading')`))) break; }
// Several clicks in a row: "css:.a >> Edit claim".
for (const step of (click ?? '').split(' >> ').filter(Boolean)) {
  if (step.startsWith('css:')) await ev(`document.querySelector(${JSON.stringify(step.slice(4))})?.click()`); else await clickText('button', step);
  await sleep(2500);
}
await sleep(800);
console.log('page width', await ev('document.documentElement.scrollWidth'), '| viewport', W);
console.log(await ev(`[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > ${W + 5} && !e.closest('nav, .subtabs'))
  .slice(0, 8).map(e => e.tagName + '.' + String(e.className || '').slice(0, 40)).join('\\n')`) || '(nothing wider than the viewport)');
await metrics(Math.min(await ev('document.documentElement.scrollHeight'), 3000));
const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(out, Buffer.from(s.result.data, 'base64')); ws.close(); chrome.kill();
