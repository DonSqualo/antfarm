import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-mobile-e2e-"));
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

type MobileBaseNode = { id: string; label?: string; buildings?: Array<{ id: string; label?: string }> };

async function setMobileHierarchyFixture(baseUrl: string): Promise<void> {
  const fixture = {
    state: {
      customBases: [
        { id: "base-alpha", kind: "base", label: "Alpha Base", x: 200, y: 200, repo: "repo-alpha" },
        { id: "base-beta", kind: "base", label: "Beta Base", x: 900, y: 500, repo: "repo-beta" },
      ],
      featureBuildings: [
        { id: "factory-alpha-1", kind: "feature", label: "Factory A1", baseId: "base-alpha", x: 320, y: 260, repo: "repo-alpha", committed: true },
        { id: "factory-beta-1", kind: "feature", label: "Factory B1", baseId: "base-beta", x: 1020, y: 560, repo: "repo-beta", committed: true },
      ],
    },
  };

  const response = await fetch(`${baseUrl}/api/rts/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fixture),
    signal: AbortSignal.timeout(8_000),
  });
  assert.equal(response.ok, true, `Failed to set fixture: HTTP ${response.status}`);
  const payload = await response.json() as { ok?: boolean; error?: string };
  assert.equal(payload.ok, true, payload.error || "Expected RTS fixture API response to be ok");
}

async function getMobileTree(baseUrl: string): Promise<MobileBaseNode[]> {
  const response = await fetch(`${baseUrl}/api/rts/mobile/tree`, { signal: AbortSignal.timeout(8_000) });
  assert.equal(response.ok, true, `Expected mobile tree endpoint to respond 200, got ${response.status}`);
  const payload = await response.json() as { ok?: boolean; bases?: MobileBaseNode[]; error?: string };
  assert.equal(payload.ok, true, payload.error || "Expected mobile tree response to be ok");
  return Array.isArray(payload.bases) ? payload.bases : [];
}

test("RTS mobile hierarchy flow supports list rendering, base plus creation, and detail navigation", async () => {
  await withDashboard(async (baseUrl) => {
    await setMobileHierarchyFixture(baseUrl);
    const treeBefore = await getMobileTree(baseUrl);
    assert.ok(treeBefore.length > 0, "Expected at least one base in mobile tree fixture");

    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 430, height: 900 });
      await page.goto(`${baseUrl}/rts`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector(".layout")?.classList.contains("mobile-list-mode") === true);
      await page.waitForSelector("#mobileListPanel .mobile-tree-base");

      const listSnapshot = await page.evaluate(() => {
        const bases = Array.from(document.querySelectorAll("#mobileListPanel .mobile-tree-base"));
        return bases.map((base) => {
          const title = (base.querySelector("h3")?.textContent || "").trim();
          const baseId = String(base.querySelector("[data-mobile-base-create]")?.getAttribute("data-mobile-base-create") || "");
          const buildingLabels = Array.from(base.querySelectorAll("[data-mobile-building-id]")).map((btn) => (btn.textContent || "").trim());
          return { title, baseId, buildingLabels };
        });
      });

      assert.ok(listSnapshot.length >= 1, `Expected at least 1 base in mobile list, got ${listSnapshot.length}`);
      assert.equal(
        listSnapshot.some((base) => base.buildingLabels.length > 0),
        true,
        "Expected at least one base row with nested building rows in mobile hierarchy"
      );

      const targetBaseId = await page.evaluate(() => {
        const baseCards = Array.from(document.querySelectorAll("#mobileListPanel .mobile-tree-base"));
        const alphaCard = baseCards.find((card) => {
          const heading = (card.querySelector("h3")?.textContent || "").trim().toLowerCase();
          return heading.includes("alpha");
        });
        const preferredButton = alphaCard?.querySelector("[data-mobile-base-create]");
        const fallbackButton = document.querySelector("#mobileListPanel [data-mobile-base-create]");
        const button = preferredButton || fallbackButton;
        return String(button?.getAttribute("data-mobile-base-create") || "").trim();
      });
      assert.ok(targetBaseId, "Expected at least one base create button with a data-mobile-base-create id");

      const treeBeforeCreate = await getMobileTree(baseUrl);
      const targetBefore = treeBeforeCreate.find((base) => String(base.id || "") === targetBaseId);
      assert.ok(targetBefore, `Expected target base ${targetBaseId} in mobile tree before create`);
      const buildingIdsBefore = new Set((targetBefore?.buildings || []).map((b) => String(b.id || "")).filter(Boolean));

      const createSelector = `#mobileListPanel [data-mobile-base-create="${targetBaseId}"]`;
      await page.waitForSelector(createSelector);
      const createResponsePromise = page.waitForResponse((response) => {
        return response.url().includes("/api/rts/factory/create") && response.request().method() === "POST";
      }, { timeout: 8_000 });
      await page.click(createSelector);
      const createResponse = await createResponsePromise;
      assert.equal(createResponse.ok(), true, `Expected create endpoint 2xx, got ${createResponse.status()}`);
      const createPayload = await createResponse.json() as { ok?: boolean; buildingId?: string; baseId?: string; error?: string };
      assert.equal(createPayload.ok, true, createPayload.error || "Expected create payload ok=true");
      assert.equal(String(createPayload.baseId || ""), targetBaseId, "Expected plus action to create under selected base");
      const createdFactoryId = String(createPayload.buildingId || "").trim();
      assert.ok(createdFactoryId, "Expected create response to include buildingId");

      const treeAfterCreate = await getMobileTree(baseUrl);
      const targetAfterCreate = treeAfterCreate.find((base) => String(base.id || "") === targetBaseId);
      assert.ok(targetAfterCreate, `Expected target base ${targetBaseId} to remain visible after plus-create`);

      const clickedBuilding = await page.evaluate(() => {
        const target = document.querySelector("#mobileListPanel [data-mobile-building-id]") as HTMLButtonElement | null;
        if (!target) return "";
        const id = String(target.getAttribute("data-mobile-building-id") || "").trim();
        target.click();
        return id;
      });
      assert.ok(clickedBuilding, "Expected to click a building row from mobile list");
      await page.waitForSelector("#mobileListPanel [data-mobile-list-back]");

      const detailState = await page.evaluate(() => {
        const panelText = document.getElementById("mobileListPanel")?.textContent || "";
        return {
          hash: window.location.hash,
          text: panelText,
        };
      });

      assert.equal(detailState.hash.startsWith("#mobile-building/"), true, "Expected hash route for mobile building detail");
      assert.ok(detailState.text.includes("Building Detail"), "Expected detail screen heading");
      assert.ok(detailState.text.includes(`ID: ${clickedBuilding}`), "Expected detail view to include selected building ID");

      await page.click("#mobileListPanel [data-mobile-list-back]");
      await page.waitForFunction(() => !window.location.hash.startsWith("#mobile-building/"));
      await page.waitForSelector("#mobileListPanel .mobile-tree-base");
    } finally {
      await browser.close();
    }
  });
});
