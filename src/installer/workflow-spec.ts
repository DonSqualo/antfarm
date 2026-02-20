import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type {
  LoopConfig,
  PromptProfile,
  PromptTree,
  WorkflowAgent,
  WorkflowSpec,
  WorkflowStep,
} from "./types.js";

export async function loadWorkflowSpec(workflowDir: string): Promise<WorkflowSpec> {
  const filePath = path.join(workflowDir, "workflow.yml");
  const raw = await fsp.readFile(filePath, "utf-8");
  return parseWorkflowSpec(raw, workflowDir);
}

export function loadWorkflowSpecSync(workflowDir: string): WorkflowSpec {
  const filePath = path.join(workflowDir, "workflow.yml");
  const raw = fs.readFileSync(filePath, "utf-8");
  return parseWorkflowSpec(raw, workflowDir);
}

function parseWorkflowSpec(raw: string, workflowDir: string): WorkflowSpec {
  const parsed = YAML.parse(raw) as Record<string, unknown>;
  const normalized = normalizeWorkflowSpec(parsed);
  if (!normalized?.id) {
    throw new Error(`workflow.yml missing id in ${workflowDir}`);
  }
  if (!Array.isArray(normalized.agents) || normalized.agents.length === 0) {
    throw new Error(`workflow.yml missing agents list in ${workflowDir}`);
  }
  if (!Array.isArray(normalized.steps) || normalized.steps.length === 0) {
    throw new Error(`workflow.yml missing steps list in ${workflowDir}`);
  }
  validatePromptTree(normalized.promptTree, workflowDir);
  validateAgents(normalized.agents, workflowDir, normalized.promptTree);
  validateSteps(normalized.steps, workflowDir);
  return normalized;
}

function normalizeWorkflowSpec(parsed: Record<string, unknown>): WorkflowSpec {
  const promptTreeRaw = (parsed.prompt_tree ?? parsed.promptTree ?? {}) as Record<string, unknown>;
  const promptTree: PromptTree = {
    base: String(promptTreeRaw.base || "").trim(),
    classes: asStringRecord(promptTreeRaw.classes),
    subclasses: asStringRecord(promptTreeRaw.subclasses),
    skills: asOptionalStringRecord(promptTreeRaw.skills),
    memory: asOptionalStringRecord(promptTreeRaw.memory),
  };
  const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
  const normalizedAgents = agents.map((agentRaw) => {
    const raw = (agentRaw || {}) as Record<string, unknown>;
    const profileRaw = (raw.prompt_profile ?? raw.promptProfile ?? {}) as Record<string, unknown>;
    const promptProfile: PromptProfile = {
      class: String(profileRaw.class || "").trim(),
      subclass: String(profileRaw.subclass || "").trim(),
      workspaceFiles: asOptionalStringArray(profileRaw.workspace_files ?? profileRaw.workspaceFiles),
      skills: asOptionalStringArray(profileRaw.skills),
      memory: asOptionalStringArray(profileRaw.memory),
    };
    const out = raw as WorkflowAgent;
    out.promptProfile = promptProfile;
    return out;
  });
  const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const normalizedSteps = steps.map((stepRaw) => {
    const step = (stepRaw || {}) as WorkflowStep;
    const rawStep = stepRaw as any;
    if (rawStep?.type) {
      step.type = rawStep.type;
    }
    if (rawStep?.loop) {
      step.loop = parseLoopConfig(rawStep.loop);
    }
    return step;
  });

  const out = parsed as WorkflowSpec;
  out.promptTree = promptTree;
  out.agents = normalizedAgents;
  out.steps = normalizedSteps;
  return out;
}

function asStringRecord(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = String(k || "").trim();
    const value = String(v || "").trim();
    if (!key || !value) continue;
    out[key] = value;
  }
  return out;
}

function asOptionalStringRecord(input: unknown): Record<string, string> | undefined {
  const out = asStringRecord(input);
  return Object.keys(out).length ? out : undefined;
}

function asOptionalStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input.map((v) => String(v || "").trim()).filter(Boolean);
  return out.length ? out : undefined;
}

function validatePromptTree(promptTree: PromptTree | undefined, workflowDir: string) {
  if (!promptTree) {
    throw new Error(`workflow.yml missing prompt_tree in ${workflowDir}`);
  }
  if (!promptTree.base?.trim()) {
    throw new Error(`workflow.yml missing prompt_tree.base in ${workflowDir}`);
  }
  if (!promptTree.classes || Object.keys(promptTree.classes).length === 0) {
    throw new Error(`workflow.yml missing prompt_tree.classes in ${workflowDir}`);
  }
  if (!promptTree.subclasses || Object.keys(promptTree.subclasses).length === 0) {
    throw new Error(`workflow.yml missing prompt_tree.subclasses in ${workflowDir}`);
  }
}

function validateAgents(agents: WorkflowAgent[], workflowDir: string, promptTree: PromptTree) {
  const ids = new Set<string>();
  for (const agent of agents) {
    if (!agent.id?.trim()) {
      throw new Error(`workflow.yml missing agent id in ${workflowDir}`);
    }
    if (ids.has(agent.id)) {
      throw new Error(`workflow.yml has duplicate agent id "${agent.id}" in ${workflowDir}`);
    }
    ids.add(agent.id);
    if (!agent.workspace?.baseDir?.trim()) {
      throw new Error(`workflow.yml missing workspace.baseDir for agent "${agent.id}"`);
    }
    if (!agent.workspace?.files || Object.keys(agent.workspace.files).length === 0) {
      throw new Error(`workflow.yml missing workspace.files for agent "${agent.id}"`);
    }
    if (agent.workspace.skills && !Array.isArray(agent.workspace.skills)) {
      throw new Error(`workflow.yml workspace.skills must be a list for agent "${agent.id}"`);
    }
    if (agent.timeoutSeconds !== undefined && agent.timeoutSeconds <= 0) {
      throw new Error(`workflow.yml agent "${agent.id}" timeoutSeconds must be positive`);
    }
    if (agent.workers !== undefined) {
      if (!Number.isInteger(agent.workers) || agent.workers <= 0) {
        throw new Error(`workflow.yml agent "${agent.id}" workers must be a positive integer`);
      }
      if (agent.workers > 32) {
        throw new Error(`workflow.yml agent "${agent.id}" workers is too large (max 32)`);
      }
    }
    if (!agent.promptProfile?.class?.trim()) {
      throw new Error(`workflow.yml missing prompt_profile.class for agent "${agent.id}"`);
    }
    if (!agent.promptProfile?.subclass?.trim()) {
      throw new Error(`workflow.yml missing prompt_profile.subclass for agent "${agent.id}"`);
    }
    if (!(agent.promptProfile.class in promptTree.classes)) {
      throw new Error(`workflow.yml agent "${agent.id}" prompt_profile.class "${agent.promptProfile.class}" not found in prompt_tree.classes`);
    }
    if (!(agent.promptProfile.subclass in promptTree.subclasses)) {
      throw new Error(`workflow.yml agent "${agent.id}" prompt_profile.subclass "${agent.promptProfile.subclass}" not found in prompt_tree.subclasses`);
    }
    const workspaceFiles = agent.promptProfile.workspaceFiles ?? ["IDENTITY.md", "SOUL.md", "AGENTS.md"];
    for (const file of workspaceFiles) {
      if (!(file in agent.workspace.files)) {
        throw new Error(
          `workflow.yml agent "${agent.id}" prompt_profile.workspace_files includes "${file}" but workspace.files does not define it`,
        );
      }
    }
  }
}

function parseLoopConfig(raw: any): LoopConfig {
  return {
    over: raw.over,
    completion: raw.completion,
    freshSession: raw.fresh_session ?? raw.freshSession,
    verifyEach: raw.verify_each ?? raw.verifyEach,
    verifyStep: raw.verify_step ?? raw.verifyStep,
  };
}

function validateSteps(steps: WorkflowStep[], workflowDir: string) {
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id?.trim()) {
      throw new Error(`workflow.yml missing step id in ${workflowDir}`);
    }
    if (ids.has(step.id)) {
      throw new Error(`workflow.yml has duplicate step id "${step.id}" in ${workflowDir}`);
    }
    ids.add(step.id);
    if (!step.agent?.trim()) {
      throw new Error(`workflow.yml missing step.agent for step "${step.id}"`);
    }
    if (!step.input?.trim()) {
      throw new Error(`workflow.yml missing step.input for step "${step.id}"`);
    }
    if (!step.expects?.trim()) {
      throw new Error(`workflow.yml missing step.expects for step "${step.id}"`);
    }
  }

  // Validate loop config references
  for (const step of steps) {
    if (step.type === "loop") {
      if (!step.loop) {
        throw new Error(`workflow.yml step "${step.id}" has type=loop but no loop config`);
      }
      if (step.loop.over !== "stories") {
        throw new Error(`workflow.yml step "${step.id}" loop.over must be "stories"`);
      }
      if (step.loop.completion !== "all_done") {
        throw new Error(`workflow.yml step "${step.id}" loop.completion must be "all_done"`);
      }
      if (step.loop.verifyEach && step.loop.verifyStep) {
        if (!ids.has(step.loop.verifyStep)) {
          throw new Error(`workflow.yml step "${step.id}" loop.verify_step references unknown step "${step.loop.verifyStep}"`);
        }
      }
    }
  }
}
