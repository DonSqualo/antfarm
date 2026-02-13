import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface RuntimeError {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface FactoryRuntimeState {
  key: string;
  worktreePath: string;
  basePort: number;
  rendererPort: number;
  serverPort: number;
  running: boolean;
  startedAt?: string;
  lastError?: RuntimeError;
}

export type RuntimeResult<T> = { ok: true; value: T } | RuntimeError;

type CommandRunner = (command: string, args: string[], options: { cwd: string }) => void;
type PortChecker = (port: number) => Promise<boolean>;

function normalizePort(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const port = Math.floor(n);
  if (port < 1 || port > 65534) return null;
  return port;
}

function defaultRuntimeKey(basePort: number): string {
  return `factory-${basePort}`;
}

function normalizeWorktree(worktreePathRaw: string): string {
  const raw = String(worktreePathRaw || "").trim();
  if (!raw) return "";
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  return path.normalize(absolute);
}

function buildError(code: string, message: string, details?: Record<string, unknown>): RuntimeError {
  return { ok: false, code, message, ...(details ? { details } : {}) };
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function defaultCommandRunner(command: string, args: string[], options: { cwd: string }): void {
  execFileSync(command, args, { cwd: options.cwd, stdio: "pipe" });
}

export class MittensFactoryRuntimeManager {
  private readonly runtimes = new Map<string, FactoryRuntimeState>();
  private readonly runCommand: CommandRunner;
  private readonly checkPortAvailable: PortChecker;

  constructor(options?: { runCommand?: CommandRunner; checkPortAvailable?: PortChecker }) {
    this.runCommand = options?.runCommand ?? defaultCommandRunner;
    this.checkPortAvailable = options?.checkPortAvailable ?? isPortAvailable;
  }

  statusByPort(portValue: unknown): RuntimeResult<FactoryRuntimeState | null> {
    const basePort = normalizePort(portValue);
    if (!basePort) return buildError("invalid_port", "Factory port must be an integer between 1 and 65534.");
    const key = defaultRuntimeKey(basePort);
    return { ok: true, value: this.runtimes.get(key) ?? null };
  }

  async startByPort(worktreePathRaw: string, portValue: unknown): Promise<RuntimeResult<FactoryRuntimeState>> {
    const basePort = normalizePort(portValue);
    if (!basePort) return buildError("invalid_port", "Factory port must be an integer between 1 and 65534.");

    const worktreePath = normalizeWorktree(worktreePathRaw);
    if (!worktreePath) return buildError("missing_worktree", "Factory worktree path is required.");
    if (!fs.existsSync(worktreePath) || !fs.statSync(worktreePath).isDirectory()) {
      return buildError("worktree_not_found", "Factory worktree path does not exist.", { worktreePath });
    }

    const key = defaultRuntimeKey(basePort);
    const rendererPort = basePort;
    const serverPort = basePort + 1;

    const existing = this.runtimes.get(key);
    if (existing?.running && existing.worktreePath === worktreePath) {
      return { ok: true, value: existing };
    }

    if (existing?.running && existing.worktreePath !== worktreePath) {
      const stopped = this.stopByPort(basePort);
      if (!stopped.ok) return stopped;
    }

    const rendererAvailable = await this.checkPortAvailable(rendererPort);
    const serverAvailable = await this.checkPortAvailable(serverPort);
    if (!rendererAvailable || !serverAvailable) {
      return buildError("port_in_use", "Factory runtime ports are already in use.", {
        rendererPort,
        serverPort,
        occupiedPorts: [rendererAvailable ? null : rendererPort, serverAvailable ? null : serverPort].filter((v) => v !== null),
      });
    }

    try {
      this.runCommand("mittens", ["renderer", "start", "--port", String(rendererPort)], { cwd: worktreePath });
      try {
        this.runCommand("mittens", ["server", "start", "--port", String(serverPort)], { cwd: worktreePath });
      } catch (err) {
        try {
          this.runCommand("mittens", ["renderer", "stop", "--port", String(rendererPort)], { cwd: worktreePath });
        } catch {}
        throw err;
      }

      const next: FactoryRuntimeState = {
        key,
        worktreePath,
        basePort,
        rendererPort,
        serverPort,
        running: true,
        startedAt: new Date().toISOString(),
      };
      this.runtimes.set(key, next);
      return { ok: true, value: next };
    } catch (err) {
      const runtimeError = buildError("start_failed", err instanceof Error ? err.message : String(err), {
        key,
        worktreePath,
        rendererPort,
        serverPort,
      });
      this.runtimes.set(key, {
        key,
        worktreePath,
        basePort,
        rendererPort,
        serverPort,
        running: false,
        lastError: runtimeError,
      });
      return runtimeError;
    }
  }

  stopByPort(portValue: unknown): RuntimeResult<{ key: string; stopped: boolean }> {
    const basePort = normalizePort(portValue);
    if (!basePort) return buildError("invalid_port", "Factory port must be an integer between 1 and 65534.");

    const key = defaultRuntimeKey(basePort);
    const existing = this.runtimes.get(key);
    if (!existing) return { ok: true, value: { key, stopped: false } };
    if (!existing.running) return { ok: true, value: { key, stopped: false } };

    try {
      this.runCommand("mittens", ["renderer", "stop", "--port", String(existing.rendererPort)], { cwd: existing.worktreePath });
      this.runCommand("mittens", ["server", "stop", "--port", String(existing.serverPort)], { cwd: existing.worktreePath });
      this.runtimes.set(key, { ...existing, running: false });
      return { ok: true, value: { key, stopped: true } };
    } catch (err) {
      const runtimeError = buildError("stop_failed", err instanceof Error ? err.message : String(err), {
        key,
        worktreePath: existing.worktreePath,
        rendererPort: existing.rendererPort,
        serverPort: existing.serverPort,
      });
      this.runtimes.set(key, { ...existing, lastError: runtimeError });
      return runtimeError;
    }
  }
}

export const mittensFactoryRuntimeManager = new MittensFactoryRuntimeManager();
