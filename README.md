# marvin

To install dependencies:

```bash
bun install
```

## Run the server

Start the API server on `http://localhost:3000`:

```bash
bun run index.ts
```

By default, the server uses `agents.sqlite` in the project directory. To use a
different database file:

```bash
AGENTS_DB_PATH=agents.test.sqlite bun run index.ts
```

## Run the Discord bot

The Discord bot runs as a separate process and talks to the Marvin API. Start the
API server first, then configure the bot with a `.env` file containing a
Discord token, the Marvin API URL, and the Discord-channel-to-agent mapping.

```bash
cat > .env <<'EOF'
DISCORD_TOKEN=your_discord_bot_token
MARVIN_API_URL=http://localhost:3000
DISCORD_CHANNEL_AGENTS=discord_channel_id=ag_123,another_channel_id=ag_456
EOF

bun run discord
```

Each configured Discord parent channel maps to one Marvin agent. The bot only
responds inside Discord threads, and each thread is stored as one Marvin
conversation.

The Discord app needs these bot permissions/intents:

- Guilds
- Guild Messages
- Message Content
- Send Messages
- Read Message History

## Use the CLI

Set `MARVIN_API_URL` to the API server before running CLI commands.

```bash
export MARVIN_API_URL=http://localhost:3000
bun run cli agents list
bun run cli agents get ag_123
bun run cli agents create --name "Support Agent" \
  --instructions "Be helpful." \
  --model gpt-5.4-mini \
  --tool read
bun run cli agents update ag_123 --name "Updated Agent"
bun run cli agents delete ag_123
bun run cli responses create --agent-id ag_123 --message "Hello"
```

## Run tests

Test files live in the `tests/` directory, use the `*.test.ts` naming convention,
and are grouped by feature:

```text
tests/
  agents.test.ts
  agent-responses.test.ts
  conversations/
    messages.test.ts
    storage.test.ts
  support/
    api.ts
```

Run the full suite with:

```bash
bun test
```

The API tests start their own server with an isolated temporary database.

This project was created using `bun init` in bun v1.3.14.
[Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
