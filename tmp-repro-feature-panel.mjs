import puppeteer from 'puppeteer';
import { startDashboard } from './dist/server/dashboard.js';
import { once } from 'node:events';

const port = 43111;
const server = startDashboard(port);
if (!server.listening) await once(server, 'listening');
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.setViewport({ width: 1366, height: 900 });
  await page.goto(`http://127.0.0.1:${port}/rts`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.palette-card[data-building="base"]');

  const world = await page.$('#worldWrap');
  const box = await world.boundingBox();

  await page.click('.palette-card[data-building="base"]');
  await page.mouse.click(box.x + 420, box.y + 320);
  await page.waitForTimeout(200);

  await page.click('.palette-card[data-building="feature"]');
  await page.mouse.click(box.x + 500, box.y + 360);
  await page.waitForTimeout(350);

  const action = await page.$eval('#actionPanel', (el) => ({
    txt: (el.textContent || '').trim(),
    children: el.children.length
  }));
  const selection = await page.$eval('#selectionPanel', (el) => (el.textContent || '').trim());
  console.log('ACTION_CHILDREN', action.children);
  console.log('ACTION_TEXT', action.txt.replace(/\s+/g, ' ').slice(0, 300));
  console.log('SELECTION_TEXT', selection.replace(/\s+/g, ' ').slice(0, 300));
  if (errs.length) {
    console.log('PAGE_ERRORS');
    for (const err of errs) console.log(err);
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
