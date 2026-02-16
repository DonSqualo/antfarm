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
  test(`${label}: action panel uses collapsible card groups with explicit primary CTA`, () => {
    const html = readHtml(filePath);
    assert.match(html, /function renderPanelCard\(/);
    assert.match(html, /<details class="panel-card"/);
    assert.match(html, /id: 'featureActionsCard'/);
    assert.match(html, /id="launchFeatureRunBtn"/);
  });

  test(`${label}: long details and prompt editor are rendered in mobile sheet containers`, () => {
    const html = readHtml(filePath);
    assert.match(html, /className = 'mobile-sheet'/);
    assert.match(html, /openMobileSheet\(\{ title, content \}\)/);
    assert.match(html, /id="openFeaturePromptSheetBtn" class="sheet-open-btn"/);
    assert.match(html, /data-plan-open-sheet=/);
  });

  test(`${label}: keyboard-safe mobile form wiring keeps focused controls recoverable`, () => {
    const html = readHtml(filePath);
    assert.match(html, /function wireKeyboardSafeFormControls\(scopeEl\)/);
    assert.match(html, /visualViewport\.addEventListener\('resize', syncInset/);
    assert.match(html, /el\.scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/);
  });
}
