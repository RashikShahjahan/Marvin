# Marvin Product Requirements

## Product summary

Marvin is a personal AI assistant that its sole user can reach through Discord direct messages.

## Problem

A useful personal assistant should be available where the user already communicates, retain conversational continuity, and work across desktop and mobile. A terminal-first interface is inconvenient for ordinary questions and personal conversations, while a Discord DM already provides notifications, asynchronous access, and familiar history.

The user needs to:

- reach the assistant from desktop or mobile;
- ask open-ended questions and receive clear, useful responses;
- instruct the assistant to perform agentic tasks with shell access;
- continue a conversation without repeatedly restating context;
- know whether a request was accepted, rejected because Marvin is busy, or failed;
- receive immediate feedback when the assistant is already working;
- keep the assistant private to its sole user.

## Access assumption

Marvin trusts Discord application visibility as its user boundary. The Discord application must be private and configured so only the sole user can discover and message it. Marvin does not maintain a second user-ID allowlist.

A one-to-one Discord DM delivered to the private application is treated as authorized. Bot-authored messages, guild messages, and group DMs are not accepted.

## Functional requirements

- Accept non-empty text messages delivered in a one-to-one Discord DM.
- Ignore messages from bots, guild channels, and group DMs.
- Preserve completed conversational context across process restarts.
- Reject additional text messages while a response is running without retaining their text.
- Report concise accepted, busy, and failed outcomes.
- Deliver all response text in order when it exceeds Discord's per-message length limit.
- Return a concise, actionable error when an accepted request fails.
- Allow the agent to use approved tools, including shell commands.

## Operating limits

- In-flight work may be lost when the process exits unexpectedly.
- Discord delivery is best effort. Crash-proof or exactly-once outbound delivery is out of scope for the first release.
- User-facing control commands and conversation switching are out of scope for the first release.
- Detached host processes are unsupported.
