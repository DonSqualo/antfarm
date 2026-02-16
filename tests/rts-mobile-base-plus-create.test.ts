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
    assert(html.includes('data-mobile-base-create="${esc(baseId)}"'), `${label}: per-base plus action data attribute missing`);
    assert(html.includes('function createFactoryForMobileBase(baseId){'), `${label}: createFactoryForMobileBase helper missing`);
    assert(html.includes("await postJson('/api/rts/factory/create', { baseId: safeBaseId, kind: 'factory' });"), `${label}: base-scoped factory creation API call missing`);
    assert(html.includes("state.mobileFactoryCreate.errorByBase[safeBaseId] = `Create failed: ${message}`;"), `${label}: deterministic mobile create error state missing`);
    assert(html.includes("mobileListPanel?.addEventListener('click', (event) => {"), `${label}: mobile panel click delegation missing`);
  }

  console.log("PASS: mobile base rows provide plus creation action with API wiring and deterministic error handling.");
}

run();
