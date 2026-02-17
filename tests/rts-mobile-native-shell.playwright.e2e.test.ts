import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import type { Server } from "node:http";
import { chromium } from "playwright";
import { startDashboard } from "../dist/server/dashboard.js";

function pickPort(): number {
  const base = 46000;
  const spread = 2000;
  return base + Math.floor(Math.random() * spread);
}

async function withDashboard<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-playwright-mobile-"));
  const oldHome = process.env.HOME;
  process.env.HOME = tempHome;

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
    process.env.HOME = oldHome;
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {}
  }
}

test("mobile native shell hides world map and keeps dock aligned for fast tab UX", async () => {
  await withDashboard(async (baseUrl) => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    try {
      await page.goto(`${baseUrl}/rts`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector(".layout")?.classList.contains("mobile-list-mode") === true);

      const shellState = await page.evaluate(() => {
        const world = document.getElementById("worldWrap");
        const panel = document.getElementById("mobileListPanel");
        const tabs = document.getElementById("mobileActionTabs");
        const worldDisplay = world ? window.getComputedStyle(world).display : "missing";
        const panelDisplay = panel ? window.getComputedStyle(panel).display : "missing";
        const tabRect = tabs?.getBoundingClientRect();
        return {
          worldDisplay,
          panelDisplay,
          tabBottom: tabRect?.bottom || 0,
          tabTop: tabRect?.top || 0,
          viewportHeight: window.innerHeight,
        };
      });

      assert.equal(shellState.worldDisplay, "none", "Expected world map to be hidden in isolated mobile shell");
      assert.equal(shellState.panelDisplay !== "none", true, "Expected mobile panel to be visible");
      assert.equal(shellState.tabBottom <= shellState.viewportHeight, true, "Expected bottom dock inside viewport");
      assert.equal(shellState.tabTop > shellState.viewportHeight - 90, true, "Expected bottom dock near safe-area bottom");

      const goTab = async (selector: string, expectedTitle: string) => {
        const start = Date.now();
        await page.click(selector);
        await page.waitForFunction((title) => {
          const el = document.querySelector("#mobileListPanel h3");
          return (el?.textContent || "").trim().toLowerCase() === String(title).toLowerCase();
        }, expectedTitle);
        const elapsed = Date.now() - start;
        // CI variance + resource contention can cause occasional slow frames.
        assert.equal(elapsed < 1800, true, `Expected fast tab switch (<1800ms), got ${elapsed}ms`);
      };

      await goTab("#mobileTabRuns", "Active Runs");
      await goTab("#mobileTabIntel", "Mission Intel");
      await goTab("#mobileTabBuild", "Mobile Ops List");
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
