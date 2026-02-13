import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  PANEL_TARGETS,
  assertKnownPanelTarget,
  createPanelUpdateEnvelope,
  isKnownPanelTarget,
} from "../dist/server/panel-update-contract.js";

test("panel target constants include bottom bar, right sidebar, and left media placeholder", () => {
  assert.equal(PANEL_TARGETS.bottomCommandBar, "panel.bottom.command-bar");
  assert.equal(PANEL_TARGETS.rightActionSidebar, "panel.right.action-sidebar");
  assert.equal(PANEL_TARGETS.leftMediaPanel, "panel.left.media-panel");
});

test("unknown panel target IDs are rejected deterministically", () => {
  assert.equal(isKnownPanelTarget(PANEL_TARGETS.bottomCommandBar), true);
  assert.equal(isKnownPanelTarget("panel.unknown"), false);
  assert.throws(
    () => assertKnownPanelTarget("panel.unknown"),
    /Unknown panel target id: "panel\.unknown"\. Allowed targets: panel\.bottom\.command-bar, panel\.right\.action-sidebar, panel\.left\.media-panel/
  );
});

test("createPanelUpdateEnvelope normalizes targets and preserves event/payload", () => {
  const envelope = createPanelUpdateEnvelope({
    event: "feature.run.started",
    payload: { runId: "run-1" },
    patches: [
      { target: " PANEL.BOTTOM.COMMAND-BAR ", mode: "merge", payload: { active: "feature" } },
      { target: "panel.right.action-sidebar", mode: "replace", payload: { mode: "feature" } },
    ],
  });

  assert.equal(envelope.event, "feature.run.started");
  assert.deepEqual(envelope.payload, { runId: "run-1" });
  assert.deepEqual(envelope.patches.map((patch) => patch.target), [
    PANEL_TARGETS.bottomCommandBar,
    PANEL_TARGETS.rightActionSidebar,
  ]);
});

test("RTS dashboard API paths use panel update envelope contract", () => {
  const dashboardPath = path.join(process.cwd(), "src", "server", "dashboard.ts");
  const source = fs.readFileSync(dashboardPath, "utf-8");

  assert.match(source, /createPanelUpdateEnvelope\(\{\s*event: "feature\.run\.started"/);
  assert.match(source, /createPanelUpdateEnvelope\(\{\s*event: "feature\.run\.deleted"/);
  assert.match(source, /PANEL_TARGETS\.bottomCommandBar/);
  assert.match(source, /PANEL_TARGETS\.rightActionSidebar/);
  assert.match(source, /PANEL_TARGETS\.leftMediaPanel/);
});
