import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { Server } from "node:http";
import puppeteer from "puppeteer";
import { startDashboard } from "../dist/server/dashboard.js";

function pickPort(): number {
  const base = 44000;
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

test("new factory opens full feature panel after warehouse placement", async () => {
  await withDashboard(async (baseUrl) => {
    const browser = await puppeteer.launch({
      headless: true,
      protocolTimeout: 240_000,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    try {
      const page = await browser.newPage();
      page.on("dialog", async (dialog) => { try { await dialog.dismiss(); } catch {} });
      await page.setViewport({ width: 1366, height: 900 });
      await page.goto(`${baseUrl}/rts`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".command-grid .palette-card[data-building='base']");

      const world = await page.$("#worldWrap");
      assert.ok(world, "worldWrap not found");
      const box = await world.boundingBox();
      assert.ok(box, "worldWrap has no box");

      // Place a base first.
      await page.click(".palette-card[data-building='base']");
      await page.mouse.click(box.x + 420, box.y + 320);
      await new Promise((r) => setTimeout(r, 180));

      // Place a warehouse near base (reported regression started after warehouse feature).
      await page.click(".palette-card[data-building='warehouse']");
      await page.mouse.click(box.x + 480, box.y + 360);
      await new Promise((r) => setTimeout(r, 180));

      // Place a new feature factory near base.
      await page.click(".palette-card[data-building='feature']");
      await page.mouse.click(box.x + 520, box.y + 360);
      await new Promise((r) => setTimeout(r, 320));

      const state = await page.evaluate(() => {
        const panel = document.getElementById("actionPanel");
        return {
          mode: panel?.dataset?.mode || "",
          featureId: panel?.dataset?.featureId || "",
          hasPrompt: !!document.getElementById("featurePrompt"),
          hasLaunch: !!document.getElementById("launchFeatureRunBtn"),
          panelText: (panel?.textContent || "").replace(/\s+/g, " ").trim(),
        };
      });

      assert.equal(state.mode, "feature", `Expected feature mode, got ${state.mode} / ${state.panelText}`);
      assert.ok(state.featureId.length > 0, "feature id missing on action panel");
      assert.equal(state.hasPrompt, true, "feature prompt textarea missing");
      assert.equal(state.hasLaunch, true, "feature launch button missing");
    } finally {
      await browser.close();
    }
  });
});
