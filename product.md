# Marvin Product Requirements

## Product summary

Marvin is a personal AI assistant that its sole user accesses through Pi's native terminal user interface (TUI) over SSH from mobile or desktop.

## Problem

A useful personal assistant should be accessible from desktop and mobile, retain conversational continuity, and provide a consistent private interface. Pi's native TUI, reached with a standard SSH client, avoids both a dependency on a third-party messaging platform and the cost of maintaining a separate Marvin interface.

The user needs to:

- reach the assistant from a desktop or mobile SSH client;
- ask open-ended questions and receive clear, useful responses;
- instruct the assistant to perform agentic tasks with shell access;
- continue a conversation without repeatedly restating context;
- know whether a request was accepted, rejected because Marvin is busy, or failed;
- receive immediate feedback when the assistant is already working;
- keep the assistant private to its sole user.

## Access assumption

Marvin trusts the SSH host's authentication and authorization as its user boundary. The host must be configured so only the sole user's account and credentials can access Marvin. Marvin does not maintain a second user allowlist.

Input submitted through an authenticated SSH session to Pi's TUI is treated as authorized. The SSH layer rejects unauthenticated connections before they reach Marvin.

## Functional requirements

- Use Pi's native interactive TUI rather than implementing a separate Marvin TUI.
- Support Pi's TUI through compatible SSH clients on desktop and mobile.
- Accept non-empty text submitted through an authenticated TUI session.
- Preserve completed conversational context across process restarts.
- Reject additional prompts while a response is running without retaining their text.
- Report concise accepted, busy, and failed outcomes.
- Display all response text in order through Pi's TUI.
- Return a concise, actionable error when an accepted request fails.
- Allow the agent to use approved tools, including shell commands.

## Operating limits

- In-flight work may be lost when the process exits unexpectedly.
- An interrupted SSH session may lose in-flight output. Durable or exactly-once output delivery is out of scope for the first release.
- User-facing control commands and conversation switching are out of scope for the first release.
- Detached host processes are unsupported.
