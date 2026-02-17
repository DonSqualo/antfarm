import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { Server } from "node:http";
import puppeteer from "puppeteer";
import { startDashboard } from "../dist/server/dashboard.js";

function pickPort(): number {
  const base = 46000;
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

async function getAnyFeatureBuildingId(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/rts/state`, { signal: AbortSignal.timeout(8_000) });
  assert.equal(response.ok, true, `Expected /api/rts/state to return 200, got ${response.status}`);
  const payload = (await response.json()) as {
    ok?: boolean;
    error?: string;
    state?: { featureBuildings?: Array<{ id?: string }> };
  };
  assert.equal(payload.ok, true, payload.error || "Expected /api/rts/state response to be ok");
  const buildings = Array.isArray(payload.state?.featureBuildings) ? payload.state?.featureBuildings : [];
  const id = buildings.map((b) => String(b?.id || "")).find(Boolean) || "";
  assert.ok(id, "Expected at least one feature building in RTS state to use as selection target");
  return id;
}

test("RTS selecting/dragging a building updates selection state without creating native text selection", async () => {
  await withDashboard(async (baseUrl) => {
    const buildingId = await getAnyFeatureBuildingId(baseUrl);

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    try {
      const page = await browser.newPage();
      page.on("dialog", async (dialog) => {
        try {
          await dialog.dismiss();
        } catch {}
      });

      await page.setViewport({ width: 1366, height: 900 });
      await page.goto(`${baseUrl}/rts`, { waitUntil: "domcontentloaded" });

      const buildingSelector = `.entity[data-entity-key="building:${buildingId}"]`;
      await page.waitForSelector(buildingSelector);

      // Ensure we start with a clean DOM Selection.
      await page.evaluate(() => {
        const sel = window.getSelection?.();
        if (sel) sel.removeAllRanges();
      });

      const clickPoint = await page.$eval(buildingSelector, (el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width * 0.6, y: rect.top + rect.height * 0.55 };
      });

      // 1) Click selects the building.
      await page.click(buildingSelector);
      await page.waitForFunction(
        (sel) => document.querySelector(sel)?.classList.contains("is-selected") === true,
        {},
        buildingSelector,
      );

      // 2) Simulate a click-drag gesture (this is where native text selection used to appear).
      await page.mouse.move(clickPoint.x, clickPoint.y);
      await page.mouse.down();
      await page.mouse.move(clickPoint.x + 40, clickPoint.y + 15, { steps: 6 });
      await page.mouse.up();

      const selectionSnapshot = await page.evaluate(() => {
        const sel = window.getSelection?.();
        if (!sel) return { supported: false };
        return {
          supported: true,
          rangeCount: sel.rangeCount,
          isCollapsed: sel.isCollapsed,
          text: sel.toString(),
        };
      });

      assert.equal(selectionSnapshot.supported, true, "Expected window.getSelection() to be available");
      // Best-effort: we should not have any selected text, and any selection should be collapsed.
      assert.equal(selectionSnapshot.text, "", `Expected no selected text, got: ${selectionSnapshot.text}`);
      assert.equal(selectionSnapshot.isCollapsed, true, "Expected DOM selection to be collapsed after world interaction");
      assert.ok(
        selectionSnapshot.rangeCount === 0 || selectionSnapshot.rangeCount === 1,
        `Expected selection rangeCount to be 0/1, got ${selectionSnapshot.rangeCount}`,
      );

      const selectedKey = await page.evaluate(() => {
        const node = document.querySelector(".entity.is-selected");
        return String(node?.getAttribute("data-entity-key") || "");
      });
      assert.equal(selectedKey, `building:${buildingId}`);
    } finally {
      await browser.close();
    }
  });
});
