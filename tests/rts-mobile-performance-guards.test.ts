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
  test(`${label}: camera updates are requestAnimationFrame-coalesced`, () => {
    const html = readHtml(filePath);
    assert.match(html, /let visualFrameHandle = 0;/);
    assert.match(html, /function scheduleVisualFrame\(\)/);
    assert.match(html, /window\.requestAnimationFrame\(flushVisualFrame\)/);
    assert.match(html, /function updateCameraVisuals\(\)\s*\{[\s\S]*cameraVisualsDirty = true;[\s\S]*scheduleVisualFrame\(\);/);
  });

  test(`${label}: mobile viewport reduces expensive shadow\/filter effects`, () => {
    const html = readHtml(filePath);
    assert.match(html, /@media \(max-width:760px\)[\s\S]*\.world-wrap,[\s\S]*\.entity,[\s\S]*\.unit,[\s\S]*box-shadow:none !important;[\s\S]*filter:none !important;/);
  });

  test(`${label}: sprite preload de-dupes and prioritizes visible assets`, () => {
    const html = readHtml(filePath);
    assert.match(html, /const spritePreloadByUrl = new Map\(\);/);
    assert.match(html, /function preloadSpriteOnce\(url\)/);
    assert.match(html, /if \(cached\) return cached;/);
    assert.match(html, /function collectVisibleSpriteUrls\(\)/);
    assert.match(html, /const deferred = RTS_SPRITE_URLS\.filter\(\(url\) => !visibleSet\.has\(url\)\);/);
  });
}
