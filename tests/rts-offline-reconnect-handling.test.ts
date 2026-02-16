import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const srcHtmlPath = path.join(repoRoot, "src/server/rts.html");
const distHtmlPath = path.join(repoRoot, "dist/server/rts.html");
const srcSwPath = path.join(repoRoot, "src/server/service-worker.v1.js");
const distSwPath = path.join(repoRoot, "dist/server/service-worker.v1.js");

function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

for (const [label, filePath] of [["src", srcHtmlPath], ["dist", distHtmlPath]] as const) {
  test(`${label}: mobile shell renders explicit connectivity status`, () => {
    const html = read(filePath);
    assert.match(html, /id="connectivityBanner"/);
    assert.match(html, /id="mobileStatusNet"/);
    assert.match(html, /function setConnectivityState\(mode, detail = ''\)/);
    assert.match(html, /window\.addEventListener\('offline'/);
    assert.match(html, /window\.addEventListener\('online'/);
  });

  test(`${label}: runtime polling uses bounded retry backoff`, () => {
    const html = read(filePath);
    assert.match(html, /function boundedRetryDelayMs\(failures\)/);
    assert.match(html, /Math\.min\(state\.runtimePoll\.maxDelayMs, delay\)/);
    assert.match(html, /state\.runtimePoll\.failures = Number\(state\.runtimePoll\.failures \|\| 0\) \+ 1/);
    assert.match(html, /scheduleRuntimePoll\(delay\)/);
  });
}

for (const [label, filePath] of [["src", srcSwPath], ["dist", distSwPath]] as const) {
  test(`${label}: service worker provides navigation offline fallback and static runtime cache`, () => {
    const sw = read(filePath);
    assert.match(sw, /if \(request\.mode === "navigate"\)/);
    assert.match(sw, /const cachedShell = await caches\.match\("\/rts"\);/);
    assert.match(sw, /function isStaticAsset\(requestUrl\)/);
    assert.match(sw, /cache\.put\(request, response\.clone\(\)\)/);
  });
}
