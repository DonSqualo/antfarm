/**
 * Setup the Antfarm orchestrator cron job.
 * This needs to be run once after installing Antfarm.
 * 
 * Since the cron API requires gateway access, this outputs instructions
 * for the user to run in their OpenClaw chat.
 */

const CRON_JOB_CONFIG = {
  name: "antfarm-orchestrator",
  schedule: { kind: "every", everyMs: 30000 },
  payload: {
    kind: "agentTurn",
    message: `Antfarm workflow orchestrator.

Step 1: Run check to detect completions and queue spawns
\`\`\`
cd ~/.openclaw/workspace/antfarm && node dist/cli/cli.js check 2>&1
\`\`\`

Step 2: List pending spawns
\`\`\`
cd ~/.openclaw/workspace/antfarm && node dist/cli/cli.js queue
\`\`\`

Step 3: For each file listed, read it with cat ~/.openclaw/antfarm/spawn-queue/<filename>, then call sessions_spawn with the agentId, task, and label (sessionLabel field)

Step 4: After successful spawn, run: node dist/cli/cli.js dequeue <filename>

If no active runs and no spawn files, reply: HEARTBEAT_OK`,
  },
  sessionTarget: "isolated",
  delivery: { mode: "none" },
  enabled: true,
};

export function getCronSetupInstructions(): string {
  return `
To complete Antfarm setup, ask your OpenClaw agent to run this command:

  Create an antfarm-orchestrator cron job that runs every 30 seconds

Or manually add this cron job via the OpenClaw cron tool:

${JSON.stringify(CRON_JOB_CONFIG, null, 2)}

The cron job will automatically orchestrate all Antfarm workflows.
`;
}

export function getCronJobConfig(): typeof CRON_JOB_CONFIG {
  return CRON_JOB_CONFIG;
}
