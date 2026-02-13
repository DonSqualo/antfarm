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
    assert(html.includes("async function syncLocalRepos()"), `${label}: local repo sync helper missing`);
    assert(html.includes("await syncLocalRepos();"), `${label}: boot does not fetch local repos`);
    assert(html.includes("syncLocalRepos()\n    ]);"), `${label}: runtime refresh does not keep local repos in sync`);

    assert(html.includes("const localRepos = Array.isArray(state.localRepos) ? state.localRepos : [];"), `${label}: dropdown not sourced from state.localRepos`);
    assert(html.includes("const repoOptions = localRepos.map(r => {"), `${label}: dropdown options are not mapped from local repos`);

    assert(html.includes("if (draft.existingRepoPath) {\n    existingRepoSelect.value = draft.existingRepoPath;\n    applyExistingRepoSelection();\n  }"), `${label}: existing selection is not deterministically re-applied`);
    assert(html.includes("draft.targetPath = draft.existingRepoPath;"), `${label}: selecting existing repo does not prefill targetPath`);
    assert(html.includes("draft.port = Number(repoMeta?.suggestedPort) || getPortForPath(draft.existingRepoPath) || draft.port || 3333;"), `${label}: selecting existing repo does not apply suggestedPort fallback logic`);

    assert(html.includes("if (!usingExisting && (!draft.repoUrl || !draft.targetPath))"), `${label}: clone mode validation check missing`);
    assert(html.includes("const payload = usingExisting\n        ? { useExistingRepoPath: draft.existingRepoPath }\n        : { repoUrl: draft.repoUrl, targetPath: draft.targetPath };"), `${label}: existing repo create payload should not require repoUrl`);
  }

  console.log("PASS: New Base dropdown uses synced local repos and existing-repo selection auto-fills deterministic defaults.");
}

run();
