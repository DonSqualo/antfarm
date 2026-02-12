import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const regressionTests = [
  "step-context-parsing-regression.test.ts",
  "loop-retry-state-consistency.test.ts",
  "rts-layout-nullpath-reconciliation.test.ts",
  "rts-run-deletion-idempotency.test.ts",
] as const;

function runRegressionTest(fileName: string): void {
  const testPath = path.join(__dirname, fileName);
  const output = execFileSync(process.execPath, [testPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.match(
    output,
    /tests passed/i,
    `Expected ${fileName} to report a successful regression run`
  );
}

function run(): void {
  for (const testFile of regressionTests) {
    runRegressionTest(testFile);
  }

  console.log("repo health regression suite tests passed");
}

run();
