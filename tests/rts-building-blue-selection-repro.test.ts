import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

test('repro doc exists for RTS building blue highlight (text selection)', () => {
  const docPath = path.join(repoRoot, 'docs', 'repros', 'rts-building-blue-selection.md');
  assert.ok(fs.existsSync(docPath), `Missing repro doc at ${docPath}`);

  const body = fs.readFileSync(docPath, 'utf8');
  assert.match(body, /Minimal reproduction/i);
  assert.match(body, /Expected/i);
  assert.match(body, /Actual/i);

  // Must identify root elements + file path where selection is wired.
  assert.match(body, /src\/server\/rts\.html/);
  assert.match(body, /renderWorld\(\)/);

  // Must identify selectors involved.
  assert.match(body, /#worldWrap/);
  assert.match(body, /\.entity\.building/);
  assert.match(body, /\.port-chip/);

  // Must clarify it's user-select/text selection rather than pointer-events.
  assert.match(body, /native text selection/i);
  assert.match(body, /user-select/i);
  assert.match(body, /pointer-events/i);
});
