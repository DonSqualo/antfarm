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
    assert(html.includes("if (runIsActive || stepIsActive) return 5;"), `${label}: run progress minimum active clamp missing`);
    assert(html.includes("const runIsActive = NON_TERMINAL_RUN_STATUSES.has(runStatus) && !['pending', 'queued', 'waiting'].includes(runStatus);"), `${label}: active run detection missing`);

    assert(html.includes("function featureRunProgressBarColor(building)"), `${label}: feature progress color helper missing`);
    assert(html.includes("if (SUCCESS_RUN_STATUSES.has(status)) return 'var(--ok)';"), `${label}: success color mapping missing`);
    assert(html.includes("if (FAILED_RUN_STATUSES.has(status)) return 'var(--bad)';"), `${label}: failed color mapping missing`);
    assert(html.includes("const color = b.kind === 'feature' ? featureRunProgressBarColor(b)"), `${label}: renderWorld color helper usage missing`);

    assert(html.includes("if (SUCCESS_RUN_STATUSES.has(status) && b.prUrl)"), `${label}: PR READY note success status mapping missing`);
    assert(html.includes("if (FAILED_RUN_STATUSES.has(status))"), `${label}: error note status mapping missing`);
    assert(html.includes("note.innerHTML = `ERROR<br>Status: ${esc(prettyStatus(status || 'failed'))}`;"), `${label}: error notification content missing`);
  }

  console.log("PASS: RTS feature progress and status color/notifications map active, success, and error states consistently.");
}

run();
