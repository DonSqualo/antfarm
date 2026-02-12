import type { AntfarmEvent } from "./events.js";

/**
 * Optional immediate handoff hook used by dashboard-triggered runs.
 *
 * Assumption/scope: current minimal behavior is a no-op handler.
 * This keeps run creation deterministic even when no handoff strategy is configured.
 */
export function createImmediateHandoffHandler(): (event: AntfarmEvent) => Promise<void> {
  return async (_event: AntfarmEvent): Promise<void> => {
    // Intentionally no-op.
  };
}
