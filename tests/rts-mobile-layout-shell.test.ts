import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const srcHtmlPath = path.join(repoRoot, "src/server/rts.html");
const distHtmlPath = path.join(repoRoot, "dist/server/rts.html");

function readHtml(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

for (const [label, filePath] of [["src", srcHtmlPath], ["dist", distHtmlPath]] as const) {
  test(`${label}: mobile layout shell renders status strip + action dock tabs`, () => {
    const html = readHtml(filePath);
    assert.match(html, /id="mobileStatusStrip"/);
    assert.match(html, /id="mobileActionTabs"/);
    assert.match(html, /id="mobileTabBuild"/);
    assert.match(html, /id="mobileTabRuns"/);
    assert.match(html, /id="mobileTabIntel"/);
  });

  test(`${label}: mobile tab state wiring toggles Build\/Runs\/Intel panel visibility`, () => {
    const html = readHtml(filePath);
    assert.match(html, /function applyMobilePanelVisibility\(\)/);
    assert.match(html, /layout\.classList\.add\(`mobile-tab-\$\{mobileActiveTab\}`\)/);
    assert.match(html, /layout\.mobile-tab-build #actionPanel \{ display:block; \}/);
    assert.match(html, /layout\.mobile-tab-runs #livePanel \{ display:block; \}/);
    assert.match(html, /layout\.mobile-tab-intel #selectionPanel \{ display:block; \}/);
  });

  test(`${label}: desktop keeps existing right-dock behavior`, () => {
    const html = readHtml(filePath);
    assert.match(html, /#livePanel,\s*\n#selectionPanel \{ display:none; \}/);
    assert.match(html, /if \(!isMobileViewport\(\)\) \{[\s\S]*actionPanel\.style\.display = 'block';[\s\S]*livePanel\.style\.display = 'none';[\s\S]*selectionPanel\.style\.display = 'none';/);
  });
}
