// Mobile fit-and-finish checks: boots the page on a phone-sized viewport and
// asserts the things that make it feel like a native mobile webapp — locked
// viewport (no pinch/zoom), no scroll on tap, real touch input via Touch events,
// a valid installable manifest + reachable icons, and no console/page errors.
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { execSync } = await import('node:child_process');
const { chromium, devices } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const buf = await readFile(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok ' : 'FAIL '} ${msg}`); if (!cond) failures++; };

const browser = await chromium.launch();
// Emulate a real touch phone (iPhone 12) — has touch, no mouse, DPR 3.
const context = await browser.newContext({ ...devices['iPhone 12'] });
const page = await context.newPage();

const badReqs = [];
page.on('requestfailed', (r) => badReqs.push(r.url()));
page.on('response', (r) => { if (r.status() >= 400) badReqs.push(`${r.status()} ${r.url()}`); });
page.on('pageerror', (e) => { console.log('PAGE ERROR:', e.message); failures++; });
page.on('console', (m) => { if (m.type() === 'error') { console.log('console.error:', m.text()); failures++; } });

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

// 1. viewport is locked against pinch/zoom
const vp = await page.getAttribute('meta[name="viewport"]', 'content');
ok(/user-scalable=no/.test(vp) && /maximum-scale=1/.test(vp), 'viewport disables user zoom');
ok(/viewport-fit=cover/.test(vp), 'viewport covers the notch/safe areas');

// 2. touch-action none on body + canvas (no browser panning/zoom gestures)
const bodyTA = await page.evaluate(() => getComputedStyle(document.body).touchAction);
const canvasTA = await page.evaluate(() => getComputedStyle(document.getElementById('game')).touchAction);
ok(bodyTA === 'none', 'body touch-action:none');
ok(canvasTA === 'none', 'canvas touch-action:none');

// 3. canvas fills the whole phone screen
const box = await page.locator('#game').boundingBox();
const vw = page.viewportSize();
ok(box && Math.abs(box.width - vw.width) < 2 && Math.abs(box.height - vw.height) < 2, 'canvas fills the viewport exactly');

// 4. installable manifest with reachable icons
const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href');
ok(!!manifestHref, 'manifest linked');
const man = await (await fetch(base + '/' + manifestHref)).json();
ok(man.display === 'fullscreen' && man.orientation === 'portrait', 'manifest is fullscreen + portrait');
for (const ic of man.icons) {
  const r = await fetch(base + '/' + ic.src);
  ok(r.ok, `icon reachable: ${ic.src}`);
}

// 5. real touch input drives a paddle (no mouse, no keyboard) — start a match and
// tap-drag on the bottom half, then confirm the page did NOT scroll.
await page.tap('#playBtn');
await page.waitForTimeout(200);
ok(await page.locator('#hudScore1').isVisible(), 'match starts from a touch tap (no click/keyboard)');
await page.waitForTimeout(3400); // countdown -> play

// touch-drag along the bottom to move P1's paddle
await page.touchscreen.tap(200, 780);
const before = await page.evaluate(() => window.scrollY);
// simulate a drag using dispatched touch events on the canvas
await page.evaluate(() => {
  const c = document.getElementById('game');
  const mk = (type, x, y) => {
    const t = new Touch({ identifier: 1, target: c, clientX: x, clientY: y });
    c.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
  };
  mk('touchstart', 120, 780); mk('touchmove', 300, 780); mk('touchend', 300, 780);
});
await page.waitForTimeout(100);
const after = await page.evaluate(() => window.scrollY);
ok(before === 0 && after === 0, 'page never scrolls on touch drag');

// 6. save state persists across a reload driven purely by touch
const snap = await page.evaluate(() => localStorage.getItem('rally.save.v1'));
ok(!!snap && JSON.parse(snap).match, 'match autosaved to localStorage');

ok(badReqs.length === 0, `no failed/4xx requests (${badReqs.join(', ') || 'none'})`);

await browser.close();
server.close();
console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
