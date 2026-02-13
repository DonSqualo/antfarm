import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { getDb } from "../db.js";
import { resolveBundledWorkflowsDir } from "../installer/paths.js";
import { runWorkflow } from "../installer/run.js";
import { teardownWorkflowCronsIfIdle } from "../installer/agent-cron.js";
import { emitEvent } from "../installer/events.js";
import { createImmediateHandoffHandler } from "../installer/immediate-handoff.js";
import { isRunning as isDashboardRunning, startDaemon, stopDaemon } from "./daemonctl.js";
import YAML from "yaml";

import type { RunInfo, StepInfo } from "../installer/status.js";
import { getRunEvents } from "../installer/events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const immediateHandoff = createImmediateHandoffHandler();

interface WorkflowDef {
  id: string;
  name: string;
  steps: Array<{ id: string; agent: string }>;
}

function loadWorkflows(): WorkflowDef[] {
  const dir = resolveBundledWorkflowsDir();
  const results: WorkflowDef[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const ymlPath = path.join(dir, entry.name, "workflow.yml");
      if (!fs.existsSync(ymlPath)) continue;
      const parsed = YAML.parse(fs.readFileSync(ymlPath, "utf-8"));
      results.push({
        id: parsed.id ?? entry.name,
        name: parsed.name ?? entry.name,
        steps: (parsed.steps ?? []).map((s: any) => ({ id: s.id, agent: s.agent })),
      });
    }
  } catch { /* empty */ }
  return results;
}

function getRuns(workflowId?: string): Array<RunInfo & { steps: StepInfo[] }> {
  const db = getDb();
  const runs = workflowId
    ? db.prepare("SELECT * FROM runs WHERE workflow_id = ? ORDER BY created_at DESC").all(workflowId) as RunInfo[]
    : db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as RunInfo[];
  return runs.map((r) => {
    const steps = db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY step_index ASC").all(r.id) as StepInfo[];
    return { ...r, steps };
  });
}

function getRunById(id: string): (RunInfo & { steps: StepInfo[] }) | null {
  const db = getDb();
  const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunInfo | undefined;
  if (!run) return null;
  const steps = db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY step_index ASC").all(run.id) as StepInfo[];
  return { ...run, steps };
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

function ensureRtsTables(db = getDb()): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS rts_state (" +
    "id INTEGER PRIMARY KEY CHECK (id = 1), " +
    "state_json TEXT NOT NULL DEFAULT '{}', " +
    "updated_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ")"
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS rts_layout_entities (" +
    "id TEXT PRIMARY KEY, " +
    "entity_type TEXT NOT NULL, " +
    "run_id TEXT, " +
    "repo_path TEXT, " +
    "worktree_path TEXT, " +
    "x REAL NOT NULL DEFAULT 0, " +
    "y REAL NOT NULL DEFAULT 0, " +
    "payload_json TEXT NOT NULL DEFAULT '{}', " +
    "updated_at TEXT NOT NULL" +
    ")"
  );
}

function normalizePathKey(raw: string): string {
  return String(raw || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function normalizeRepoPath(rawPath: string): string {
  const trimmed = String(rawPath || "").trim();
  if (!trimmed) return "";
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(process.cwd(), trimmed);
}

function isGitRepoPath(repoPathRaw: string): boolean {
  const repoPath = normalizeRepoPath(repoPathRaw);
  if (!repoPath) return false;
  try {
    if (!fs.existsSync(repoPath)) return false;
    const gitMeta = path.join(repoPath, ".git");
    if (!fs.existsSync(gitMeta)) return false;
    const st = fs.lstatSync(gitMeta);
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

function inferSuggestedPortForRepo(repoPathRaw: string): number | null {
  const key = normalizePathKey(repoPathRaw);
  if (!key) return null;
  if (/\/antfarm$/i.test(key)) return 3333;
  const featureMatch = key.match(/antfarm-feature-(\d+)/i);
  if (featureMatch) {
    const n = Number(featureMatch[1] || 0);
    if (Number.isFinite(n)) return 3400 + (n % 400);
  }
  const featureName = path.basename(key);
  if (/^antfarm-feature-/i.test(featureName)) {
    let hash = 2166136261;
    for (let i = 0; i < featureName.length; i++) {
      hash ^= featureName.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return 3500 + ((hash >>> 0) % 500);
  }
  return null;
}

function listLocalGitRepos(): Array<{ path: string; name: string; suggestedPort?: number }> {
  const envRoots = String(process.env.ANTFARM_LOCAL_REPO_ROOTS || "")
    .split(/[,:;]/)
    .map((v) => normalizeRepoPath(v))
    .filter(Boolean);
  const roots = [
    ...envRoots,
    normalizeRepoPath(process.cwd()),
    normalizeRepoPath(path.resolve(process.cwd(), "..")),
    normalizeRepoPath(path.join(os.homedir(), ".openclaw", "workspace")),
  ].filter(Boolean);
  const seenRoots = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = [];
  for (const root of roots) {
    if (!root || seenRoots.has(root)) continue;
    seenRoots.add(root);
    queue.push({ dir: root, depth: 0 });
  }

  const skipDirs = new Set([".git", "node_modules", "dist", "build", ".next", "target", ".turbo", ".cache", "coverage"]);
  const skipDirPatterns: RegExp[] = [/^mittens-projects$/i, /^branch-cleanup-backups$/i];
  const maxDepth = 3;
  const maxRepos = 200;
  const seenRepos = new Set<string>();
  const repos: Array<{ path: string; name: string; suggestedPort?: number; mtimeMs: number }> = [];

  while (queue.length && repos.length < maxRepos) {
    const current = queue.shift() as { dir: string; depth: number };
    const dir = current.dir;
    if (!dir) continue;
    if (isGitRepoPath(dir)) {
      const repoPath = normalizePathKey(dir);
      if (!seenRepos.has(repoPath)) {
        seenRepos.add(repoPath);
        let mtimeMs = 0;
        try {
          mtimeMs = Number(fs.statSync(repoPath).mtimeMs || 0);
        } catch {}
        const suggested = inferSuggestedPortForRepo(repoPath);
        repos.push({
          path: repoPath,
          name: path.basename(repoPath) || repoPath,
          ...(suggested ? { suggestedPort: suggested } : {}),
          mtimeMs,
        });
      }
    }
    if (current.depth >= maxDepth) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (skipDirs.has(ent.name)) continue;
      if (skipDirPatterns.some((re) => re.test(ent.name))) continue;
      const full = path.join(dir, ent.name);
      queue.push({ dir: full, depth: current.depth + 1 });
    }
  }

  const chosen = repos.sort((a, b) =>
    Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0) ||
    a.path.localeCompare(b.path)
  );
  return chosen.map((r) => ({ path: r.path, name: r.name, ...(r.suggestedPort ? { suggestedPort: r.suggestedPort } : {}) }));
}

function isValidPortValue(portValue: unknown): number | null {
  const n = Number(portValue);
  if (!Number.isFinite(n)) return null;
  const port = Math.floor(n);
  if (port < 1 || port > 65535) return null;
  return port;
}

function factoryRuntimeKey(port: number): string {
  return `factory-${port}`;
}

function ensureFactoryRuntime(worktreePathRaw: string, portValue: unknown): { ok: boolean; port?: number; key?: string; message?: string } {
  const port = isValidPortValue(portValue);
  if (!port) return { ok: false, message: "invalid_port" };
  const worktreePath = normalizePathKey(worktreePathRaw);
  if (!worktreePath) return { ok: false, message: "missing_worktree" };
  if (!fs.existsSync(worktreePath)) return { ok: false, message: "worktree_not_found" };
  const key = factoryRuntimeKey(port);
  try {
    // Always restart this per-port runtime so it follows the latest worktree path.
    if (isDashboardRunning(key).running) stopDaemon(key);
    startDaemon(port, { cwd: worktreePath, daemonKey: key }).catch(() => {});
    return { ok: true, port, key };
  } catch (err) {
    return { ok: false, port, key, message: err instanceof Error ? err.message : String(err) };
  }
}

function stopFactoryRuntimeByPort(portValue: unknown): { ok: boolean; stopped: boolean; port?: number } {
  const port = isValidPortValue(portValue);
  if (!port) return { ok: false, stopped: false };
  const key = factoryRuntimeKey(port);
  const stopped = stopDaemon(key);
  return { ok: true, stopped, port };
}

function resolveResearchRepoPath(rawRepoPath: string): string {
  const candidates = [
    normalizePathKey(rawRepoPath),
    normalizePathKey(process.cwd()),
    normalizePathKey(path.resolve(process.cwd(), "..", "antfarm")),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      if (fs.existsSync(path.join(candidate, ".git"))) return candidate;
    } catch {}
  }
  return "";
}

function absolutizePath(pathValue: string, repoPath: string): string {
  const key = normalizePathKey(pathValue);
  if (!key) return "";
  if (key.startsWith("/")) return key;
  if (/^[A-Za-z]:\//.test(key)) return key;
  const base = normalizePathKey(repoPath);
  if (!base) return key;
  const stack = base.split("/");
  for (const part of key.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

const LIBRARY_WORKER_ROLES = ["planner", "setup", "developer", "verifier", "tester", "reviewer"] as const;
type LibraryWorkerRole = typeof LIBRARY_WORKER_ROLES[number];

function isAntfarmRoot(dir: string): boolean {
  try {
    if (!fs.existsSync(path.join(dir, "workflows"))) return false;
    if (!fs.existsSync(path.join(dir, "src", "server", "rts.html"))) return false;
    const pkgPath = path.join(dir, "package.json");
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name?: string };
    return String(pkg.name || "").trim() === "antfarm";
  } catch {
    return false;
  }
}

function findAntfarmRootFromCwd(): string {
  let cur = normalizePathKey(process.cwd());
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (isAntfarmRoot(cur)) return cur;
    const parent = normalizePathKey(path.dirname(cur));
    if (!parent || parent === cur) break;
    cur = parent;
  }
  const cwd = normalizePathKey(process.cwd());
  const directChild = normalizePathKey(path.join(cwd, "antfarm"));
  if (directChild && isAntfarmRoot(directChild)) return directChild;
  return cwd;
}

function listLibraryRoots(): string[] {
  const home = os.homedir();
  const primary = findAntfarmRootFromCwd();
  const roots = [
    primary,
    normalizePathKey(path.join(home, ".openclaw", "antfarm")),
    normalizePathKey(path.join(home, ".openclaw", "workspaces", "workflows")),
  ].filter(Boolean);
  const uniq = new Set<string>();
  const resolved: string[] = [];
  for (const root of roots) {
    if (uniq.has(root)) continue;
    uniq.add(root);
    try {
      if (!fs.existsSync(root)) continue;
      resolved.push(root);
    } catch {}
  }
  return resolved;
}

function pathTagsForLibrary(relPathRaw: string): string[] {
  const relPath = String(relPathRaw || "").replace(/\\/g, "/");
  const lower = relPath.toLowerCase();
  const tags = new Set<string>();
  tags.add("md");
  if (/(^|\/)agents\//.test(lower)) tags.add("agents");
  if (/(^|\/)workflows\//.test(lower)) tags.add("workflows");
  if (/(^|\/)docs\//.test(lower) || /readme\.md$/.test(lower)) tags.add("docs");
  if (/agents\.md$/.test(lower)) tags.add("instructions");
  if (/skill\.md$/.test(lower)) tags.add("skills");
  if (/memory\.md$/.test(lower)) tags.add("memory");
  if (/security/.test(lower)) tags.add("security");
  if (/design|plan|roadmap|spec/.test(lower)) tags.add("planning");
  if (/setup|install|provision/.test(lower)) tags.add("setup");
  if (/review|pr\b/.test(lower)) tags.add("review");
  if (/verif|audit|lint|qa/.test(lower)) tags.add("verification");
  if (/test/.test(lower)) tags.add("testing");
  if (/research/.test(lower)) tags.add("research");
  return [...tags].sort();
}

function rolesForLibraryPath(relPathRaw: string, tags: string[]): LibraryWorkerRole[] {
  const relPath = String(relPathRaw || "").replace(/\\/g, "/");
  const lower = relPath.toLowerCase();
  const roleMatchers: Array<{ role: LibraryWorkerRole; re: RegExp }> = [
    { role: "planner", re: /(^|\/)(planner)(\/|$)/ },
    { role: "setup", re: /(^|\/)(setup)(\/|$)/ },
    { role: "developer", re: /(^|\/)(developer)(\/|$)/ },
    { role: "verifier", re: /(^|\/)(verifier)(\/|$)/ },
    { role: "tester", re: /(^|\/)(tester)(\/|$)/ },
    { role: "reviewer", re: /(^|\/)(reviewer|pr)(\/|$)/ },
  ];

  for (const { role, re } of roleMatchers) {
    if (re.test(lower)) return [role];
  }
  return [];
}

function relativeLibraryPath(filePath: string, roots: string[]): string {
  const full = normalizePathKey(filePath);
  for (const root of roots) {
    if (full === root) return path.basename(full) || full;
    if (full.startsWith(`${root}/`)) return full.slice(root.length + 1);
  }
  return full;
}

function listLibraryMarkdownFiles(input: { role?: string; tag?: string; q?: string; max?: number }): {
  role: string;
  tag: string;
  q: string;
  roots: string[];
  tags: string[];
  files: Array<{
    path: string;
    absPath: string;
    root: string;
    size: number;
    mtimeMs: number;
    tags: string[];
    roles: string[];
  }>;
} {
  const role = String(input.role || "all").trim().toLowerCase();
  const tag = String(input.tag || "all").trim().toLowerCase();
  const q = String(input.q || "").trim().toLowerCase();
  const max = Number.isFinite(Number(input.max)) ? Math.max(50, Math.min(12000, Math.floor(Number(input.max)))) : 5000;
  const roots = listLibraryRoots();
  const skipDirs = new Set([".git", "node_modules", "dist", "build", ".next", "target", ".turbo", ".cache", "coverage"]);
  const skipDirPatterns: RegExp[] = [
    /^antfarm-feature-/i,
    /^branch-cleanup-backups$/i,
  ];
  const stack = [...roots];
  const files: Array<{
    path: string;
    absPath: string;
    root: string;
    size: number;
    mtimeMs: number;
    tags: string[];
    roles: string[];
  }> = [];
  const tagSet = new Set<string>();
  while (stack.length && files.length < max) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        if (skipDirPatterns.some((re) => re.test(ent.name))) continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!/\.md$/i.test(ent.name)) continue;
      const root = roots.find((r) => full === r || full.startsWith(`${r}${path.sep}`)) || roots[0] || "";
      const relPath = relativeLibraryPath(full, roots);
      const tags = pathTagsForLibrary(relPath);
      const roles = rolesForLibraryPath(relPath, tags);
      if (role !== "all" && !roles.includes(role as LibraryWorkerRole)) continue;
      if (tag !== "all" && !tags.includes(tag)) continue;
      if (q) {
        const hay = `${relPath}\n${tags.join(" ")}\n${roles.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(full);
        size = Number(st.size || 0);
        mtimeMs = Number(st.mtimeMs || 0);
      } catch {}
      tags.forEach((t) => tagSet.add(t));
      files.push({
        path: relPath,
        absPath: normalizePathKey(full),
        root: normalizePathKey(root),
        size,
        mtimeMs,
        tags,
        roles,
      });
      if (files.length >= max) break;
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
  return {
    role,
    tag,
    q,
    roots,
    tags: [...tagSet].sort(),
    files,
  };
}

function readLibraryMarkdownFile(absPathRaw: string): { path: string; content: string; size: number; mtimeMs: number } {
  const absPath = normalizePathKey(absPathRaw);
  if (!absPath) throw new Error("path is required");
  if (!/\.md$/i.test(absPath)) throw new Error("only .md files are allowed");
  const roots = listLibraryRoots();
  const insideRoot = roots.some((root) => absPath === root || absPath.startsWith(`${root}/`));
  if (!insideRoot) throw new Error("path is outside library roots");
  if (!fs.existsSync(absPath)) throw new Error("file not found");
  const st = fs.statSync(absPath);
  if (!st.isFile()) throw new Error("not a file");
  if (st.size > 2_000_000) throw new Error("file too large");
  const content = fs.readFileSync(absPath, "utf-8");
  return { path: absPath, content, size: Number(st.size || 0), mtimeMs: Number(st.mtimeMs || 0) };
}

function getRtsState(): Record<string, unknown> {
  // RTS consistency invariant:
  // UI state must reflect authoritative Antfarm runtime state on this machine.
  // Any layout/state rows that reference missing runs are reconciled away here.
  const db = getDb();
  ensureRtsTables(db);
  const row = db.prepare("SELECT state_json FROM rts_state WHERE id = 1").get() as { state_json: string } | undefined;
  let state: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row?.state_json || "{}");
    if (parsed && typeof parsed === "object") state = parsed as Record<string, unknown>;
  } catch {
    state = {};
  }
  // Legacy cleanup: these are now entity-owned or ephemeral and should not be revived from rts_state.
  delete (state as Record<string, unknown>).baseDrafts;
  delete (state as Record<string, unknown>).researchPlansByRepo;
  delete (state as Record<string, unknown>).warehouseItemsByRepo;
  delete (state as Record<string, unknown>).portByPath;
  const rows = db.prepare(
    "SELECT id, entity_type, run_id, repo_path, worktree_path, x, y, payload_json FROM rts_layout_entities ORDER BY updated_at DESC"
  ).all() as Array<{
    id: string;
    entity_type: string;
    run_id: string | null;
    repo_path: string | null;
    worktree_path: string | null;
    x: number;
    y: number;
    payload_json: string | null;
  }>;
  const customBases: Array<Record<string, unknown>> = [];
  const featureBuildings: Array<Record<string, unknown>> = [];
  const researchBuildings: Array<Record<string, unknown>> = [];
  const warehouseBuildings: Array<Record<string, unknown>> = [];
  const runLayoutOverrides: Record<string, { x: number; y: number }> = {};
  const runs = db.prepare("SELECT id, status, context FROM runs").all() as Array<{ id: string; status: string; context: string }>;
  const runIdSet = new Set(runs.map((r) => r.id));
  const runByWorktree = new Map<string, { id: string; status: string; worktree: string }>();
  const runByWorktreeBase = new Map<string, { id: string; status: string; worktree: string }>();
  for (const run of runs) {
    let ctx: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(run.context || "{}");
      if (parsed && typeof parsed === "object") ctx = parsed as Record<string, unknown>;
    } catch {}
    const baseRepo = String(ctx.baseRepoPath || ctx.repoPath || ctx.repo || "");
    const wt = absolutizePath(String(ctx.worktreePath || ""), baseRepo);
    if (wt) {
      runByWorktree.set(wt, { id: run.id, status: run.status, worktree: wt });
      const bn = path.basename(wt);
      if (bn && !runByWorktreeBase.has(bn)) runByWorktreeBase.set(bn, { id: run.id, status: run.status, worktree: wt });
    }
  }
  const seenFeatureKeys = new Set<string>();
  for (const r of rows) {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(r.payload_json || "{}");
      if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
    } catch {}
    if (r.entity_type === "base") {
      customBases.push({
        ...payload,
        id: payload.id ?? r.id,
        x: Number(r.x),
        y: Number(r.y),
        repo: r.repo_path ?? payload.repo ?? "",
        source: "custom",
      });
      continue;
    }
    if (r.entity_type === "feature") {
      const repoPath = String(r.repo_path ?? payload.repo ?? "");
      const worktreePath = absolutizePath(String(r.worktree_path ?? payload.worktreePath ?? ""), repoPath);
      let resolvedRunId = (r.run_id ?? payload.runId ?? null) as string | null;
      let resolvedStatus: string | null = null;
      if (resolvedRunId && !runIdSet.has(resolvedRunId)) {
        // Layout pointed at a deleted run: heal to draft mode immediately.
        resolvedRunId = null;
        try {
          db.prepare("UPDATE rts_layout_entities SET run_id = NULL, updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), r.id);
        } catch {}
      }
      if (!resolvedRunId && worktreePath) {
        const inferred = runByWorktree.get(worktreePath) || runByWorktreeBase.get(path.basename(worktreePath));
        if (inferred) {
          resolvedRunId = inferred.id;
          resolvedStatus = inferred.status;
          const canonicalWorktreePath = inferred.worktree || worktreePath;
          // Heal stale layout row directly in DB when we can infer the run id.
          try {
            db.prepare("UPDATE rts_layout_entities SET run_id = ?, worktree_path = ?, updated_at = ? WHERE id = ?")
              .run(inferred.id, canonicalWorktreePath, new Date().toISOString(), r.id);
          } catch {}
        }
      }
      const dedupeKey = resolvedRunId ? `run:${resolvedRunId}` : `draft:${worktreePath || r.id}`;
      if (seenFeatureKeys.has(dedupeKey)) continue;
      seenFeatureKeys.add(dedupeKey);
      featureBuildings.push({
        ...payload,
        id: payload.id ?? r.id,
        kind: "feature",
        x: Number(r.x),
        y: Number(r.y),
        repo: repoPath,
        worktreePath: worktreePath || String(r.worktree_path ?? payload.worktreePath ?? ""),
        runId: resolvedRunId,
        committed: resolvedRunId ? true : payload.committed,
        phase: resolvedStatus || payload.phase || (resolvedRunId ? "running" : "draft"),
      });
      continue;
    }
    if (r.entity_type === "research") {
      const repoPath = String(r.repo_path ?? payload.repo ?? "");
      const worktreePath = absolutizePath(String(r.worktree_path ?? payload.worktreePath ?? ""), repoPath) || repoPath;
      const rawKind = String(payload.kind || payload.variant || (String(r.id || "").startsWith("university-") ? "university" : "research")).toLowerCase();
      const kind = rawKind === "university" ? "university" : "research";
      researchBuildings.push({
        ...payload,
        id: payload.id ?? r.id,
        kind,
        x: Number(r.x),
        y: Number(r.y),
        repo: repoPath,
        worktreePath,
      });
      continue;
    }
    if (r.entity_type === "warehouse") {
      const repoPath = String(r.repo_path ?? payload.repo ?? "");
      const worktreePath = absolutizePath(String(r.worktree_path ?? payload.worktreePath ?? ""), repoPath) || repoPath;
      const rawKind = String(payload.kind || payload.variant || (String(r.id || "").startsWith("library-") ? "library" : "warehouse")).toLowerCase();
      const kind = rawKind === "library" ? "library" : (rawKind === "power" ? "power" : "warehouse");
      warehouseBuildings.push({
        ...payload,
        id: payload.id ?? r.id,
        kind,
        x: Number(r.x),
        y: Number(r.y),
        repo: repoPath,
        worktreePath,
      });
      continue;
    }
    if (r.entity_type === "run") {
      const runId = r.run_id || (String(r.id || "").startsWith("run:") ? String(r.id).slice(4) : String(r.id || ""));
      if (!runId) continue;
      if (!runIdSet.has(runId)) {
        try { db.prepare("DELETE FROM rts_layout_entities WHERE id = ?").run(r.id); } catch {}
        continue;
      }
      runLayoutOverrides[runId] = { x: Number(r.x), y: Number(r.y) };
    }
  }
  return { ...state, customBases, featureBuildings, researchBuildings, warehouseBuildings, runLayoutOverrides };
}

function upsertLayoutEntitiesFromState(nextState: Record<string, unknown>): void {
  const db = getDb();
  ensureRtsTables(db);
  const now = new Date().toISOString();
  const upsert = db.prepare(
    "INSERT INTO rts_layout_entities (id, entity_type, run_id, repo_path, worktree_path, x, y, payload_json, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET " +
    "entity_type = excluded.entity_type, run_id = excluded.run_id, repo_path = excluded.repo_path, worktree_path = excluded.worktree_path, " +
    "x = excluded.x, y = excluded.y, payload_json = excluded.payload_json, updated_at = excluded.updated_at"
  );
  const deleteById = db.prepare("DELETE FROM rts_layout_entities WHERE id = ?");
  const customBases = Array.isArray(nextState.customBases) ? nextState.customBases as Array<Record<string, unknown>> : [];
  const featureBuildings = Array.isArray(nextState.featureBuildings) ? nextState.featureBuildings as Array<Record<string, unknown>> : [];
  const researchBuildings = Array.isArray(nextState.researchBuildings) ? nextState.researchBuildings as Array<Record<string, unknown>> : [];
  const warehouseBuildings = Array.isArray(nextState.warehouseBuildings) ? nextState.warehouseBuildings as Array<Record<string, unknown>> : [];
  const runLayoutOverrides = (nextState.runLayoutOverrides && typeof nextState.runLayoutOverrides === "object")
    ? nextState.runLayoutOverrides as Record<string, { x?: number; y?: number }>
    : {};
  const seenBaseIds = new Set<string>();
  const seenFeatureIds = new Set<string>();
  const seenResearchIds = new Set<string>();
  const seenWarehouseIds = new Set<string>();
  const seenRunIds = new Set<string>();
  const runs = db.prepare("SELECT id, context FROM runs").all() as Array<{ id: string; context: string }>;
  const runIdSet = new Set(runs.map((r) => r.id));
  const runByWorktree = new Map<string, string>();
  const runByWorktreeBase = new Map<string, string>();
  const existingPosById = new Map<string, { x: number; y: number }>();
  const existingRunPosByRunId = new Map<string, { x: number; y: number }>();
  const existingRows = db.prepare(
    "SELECT id, entity_type, run_id, x, y FROM rts_layout_entities"
  ).all() as Array<{ id: string; entity_type: string; run_id: string | null; x: number; y: number }>;
  for (const row of existingRows) {
    existingPosById.set(String(row.id), { x: Number(row.x), y: Number(row.y) });
    if (row.entity_type === "run" && row.run_id) {
      existingRunPosByRunId.set(String(row.run_id), { x: Number(row.x), y: Number(row.y) });
    }
  }
  for (const run of runs) {
    let ctx: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(run.context || "{}");
      if (parsed && typeof parsed === "object") ctx = parsed as Record<string, unknown>;
    } catch {}
    const repo = String(ctx.baseRepoPath || ctx.repoPath || ctx.repo || "");
    const wt = absolutizePath(String(ctx.worktreePath || ""), repo);
    if (wt) {
      runByWorktree.set(wt, run.id);
      const bn = path.basename(wt);
      if (bn && !runByWorktreeBase.has(bn)) runByWorktreeBase.set(bn, run.id);
    }
  }
  db.exec("BEGIN");
  try {
    for (const base of customBases) {
      const id = String(base?.id ?? "");
      if (!id) continue;
      seenBaseIds.add(id);
      const repoPath = String(base?.repo ?? "");
      const incomingX = Number(base?.x ?? 0);
      const incomingY = Number(base?.y ?? 0);
      const existing = existingPosById.get(id);
      const x = Number.isFinite(existing?.x) ? Number(existing!.x) : (Number.isFinite(incomingX) ? incomingX : 0);
      const y = Number.isFinite(existing?.y) ? Number(existing!.y) : (Number.isFinite(incomingY) ? incomingY : 0);
      const payload = { ...base, x, y };
      upsert.run(id, "base", null, repoPath || null, null, x, y, JSON.stringify(payload), now);
    }
    for (const feature of featureBuildings) {
      const id = String(feature?.id ?? "");
      if (!id) continue;
      // Snapshot writes cannot create feature layout rows. Creation must come
      // from explicit actions (/api/rts/layout/position or /api/rts/feature/run).
      if (!existingPosById.has(id)) continue;
      const repoPath = String(feature?.repo ?? "");
      const worktreePath = absolutizePath(String(feature?.worktreePath ?? ""), repoPath) || String(feature?.worktreePath ?? "");
      const runIdRaw = feature?.runId;
      let runId = (runIdRaw === null || runIdRaw === undefined || String(runIdRaw).trim() === "") ? null : String(runIdRaw);
      if (runId && !runIdSet.has(runId)) runId = null;
      if (!runId) {
        const absWt = absolutizePath(worktreePath, repoPath);
        const inferred = runByWorktree.get(absWt) || runByWorktreeBase.get(path.basename(absWt || worktreePath));
        if (inferred) runId = inferred;
      }
      const committedRaw = feature?.committed;
      const committed = committedRaw === true || String(committedRaw || "").toLowerCase() === "true";
      // Prevent stale "launched" ghosts (dead runId but committed=true) from being reinserted.
      if (!runId && committed) continue;
      // Run-backed feature rows are positioned via /api/rts/layout/position and
      // launch reconciliation; ignore state snapshot x/y for them to avoid drift.
      if (runId) continue;
      seenFeatureIds.add(id);
      const incomingX = Number(feature?.x ?? 0);
      const incomingY = Number(feature?.y ?? 0);
      const existing = existingPosById.get(id);
      const x = Number.isFinite(existing?.x) ? Number(existing!.x) : (Number.isFinite(incomingX) ? incomingX : 0);
      const y = Number.isFinite(existing?.y) ? Number(existing!.y) : (Number.isFinite(incomingY) ? incomingY : 0);
      const payload = {
        ...feature,
        runId: runId ?? feature.runId ?? null,
        committed: runId ? true : feature.committed,
        worktreePath,
        x,
        y,
      };
      upsert.run(id, "feature", runId, repoPath || null, worktreePath || null, x, y, JSON.stringify(payload), now);
    }
    for (const research of researchBuildings) {
      const id = String(research?.id ?? "");
      if (!id) continue;
      seenResearchIds.add(id);
      const repoPath = String(research?.repo ?? "");
      const incomingX = Number(research?.x ?? 0);
      const incomingY = Number(research?.y ?? 0);
      const existing = existingPosById.get(id);
      const x = Number.isFinite(existing?.x) ? Number(existing!.x) : (Number.isFinite(incomingX) ? incomingX : 0);
      const y = Number.isFinite(existing?.y) ? Number(existing!.y) : (Number.isFinite(incomingY) ? incomingY : 0);
      const worktreePath = absolutizePath(String(research?.worktreePath ?? ""), repoPath) || repoPath || null;
      const payload = { ...research, kind: "research", repo: repoPath, worktreePath, x, y };
      upsert.run(id, "research", null, repoPath || null, worktreePath, x, y, JSON.stringify(payload), now);
    }
    for (const warehouse of warehouseBuildings) {
      const id = String(warehouse?.id ?? "");
      if (!id) continue;
      seenWarehouseIds.add(id);
      const repoPath = String(warehouse?.repo ?? "");
      const incomingX = Number(warehouse?.x ?? 0);
      const incomingY = Number(warehouse?.y ?? 0);
      const existing = existingPosById.get(id);
      const x = Number.isFinite(existing?.x) ? Number(existing!.x) : (Number.isFinite(incomingX) ? incomingX : 0);
      const y = Number.isFinite(existing?.y) ? Number(existing!.y) : (Number.isFinite(incomingY) ? incomingY : 0);
      const worktreePath = absolutizePath(String(warehouse?.worktreePath ?? ""), repoPath) || repoPath || null;
      const rawKind = String(warehouse?.kind ?? warehouse?.variant ?? "warehouse").toLowerCase();
      const kind = rawKind === "library" ? "library" : (rawKind === "power" ? "power" : "warehouse");
      const payload = { ...warehouse, kind, repo: repoPath, worktreePath, x, y };
      upsert.run(id, "warehouse", null, repoPath || null, worktreePath, x, y, JSON.stringify(payload), now);
    }
    for (const [runId, pos] of Object.entries(runLayoutOverrides)) {
      if (!runId) continue;
      seenRunIds.add(runId);
      const id = `run:${runId}`;
      // Snapshot writes cannot create run layout rows.
      if (!existingRunPosByRunId.has(runId) && !existingPosById.has(id)) continue;
      const incomingX = Number(pos?.x ?? 0);
      const incomingY = Number(pos?.y ?? 0);
      const existing = existingRunPosByRunId.get(runId) || existingPosById.get(id);
      const x = Number.isFinite(existing?.x) ? Number(existing!.x) : (Number.isFinite(incomingX) ? incomingX : 0);
      const y = Number.isFinite(existing?.y) ? Number(existing!.y) : (Number.isFinite(incomingY) ? incomingY : 0);
      upsert.run(id, "run", runId, null, null, x, y, JSON.stringify({ runId, x, y }), now);
    }
    const baseRows = db.prepare("SELECT id FROM rts_layout_entities WHERE entity_type = 'base'").all() as Array<{ id: string }>;
    for (const row2 of baseRows) if (!seenBaseIds.has(row2.id)) deleteById.run(row2.id);
    const featureRows = db.prepare("SELECT id, run_id FROM rts_layout_entities WHERE entity_type = 'feature'").all() as Array<{ id: string; run_id: string | null }>;
    for (const row2 of featureRows) {
      if (seenFeatureIds.has(row2.id)) continue;
      // Keep run-backed feature rows even if the latest state snapshot omitted them.
      if (row2.run_id && runIdSet.has(row2.run_id)) continue;
      deleteById.run(row2.id);
    }
    // Research labs are long-lived user structures. Do not prune by omission from
    // snapshot state; stale/incomplete clients can otherwise wipe them.
    const warehouseRows = db.prepare("SELECT id FROM rts_layout_entities WHERE entity_type = 'warehouse'").all() as Array<{ id: string }>;
    for (const row2 of warehouseRows) {
      if (!seenWarehouseIds.has(row2.id)) deleteById.run(row2.id);
    }
    const runRows = db.prepare("SELECT id, run_id FROM rts_layout_entities WHERE entity_type = 'run'").all() as Array<{ id: string; run_id: string | null }>;
    for (const row2 of runRows) {
      const id = row2.run_id || (String(row2.id || "").startsWith("run:") ? String(row2.id).slice(4) : "");
      if (!id || !seenRunIds.has(id)) deleteById.run(row2.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function deleteLayoutEntity(entityType: "base" | "feature" | "research" | "warehouse" | "run", entityId: string): { deleted: boolean } {
  const db = getDb();
  ensureRtsTables(db);
  const id = String(entityId || "").trim();
  if (!id) return { deleted: false };
  const result = db.prepare("DELETE FROM rts_layout_entities WHERE id = ? AND entity_type = ?").run(id, entityType);
  return { deleted: Number(result.changes || 0) > 0 };
}

function saveRtsState(nextState: unknown): Record<string, unknown> {
  const db = getDb();
  ensureRtsTables(db);
  const safe = (nextState && typeof nextState === "object") ? nextState as Record<string, unknown> : {};
  const nonLayoutState: Record<string, unknown> = { ...safe };
  delete nonLayoutState.customBases;
  delete nonLayoutState.featureBuildings;
  delete nonLayoutState.researchBuildings;
  delete nonLayoutState.warehouseBuildings;
  delete nonLayoutState.runLayoutOverrides;
  const hasLayoutPayload =
    Object.prototype.hasOwnProperty.call(safe, "customBases") ||
    Object.prototype.hasOwnProperty.call(safe, "featureBuildings") ||
    Object.prototype.hasOwnProperty.call(safe, "researchBuildings") ||
    Object.prototype.hasOwnProperty.call(safe, "warehouseBuildings") ||
    Object.prototype.hasOwnProperty.call(safe, "runLayoutOverrides");
  if (hasLayoutPayload) upsertLayoutEntitiesFromState(safe);
  const derived = getRtsState();
  // Persist only non-layout UI state in rts_state; layout is authoritative in rts_layout_entities.
  const storageState = {
    ...nonLayoutState,
  };
  const responseState = {
    ...storageState,
    // Preserve response shape for existing clients.
    customBases: Array.isArray(derived.customBases) ? derived.customBases : [],
    featureBuildings: Array.isArray(derived.featureBuildings) ? derived.featureBuildings : [],
    researchBuildings: Array.isArray(derived.researchBuildings) ? derived.researchBuildings : [],
    warehouseBuildings: Array.isArray(derived.warehouseBuildings) ? derived.warehouseBuildings : [],
    runLayoutOverrides: (derived.runLayoutOverrides && typeof derived.runLayoutOverrides === "object")
      ? derived.runLayoutOverrides
      : {},
  };
  const stored = JSON.stringify(storageState);
  const current = db.prepare("SELECT state_json FROM rts_state WHERE id = 1").get() as { state_json: string } | undefined;
  if (current?.state_json === stored) {
    return responseState;
  }
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO rts_state (id, state_json, updated_at) VALUES (1, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at"
  ).run(stored, now);
  return responseState;
}

function getRtsLiveStatus(): Record<string, unknown> {
  const workerTotal = (() => {
    try {
      const jobsPath = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");
      if (!fs.existsSync(jobsPath)) return 0;
      const raw = JSON.parse(fs.readFileSync(jobsPath, "utf-8")) as { jobs?: Array<{ name?: string; enabled?: boolean }> };
      const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
      return jobs.filter((j) => j.enabled !== false && String(j.name || "").startsWith("antfarm/")).length;
    } catch {
      return 0;
    }
  })();

  const db = getDb();
  const runningAgentCount = Number((db.prepare("SELECT COUNT(*) AS c FROM steps WHERE status = 'running'").get() as { c: number }).c || 0);
  const activeRunCount = Number((db.prepare("SELECT COUNT(*) AS c FROM runs WHERE status = 'running'").get() as { c: number }).c || 0);
  const pendingRunCount = Number((db.prepare("SELECT COUNT(*) AS c FROM runs WHERE status IN ('pending','running')").get() as { c: number }).c || 0);
  const rows = db.prepare(
    "SELECT run_id, agent_id, step_id, updated_at FROM steps WHERE status = 'running' ORDER BY updated_at DESC LIMIT 200"
  ).all() as Array<{ run_id: string; agent_id: string; step_id: string; updated_at: string }>;
  return {
    ts: new Date().toISOString(),
    runningAgentCount,
    activeRunCount,
    pendingRunCount,
    workerTotal,
    activeAgents: rows.map((r) => ({
      runId: r.run_id,
      agentId: r.agent_id,
      stepId: r.step_id,
      stale: false,
      ageSec: 0,
    })),
  };
}

function listCronJobsSummary(): Array<Record<string, unknown>> {
  try {
    const jobsPath = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");
    if (!fs.existsSync(jobsPath)) return [];
    const raw = JSON.parse(fs.readFileSync(jobsPath, "utf-8")) as { jobs?: Array<Record<string, unknown>> };
    const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
    return jobs.map((job) => {
      const state = (job.state && typeof job.state === "object") ? job.state as Record<string, unknown> : {};
      return {
        name: String(job.name || ""),
        schedule: String(job.schedule || ""),
        enabled: job.enabled !== false,
        nextRunAtMs: Number(state.nextRunAtMs || 0) || null,
        lastRunAtMs: Number(state.lastRunAtMs || 0) || null,
        lastStatus: String(state.lastStatus || ""),
      };
    });
  } catch {
    return [];
  }
}

function nudgeWorkflowCronSchedules(workflowIds: string[]): void {
  if (!workflowIds.length) return;
  try {
    const jobsPath = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");
    if (!fs.existsSync(jobsPath)) return;
    const raw = JSON.parse(fs.readFileSync(jobsPath, "utf-8")) as { jobs?: Array<Record<string, unknown>> };
    const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
    const nowMs = Date.now();
    let changed = false;
    for (const job of jobs) {
      const name = String(job?.name || "");
      const hit = workflowIds.some((wf) => name.startsWith(`antfarm/${wf}/`));
      if (!hit || job?.enabled === false) continue;
      const state = (job.state && typeof job.state === "object") ? job.state as Record<string, unknown> : {};
      state.nextRunAtMs = nowMs;
      job.state = state;
      job.updatedAtMs = nowMs;
      changed = true;
    }
    if (!changed) return;
    fs.writeFileSync(jobsPath, JSON.stringify({ ...(raw || {}), jobs }, null, 2), "utf-8");
  } catch {
    // best-effort fallback only
  }
}

function nudgeAllAntfarmCronSchedules(): { attempted: number; nudged: number } {
  try {
    const jobsPath = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");
    if (!fs.existsSync(jobsPath)) return { attempted: 0, nudged: 0 };
    const raw = JSON.parse(fs.readFileSync(jobsPath, "utf-8")) as { jobs?: Array<Record<string, unknown>> };
    const jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
    const nowMs = Date.now();
    let attempted = 0;
    let nudged = 0;
    for (const job of jobs) {
      const name = String(job?.name || "");
      if (!name.startsWith("antfarm/")) continue;
      if (job?.enabled === false) continue;
      attempted += 1;
      const state = (job.state && typeof job.state === "object") ? job.state as Record<string, unknown> : {};
      state.nextRunAtMs = nowMs;
      job.state = state;
      job.updatedAtMs = nowMs;
      nudged += 1;
    }
    if (nudged > 0) {
      fs.writeFileSync(jobsPath, JSON.stringify({ ...(raw || {}), jobs }, null, 2), "utf-8");
    }
    return { attempted, nudged };
  } catch {
    return { attempted: 0, nudged: 0 };
  }
}

async function deployPendingRuns(
  maxRuns = 25,
  scope?: { baseId?: string; repoPath?: string },
): Promise<{ attempted: number; kicked: number; runIds: string[] }> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT s.id AS step_id, s.run_id AS run_id, r.workflow_id AS workflow_id, r.context AS run_context, r.status AS run_status " +
    "FROM steps s JOIN runs r ON r.id = s.run_id " +
    "WHERE s.status = 'pending' AND r.status = 'running' " +
    "ORDER BY s.updated_at ASC, s.step_index ASC"
  ).all() as Array<{ step_id: string; run_id: string; workflow_id: string; run_context: string; run_status: string }>;

  const scopeBaseId = String(scope?.baseId || "").trim();
  const scopeRepo = normalizePathKey(String(scope?.repoPath || ""));

  const perRun = new Map<string, { stepId: string; workflowId: string }>();
  for (const row of rows) {
    let ctx: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.run_context || "{}");
      if (parsed && typeof parsed === "object") ctx = parsed as Record<string, unknown>;
    } catch {}
    const rowBaseId = String(ctx.baseId || "").trim();
    const rowRepo = normalizePathKey(String(ctx.baseRepoPath || ctx.repoPath || ctx.repo || ""));
    if (scopeBaseId) {
      if (rowBaseId && rowBaseId !== scopeBaseId) continue;
      // Legacy runs can have empty baseId; constrain by repo fallback when base is specified.
      if (!rowBaseId && scopeRepo && rowRepo && rowRepo !== scopeRepo) continue;
    } else if (scopeRepo && rowRepo && rowRepo !== scopeRepo) {
      continue;
    }
    if (!row?.run_id || perRun.has(row.run_id)) continue;
    perRun.set(row.run_id, { stepId: row.step_id, workflowId: row.workflow_id });
  }

  const targets = Array.from(perRun.entries()).slice(0, Math.max(1, Number(maxRuns) || 1));
  const workflowsToActivate = Array.from(new Set(targets.map(([, t]) => String(t.workflowId || "").trim()).filter(Boolean)));
  nudgeWorkflowCronSchedules(workflowsToActivate);
  let kicked = 0;
  const runIds: string[] = [];
  for (const [runId, target] of targets) {
    runIds.push(runId);
    // Force a new step version so immediate handoff does not get blocked by version gating.
    getDb().prepare("UPDATE steps SET updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(new Date().toISOString(), target.stepId);
    const evt = {
      ts: new Date().toISOString(),
      event: "step.pending" as const,
      runId,
      workflowId: target.workflowId,
      stepId: target.stepId,
      detail: "RTS deploy requested from live panel",
    };
    emitEvent(evt);
    try {
      await immediateHandoff(evt);
      kicked += 1;
    } catch {
      // keep iterating through remaining pending runs
    }
  }
  return { attempted: targets.length, kicked, runIds };
}

function serveHTML(res: http.ServerResponse, fileName = "index.html") {
  const htmlPath = path.join(__dirname, fileName);
  // In dist, html may not exist—serve from src
  const srcHtmlPath = path.resolve(__dirname, "..", "..", "src", "server", fileName);
  const filePath = fs.existsSync(htmlPath) ? htmlPath : srcHtmlPath;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(fs.readFileSync(filePath, "utf-8"));
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function parseRunContext(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function resolveWorktreePath(baseRepoPath: string, worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) return path.resolve(path.dirname(baseRepoPath), `${path.basename(baseRepoPath)}-feature-${Date.now().toString().slice(-4)}`);
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(baseRepoPath, trimmed);
}

function branchExists(baseRepoPath: string, branchName: string): boolean {
  const trimmed = String(branchName || "").trim();
  if (!trimmed) return false;
  try {
    execFileSync("git", ["-C", baseRepoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${trimmed}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function summarizeText(raw: string, max = 3000): string {
  return String(raw || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function extractTestFailureFeedback(runId: string, testStepId: string, testOutput: string | null): string {
  const fromStep = summarizeText(String(testOutput || ""));
  if (fromStep) return fromStep;
  const events = getRunEvents(runId, 400);
  const matched = [...events].reverse().find((evt) => {
    if (evt.stepId && evt.stepId === testStepId && evt.detail) return true;
    if (evt.event === "run.failed" && evt.detail) return true;
    return false;
  });
  return summarizeText(String(matched?.detail || "")) || "Test step failed with no detailed output captured.";
}

async function redoDeveloperFromFailedTest(runIdOrPrefix: string): Promise<{
  runId: string;
  developerStepId: string;
  testStepId: string;
  storyId: string;
  kicked: boolean;
  feedback: string;
}> {
  const run = resolveRunRecord(runIdOrPrefix);
  if (!run) throw new Error("run_not_found");

  const db = getDb();
  const steps = db.prepare(
    "SELECT id, step_id, agent_id, step_index, status, output, type FROM steps WHERE run_id = ? ORDER BY step_index ASC"
  ).all(run.id) as Array<{
    id: string;
    step_id: string;
    agent_id: string;
    step_index: number;
    status: string;
    output: string | null;
    type: string;
  }>;

  const testStep = steps.find((s) => String(s.step_id || "").toLowerCase() === "test");
  if (!testStep) throw new Error("test_step_not_found");

  const developerStep = steps.find((s) => String(s.step_id || "").toLowerCase() === "implement")
    || [...steps]
      .filter((s) => s.step_index < testStep.step_index && String(s.agent_id || "").toLowerCase().endsWith("/developer"))
      .sort((a, b) => b.step_index - a.step_index)[0];
  if (!developerStep) throw new Error("developer_step_not_found");

  const feedback = extractTestFailureFeedback(run.id, testStep.id, testStep.output);
  const now = new Date().toISOString();
  const storyIndexRow = db.prepare("SELECT COALESCE(MAX(story_index), -1) AS m FROM stories WHERE run_id = ?").get(run.id) as { m: number };
  const nextStoryIndex = Number(storyIndexRow?.m ?? -1) + 1;
  const storyId = `rerun-${nextStoryIndex + 1}`;
  const storyPk = `${run.id}-redo-${Date.now()}`;
  const acceptance = JSON.stringify([
    "Address the failed integration test findings from TEST_FEEDBACK",
    "Relevant tests pass",
    "Typecheck passes",
  ]);

  db.exec("BEGIN IMMEDIATE");
  try {
    const contextRow = db.prepare("SELECT context FROM runs WHERE id = ?").get(run.id) as { context: string } | undefined;
    const context = parseRunContext(contextRow?.context ?? "{}");
    context.test_feedback = feedback;
    context.verify_feedback = feedback;

    db.prepare("UPDATE runs SET status = 'running', context = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(context),
      now,
      run.id
    );

    db.prepare(
      "INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, output, retry_count, max_retries, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, 2, ?, ?)"
    ).run(
      storyPk,
      run.id,
      nextStoryIndex,
      storyId,
      "Address failed integration test feedback",
      feedback.slice(0, 4000),
      acceptance,
      now,
      now
    );

    db.prepare(
      "UPDATE steps SET status = 'pending', output = NULL, retry_count = 0, current_story_id = NULL, updated_at = ? WHERE id = ?"
    ).run(now, developerStep.id);

    db.prepare(
      "UPDATE steps SET status = 'waiting', output = NULL, retry_count = 0, current_story_id = NULL, updated_at = ? WHERE run_id = ? AND step_index >= ? AND id <> ?"
    ).run(now, run.id, testStep.step_index, developerStep.id);

    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    throw err;
  }

  const evt = {
    ts: new Date().toISOString(),
    event: "step.pending" as const,
    runId: run.id,
    workflowId: run.workflow_id,
    stepId: developerStep.id,
    detail: "Developer redo requested from failed test output",
  };
  emitEvent(evt);
  let kicked = false;
  try {
    await immediateHandoff(evt);
    kicked = true;
  } catch {}

  return {
    runId: run.id,
    developerStepId: developerStep.id,
    testStepId: testStep.id,
    storyId,
    feedback,
    kicked,
  };
}

function resolveRunRecord(runIdOrPrefix: string): { id: string; status: string; workflow_id: string; context: string } | null {
  const db = getDb();
  const exact = db.prepare("SELECT id, status, workflow_id, context FROM runs WHERE id = ?").get(runIdOrPrefix) as { id: string; status: string; workflow_id: string; context: string } | undefined;
  if (exact) return exact;
  const rows = db.prepare("SELECT id, status, workflow_id, context FROM runs WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 2").all(`${runIdOrPrefix}%`) as Array<{ id: string; status: string; workflow_id: string; context: string }>;
  if (rows.length === 1) return rows[0];
  return null;
}

function pruneRunEvents(runId: string): void {
  try {
    const eventsFile = path.join(os.homedir(), ".openclaw", "antfarm", "events.jsonl");
    if (!fs.existsSync(eventsFile)) return;
    const content = fs.readFileSync(eventsFile, "utf-8");
    const kept = content
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        try {
          const evt = JSON.parse(line) as { runId?: string };
          return evt.runId !== runId;
        } catch {
          return true;
        }
      })
      .join("\n");
    fs.writeFileSync(eventsFile, kept ? `${kept}\n` : "");
  } catch {
    // best-effort cleanup
  }
}

function removeRunWorktree(context: Record<string, unknown>): { removed: boolean; path?: string } {
  return removeWorktreeByPaths(
    String(context.worktreePath ?? "").trim(),
    String(context.baseRepoPath ?? context.repoPath ?? "").trim()
  );
}

function removeWorktreeByPaths(worktreePathRaw: string, baseRepoPathRaw: string): { removed: boolean; path?: string } {
  const wtRaw = String(worktreePathRaw || "").trim();
  if (!wtRaw) return { removed: false };
  const baseRaw = String(baseRepoPathRaw || "").trim();
  const worktreePath = path.isAbsolute(wtRaw) ? path.normalize(wtRaw) : path.resolve(process.cwd(), wtRaw);
  const baseRepoPath = baseRaw ? (path.isAbsolute(baseRaw) ? path.normalize(baseRaw) : path.resolve(process.cwd(), baseRaw)) : "";
  if (baseRepoPath && worktreePath === baseRepoPath) return { removed: false, path: worktreePath };
  if (!fs.existsSync(worktreePath)) return { removed: false, path: worktreePath };
  try {
    const gitBase = baseRepoPath || path.dirname(worktreePath);
    execFileSync("git", ["-C", gitBase, "worktree", "remove", "--force", worktreePath], { stdio: "pipe" });
    return { removed: true, path: worktreePath };
  } catch {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      return { removed: true, path: worktreePath };
    } catch {
      return { removed: false, path: worktreePath };
    }
  }
}

function purgeRtsArtifactsForRunId(runId: string): { purged: boolean } {
  const db = getDb();
  ensureRtsTables(db);
  let purged = false;
  const byRun = db.prepare("DELETE FROM rts_layout_entities WHERE run_id = ?").run(runId);
  const byId = db.prepare("DELETE FROM rts_layout_entities WHERE id = ?").run(`run:${runId}`);
  purged = Number(byRun.changes || 0) > 0 || Number(byId.changes || 0) > 0;

  const stateRow = db.prepare("SELECT state_json FROM rts_state WHERE id = 1").get() as { state_json: string } | undefined;
  if (stateRow?.state_json) {
    let stateJson: Record<string, unknown> = {};
    try { stateJson = JSON.parse(stateRow.state_json) as Record<string, unknown>; } catch { stateJson = {}; }
    const beforeCount = Array.isArray(stateJson.featureBuildings) ? stateJson.featureBuildings.length : 0;
    const featureBuildings = Array.isArray(stateJson.featureBuildings)
      ? (stateJson.featureBuildings as Array<Record<string, unknown>>).filter((b) => String(b?.runId ?? "") !== runId)
      : [];
    const runLayoutOverrides = (stateJson.runLayoutOverrides && typeof stateJson.runLayoutOverrides === "object")
      ? { ...(stateJson.runLayoutOverrides as Record<string, unknown>) }
      : {};
    const hadOverride = Object.prototype.hasOwnProperty.call(runLayoutOverrides, runId);
    delete runLayoutOverrides[runId];

    const selected = (stateJson.selected && typeof stateJson.selected === "object")
      ? stateJson.selected as Record<string, unknown>
      : null;
    const selectedData = selected && typeof selected.data === "object" ? selected.data as Record<string, unknown> : null;
    const selectedRunId = selectedData ? String(selectedData.runId ?? selectedData.id ?? "") : "";
    const nextSelected = selectedRunId === runId ? null : selected;
    const nextState = { ...stateJson, featureBuildings, runLayoutOverrides, ...(nextSelected ? { selected: nextSelected } : { selected: null }) };
    const afterCount = Array.isArray(nextState.featureBuildings) ? nextState.featureBuildings.length : 0;
    if (beforeCount !== afterCount || hadOverride || (selected && !nextSelected)) purged = true;
    db.prepare("UPDATE rts_state SET state_json = ?, updated_at = ? WHERE id = 1").run(JSON.stringify(nextState), new Date().toISOString());
  }
  return { purged };
}

function deleteRunWithArtifacts(runIdOrPrefix: string): { deleted: boolean; status?: string; runId?: string; worktreeRemoved?: boolean; worktreePath?: string } {
  const db = getDb();
  ensureRtsTables(db);
  const run = resolveRunRecord(runIdOrPrefix);
  if (!run) {
    const idGuess = runIdOrPrefix.trim();
    if (!idGuess) return { deleted: false };
    const purged = purgeRtsArtifactsForRunId(idGuess);
    return purged.purged ? { deleted: true, runId: idGuess } : { deleted: false };
  }
  const runId = run.id;
  let context: Record<string, unknown> = {};
  try { context = JSON.parse(run.context || "{}") as Record<string, unknown>; } catch { context = {}; }
  const runtimePortFromContext = isValidPortValue((context as Record<string, unknown>).runtimePort);
  let runtimePortFromLayout: number | null = null;
  try {
    const db2 = getDb();
    const layout = db2.prepare(
      "SELECT payload_json FROM rts_layout_entities WHERE entity_type = 'feature' AND run_id = ? ORDER BY updated_at DESC LIMIT 1"
    ).get(runId) as { payload_json: string } | undefined;
    const payload = JSON.parse(layout?.payload_json || "{}") as Record<string, unknown>;
    runtimePortFromLayout = isValidPortValue(payload.port);
  } catch {}
  const runtimePort = runtimePortFromContext ?? runtimePortFromLayout;

  db.exec("BEGIN");
  try {
    const stateRow = db.prepare("SELECT state_json FROM rts_state WHERE id = 1").get() as { state_json: string } | undefined;
    if (stateRow?.state_json) {
      let stateJson: Record<string, unknown> = {};
      try { stateJson = JSON.parse(stateRow.state_json) as Record<string, unknown>; } catch { stateJson = {}; }
      const featureBuildings = Array.isArray(stateJson.featureBuildings)
        ? (stateJson.featureBuildings as Array<Record<string, unknown>>).filter((b) => String(b?.runId ?? "") !== runId)
        : [];
      const runLayoutOverrides = (stateJson.runLayoutOverrides && typeof stateJson.runLayoutOverrides === "object")
        ? { ...(stateJson.runLayoutOverrides as Record<string, unknown>) }
        : {};
      delete runLayoutOverrides[runId];
      const selected = (stateJson.selected && typeof stateJson.selected === "object")
        ? stateJson.selected as Record<string, unknown>
        : null;
      const selectedData = selected && typeof selected.data === "object" ? selected.data as Record<string, unknown> : null;
      const selectedRunId = selectedData ? String(selectedData.runId ?? selectedData.id ?? "") : "";
      const nextSelected = selectedRunId === runId ? null : selected;
      const nextState = { ...stateJson, featureBuildings, runLayoutOverrides, ...(nextSelected ? { selected: nextSelected } : { selected: null }) };
      db.prepare("UPDATE rts_state SET state_json = ?, updated_at = ? WHERE id = 1").run(JSON.stringify(nextState), new Date().toISOString());
    }

    db.prepare("DELETE FROM stories WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db.prepare("DELETE FROM rts_layout_entities WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM rts_layout_entities WHERE id = ?").run(`run:${runId}`);
    db.exec("COMMIT");
    pruneRunEvents(runId);
    const wt = removeRunWorktree(context);
    if (runtimePort) stopFactoryRuntimeByPort(runtimePort);
    teardownWorkflowCronsIfIdle(run.workflow_id).catch(() => {});
    return { deleted: true, status: run.status, runId, worktreeRemoved: wt.removed, worktreePath: wt.path };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function upsertLayoutPosition(input: {
  entityType: "base" | "feature" | "research" | "warehouse" | "run";
  entityId?: string;
  runId?: string | null;
  repoPath?: string | null;
  worktreePath?: string | null;
  x: number;
  y: number;
  allowCreate?: boolean;
  payload?: Record<string, unknown>;
}): { id: string; entityType: string; runId: string | null } {
  const db = getDb();
  ensureRtsTables(db);
  const now = new Date().toISOString();
  const entityType = input.entityType;
  const x = Number.isFinite(input.x) ? input.x : 0;
  const y = Number.isFinite(input.y) ? input.y : 0;
  const repoPath = input.repoPath ? String(input.repoPath) : null;
  const worktreePath = input.worktreePath ? absolutizePath(String(input.worktreePath), String(input.repoPath || "")) : null;
  let runId = input.runId ? String(input.runId) : null;
  let id = String(input.entityId || "").trim();

  if (entityType === "run") {
    if (!runId) runId = id || null;
    if (!runId) throw new Error("runId is required for run layout");
    id = `run:${runId}`;
  } else if (entityType === "feature") {
    if (runId) {
      const byRun = db.prepare("SELECT id FROM rts_layout_entities WHERE entity_type = 'feature' AND run_id = ? LIMIT 1").get(runId) as { id: string } | undefined;
      if (byRun?.id) id = byRun.id;
    }
    if (!id || id.startsWith("feature-run-")) id = runId ? `feature-${runId}` : `feature-${Date.now()}`;
    if (!runId) {
      const exists = db.prepare("SELECT 1 as ok FROM rts_layout_entities WHERE id = ? LIMIT 1").get(id) as { ok: number } | undefined;
      if (!exists && !input.allowCreate) {
        throw new Error("feature_layout_create_not_allowed");
      }
    }
  } else if (entityType === "research") {
    if (!id) id = `research-${Date.now()}`;
    const exists = db.prepare("SELECT 1 as ok FROM rts_layout_entities WHERE id = ? LIMIT 1").get(id) as { ok: number } | undefined;
    if (!exists && !input.allowCreate) throw new Error("research_layout_create_not_allowed");
  } else if (entityType === "warehouse") {
    if (!id) id = `warehouse-${Date.now()}`;
    const exists = db.prepare("SELECT 1 as ok FROM rts_layout_entities WHERE id = ? LIMIT 1").get(id) as { ok: number } | undefined;
    if (!exists && !input.allowCreate) throw new Error("warehouse_layout_create_not_allowed");
  } else {
    if (!id) throw new Error("entityId is required for base layout");
  }

  const current = db.prepare("SELECT payload_json FROM rts_layout_entities WHERE id = ?").get(id) as { payload_json: string } | undefined;
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(current?.payload_json || "{}");
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch {}
  const payloadPatch = (input.payload && typeof input.payload === "object")
    ? input.payload as Record<string, unknown>
    : {};
  const nextPayload: Record<string, unknown> = { ...payload, ...payloadPatch, id, x, y };
  if (runId) nextPayload.runId = runId;
  if (repoPath) nextPayload.repo = repoPath;
  if (worktreePath) nextPayload.worktreePath = worktreePath;

  db.prepare(
    "INSERT INTO rts_layout_entities (id, entity_type, run_id, repo_path, worktree_path, x, y, payload_json, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET " +
    "entity_type = excluded.entity_type, run_id = excluded.run_id, repo_path = excluded.repo_path, worktree_path = excluded.worktree_path, " +
    "x = excluded.x, y = excluded.y, payload_json = excluded.payload_json, updated_at = excluded.updated_at"
  ).run(id, entityType, runId, repoPath, worktreePath, x, y, JSON.stringify(nextPayload), now);

  return { id, entityType, runId };
}

type ResearchPlanType = "feature" | "bug" | "placeholder";
type ResearchPlanDisposition = "OPEN" | "WONT_FIX";
type ResearchPlan = {
  id: string;
  type: ResearchPlanType;
  title: string;
  summary: string;
  prompt: string;
  evidence: string[];
  disposition?: ResearchPlanDisposition;
  source?: "agent" | "static";
  sourceRunId?: string;
};

function buildResearchPrompt(input: {
  type: ResearchPlanType;
  title: string;
  repoPath: string;
  summary: string;
  evidence: string[];
}): string {
  const lane = input.type === "bug" ? "bug-fix" : "feature-dev";
  const acceptance = input.type === "bug"
    ? [
      "Root cause is identified and explained.",
      "A targeted fix is implemented with regression coverage.",
      "No unrelated refactors are included."
    ]
    : input.type === "placeholder"
      ? [
        "Placeholder logic is replaced with production-ready behavior.",
        "Tests cover success and failure paths.",
        "Any temporary markers are removed or documented."
      ]
      : [
        "Feature behavior is implemented and documented.",
        "Tests cover new behavior and edge cases.",
        "No regressions in nearby modules."
      ];
  const evidenceBlock = input.evidence.length
    ? input.evidence.map((e) => `- ${e}`).join("\n")
    : "- Repository-wide structural scan results";
  return [
    `Task: ${input.title}`,
    `Preferred workflow: ${lane}`,
    `Base repo path: ${input.repoPath}`,
    "",
    "Goal:",
    input.summary,
    "",
    "Evidence:",
    evidenceBlock,
    "",
    "Expected deliverables:",
    "- Implementation changes scoped to this task.",
    "- Tests added/updated for behavior changes.",
    "- Short PR-ready summary of what changed and why.",
    "",
    "Acceptance criteria:",
    ...acceptance.map((line) => `- ${line}`),
  ].join("\n");
}

function generateStaticResearchPlans(repoPath: string, maxPlansRaw: number): { plans: ResearchPlan[]; stats: Record<string, unknown> } {
  const maxPlans = Number.isFinite(maxPlansRaw) ? Math.max(1, Math.min(20, Math.floor(maxPlansRaw))) : 8;
  const skipDirs = new Set([".git", "node_modules", "dist", "build", ".next", "target", ".turbo", ".cache", "coverage"]);
  const textExt = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".toml", ".rs",
    ".go", ".py", ".java", ".kt", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".sh", ".sql", ".html", ".css"
  ]);
  const stack: string[] = [repoPath];
  const files: string[] = [];
  let truncated = false;
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".") && ent.name !== ".env.example") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      files.push(full);
      if (files.length >= 3000) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  const extCounts = new Map<string, number>();
  const todoEvidence: string[] = [];
  const placeholderEvidence: string[] = [];
  let srcCount = 0;
  let testCount = 0;
  const todoRegex = /\b(TODO|FIXME|HACK|XXX)\b/i;
  const placeholderRegexes = [
    /throw new Error\((['"`])(todo|not implemented|nyi|implement me)\1\)/i,
    /\bnotImplemented\b/i,
    /\breturn\s+(null|undefined)\s*;[\t ]*(?:\/\/[^\n]*)?$/im,
    /\bplaceholder\b/i,
  ];
  for (const full of files) {
    const rel = path.relative(repoPath, full).replace(/\\/g, "/");
    const ext = path.extname(rel).toLowerCase();
    extCounts.set(ext, Number(extCounts.get(ext) || 0) + 1);
    if (/(^|\/)(src|app|server|client)\//.test(rel)) srcCount += 1;
    if (/(^|\/)(test|tests|__tests__|spec)\//.test(rel) || /\.(test|spec)\./.test(rel)) testCount += 1;
    if (!textExt.has(ext)) continue;
    let body = "";
    try {
      const st = fs.statSync(full);
      if (st.size > 220000) continue;
      body = fs.readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    if (todoEvidence.length < 12 && todoRegex.test(body)) {
      const lines = body.split("\n");
      for (let i = 0; i < lines.length && todoEvidence.length < 12; i++) {
        if (todoRegex.test(lines[i])) {
          todoEvidence.push(`${rel}:${i + 1} ${lines[i].trim().slice(0, 120)}`);
        }
      }
    }
    if (placeholderEvidence.length < 12) {
      const lines = body.split("\n");
      for (let i = 0; i < lines.length && placeholderEvidence.length < 12; i++) {
        const line = lines[i];
        if (placeholderRegexes.some((rx) => rx.test(line))) {
          placeholderEvidence.push(`${rel}:${i + 1} ${line.trim().slice(0, 120)}`);
        }
      }
    }
  }

  const topExt = [...extCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([ext, count]) => `${ext || "(none)"}:${count}`);
  const plans: ResearchPlan[] = [];
  const pushPlan = (type: ResearchPlanType, title: string, summary: string, evidence: string[]) => {
    if (plans.length >= maxPlans) return;
    plans.push({
      id: `plan-${Date.now()}-${plans.length + 1}`,
      type,
      title,
      summary,
      evidence,
      disposition: "OPEN",
      source: "static",
      prompt: buildResearchPrompt({ type, title, repoPath, summary, evidence }),
    });
  };

  if (todoEvidence.length) {
    pushPlan(
      "bug",
      "Triage and fix high-signal TODO/FIXME hotspots",
      "Resolve the most actionable TODO/FIXME markers that indicate real defects or broken behavior.",
      todoEvidence.slice(0, 5)
    );
  }
  if (placeholderEvidence.length) {
    pushPlan(
      "placeholder",
      "Replace placeholder implementations with production behavior",
      "Implement incomplete stubs and remove temporary placeholders discovered in the code scan.",
      placeholderEvidence.slice(0, 5)
    );
  }
  pushPlan(
    "feature",
    "Improve core developer workflow and reliability",
    "Add one incremental, user-facing improvement in the core flow and verify with automated tests.",
    [`Dominant file types: ${topExt.join(", ") || "unknown"}`]
  );
  if (srcCount > 20 && testCount < Math.max(3, Math.floor(srcCount / 6))) {
    pushPlan(
      "feature",
      "Expand test coverage for critical runtime paths",
      "Increase automated coverage around high-change or high-risk paths to reduce regressions.",
      [`Source-like files: ${srcCount}`, `Test-like files: ${testCount}`]
    );
  }
  while (plans.length < Math.min(maxPlans, 4)) {
    pushPlan(
      "bug",
      "Repo health pass for edge-case regressions",
      "Run a focused quality pass over error handling, null paths, and state consistency in active modules.",
      ["Generated from repository-wide static scan."]
    );
  }
  return {
    plans: plans.slice(0, maxPlans),
    stats: {
      filesScanned: files.length,
      truncated,
      srcCount,
      testCount,
      topExt,
      todoHits: todoEvidence.length,
      placeholderHits: placeholderEvidence.length,
      mode: "static",
    },
  };
}

type PlannerStoryRow = {
  story_id: string;
  title: string;
  description: string;
  acceptance_criteria: string;
};

function classifyStoryPlanType(title: string, description: string): ResearchPlanType {
  const blob = `${title}\n${description}`.toLowerCase();
  if (/\b(todo|placeholder|stub|not implemented|nyi|implement me)\b/.test(blob)) return "placeholder";
  if (/\b(bug|fix|regression|error|crash|fault|null|exception)\b/.test(blob)) return "bug";
  return "feature";
}

function buildAgentResearchTask(repoPath: string, maxPlans: number): string {
  return [
    `Research repository at: ${repoPath}`,
    "",
    "You are planning only. Do not implement code.",
    "Explore this repo and produce actionable, dependency-ordered stories.",
    `Create at most ${maxPlans} stories.`,
    "Mix bug-fixes and feature improvements where justified by the codebase.",
    "Each story must be scoped for one developer session.",
    "Use concrete acceptance criteria.",
    "",
    "Extra constraints:",
    "- Start from this repo path; do not plan for unrelated repositories.",
    "- Prioritize high-signal defects and missing production behavior.",
    "- Avoid placeholder or speculative stories with no code evidence.",
  ].join("\n");
}

function toResearchPlanFromStory(repoPath: string, runId: string, row: PlannerStoryRow): ResearchPlan {
  let acceptanceCriteria: string[] = [];
  try {
    const parsed = JSON.parse(row.acceptance_criteria || "[]");
    if (Array.isArray(parsed)) acceptanceCriteria = parsed.map((x) => String(x || "").trim()).filter(Boolean);
  } catch {
    acceptanceCriteria = [];
  }
  const type = classifyStoryPlanType(row.title, row.description);
  const evidence: string[] = [`planner:${row.story_id}`];
  for (const criterion of acceptanceCriteria.slice(0, 4)) evidence.push(`AC: ${criterion}`);
  const summary = row.description.split("\n").map((line) => line.trim()).find(Boolean) || row.title;
  return {
    id: `${runId}:${row.story_id}`,
    type,
    title: row.title,
    summary: summary.slice(0, 220),
    evidence,
    disposition: "OPEN",
    source: "agent",
    sourceRunId: runId,
    prompt: buildResearchPrompt({
      type,
      title: row.title,
      repoPath,
      summary: row.description || summary,
      evidence,
    }),
  };
}

async function waitForPlannerStories(runId: string, timeoutMs: number): Promise<{ stories: PlannerStoryRow[]; timedOut: boolean; runStatus: string }> {
  const db = getDb();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const stories = db.prepare(
      "SELECT story_id, title, description, acceptance_criteria FROM stories WHERE run_id = ? ORDER BY story_index ASC"
    ).all(runId) as PlannerStoryRow[];
    if (stories.length > 0) {
      const runRow = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
      return { stories, timedOut: false, runStatus: String(runRow?.status || "unknown") };
    }
    const runRow = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
    const runStatus = String(runRow?.status || "");
    if (runStatus && runStatus !== "running") return { stories: [], timedOut: false, runStatus };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const runRow = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
  return { stories: [], timedOut: true, runStatus: String(runRow?.status || "unknown") };
}

async function generateResearchPlans(repoPath: string, maxPlansRaw: number): Promise<{ plans: ResearchPlan[]; stats: Record<string, unknown> }> {
  const maxPlans = Number.isFinite(maxPlansRaw) ? Math.max(1, Math.min(20, Math.floor(maxPlansRaw))) : 8;
  let runId = "";
  try {
    const run = await runWorkflow({
      workflowId: "feature-dev",
      taskTitle: buildAgentResearchTask(repoPath, maxPlans),
      deferInitialKick: true,
    });
    runId = run.id;
    const db = getDb();
    const contextRow = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string } | undefined;
    const context = parseRunContext(contextRow?.context ?? "{}");
    const nextContext = {
      ...context,
      repo: repoPath,
      repoPath,
      baseRepoPath: repoPath,
      branch: `research/${Date.now().toString().slice(-6)}`,
    };
    db.prepare("UPDATE runs SET context = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(nextContext), new Date().toISOString(), runId);

    const firstStep = db.prepare(
      "SELECT id FROM steps WHERE run_id = ? AND step_index = 0 AND status = 'pending' LIMIT 1"
    ).get(runId) as { id: string } | undefined;
    if (!firstStep?.id) throw new Error("planner_step_not_pending");
    const evt = { ts: new Date().toISOString(), event: "step.pending" as const, runId, workflowId: "feature-dev", stepId: firstStep.id };
    emitEvent(evt);
    try { await immediateHandoff(evt); } catch {}

    const waited = await waitForPlannerStories(runId, 45_000);
    if (!waited.stories.length) {
      throw new Error(waited.timedOut ? "planner_timeout_no_stories" : `planner_no_stories_status_${waited.runStatus || "unknown"}`);
    }
    const plans = waited.stories
      .slice(0, maxPlans)
      .map((row) => toResearchPlanFromStory(repoPath, runId, row));
    return {
      plans,
      stats: {
        mode: "agent",
        runId,
        runStatus: waited.runStatus,
        storiesGenerated: waited.stories.length,
      },
    };
  } catch (err) {
    const fallback = generateStaticResearchPlans(repoPath, maxPlans);
    return {
      plans: fallback.plans,
      stats: {
        ...fallback.stats,
        mode: "static_fallback",
        agentError: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    if (runId) {
      try { deleteRunWithArtifacts(runId); } catch {}
    }
  }
}

export function startDashboard(port = 3333): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const p = url.pathname;
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }

    if (p === "/api/workflows") {
      return json(res, loadWorkflows());
    }

    if (p === "/api/local-repos") {
      return json(res, listLocalGitRepos());
    }

    if (p === "/api/rts/base/clone" && method === "POST") {
      try {
        const body = JSON.parse(await readBody(req)) as {
          useExistingRepoPath?: string;
          repoUrl?: string;
          targetPath?: string;
          placement?: { x?: number; y?: number };
        };
        const useExistingRepoPath = String(body?.useExistingRepoPath || "").trim();
        if (useExistingRepoPath) {
          const repoPath = normalizeRepoPath(useExistingRepoPath);
          if (!repoPath || !fs.existsSync(repoPath)) {
            return json(res, { ok: false, error: `Repo path not found: ${repoPath || "(empty)"}` }, 400);
          }
          if (!isGitRepoPath(repoPath)) {
            return json(res, { ok: false, error: `Not a git repo: ${repoPath}` }, 400);
          }
          return json(res, { ok: true, mode: "existing", repoPath });
        }

        const repoUrl = String(body?.repoUrl || "").trim();
        const targetPath = String(body?.targetPath || "").trim();
        if (!repoUrl || !targetPath) {
          return json(res, { ok: false, error: "repoUrl and targetPath are required when not using an existing repo" }, 400);
        }
        const repoPath = normalizeRepoPath(targetPath);
        if (!repoPath) return json(res, { ok: false, error: "targetPath resolved to empty path" }, 400);
        if (!fs.existsSync(repoPath)) {
          fs.mkdirSync(path.dirname(repoPath), { recursive: true });
          execFileSync("git", ["clone", repoUrl, repoPath], { stdio: "pipe" });
        }
        if (!isGitRepoPath(repoPath)) {
          return json(res, { ok: false, error: `Clone target is not a git repo: ${repoPath}` }, 400);
        }
        return json(res, { ok: true, mode: "clone", repoPath });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(res, { ok: false, error: message }, 500);
      }
    }

    if (p === "/api/rts/state" && method === "GET") {
      return json(res, { ok: true, state: getRtsState() });
    }

    if (p === "/api/rts/state" && method === "POST") {
      try {
        const body = JSON.parse(await readBody(req));
        const saved = saveRtsState(body?.state ?? body);
        return json(res, { ok: true, state: saved });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(res, { ok: false, error: message }, 400);
      }
    }

    if (p === "/api/rts/live" && method === "GET") {
      return json(res, { ok: true, live: getRtsLiveStatus() });
    }

    if (p === "/api/rts/live/stream" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      const send = () => {
        try {
          const live = getRtsLiveStatus();
          res.write("event: live\n");
          res.write(`data: ${JSON.stringify(live)}\n\n`);
        } catch {}
      };
      send();
      const timer = setInterval(send, 1000);
      req.on("close", () => {
        clearInterval(timer);
        try { res.end(); } catch {}
      });
      return;
    }

    if (p === "/api/rts/diag" && method === "GET") {
      const cronJobs = listCronJobsSummary();
      return json(res, {
        ok: true,
        diag: {
          workflowId: url.searchParams.get("workflow") ?? null,
          cron: {
            matchingCount: cronJobs.length,
            jobs: cronJobs,
          },
          likelyBlockedReason: "",
        },
      });
    }

    if (p === "/api/rts/runtime" && method === "GET") {
      return json(res, {
        ok: true,
        runtime: {
          cwd: process.cwd(),
          port,
          startedAt: new Date().toISOString(),
        },
      });
    }

    if (p === "/api/rts/agent/redo-developer" && method === "POST") {
      try {
        const body = JSON.parse(await readBody(req)) as { runId?: string };
        const runId = String(body?.runId ?? "").trim();
        if (!runId) return json(res, { ok: false, error: "runId is required" }, 400);
        const result = await redoDeveloperFromFailedTest(runId);
        return json(res, { ok: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(res, { ok: false, error: message }, 500);
      }
    }

    if (p === "/api/rts/deploy" && method === "POST") {
      try {
        const body = JSON.parse(await readBody(req)) as { maxRuns?: number; baseId?: string; repoPath?: string };
        const maxRuns = Number(body?.maxRuns ?? 25);
        const result = await deployPendingRuns(maxRuns, {
          baseId: String(body?.baseId || ""),
          repoPath: String(body?.repoPath || ""),
        });
        return json(res, { ok: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(res, { ok: false, error: message }, 500);
      }
    }

    if (p === "/api/rts/cron/run-global" && method === "POST") {
      try {
        const result = nudgeAllAntfarmCronSchedules();
        return json(res, { ok: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(res, { ok: false, error: message }, 500);
      }
    }

    if (p === "/api/rts/research/generate" && method === "POST") {
      try {
        const body = JSON.parse(await readBody(req)) as { repoPath?: string; maxPlans?: number };
        const requestedRepoPath = normalizePathKey(String(body.repoPath || ""));
        const repoPath = resolveResearchRepoPath(requestedRepoPath);
        if (!repoPath) {
          return json(res, {
            ok: false,
            error: `No usable git repo found for research. Requested=${requestedRepoPath || "(empty)"} cwd=${normalizePathKey(process.cwd())}`
          }, 400);
        }
        const { plans, stats } = await generateResearchPlans(repoPath, Number(body.maxPlans ?? 8));
        return json(res, {
          ok: true,
          repoPath,
          generatedAt: new Date().toISOString(),
          plans,
          stats,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(res, { ok: false, error: message }, 500);
      }
    }

    if (p === "/api/rts/library/files" && method === "GET") {
      try {
        const role = String(url.searchParams.get("role") || "all");
        const tag = String(url.searchParams.get("tag") || "all");
        const q = String(url.searchParams.get("q") || "");
        const max = Number(url.searchParams.get("max") || "5000");
        const result = listLibraryMarkdownFiles({ role, tag, q, max });
        return json(res, { ok: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(res, { ok: false, error: message }, 500);
      }
    }

    if (p === "/api/rts/library/file" && method === "GET") {
      try {
        const filePath = String(url.searchParams.get("path") || "");
        const result = readLibraryMarkdownFile(filePath);
        return json(res, { ok: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(res, { ok: false, error: message }, 400);
      }
    }

    if (p === "/api/rts/feature/run" && method === "POST") {
      try {
        const body = JSON.parse(await readBody(req)) as {
          workflowId?: string;
          taskTitle?: string;
          prompt?: string;
          baseRepoPath?: string;
          baseId?: string;
          worktreePath?: string;
          branchName?: string;
          workerAssignments?: Record<string, string>;
          draftId?: string;
          draftX?: number;
          draftY?: number;
          draftPort?: number;
        };
        const workflowId = (body.workflowId || "feature-dev").trim();
        const taskTitle = (body.taskTitle || body.prompt || "Feature request").trim();
        const baseRepoPath = normalizeRepoPath(String(body.baseRepoPath || ""));
        const worktreePath = resolveWorktreePath(baseRepoPath, String(body.worktreePath || ""));
        const branchName = String(body.branchName || `feature/task-${Date.now().toString().slice(-5)}`).trim();

        if (!baseRepoPath || !fs.existsSync(baseRepoPath)) {
          return json(res, { ok: false, error: `Base repo path not found: ${baseRepoPath || "(empty)"}` }, 400);
        }
        if (!fs.existsSync(path.join(baseRepoPath, ".git"))) {
          return json(res, { ok: false, error: `Not a git repo: ${baseRepoPath}` }, 400);
        }

        if (!fs.existsSync(worktreePath)) {
          const args = ["-C", baseRepoPath, "worktree", "add"];
          if (branchName) {
            if (branchExists(baseRepoPath, branchName)) {
              args.push(worktreePath, branchName);
            } else {
              args.push("-b", branchName, worktreePath);
            }
          } else {
            args.push(worktreePath);
          }
          execFileSync("git", args, { stdio: "pipe" });
        }

        const run = await runWorkflow({ workflowId, taskTitle, deferInitialKick: true });
        const db = getDb();
        const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(run.id) as { context: string } | undefined;
        const context = parseRunContext(row?.context ?? "{}");
        const draftId = String(body.draftId || "").trim();
        let baseId = String(body.baseId || "").trim();
        if (!baseId && draftId) {
          try {
            const layoutRow = db.prepare("SELECT payload_json FROM rts_layout_entities WHERE id = ?").get(draftId) as { payload_json: string } | undefined;
            const payload = JSON.parse(layoutRow?.payload_json || "{}") as Record<string, unknown>;
            baseId = String(payload.baseId || "").trim();
          } catch {}
        }
        const assignmentInput = (body.workerAssignments && typeof body.workerAssignments === "object")
          ? body.workerAssignments
          : {};
        const defaultRoles = workflowId === "feature-dev"
          ? ["planner", "setup", "developer", "verifier", "tester", "reviewer"]
          : [];
        const workerAssignments: Record<string, string> = {};
        for (const role of defaultRoles) {
          workerAssignments[role] = `${role}-1`;
        }
        for (const [role, worker] of Object.entries(assignmentInput)) {
          const r = String(role || "").trim().toLowerCase();
          const w = String(worker || "").trim();
          if (!r || !w) continue;
          workerAssignments[r] = w;
        }
        const draftPort = Number(body.draftPort);
        const nextContext = {
          ...context,
          prompt: body.prompt || taskTitle,
          task: taskTitle,
          baseId,
          workerAssignments,
          baseRepoPath,
          repoPath: baseRepoPath,
          worktreePath,
          runtimePort: Number.isFinite(draftPort) && draftPort > 0 ? Math.floor(draftPort) : null,
          branchName,
        };
        db.prepare("UPDATE runs SET context = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify(nextContext),
          new Date().toISOString(),
          run.id
        );

        const firstStep = db.prepare(
          "SELECT id FROM steps WHERE run_id = ? AND step_index = 0 AND status = 'pending' LIMIT 1"
        ).get(run.id) as { id: string } | undefined;
        let layout: { id: string; entityType: string; runId: string | null } | null = null;
        const draftX = Number(body.draftX);
        const draftY = Number(body.draftY);
        const layoutId = draftId || `feature-${run.id}`;
        layout = upsertLayoutPosition({
          entityType: "feature",
          entityId: layoutId,
          runId: run.id,
          repoPath: baseRepoPath,
          worktreePath,
          x: Number.isFinite(draftX) ? draftX : 0,
          y: Number.isFinite(draftY) ? draftY : 0,
        });
        try {
          const row2 = db.prepare("SELECT payload_json FROM rts_layout_entities WHERE id = ?").get(layout.id) as { payload_json: string } | undefined;
          let payload: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(row2?.payload_json || "{}");
            if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
          } catch {}
          const nextPayload: Record<string, unknown> = {
            ...payload,
            id: layout.id,
            kind: "feature",
            repo: baseRepoPath,
            worktreePath,
            baseId,
            workerAssignments,
            prompt: String(body.prompt || taskTitle),
            runId: run.id,
            committed: true,
            phase: "running",
            x: Number.isFinite(draftX) ? draftX : Number(payload.x || 0),
            y: Number.isFinite(draftY) ? draftY : Number(payload.y || 0),
          };
          if (Number.isFinite(draftPort) && draftPort > 0) nextPayload.port = draftPort;
          db.prepare(
            "UPDATE rts_layout_entities SET payload_json = ?, updated_at = ? WHERE id = ?"
          ).run(JSON.stringify(nextPayload), new Date().toISOString(), layout.id);
        } catch {}
        try {
          db.prepare(
            "DELETE FROM rts_layout_entities WHERE entity_type = 'feature' AND id <> ? AND (run_id = ? OR worktree_path = ?)"
          ).run(layout.id, run.id, worktreePath);
        } catch {}
        const runtimeStart = ensureFactoryRuntime(worktreePath, Number.isFinite(draftPort) && draftPort > 0 ? draftPort : null);
        if (firstStep?.id) {
          const evt = { ts: new Date().toISOString(), event: "step.pending" as const, runId: run.id, workflowId, stepId: firstStep.id };
          emitEvent(evt);
          try {
            await immediateHandoff(evt);
          } catch {}
        }

        return json(res, { ok: true, run: getRunById(run.id), worktreePath, branchName, layout, runtime: runtimeStart });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(res, { ok: false, error: message }, 500);
      }
    }

    if (p === "/api/rts/building/delete" && method === "POST") {
      try {
        const body = JSON.parse(await readBody(req)) as { runId?: string };
        const runId = String(body?.runId ?? "").trim();
        if (!runId) return json(res, { ok: false, error: "runId is required" }, 400);
        const result = deleteRunWithArtifacts(runId);
        if (!result.deleted) return json(res, { ok: true, runId, deleted: false, alreadyAbsent: true });
        return json(res, {
          ok: true,
          runId: result.runId || runId,
          deleted: true,
          previousStatus: result.status,
          worktreeRemoved: !!result.worktreeRemoved,
          worktreePath: result.worktreePath || null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(res, { ok: false, error: message }, 500);
      }
    }

    if (p === "/api/rts/layout/position" && method === "POST") {
      try {
        const body = JSON.parse(await readBody(req)) as {
          entityType?: "base" | "feature" | "research" | "warehouse" | "run";
          entityId?: string;
          runId?: string | null;
          repoPath?: string | null;
          worktreePath?: string | null;
          x?: number;
          y?: number;
          allowCreate?: boolean;
          payload?: Record<string, unknown>;
        };
        const entityType = body.entityType;
        if (entityType !== "base" && entityType !== "feature" && entityType !== "research" && entityType !== "warehouse" && entityType !== "run") {
          return json(res, { ok: false, error: "entityType must be base|feature|research|warehouse|run" }, 400);
        }
        const result = upsertLayoutPosition({
          entityType,
          entityId: body.entityId,
          runId: body.runId ?? null,
          repoPath: body.repoPath ?? null,
          worktreePath: body.worktreePath ?? null,
          x: Number(body.x ?? 0),
          y: Number(body.y ?? 0),
          allowCreate: body.allowCreate === true,
          payload: (body.payload && typeof body.payload === "object") ? body.payload : undefined,
        });
        return json(res, { ok: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(res, { ok: false, error: message }, 500);
      }
    }

    if (p === "/api/rts/layout/delete" && method === "POST") {
      try {
        const body = JSON.parse(await readBody(req)) as {
          entityType?: "base" | "feature" | "research" | "warehouse" | "run";
          entityId?: string;
        };
        const entityType = body.entityType;
        if (entityType !== "base" && entityType !== "feature" && entityType !== "research" && entityType !== "warehouse" && entityType !== "run") {
          return json(res, { ok: false, error: "entityType must be base|feature|research|warehouse|run" }, 400);
        }
        const entityId = String(body.entityId || "").trim();
        if (!entityId) return json(res, { ok: false, error: "entityId is required" }, 400);
        if (entityType === "feature") {
          const db = getDb();
          const row = db.prepare(
            "SELECT run_id, repo_path, worktree_path, payload_json FROM rts_layout_entities WHERE id = ? AND entity_type = 'feature' LIMIT 1"
          ).get(entityId) as { run_id: string | null; repo_path: string | null; worktree_path: string | null; payload_json: string } | undefined;
          if (row?.run_id) {
            const result = deleteRunWithArtifacts(String(row.run_id));
            return json(res, { ok: true, ...result, via: "run-delete" });
          }
          if (row) {
            try {
              const payload = JSON.parse(row.payload_json || "{}") as Record<string, unknown>;
              const port = isValidPortValue(payload.port);
              if (port) stopFactoryRuntimeByPort(port);
              const wtRaw = String(payload.worktreePath ?? row.worktree_path ?? "").trim();
              const repoRaw = String(payload.repo ?? row.repo_path ?? "").trim();
              if (wtRaw) removeWorktreeByPaths(wtRaw, repoRaw);
            } catch {}
          }
        }
        const result = deleteLayoutEntity(entityType, entityId);
        return json(res, { ok: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(res, { ok: false, error: message }, 500);
      }
    }

    const eventsMatch = p.match(/^\/api\/runs\/([^/]+)\/events$/);
    if (eventsMatch) {
      return json(res, getRunEvents(eventsMatch[1]));
    }

    const storiesMatch = p.match(/^\/api\/runs\/([^/]+)\/stories$/);
    if (storiesMatch) {
      const db = getDb();
      const stories = db.prepare(
        "SELECT * FROM stories WHERE run_id = ? ORDER BY story_index ASC"
      ).all(storiesMatch[1]);
      return json(res, stories);
    }

    const runMatch = p.match(/^\/api\/runs\/(.+)$/);
    if (runMatch) {
      const run = getRunById(runMatch[1]);
      return run ? json(res, run) : json(res, { error: "not found" }, 404);
    }

    if (p === "/api/runs") {
      const wf = url.searchParams.get("workflow") ?? undefined;
      return json(res, getRuns(wf));
    }

    if (p.startsWith("/api/")) {
      return json(res, { ok: false, error: `not_found:${p}` }, 404);
    }

    // Serve fonts
    if (p.startsWith("/fonts/")) {
      const fontName = path.basename(p);
      const fontPath = path.resolve(__dirname, "..", "..", "assets", "fonts", fontName);
      const srcFontPath = path.resolve(__dirname, "..", "..", "src", "..", "assets", "fonts", fontName);
      const resolvedFont = fs.existsSync(fontPath) ? fontPath : srcFontPath;
      if (fs.existsSync(resolvedFont)) {
        res.writeHead(200, { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=31536000", "Access-Control-Allow-Origin": "*" });
        return res.end(fs.readFileSync(resolvedFont));
      }
    }

    // Serve logo
    if (p === "/logo.jpeg") {
      const logoPath = path.resolve(__dirname, "..", "..", "assets", "logo.jpeg");
      const srcLogoPath = path.resolve(__dirname, "..", "..", "src", "..", "assets", "logo.jpeg");
      const resolvedLogo = fs.existsSync(logoPath) ? logoPath : srcLogoPath;
      if (fs.existsSync(resolvedLogo)) {
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
        return res.end(fs.readFileSync(resolvedLogo));
      }
    }

    // Serve RTS sprite assets
    if (p.startsWith("/rts-sprites/")) {
      const spriteName = path.basename(p);
      const spritePath = path.resolve(__dirname, "rts-sprites", spriteName);
      const srcSpritePath = path.resolve(__dirname, "..", "..", "src", "server", "rts-sprites", spriteName);
      const resolvedSprite = fs.existsSync(spritePath) ? spritePath : srcSpritePath;
      if (fs.existsSync(resolvedSprite)) {
        res.writeHead(200, {
          "Content-Type": guessMime(resolvedSprite),
          "Cache-Control": "public, max-age=86400",
          "Access-Control-Allow-Origin": "*",
        });
        return res.end(fs.readFileSync(resolvedSprite));
      }
      res.writeHead(404);
      return res.end("not found");
    }

    // Serve frontend
    if (p === "/" || p === "/rts" || p === "/rts/") {
      return serveHTML(res, "rts.html");
    }
    if (p === "/classic" || p === "/index" || p === "/index.html") {
      return serveHTML(res, "index.html");
    }
    return serveHTML(res, "rts.html");
  });

  server.listen(port, () => {
    console.log(`Antfarm Dashboard: http://localhost:${port}`);
  });

  return server;
}
