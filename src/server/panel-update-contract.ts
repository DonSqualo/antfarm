export const PANEL_TARGETS = {
  bottomCommandBar: "panel.bottom.command-bar",
  rightActionSidebar: "panel.right.action-sidebar",
  leftMediaPanel: "panel.left.media-panel",
} as const;

export type PanelTargetId = typeof PANEL_TARGETS[keyof typeof PANEL_TARGETS];

export type PanelPatchMode = "replace" | "merge";

export interface PanelPatch<TPayload = unknown> {
  target: PanelTargetId;
  mode?: PanelPatchMode;
  html?: string;
  payload?: TPayload;
}

export interface PanelUpdateEnvelope<TPayload = unknown> {
  event: string;
  payload?: TPayload;
  patches: PanelPatch[];
}

const TARGET_SET = new Set<PanelTargetId>(Object.values(PANEL_TARGETS));

function normalizeTargetInput(target: string): string {
  return String(target || "").trim().toLowerCase();
}

export function isKnownPanelTarget(target: string): target is PanelTargetId {
  return TARGET_SET.has(normalizeTargetInput(target) as PanelTargetId);
}

export function assertKnownPanelTarget(target: string): PanelTargetId {
  const normalized = normalizeTargetInput(target);
  if (TARGET_SET.has(normalized as PanelTargetId)) {
    return normalized as PanelTargetId;
  }
  const allowed = Object.values(PANEL_TARGETS).join(", ");
  throw new Error(`Unknown panel target id: ${JSON.stringify(target)}. Allowed targets: ${allowed}`);
}

export function normalizePanelPatch<TPayload = unknown>(patch: {
  target: string;
  mode?: PanelPatchMode;
  html?: string;
  payload?: TPayload;
}): PanelPatch<TPayload> {
  return {
    target: assertKnownPanelTarget(patch.target),
    mode: patch.mode,
    html: patch.html,
    payload: patch.payload,
  };
}

export function createPanelUpdateEnvelope<TPayload = unknown>(input: {
  event: string;
  payload?: TPayload;
  patches: Array<{
    target: string;
    mode?: PanelPatchMode;
    html?: string;
    payload?: unknown;
  }>;
}): PanelUpdateEnvelope<TPayload> {
  return {
    event: String(input.event || "").trim(),
    payload: input.payload,
    patches: input.patches.map((patch) => normalizePanelPatch(patch)),
  };
}
