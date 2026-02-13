import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function normalizeDaemonKey(raw?: string): string {
  const key = String(raw || "main").trim().toLowerCase();
  const cleaned = key.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "main";
}

export function getPidFile(daemonKey = "main"): string {
  const key = normalizeDaemonKey(daemonKey);
  if (key === "main") return path.join(os.homedir(), ".openclaw", "antfarm", "dashboard.pid");
  return path.join(os.homedir(), ".openclaw", "antfarm", `dashboard.${key}.pid`);
}

export function getLogFile(daemonKey = "main"): string {
  const key = normalizeDaemonKey(daemonKey);
  if (key === "main") return path.join(os.homedir(), ".openclaw", "antfarm", "dashboard.log");
  return path.join(os.homedir(), ".openclaw", "antfarm", `dashboard.${key}.log`);
}

export function isRunning(daemonKey = "main"): { running: true; pid: number } | { running: false } {
  const pidFile = getPidFile(daemonKey);
  if (!fs.existsSync(pidFile)) return { running: false };
  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  if (isNaN(pid)) return { running: false };
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // Stale PID file
    try { fs.unlinkSync(pidFile); } catch {}
    return { running: false };
  }
}

export async function startDaemon(
  port = 3333,
  options?: { cwd?: string; daemonKey?: string }
): Promise<{ pid: number; port: number }> {
  const daemonKey = normalizeDaemonKey(options?.daemonKey);
  const status = isRunning(daemonKey);
  if (status.running) {
    return { pid: status.pid, port };
  }

  const logFile = getLogFile(daemonKey);
  const pidDir = path.dirname(getPidFile(daemonKey));
  fs.mkdirSync(pidDir, { recursive: true });

  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(logFile, "a");

  const daemonScript = path.resolve(__dirname, "daemon.js");
  const child = spawn("node", [daemonScript, String(port)], {
    cwd: options?.cwd || process.cwd(),
    detached: true,
    stdio: ["ignore", out, err],
    env: {
      ...process.env,
      AF_DAEMON_KEY: daemonKey,
    },
  });
  child.unref();

  // Wait 1s then confirm
  await new Promise((r) => setTimeout(r, 1000));

  const check = isRunning(daemonKey);
  if (!check.running) {
    throw new Error("Daemon failed to start. Check " + logFile);
  }
  return { pid: check.pid, port };
}

export function stopDaemon(daemonKey = "main"): boolean {
  const status = isRunning(daemonKey);
  if (!status.running) return false;
  try {
    process.kill(status.pid, "SIGTERM");
  } catch {}
  try { fs.unlinkSync(getPidFile(daemonKey)); } catch {}
  return true;
}

export function getDaemonStatus(daemonKey = "main"): { running: boolean; pid?: number; port?: number } | null {
  const status = isRunning(daemonKey);
  if (!status.running) return { running: false };
  return { running: true, pid: status.pid };
}
