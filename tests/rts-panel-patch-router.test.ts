import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const RTS_FILES = [
  path.join(process.cwd(), "src", "server", "rts.html"),
  path.join(process.cwd(), "dist", "server", "rts.html"),
];

for (const filePath of RTS_FILES) {
  test(`panel patch router exists and is target-dispatched (${path.relative(process.cwd(), filePath)})`, () => {
    const source = fs.readFileSync(filePath, "utf-8");

    assert.match(source, /const PANEL_TARGET_IDS = \{[\s\S]*bottomCommandBar:[\s\S]*rightActionSidebar:[\s\S]*leftMediaPanel:/);
    assert.match(source, /const panelPatchRenderers = new Map\(\)/);
    assert.match(source, /function registerPanelPatchRenderer\(targetId, renderPatch\)/);
    assert.match(source, /function applyPanelUpdateRouter\(update, context = \{\}\)/);
    assert.match(source, /registerPanelPatchRenderer\(PANEL_TARGET_IDS\.rightActionSidebar, \(\{ payload \}, context = \{\}\) => \{/);
  });

  test(`default Action Console render routes through dispatcher (${path.relative(process.cwd(), filePath)})`, () => {
    const source = fs.readFileSync(filePath, "utf-8");

    assert.match(source, /function routeDefaultActionConsole\(context = \{\}\)\{/);
    assert.match(source, /target: PANEL_TARGET_IDS\.rightActionSidebar,[\s\S]*payload: \{ mode: 'default' \}/);
    assert.match(source, /if \(!state\.selected\) routeDefaultActionConsole\(\);/);
  });

  test(`building panel renderers are mapped by target kind instead of click-handler hardcoding (${path.relative(process.cwd(), filePath)})`, () => {
    const source = fs.readFileSync(filePath, "utf-8");

    assert.match(source, /const buildingSelectionRenderers = new Map\(\)/);
    assert.match(source, /registerBuildingSelectionRenderer\('feature'/);
    assert.match(source, /registerBuildingSelectionRenderer\('research'/);
    assert.match(source, /function renderBuildingSelectionPanel\(building\)/);
    assert.match(source, /if \(renderBuildingSelectionPanel\(b\)\) return;/);
    assert.doesNotMatch(source, /if \(b\.kind === 'feature'\) renderRunSetupPanel\(b\.id\);/);
  });
}
