# Marvin

> **Implementation status:** The checked-in application and setup below are the previous Discord prototype. The proposed SSH and native Pi TUI release is specified in [`product.md`](./product.md), [`architecture.md`](./architecture.md), and [`program-design.md`](./program-design.md); it has not been implemented yet.

Marvin is a private, single-user AI assistant reached through Discord direct messages. It runs as
one Bun process and stores conversation history in Pi's native JSONL session format.

## Setup

Install dependencies:

```bash
bun install --frozen-lockfile
```

Configure a private Discord application that only the intended user can discover and message. Pi
provider credentials remain in Pi's standard credential store.

Set the runtime environment:

```bash
export DISCORD_TOKEN="..."
export MARVIN_WORKSPACE="/absolute/path/to/workspace"

# Optional. Defaults to a private Marvin directory under Pi's agent directory.
export MARVIN_SESSION_DIR="/absolute/path/to/private/session-directory"

# Optional exact selector: provider/model or provider/model:thinking-level
export MARVIN_MODEL="provider/model:medium"
```

The session directory must have no group or other permission bits on POSIX systems. Marvin has
shell access with the process's OS permissions; the workspace is a starting directory, not a
sandbox. Run it as a dedicated non-root user or in a restricted container.

Start Marvin:

```bash
bun run start
```

Marvin accepts non-empty one-to-one DMs, rejects overlapping prompts as busy, and splits long
answers into Discord-sized chunks. Bot,
guild, group-DM, and empty messages are ignored.

## Verification

```bash
bun run typecheck
bun test
```

The Pi contract tests use its credential-free faux provider and do not access a paid model or the
network. A deployment still needs a one-time Discord smoke test to confirm DM content visibility;
enable the Discord `Message Content` intent only if the application configuration requires it.
