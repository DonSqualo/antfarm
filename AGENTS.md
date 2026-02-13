# Antfarm Agents

Antfarm provisions multi-agent workflows for OpenClaw. It installs workflow agent workspaces, wires agents into the OpenClaw config, and keeps a run record per task.

## Installing Antfarm

**Prerequisites:** Node.js >= 22, OpenClaw v2026.2.9+, `gh` CLI (for PR steps).

> **Do NOT run `npm install antfarm`.** There is an unrelated package on npm with that name. Antfarm is installed from GitHub only.

### Steps

1. **Clone the repo** into the OpenClaw workspace:
   ```bash
   git clone https://github.com/snarktank/antfarm.git ~/.openclaw/workspace/antfarm
   ```

2. **Build:**
   ```bash
   cd ~/.openclaw/workspace/antfarm
   npm install
   npm run build
   ```

3. **Link the CLI** (makes `antfarm` available globally):
   ```bash
   npm link
   ```

4. **Install workflows** (provisions agents, cron jobs, and DB):
   ```bash
   antfarm install
   ```

5. **Verify:** Run `antfarm workflow list` — you should see the available workflows.

If `antfarm` fails with a `node:sqlite` error, your `node` binary may be Bun's wrapper instead of real Node.js 22+. Check with `node -e "require('node:sqlite')"`. See [#54](https://github.com/snarktank/antfarm/issues/54) for workarounds.

## Why Antfarm

- **Repeatable workflow execution**: Start the same set of agents with a consistent prompt and workspace every time.
- **Structured collaboration**: Each workflow defines roles (lead, developer, verifier, reviewer) and how they hand off work.
- **Traceable runs**: Runs are stored by task title so you can check status without hunting through logs.
- **Clean lifecycle**: Install, update, or uninstall workflows without manual cleanup.

## Frontend Asset Notes

- RTS dashboard source is in `src/server/rts.html`.
- RTS sprite assets are in `src/server/rts-sprites/`.
- `npm run build` copies `src/server/index.html`, `src/server/rts.html`, and `src/server/rts-sprites/*` into `dist/server/`.
- Building sprite policy: refuse building create/update work when `OPENAI_API_KEY` is not set; building sprites must be produced via OpenAI image generation as PNG assets (no SVG/vector fallback pipeline for buildings).
- RTS building perspective policy: enforce a fixed camera lock for all building sprites (2.5D isometric 3/4 view, yaw ~45deg, pitch ~35deg, same angle across base/feature/research/warehouse). Refuse delivery when perspective does not match.
- RTS sprite versioning policy: do not replace existing building sprite files; add new versioned PNG filenames and update `src/server/rts.html` references.
- Responsive RTS shell behavior is class-driven on `.layout` (`mobile-tab-build|runs|intel`) and must preserve desktop fallback by explicitly restoring non-mobile panel visibility in client JS.
- RTS multi-panel API update contract lives in `src/server/panel-update-contract.ts`; prefer returning a typed `uiUpdate` envelope (`createPanelUpdateEnvelope`) from dashboard endpoints instead of ad-hoc target strings.

## What It Changes in OpenClaw

- Adds workflow agents to `openclaw.json` (your main agent stays default).
- Creates workflow workspaces under `~/.openclaw/workspaces/workflows`.
- Stores workflow definitions and run state under `~/.openclaw/antfarm`.
- Inserts an Antfarm guidance block into the main agent's `AGENTS.md` and `TOOLS.md`.

## Uninstalling

- `antfarm workflow uninstall <workflow-id>` removes a single workflow's agents, workspaces, and run records.
- `antfarm uninstall` removes everything: all workflows, agents, cron jobs, and DB state.

If something fails, report the exact error and ask the user to resolve it before continuing.
