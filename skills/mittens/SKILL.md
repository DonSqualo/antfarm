---
name: mittens
description: "Run and operate Mittens factory runtime services (renderer + server) via the mittens CLI, including per-worktree/port startup conventions."
user-invocable: false
---

# Mittens

Use this skill when a task involves launching or managing Mittens runtimes, especially for factory environments where each factory has its own worktree and base port.

## Factory Runtime Convention

Each factory gets:
- Its own git worktree (isolated workspace)
- A unique base port (`PORT`)
- A renderer on `PORT`
- A server on `PORT + 1`

Always keep renderer/server port pairing consistent for a given factory.

## Common CLI Flows

```bash
# Show CLI help
mittens --help

# Show available subcommands/help for runtime commands
mittens runtime --help
```

### Start renderer + server for a factory

```bash
# Example factory workspace + base port
cd /path/to/factory-worktree
PORT=3401

# Start renderer on base port
mittens renderer start --port "$PORT"

# Start server on base+1
mittens server start --port "$((PORT + 1))"
```

### Stop factory services

```bash
cd /path/to/factory-worktree
PORT=3401

mittens renderer stop --port "$PORT"
mittens server stop --port "$((PORT + 1))"
```

### Health check / status

```bash
cd /path/to/factory-worktree
PORT=3401

mittens renderer status --port "$PORT"
mittens server status --port "$((PORT + 1))"
```

## Agent Guidance

- When spinning up a new factory, derive two ports from one base value:
  - `rendererPort = basePort`
  - `serverPort = basePort + 1`
- Run commands from the factory's own worktree.
- If a port is already in use, choose a different base port and preserve the `+1` relationship.
- Keep logs/process metadata per factory so parallel factories do not conflict.
