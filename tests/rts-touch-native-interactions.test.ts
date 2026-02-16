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
  test(`${label}: mobile touch drag pans world with guarded touch gesture start`, () => {
    const html = readHtml(filePath);
    assert.match(html, /touch-action:none/);
    assert.match(html, /function shouldIgnoreTouchWorldGesture\(target\)/);
    assert.match(html, /worldWrapEl\.addEventListener\('touchstart',[\s\S]*state\.cameraDrag = \{[\s\S]*viaTouch:true/);
    assert.match(html, /window\.addEventListener\('touchmove',[\s\S]*handlePointerMove\(touch\)/);
  });

  test(`${label}: tap and placement remain touch-compatible without hover dependency`, () => {
    const html = readHtml(filePath);
    assert.match(html, /hideBuildingHoverCard\(\);/);
    assert.match(html, /if \(state\.placementMode\) \{[\s\S]*placeFeatureAt\(snapped\.x, snapped\.y\);[\s\S]*setPlacement\(null\);/);
    assert.match(html, /onClick:\(\) => \{[\s\S]*state\.selected = \{ type:'building', data:b \};[\s\S]*renderSelection\(\);/);
  });

  test(`${label}: pinch zoom path is bounded and safely disabled by default`, () => {
    const html = readHtml(filePath);
    assert.match(html, /cameraZoom: \{ enabled:false, scale:1, min:0\.8, max:1\.4 \}/);
    assert.match(html, /function applyPinchZoomFromTouches\(touchA, touchB\)/);
    assert.match(html, /Math\.min\(state\.cameraZoom\.max, Math\.max\(state\.cameraZoom\.min/);
  });
}
