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
