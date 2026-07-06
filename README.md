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

## Use the CLI

Set `MARVIN_API_URL` to the API server before running CLI commands.

```bash
export MARVIN_API_URL=http://localhost:3000
bun run cli agents list
bun run cli agents get ag_123
bun run cli agents create --name "Support Agent" --instructions "Be helpful." --model gpt-4.1 --tool read
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
