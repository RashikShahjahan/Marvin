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

Start the server in one terminal, then run the test suite in another terminal:

```bash
bun run tests.ts
```

If the server is running on a different URL or using a different database file,
pass the same settings to the tests:

```bash
AGENTS_API_BASE_URL=http://localhost:3000 \
AGENTS_DB_PATH=agents.test.sqlite \
bun run tests.ts
```

This project was created using `bun init` in bun v1.3.14.
[Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
