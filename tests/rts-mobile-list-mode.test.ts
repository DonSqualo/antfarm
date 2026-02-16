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
    assert(html.includes('const MOBILE_LIST_BREAKPOINT = 900;'), `${label}: mobile breakpoint constant missing`);
    assert(html.includes('id="mobileListPanel" class="mobile-list-panel"'), `${label}: mobile list container missing`);
    assert(html.includes("function setMobileListMode(active){"), `${label}: mobile mode switch function missing`);
    assert(html.includes("layout.classList.toggle('mobile-list-mode', enabled)"), `${label}: mobile mode CSS class toggle missing`);
    assert(html.includes("state.mobileTree = buildMobileTreeFromScene();"), `${label}: mobile list should derive from rebuilt desktop scene state`);
    assert(html.includes("function buildMobileTreeFromScene(){"), `${label}: mobile scene tree helper missing`);
    assert(html.includes("class=\"mobile-tree-item-icon\""), `${label}: mobile building rows should render sprite icon tiles`);
    assert(html.includes("<span class=\"progress\"><span class=\"bar\""), `${label}: mobile building rows should render shared loading bars`);
    assert(html.includes("if (state.mobileListMode) return false;"), `${label}: edge pan guard missing for mobile mode`);
    assert(html.includes("if (state.mobileListMode) return;\n  if (state.cameraDrag.active) {"), `${label}: pointer move should short-circuit in mobile mode`);
    assert(html.includes("const movable = !state.mobileListMode;"), `${label}: dragging should be disabled in mobile mode`);
  }

  console.log("PASS: mobile list mode wiring exists and disables map pan/drag interactions.");
}

run();
