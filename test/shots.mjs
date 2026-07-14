// Capture screenshots of the menu and live gameplay for a visual taste check.
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { execSync } = await import('node:child_process');
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer(async (req, res) => {
  try { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    const buf = await readFile(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }); res.end(buf);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.fill('#name1', 'Ro');
await page.fill('#name2', 'Bro');
await page.screenshot({ path: path.join(ROOT, 'test/shot-home.png') });
await page.click('#settingsToggle');
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(ROOT, 'test/shot-settings.png') });
await page.click('#settingsToggle');
await page.click('#playBtn');
await page.waitForTimeout(4200); // through countdown into a live rally
await page.screenshot({ path: path.join(ROOT, 'test/shot-play.png') });

// win screen: short match + park a paddle so it resolves fast
await page.click('#pauseBtn'); await page.click('#quitBtn'); await page.waitForTimeout(150);
await page.click('#settingsToggle');
for (let i = 0; i < 6; i++) await page.click('[data-step="goals"][data-dir="-1"]');
for (let i = 0; i < 2; i++) await page.click('[data-step="series"][data-dir="-2"]');
await page.click('#settingsToggle');
await page.click('#playBtn');
await page.waitForTimeout(3600);
await page.mouse.move(20, 760); await page.mouse.down(); await page.mouse.up();
await page.waitForSelector('#win:not(.hidden)', { timeout: 30000 });
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(ROOT, 'test/shot-win.png') });
await browser.close();
server.close();
console.log('shots written');
