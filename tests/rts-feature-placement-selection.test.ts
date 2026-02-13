import fs from "node:fs";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function run(): void {
  const repoRoot = process.cwd();
  const srcHtmlPath = path.join(repoRoot, "src/server/rts.html");
  const distHtmlPath = path.join(repoRoot, "dist/server/rts.html");

  const srcHtml = readUtf8(srcHtmlPath);
  const distHtml = readUtf8(distHtmlPath);

  for (const [label, html] of [["src", srcHtml], ["dist", distHtml]] as const) {
    assert(html.includes("if (!run || typeof run !== 'object') return null;"), `${label}: extractPrUrl null guard missing`);
    assert(html.includes("worldWrapEl.addEventListener('mousedown', (e) => {"), `${label}: placement mousedown handler missing`);
    assert(html.includes("state.suppressWorldClick = true;"), `${label}: placement flow no longer suppresses trailing world click`);
    assert(html.includes("worldWrapEl.addEventListener('drop', (e) => {"), `${label}: drop placement handler missing`);
    assert(html.includes("if (placed) state.suppressWorldClick = true;"), `${label}: drop placement no longer suppresses trailing world click`);
    assert(html.includes("state.recentFeaturePlacementUntil = Date.now() + 600;"), `${label}: feature placement timing guard missing`);
    assert(html.includes("queueMicrotask(() => {"), `${label}: feature post-placement activation microtask missing`);
    assert(html.includes("if (Date.now() < Number(state.recentFeaturePlacementUntil || 0)) return;"), `${label}: world click timing guard missing`);
    assert(html.includes("if (state.suppressWorldClick) {"), `${label}: world click suppression guard missing`);
    assert(html.includes("if (state.selected) clearSelectedEntity();"), `${label}: world click clear-selection path missing`);
    assert(html.includes("panel.scrollTop = 0;"), `${label}: action panel scroll reset missing for feature render`);
  }

  console.log("PASS: Placement keeps fresh selection by suppressing trailing world click.");
}

run();
