import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { Server } from "node:http";
import puppeteer from "puppeteer";
import { startDashboard } from "../dist/server/dashboard.js";

function pickPort(): number {
  const base = 42000;
  const spread = 2000;
  return base + Math.floor(Math.random() * spread);
}

async function withDashboard<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const port = pickPort();
  const server = startDashboard(port) as Server;
  if (!server.listening) await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("RTS building palette shows larger previews and styled hover tooltips", async () => {
  await withDashboard(async (baseUrl) => {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });
      await page.goto(`${baseUrl}/rts`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".command-grid .palette-card[data-building='base']");

      const rootOverflow = await page.evaluate(() => {
        const docEl = document.documentElement;
        const body = document.body;
        const d = getComputedStyle(docEl);
        const b = getComputedStyle(body);
        return {
          docOverflowX: d.overflowX,
          docOverflowY: d.overflowY,
          bodyOverflowX: b.overflowX,
          bodyOverflowY: b.overflowY,
          hasPageHorizontalOverflow: docEl.scrollWidth > docEl.clientWidth,
          hasPageVerticalOverflow: docEl.scrollHeight > docEl.clientHeight,
        };
      });
      assert.equal(rootOverflow.docOverflowX, "hidden");
      assert.equal(rootOverflow.docOverflowY, "hidden");
      assert.equal(rootOverflow.bodyOverflowX, "hidden");
      assert.equal(rootOverflow.bodyOverflowY, "hidden");
      assert.equal(rootOverflow.hasPageHorizontalOverflow, false, "Unexpected page horizontal overflow");
      assert.equal(rootOverflow.hasPageVerticalOverflow, false, "Unexpected page vertical overflow");

      const commandTitle = await page.$eval(".command-title", (el) => (el.textContent || "").trim());
      assert.equal(commandTitle, "BUILD FORGE 4");

      const baseCard = ".palette-card[data-building='base']";
      const paletteSize = await page.$eval(baseCard, (el) => {
        const rect = el.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      assert.ok(paletteSize.width >= 110, `Expected larger base card width, got ${paletteSize.width}`);
      assert.ok(paletteSize.height >= 110, `Expected larger base card height, got ${paletteSize.height}`);

      await page.waitForSelector(`${baseCard} .palette-tooltip`);

      const tooltipState = await page.$eval(`${baseCard} .palette-tooltip`, (el) => {
        const style = getComputedStyle(el);
        return {
          borderStyle: style.borderStyle,
          bg: style.backgroundImage,
          text: (el.textContent || "").trim(),
        };
      });
      assert.equal(tooltipState.borderStyle, "solid");
      assert.ok(tooltipState.bg.includes("gradient"), "Expected styled tooltip gradient background");
      assert.ok(tooltipState.text.length >= 24, "Expected non-trivial tooltip description text");
      assert.ok(tooltipState.text.length <= 90, "Tooltip copy should stay concise");
      assert.ok(tooltipState.text.includes("Main command hub"), "Expected Base Core description content");
    } finally {
      await browser.close();
    }
  });
});
