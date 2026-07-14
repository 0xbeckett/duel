// Verify the LIVE deployed URL on a real touch phone viewport: it loads, fills
// the screen, starts a match from a tap, and writes a save. Screenshots the menu
// and live play so a human can eyeball the result.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium, devices } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = process.argv[2] || 'https://duel.0xbeckett.me';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok ' : 'FAIL '} ${m}`); if (!c) failures++; };

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['iPhone 12'] });
const page = await context.newPage();
page.on('pageerror', (e) => { console.log('PAGE ERROR:', e.message); failures++; });
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error:', m.text()); });

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(600);

ok((await page.title()).includes('RALLY'), 'live page title is RALLY');
ok(await page.locator('#home').isVisible(), 'home menu renders on the live URL');
const box = await page.locator('#game').boundingBox();
const vw = page.viewportSize();
ok(box && Math.abs(box.width - vw.width) < 2 && Math.abs(box.height - vw.height) < 2, 'canvas fills the phone screen');
await page.screenshot({ path: path.join(ROOT, 'test/live-home.png') });

// start a match with pure touch input
await page.tap('#name1'); await page.fill('#name1', 'Ro');
await page.tap('#name2'); await page.fill('#name2', 'Bro');
await page.tap('#playBtn');
await page.waitForTimeout(200);
ok(await page.locator('#hudScore1').isVisible(), 'match starts from a touch tap');
await page.waitForTimeout(3600);
await page.screenshot({ path: path.join(ROOT, 'test/live-play.png') });

const saved = await page.evaluate(() => localStorage.getItem('rally.save.v1'));
ok(!!saved && !!JSON.parse(saved).match, 'live save state written to localStorage');

await browser.close();
console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
