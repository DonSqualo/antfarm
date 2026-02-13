import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { MittensFactoryRuntimeManager } from "./mittens-runtime.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-mittens-runtime-"));
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function mkWorktree(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("startByPort runs mittens renderer/server with paired ports and tracks runtime status", async () => {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const manager = new MittensFactoryRuntimeManager({
    runCommand: (command, args, options) => calls.push({ command, args, cwd: options.cwd }),
    checkPortAvailable: async () => true,
  });

  const worktree = mkWorktree("factory-a");
  const started = await manager.startByPort(worktree, 3401);
  assert.equal(started.ok, true);
  if (!started.ok) return;

  assert.equal(started.value.rendererPort, 3401);
  assert.equal(started.value.serverPort, 3402);

  assert.deepEqual(calls, [
    { command: "mittens", args: ["renderer", "start", "--port", "3401"], cwd: worktree },
    { command: "mittens", args: ["server", "start", "--port", "3402"], cwd: worktree },
  ]);

  const status = manager.statusByPort(3401);
  assert.equal(status.ok, true);
  if (!status.ok) return;
  assert.equal(status.value?.running, true);
  assert.equal(status.value?.key, "factory-3401");
});

test("startByPort validates worktree and port with structured errors and no process calls", async () => {
  const calls: string[] = [];
  const manager = new MittensFactoryRuntimeManager({
    runCommand: () => calls.push("called"),
    checkPortAvailable: async () => true,
  });

  const badPort = await manager.startByPort(mkWorktree("factory-b"), 65535);
  assert.equal(badPort.ok, false);
  if (badPort.ok) return;
  assert.equal(badPort.code, "invalid_port");

  const badPath = await manager.startByPort(path.join(tmpRoot, "missing"), 3405);
  assert.equal(badPath.ok, false);
  if (badPath.ok) return;
  assert.equal(badPath.code, "worktree_not_found");

  assert.equal(calls.length, 0);
});

test("startByPort fails cleanly when either runtime port is occupied", async () => {
  const manager = new MittensFactoryRuntimeManager({
    runCommand: () => {
      throw new Error("should not be called");
    },
    checkPortAvailable: async (port) => port !== 3601,
  });

  const started = await manager.startByPort(mkWorktree("factory-c"), 3600);
  assert.equal(started.ok, false);
  if (started.ok) return;
  assert.equal(started.code, "port_in_use");
});

test("startByPort stops renderer when server startup fails; stopByPort is idempotent", async () => {
  const calls: Array<{ args: string[] }> = [];
  const manager = new MittensFactoryRuntimeManager({
    runCommand: (_command, args) => {
      calls.push({ args });
      if (args[0] === "server" && args[1] === "start") throw new Error("server start failed");
    },
    checkPortAvailable: async () => true,
  });

  const failed = await manager.startByPort(mkWorktree("factory-d"), 3700);
  assert.equal(failed.ok, false);
  if (failed.ok) return;
  assert.equal(failed.code, "start_failed");

  assert.deepEqual(
    calls.map((c) => c.args),
    [
      ["renderer", "start", "--port", "3700"],
      ["server", "start", "--port", "3701"],
      ["renderer", "stop", "--port", "3700"],
    ]
  );

  const stopFirst = manager.stopByPort(3700);
  assert.equal(stopFirst.ok, true);
  if (!stopFirst.ok) return;
  assert.equal(stopFirst.value.stopped, false);

  const stopSecond = manager.stopByPort(3700);
  assert.equal(stopSecond.ok, true);
});
