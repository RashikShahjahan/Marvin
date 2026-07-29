# Marvin Program Design

**Status:** Proposed for the first release  
**Inputs:** [`product.md`](./product.md) and [`architecture.md`](./architecture.md)  
**Scope:** Launcher files, exact Pi invocation, deployment policy, and verification.

## Design summary

Marvin is a small foreground launcher around Pi's native interactive CLI. It has no TypeScript application runtime, Discord adapter, Pi SDK integration, prompt queue, event reducer, renderer, or application database.

The launcher does only five things:

1. validate the SSH terminal and deterministic local configuration;
2. acquire one non-blocking instance lock;
3. change to Marvin's workspace;
4. run the exactly pinned Pi CLI with fixed base-prompt, tool, and session arguments; and
5. replace itself with Pi while transferring the open lock descriptor.

Everything after Pi starts is Pi-native. This is the smallest design that preserves SSH access, conversational continuity, agent tools, steering and follow-up queues, ordered terminal output, and visible request failures.

## Host contract

The first release targets one Linux SSH host with:

- OpenSSH or an equivalent server that supports a forced command and PTY allocation;
- a POSIX shell;
- util-linux `flock(1)` with non-blocking descriptor locks on a local filesystem;
- Node.js `>=22.19.0`, required by the pinned Pi package; and
- Bun for frozen dependency installation and repository scripts.

Desktop and mobile clients need only a compatible SSH terminal. Host portability beyond this contract is not a first-release feature; a different host must provide equivalent descriptor-lock and `exec` behavior and pass the same acceptance suite.

## Dependency

Pi is the only application dependency:

```json
{
  "dependencies": {
    "@earendil-works/pi-coding-agent": "0.82.1"
  },
  "engines": {
    "node": ">=22.19.0"
  }
}
```

The exact version and `bun.lock` are committed. The launcher invokes the installed CLI file directly with Node; it does not use `bunx`, `npx`, an ambient global `pi`, or package self-update behavior.

An upgrade is complete only after the Pi contract tests pass against the new exact version.

## File layout

```text
marvin/
├── bin/
│   └── marvin                  # POSIX launcher and SSH ForceCommand target
├── config/
│   └── system-prompt.md        # administrator-owned Marvin base prompt
├── deploy/
│   ├── marvin.conf             # installed as administrator-owned /etc/marvin.conf
│   └── sshd_config             # dedicated-account policy example
├── tests/
│   ├── launcher.test.sh        # deterministic black-box launcher tests
│   └── pi-contract.test.sh     # pinned CLI and pseudo-terminal contract tests
├── package.json
└── bun.lock
```

There are no `src/` modules. The launcher stays in one file because none of its behavior is reusable application logic.

## Configuration

The launcher reads one fixed administrator-owned file, `/etc/marvin.conf`:

| Value | Default | Validation |
| --- | --- | --- |
| `MARVIN_WORKSPACE` | None | Required absolute path; canonical target is an existing readable and searchable directory. |
| `MARVIN_SESSION_DIR` | `$HOME/.pi/agent/marvin/sessions` | Absolute path when provided; create with mode `0700` when absent; require read, write, and search access and no group/other permission bits. |
| `MARVIN_NODE_BIN` | None | Required absolute path to the administrator-owned Node executable. |

The default session path deliberately matches the existing Marvin Pi session location so completed conversations can survive the transport migration. The migration backs up this directory but does not convert or rewrite its JSONL files.

The release root determines the absolute Pi CLI and system-prompt paths. The configuration file is sourced only after its file and parent path are verified as administrator-owned and not writable by the Marvin account. The launcher also verifies that:

- the effective account is not root;
- `HOME` is an absolute directory owned by the deployment account;
- the Node binary, `flock`, prompt, and installed CLI are readable regular files; and
- stdin and stdout are attached to a PTY.

Installation and deployment acceptance, rather than every launch, verify that the Node binary, `flock`, complete release/dependency tree, and their parent paths are administrator-owned and not writable by the account.

The SSH client supplies no Marvin configuration. The account uses an administrator-controlled non-interactive login shell, executable lookup is fixed, and shell/runtime injection variables such as `ENV`, `BASH_ENV`, `LD_*`, and `NODE_OPTIONS` are absent before the forced command or removed before Node starts.

## Launcher control flow

`bin/marvin` uses `umask 077` and follows this order:

```text
require TTY stdin and stdout
  -> reject a non-empty SSH_ORIGINAL_COMMAND
  -> validate account, configuration, release files, workspace, and session directory
  -> open the fixed administrator-owned lock inode read-only on descriptor 9
  -> util-linux flock --exclusive --nonblock --conflict-exit-code 75 descriptor 9
  -> if held: print "Marvin is already active." and exit non-zero
  -> cd to the canonical workspace
  -> exec Pi with descriptor 9 still open
```

The lock path is fixed at `/var/lock/marvin/instance.lock`. Deployment creates it as a regular file under an administrator-owned, account-non-writable directory on a local filesystem. The launcher opens the existing inode without truncation and rejects a missing, symbolic-link, or non-regular path. Exit code `75` means contention; other open or `flock` failures are configuration errors.

The lock is acquired before Pi can run migrations or inspect a session. The shell then `exec`s Node, so Pi inherits the lock descriptor, stdin, stdout, stderr, terminal size, process identity, and foreground process group unchanged. Pi's normal exit, signal death, or crash closes the descriptor and releases the lock. There is no launcher supervisor, signal forwarding, restart, PID file, heartbeat, stale-lock timeout, or cleanup protocol.

The pinned runtime contract verifies that Pi and its normal tool subprocesses do not retain the lock beyond Pi's process lifetime. Trusted extensions that deliberately duplicate inherited descriptors are outside the supported contract.

Startup errors use fixed safe text and exit non-zero:

| Condition | Text |
| --- | --- |
| No interactive PTY | `Marvin requires an interactive SSH terminal.` |
| Client requested a remote command or subsystem | `Marvin does not accept remote commands.` |
| Lock held | `Marvin is already active.` |
| Lock unavailable or invalid | `Marvin cannot start: instance lock unavailable.` |
| Invalid local deployment input | `Marvin cannot start: <actionable local reason>.` |

Local errors may identify the setting that needs repair, but do not print credentials or provider data. Once Pi starts, its output and errors pass through unchanged.

## Pi invocation

With validated absolute paths, the launcher runs:

```sh
"$MARVIN_NODE_BIN" "$PI_CLI" \
  --continue \
  --session-dir "$MARVIN_SESSION_DIR" \
  --tools read,bash,grep,find,ls \
  --system-prompt "$MARVIN_SYSTEM_PROMPT"
```

No initial message is supplied, so TTY input and output select Pi's interactive mode. The design intentionally omits:

- `--mode`, `--print`, and RPC options because Pi owns the TUI;
- `--model`, `--provider`, and `--thinking` because Pi's session and settings own model selection;
- resource-disabling flags because Pi-native trusted settings, extensions, skills, templates, themes, and context files remain available; and
- API keys because Pi uses its standard credential mechanisms.

`--continue` asks Pi `0.82.1` to open the newest discoverable session for the current workspace in the dedicated session directory, or to create one if none exists. It is a continuation convention, not a permanent current-session pointer. Pi-native `/new`, `/resume`, `/tree`, `/fork`, `/clone`, and `/import` controls remain available, but Marvin adds no session controls and promises no workflow around switching.

## Base prompt and tools

`config/system-prompt.md` contains only stable Marvin behavior:

```text
You are Marvin, a personal AI assistant for one user.
Give clear, concise, useful answers. Use the available tools when they help complete the user's request. Report actions and failures truthfully. Ask a focused question before taking a materially ambiguous or destructive action.
```

The file contains no credentials, deployment paths, terminal assumptions, or claim that the workspace is a sandbox.

The initial model-facing tool allowlist is `read`, `bash`, `grep`, `find`, and `ls`. `bash` supplies the required shell access; the other names preserve direct read and search behavior without granting Pi's built-in file-mutation tools by default.

This is an initial behavior policy, not an isolation boundary. Pi may append trusted context files and skills to the base prompt. Trusted extensions can change runtime behavior, register same-named tools, or change active tools. The dedicated OS identity or container remains responsible for filesystem, process, and network restrictions.

## Pi-owned behavior

Marvin adds no code for these product features:

| Product behavior | Owner |
| --- | --- |
| Non-empty prompt submission and accepted feedback | Pi editor and TUI |
| Steering with Enter during a run | Pi steering queue |
| Follow-up with Alt+Enter during a run | Pi follow-up queue |
| Immediate queued-state display and queue retrieval | Pi TUI |
| Ordered response, progress, thinking, and tool display | Pi TUI on one PTY |
| Model and tool retries and actionable request errors | Pi runtime and TUI |
| Completed conversation continuity | Pi JSONL session manager |
| Model login, selection, thinking level, and settings | Pi-native commands and settings |

Ordinary prompts use queue semantics. Slash commands, `!` shell commands, and other Pi controls retain their own native behavior. If the pinned release fails any required behavior, the dependency or the product requirement must change; Marvin does not add an interception layer.

## SSH deployment

The repository's `deploy/sshd_config` documents a policy equivalent to:

```text
PermitUserEnvironment no

Match User marvin
    PubkeyAuthentication yes
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AuthorizedKeysFile /etc/ssh/authorized_keys/%u
    AuthorizedKeysCommand none
    TrustedUserCAKeys none
    PermitTTY yes
    ForceCommand /opt/marvin/bin/marvin
    DisableForwarding yes
    PermitUserRC no
    ClientAliveInterval 30
    ClientAliveCountMax 2

Match all
```

This fragment is included from global scope and explicitly closes its `Match` block. Exact directive support and precedence are validated with `sshd -T -C` on the target server. The effective policy must ensure that:

- only the sole user's administrator-managed public keys authenticate;
- no global authorized-keys command, trusted CA, or other authentication method adds credentials;
- the Marvin account cannot modify its authorized-key source, launcher, prompt, or SSH policy;
- shell, command, subsystem, and forwarding requests cannot bypass the forced launcher;
- no effective `AcceptEnv` pattern accepts names that affect Marvin, Pi, Node, executable lookup, or shell startup;
- the account's administrator-controlled login shell cannot execute user startup files before the forced command; and
- a normal client requests and receives a PTY with an empty `SSH_ORIGINAL_COMMAND`.

The workspace and session directory may be writable by the dedicated account. They are trusted application data, not administrator-owned executable policy. The lock file, `/etc/marvin.conf`, Node runtime, `flock`, release tree, and their parent directories are not account-writable. Server keepalives bound detection of an unresponsive client to approximately 60 seconds after the last successful response.

## Verification

### Launcher tests

`tests/launcher.test.sh` uses temporary directories, a fake Pi executable, and a pseudo-terminal. It verifies:

- missing PTY and remote-command requests fail before Pi starts;
- required, relative, missing, inaccessible, and insecure paths fail safely;
- a new session directory is private and an existing insecure directory is rejected;
- a missing, replaced, symbolic-link, or non-regular lock target is rejected;
- Pi receives the exact argument vector and canonical working directory;
- stdin, stdout, stderr, `TERM`, UTF-8 locale, and resize signals reach Pi unchanged;
- a second launch reports busy immediately and never starts Pi;
- `exec` leaves no launcher supervisor and Pi receives SSH signals directly;
- the inherited descriptor holds the lock for exactly Pi's lifetime and normal tool subprocesses do not extend it; and
- normal exit, failure, and forced termination release the lock without stale cleanup.

### Pi contract tests

`tests/pi-contract.test.sh` runs the real pinned CLI under a pseudo-terminal with Pi's credential-free local/faux provider where possible. It verifies:

- the direct CLI reports version `0.82.1` and starts in interactive mode;
- the exact tool names and base prompt are effective while native trusted resources still load;
- first launch creates a native session and the next launch continues completed context;
- idle submission displays accepted/working feedback;
- Enter and Alt+Enter during a slow run display and deliver steering and follow-up queues in native order;
- ordinary response text and tool activity remain ordered;
- a recoverable model or tool failure is actionable and returns Pi to an input-ready state; and
- an unavailable session directory fails, while corrupt/non-discoverable files and Pi-native session migration behavior are documented and tested against backup copies.

### Deployment acceptance

The target host is not released until manual SSH checks confirm:

- unauthorized, password, command, subsystem, environment, and forwarding attempts are rejected;
- two concurrent desktop/mobile connections produce one TUI and one immediate busy result;
- supported desktop and mobile clients handle UTF-8, paste, resize, Enter, Alt+Enter, Escape, and Alt+Up;
- completed context survives a clean exit and process restart;
- a network drop loses no already-persisted context, replays no unseen output, ends Pi within the keepalive bound, and releases the lock; and
- missing/expired provider authentication, model failure, and tool failure produce useful native terminal guidance without exposing credentials.

## Migration from the Discord implementation

Implementation of this design removes `index.ts`, `src/`, the Discord/message-splitting tests, `discord.js`, the direct Pi SDK adapter, and TypeScript-only development dependencies. No compatibility transport or dormant Discord code remains.

Before removal, the existing native Pi session directory is backed up. The new launcher uses the same default directory and validates continuation and any Pi-native format migration against a copy before opening the authoritative JSONL. Marvin never parses or rewrites session files itself. Discord tokens and configuration are then removed from the runtime environment and documentation.
