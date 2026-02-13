#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startDashboard } from "./dashboard.js";

const port = parseInt(process.argv[2], 10) || 3333;
const daemonKeyRaw = String(process.env.AF_DAEMON_KEY || "main").trim().toLowerCase();
const daemonKey = daemonKeyRaw.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "main";

const pidDir = path.join(os.homedir(), ".openclaw", "antfarm");
const pidFile = daemonKey === "main"
  ? path.join(pidDir, "dashboard.pid")
  : path.join(pidDir, `dashboard.${daemonKey}.pid`);

fs.mkdirSync(pidDir, { recursive: true });
fs.writeFileSync(pidFile, String(process.pid));

process.on("SIGTERM", () => {
  try { fs.unlinkSync(pidFile); } catch {}
  process.exit(0);
});

startDashboard(port);
