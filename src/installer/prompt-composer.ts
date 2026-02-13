import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { WorkflowAgent, WorkflowSpec } from "./types.js";

export type PromptTraceFile = {
  layer: "base" | "class" | "subclass" | "workspace";
  logicalName: string;
  absPath: string;
  sha256: string;
  bytes: number;
  source: "root" | "study";
};

export type PromptTrace = {
  files: PromptTraceFile[];
  promptMarkdown: string;
  promptHash: string;
};

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function toPosix(p: string): string {
  return String(p || "").replace(/\\/g, "/");
}

function parseStudyInclude(line: string): string | null {
  const trimmed = String(line || "").trim();
  const m = trimmed.match(/^study\s+@file\s+(.+)$/i);
  if (!m) return null;
  const target = String(m[1] || "").trim().replace(/^['"]|['"]$/g, "");
  return target || null;
}

function readFileStrict(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Prompt composition failed: cannot read "${filePath}": ${msg}`);
  }
}

function resolveFileStrict(baseDir: string, relativeOrAbsPath: string): string {
  const raw = String(relativeOrAbsPath || "").trim();
  if (!raw) throw new Error("Prompt composition failed: empty file path");
  const abs = path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
  if (!fs.existsSync(abs)) {
    throw new Error(`Prompt composition failed: missing file "${abs}"`);
  }
  const st = fs.statSync(abs);
  if (!st.isFile()) {
    throw new Error(`Prompt composition failed: not a file "${abs}"`);
  }
  return abs;
}

type ComposeFileParams = {
  files: PromptTraceFile[];
  sections: string[];
  seen: Set<string>;
  logicalName: string;
  layer: PromptTraceFile["layer"];
  source: PromptTraceFile["source"];
  absPath: string;
};

function composeFile(params: ComposeFileParams): void {
  const canonical = toPosix(path.resolve(params.absPath));
  if (params.seen.has(canonical)) return;
  params.seen.add(canonical);

  const raw = readFileStrict(canonical);
  const lines = raw.split(/\r?\n/);
  const rendered: string[] = [];
  for (const line of lines) {
    const includeTarget = parseStudyInclude(line);
    if (!includeTarget) {
      rendered.push(line);
      continue;
    }
    const includeAbs = resolveFileStrict(path.dirname(canonical), includeTarget);
    composeFile({
      ...params,
      source: "study",
      absPath: includeAbs,
    });
  }

  const content = rendered.join("\n").trim();
  const bytes = Buffer.byteLength(raw, "utf-8");
  params.files.push({
    layer: params.layer,
    logicalName: params.logicalName,
    absPath: canonical,
    sha256: sha256(raw),
    bytes,
    source: params.source,
  });
  params.sections.push(
    [
      `## Source: ${params.logicalName}`,
      `Path: ${canonical}`,
      "",
      content,
      "",
    ].join("\n"),
  );
}

export function composePromptTrace(params: {
  workflowDir: string;
  workflow: WorkflowSpec;
  agent: WorkflowAgent;
  workspaceDir: string;
}): PromptTrace {
  const { workflowDir, workflow, agent, workspaceDir } = params;
  const files: PromptTraceFile[] = [];
  const sections: string[] = [];
  const seen = new Set<string>();
  const promptTree = workflow.promptTree;
  const profile = agent.promptProfile;

  const orderedRoots: Array<{ layer: PromptTraceFile["layer"]; logicalName: string; absPath: string }> = [];
  orderedRoots.push({
    layer: "base",
    logicalName: `base:${profile.class}/${profile.subclass}`,
    absPath: resolveFileStrict(workflowDir, promptTree.base),
  });
  orderedRoots.push({
    layer: "class",
    logicalName: `class:${profile.class}`,
    absPath: resolveFileStrict(workflowDir, promptTree.classes[profile.class]),
  });
  orderedRoots.push({
    layer: "subclass",
    logicalName: `subclass:${profile.subclass}`,
    absPath: resolveFileStrict(workflowDir, promptTree.subclasses[profile.subclass]),
  });
  const workspaceFiles = profile.workspaceFiles ?? ["IDENTITY.md", "SOUL.md", "AGENTS.md"];
  for (const fileName of workspaceFiles) {
    orderedRoots.push({
      layer: "workspace",
      logicalName: `workspace:${fileName}`,
      absPath: resolveFileStrict(workspaceDir, fileName),
    });
  }

  for (const root of orderedRoots) {
    composeFile({
      files,
      sections,
      seen,
      logicalName: root.logicalName,
      layer: root.layer,
      source: "root",
      absPath: root.absPath,
    });
  }

  const promptMarkdown = sections.join("\n").trim();
  return {
    files,
    promptMarkdown,
    promptHash: sha256(promptMarkdown),
  };
}

