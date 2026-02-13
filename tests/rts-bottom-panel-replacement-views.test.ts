import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const RTS_FILES = [
  path.join(process.cwd(), "src", "server", "rts.html"),
  path.join(process.cwd(), "dist", "server", "rts.html"),
];

for (const filePath of RTS_FILES) {
  test(`bottom panel has building-specific replacement view builders (${path.relative(process.cwd(), filePath)})`, () => {
    const source = fs.readFileSync(filePath, "utf-8");

    assert.match(source, /function buildBottomPanelView\(selectedKind, payload = \{\}\)\{/);
    assert.match(source, /if \(kind === 'base'\)/);
    assert.match(source, /if \(kind === 'feature'\)/);
    assert.match(source, /if \(kind === 'research' \|\| kind === 'university'\)/);
    assert.match(source, /if \(kind === 'warehouse' \|\| kind === 'library' \|\| kind === 'power'\)/);
  });

  test(`default mode restores original bottom palette and bindings (${path.relative(process.cwd(), filePath)})`, () => {
    const source = fs.readFileSync(filePath, "utf-8");

    assert.match(source, /function renderDefaultBottomCommandBar\(\)\{/);
    assert.match(source, /commandBar\.innerHTML = defaultBottomCommandBarMarkup;/);
    assert.match(source, /bindPaletteCardHandlers\(commandBar\);/);
    assert.match(source, /payload: \{ active: 'default' \}/);
  });

  test(`bottom panel router swaps between default and building-specific views (${path.relative(process.cwd(), filePath)})`, () => {
    const source = fs.readFileSync(filePath, "utf-8");

    assert.match(source, /registerPanelPatchRenderer\(PANEL_TARGET_IDS\.bottomCommandBar,[\s\S]*active === 'default'[\s\S]*renderDefaultBottomCommandBar\(\);[\s\S]*renderBottomBuildingView\(active, payload \|\| \{\}\);/);
    assert.match(source, /payload: \{ active: selectedKind, selectedKind, buildingId: building\?\.id \|\| null \}/);
  });
}
