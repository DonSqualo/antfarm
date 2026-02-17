import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const RTS_FILES = [
  path.join(process.cwd(), "src", "server", "rts.html"),
  path.join(process.cwd(), "dist", "server", "rts.html"),
];

for (const filePath of RTS_FILES) {
  test(`building selection emits a multi-target panel update envelope (${path.relative(process.cwd(), filePath)})`, () => {
    const source = fs.readFileSync(filePath, "utf-8");

    assert.match(source, /function createBuildingSelectionPanelUpdate\(building\)\{/);
    assert.match(source, /target: PANEL_TARGET_IDS\.bottomCommandBar,[\s\S]*target: PANEL_TARGET_IDS\.rightActionSidebar,/);
    assert.match(source, /applyPanelUpdateRouter\(update, \{ featureId: building\?\.id \|\| null, buildingId: building\?\.id \|\| null \}\);/);
  });

  test(`building selection renderers route via panel update router (${path.relative(process.cwd(), filePath)})`, () => {
    const source = fs.readFileSync(filePath, "utf-8");

    assert.match(source, /registerBuildingSelectionRenderer\('research',[\s\S]*createBuildingSelectionPanelUpdate\(building\)[\s\S]*applyPanelUpdateRouter\(update, \{ buildingId: building\?\.id \|\| null \}\);/);
    assert.match(source, /registerBuildingSelectionRenderer\('university',[\s\S]*createBuildingSelectionPanelUpdate\(building\)[\s\S]*applyPanelUpdateRouter\(update, \{ buildingId: building\?\.id \|\| null \}\);/);
    assert.match(source, /registerBuildingSelectionRenderer\('warehouse',[\s\S]*createBuildingSelectionPanelUpdate\(building\)[\s\S]*applyPanelUpdateRouter\(update, \{ buildingId: building\?\.id \|\| null \}\);/);
    assert.match(source, /registerPanelPatchRenderer\(PANEL_TARGET_IDS\.rightActionSidebar,[\s\S]*if \(mode === 'research'\)[\s\S]*renderResearchLabPanel\(buildingId \|\| null\);/);
  });
}

