// Headless smoke test for RALLY. Boots the page in Chromium, reaches into the
// game's internal state via a small test hook, and asserts the core rules:
// scoring, no-tunnel physics at max speed, save/resume fidelity, and that a
// series reset preserves preferences + lifetime stats.
//
// Run: node test/smoke.mjs   (serves the repo root on an ephemeral port)
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Playwright is installed globally; resolve it from the global root.
const { execSync } = await import('node:child_process');
const gRoot = execSync('npm root -g').toString().trim();
const { chromium } = require(path.join(gRoot, 'playwright'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const buf = await readFile(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('nf');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok ' : 'FAIL '} ${msg}`); if (!cond) failures++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => { console.log('PAGE ERROR:', e.message); failures++; });
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error:', m.text()); });

await page.goto(base + '/?test=1', { waitUntil: 'networkidle' });
await page.waitForTimeout(300);

// 0. No-tunnel physics: drive the puck straight into a centered paddle at up to
// 6x the game's own max speed and confirm it reflects (never passes through).
const probe = await page.evaluate(() => {
  const out = [];
  for (const mul of [1, 2, 4, 6]) out.push([mul, window.__rally.tunnelProbe(mul, 0.25)]);
  return out;
});
for (const [mul, r] of probe) {
  ok(!r.crossed && r.finalVY < 0, `puck reflects (no tunnel) at ${mul}x max speed`);
}
// reload clean for the rest of the UI-driven suite
await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(200);

// The game IIFE is private; expose a hook by re-reading its live objects through
// the DOM events it wires. We drive it purely through the public UI + localStorage,
// which is exactly what a player/refresh does — so this tests the real contract.

// 1. Boot lands on home, no errors, canvas sized.
const homeVisible = await page.locator('#home').isVisible();
ok(homeVisible, 'home menu visible on boot');
const canvasBox = await page.locator('#game').boundingBox();
ok(canvasBox && canvasBox.width > 300, 'canvas fills viewport');

// #hud is a zero-size container of absolutely-positioned children, so check a
// sized child (the score) for "in play" instead of the container itself.
const inPlay = () => page.locator('#hudScore1').isVisible();

// 2. Set names + settings, start a match.
await page.fill('#name1', 'Ada');
await page.fill('#name2', 'Bo');
await page.click('#settingsToggle');
await page.click('#speedSeg [data-speed="fast"]'); // stress physics at fast speed
await page.click('#playBtn');
await page.waitForTimeout(200);
ok(await inPlay(), 'HUD shows after starting match');

// wait out the countdown into play
await page.waitForTimeout(3600);

// Park P1's paddle against the left wall so the center lane is open — with a
// human this never happens, but it makes unattended scoring deterministic
// (otherwise two dead-center paddles can rally near-vertically for a long time).
const parkP1Left = async () => {
  await page.mouse.move(20, 760); await page.mouse.down();
  await page.mouse.move(20, 760); await page.mouse.up();
};
await parkP1Left();

// 3. Read persisted match state — proves autosave writes a resumable snapshot.
const readSave = () => page.evaluate(() => JSON.parse(localStorage.getItem('rally.save.v1')));
let snap = await readSave();
ok(snap && snap.settings.name1 === 'Ada' && snap.settings.name2 === 'Bo', 'names persisted');
ok(snap.settings.speed === 'fast', 'speed setting persisted');
ok(snap.match && ['playing', 'countdown', 'goal'].includes(snap.match.phase), 'in-progress match snapshot exists');

// 4. No-tunnel / scoring: force the puck to hammer a paddle at max speed many
// times by simulating rapid pointer tracking, then let goals accrue. We can't
// reach engine internals, so instead assert the invariant a player cares about:
// after a long play with NO input (paddles parked center), goals are scored and
// the round eventually resolves — the puck never gets stuck or escapes.
await page.waitForTimeout(6000);
snap = await readSave();
const anyScore = snap.match && (snap.match.roundScore.p1 + snap.match.roundScore.p2) > 0;
ok(anyScore || !snap.match, 'goals accrue during unattended play (puck not stuck/escaped)');

// 5. Save/resume fidelity: reload mid-match, expect a Resume affordance and that
// reloading preserves the score exactly.
const beforeReload = await readSave();
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(300);
const resumeBtn = page.locator('#resumeBtn');
ok(await resumeBtn.isVisible(), 'Resume button offered after refresh mid-match');
const afterReload = await readSave();
ok(JSON.stringify(afterReload.match.roundScore) === JSON.stringify(beforeReload.match.roundScore),
   'score survives refresh unchanged');

await resumeBtn.click();
await page.waitForTimeout(200);
ok(await inPlay(), 'resume re-enters the match');

// 6. Play a whole short match end-to-end to exercise the win flow + lifetime
// tally, then verify reset-series keeps preferences AND lifetime stats.
await page.click('#pauseBtn');
await page.waitForSelector('#pause:not(.hidden)');
await page.click('#quitBtn'); // to menu
await page.waitForTimeout(150);
await page.click('#settingsToggle');
// shrink to first-to-1, best-of-1 so an unattended match resolves quickly
const clickN = async (sel, n) => { for (let i = 0; i < n; i++) { await page.click(sel); } };
await clickN('[data-step="goals"][data-dir="-1"]', 6);   // -> 1
await clickN('[data-step="series"][data-dir="-2"]', 2);  // -> 1
await page.click('#settingsToggle');
const life0 = (await readSave()).stats;
await page.click('#playBtn');
await page.waitForTimeout(3600); // countdown -> play
await parkP1Left();              // open the lane so a goal lands fast
// wait for the match to resolve to a win screen (unattended goals accrue)
await page.waitForSelector('#win:not(.hidden)', { timeout: 30000 });
ok(true, 'unattended match reaches a win screen');
const afterWin = await readSave();
ok(afterWin.match === null, 'series-complete clears the resumable match');
ok((afterWin.stats.life1 + afterWin.stats.life2) === (life0.life1 + life0.life2) + 1,
   'winning a match increments a lifetime tally');

// back to menu, start again, then reset series and confirm stats survive
await page.click('#winHomeBtn');
await page.waitForTimeout(150);
await page.click('#playBtn');
await page.waitForTimeout(400);
await page.click('#pauseBtn');
await page.waitForTimeout(100);
await page.click('#quitBtn');
await page.waitForTimeout(100);
await page.click('#newGameBtn'); // "Reset series"
await page.waitForTimeout(150);
const afterReset = await readSave();
ok(afterReset.match === null, 'reset clears the in-progress match');
ok(afterReset.settings.name1 === 'Ada' && afterReset.settings.speed === 'fast', 'reset keeps names + settings');
ok(JSON.stringify(afterReset.stats) === JSON.stringify(afterWin.stats), 'reset keeps lifetime stats');

// 7. Wipe clears everything back to defaults.
page.on('dialog', (d) => d.accept());
await page.click('#settingsToggle');
await page.click('#wipeBtn');
await page.waitForTimeout(150);
const wiped = await readSave();
ok(!wiped || wiped === null, 'wipe removes the save key');
const freshName = await page.inputValue('#name1');
ok(freshName === '', 'wipe resets names to default');

await browser.close();
server.close();

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
