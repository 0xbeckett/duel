// One-shot: render icon.svg to the PNG app icons the manifest references.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(path.join(ROOT, 'icon.svg'), 'utf8');
const b = await chromium.launch();
for (const size of [180, 192, 512]) {
  const page = await b.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent('<style>*{margin:0;padding:0}svg{width:' + size + 'px;height:' + size + 'px;display:block}</style>' + svg);
  await page.waitForTimeout(120);
  const out = size === 180 ? 'apple-touch-icon.png' : 'icon-' + size + '.png';
  await page.screenshot({ path: path.join(ROOT, out) });
  await page.close();
}
await b.close();
console.log('icons written');
