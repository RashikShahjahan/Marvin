# Marvin Product Requirements

## Product summary

Marvin is a personal AI assistant a user can chat with on discord.

## Problem

A useful personal assistant should be available where the user already communicates, retain conversational continuity, and work across desktop and mobile. A terminal-first interface is inconvenient for ordinary questions and personal conversations, while a Discord DM already provides notifications, asynchronous access, and familiar history.

The user needs to:

- reach the assistant from desktop or mobile;
- ask open-ended questions and receive clear, useful responses;
- instruct the assistant to perform agentic task
- continue a conversation without repeatedly restating context;
- know whether the assistant is responding, waiting, or failed;
- stop an unhelpful response or intentionally start a clean conversation;
- prevent anyone else from using the assistant;

## Functional requirements

- Accept text messages sent in a Discord DM by the configured operator.
- Reject messages from bots, guild channels, group contexts, and non-allowlisted users.
- Deliver complete responses even when they exceed Discord's per-message length limit.
- Return a concise, actionable error when an authorized request fails.
- Enable tool to use shell commands
