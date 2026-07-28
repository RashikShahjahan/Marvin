import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  APPROVED_TOOLS,
  ConfigError,
  loadConfig,
  type ConfigFailureReason,
} from "../src/config.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "marvin-config-"));
  roots.push(root);
  return root;
}

async function workspaceAt(root: string): Promise<string> {
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return workspace;
}

async function expectConfigFailure(
  promise: ReturnType<typeof loadConfig>,
  reason: ConfigFailureReason,
): Promise<void> {
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }

  expect(rejection).toBeInstanceOf(ConfigError);
  expect(rejection).toMatchObject({ name: "ConfigError", message: reason, reason });
}

describe("configuration constants and errors", () => {
  test("exposes the exact least-privilege tool allowlist", () => {
    expect(APPROVED_TOOLS).toEqual(["read", "bash", "grep", "find", "ls"]);
    expect(new Set(APPROVED_TOOLS).size).toBe(APPROVED_TOOLS.length);
  });

  test("ConfigError identifies its stable machine-readable reason", () => {
    const error = new ConfigError("workspace_unavailable");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ConfigError");
    expect(error.message).toBe("workspace_unavailable");
    expect(error.reason).toBe("workspace_unavailable");
  });
});

describe("loadConfig validation", () => {
  test("rejects missing, blank, and relative required settings", async () => {
    const root = await temporaryRoot();
    const workspace = await workspaceAt(root);
    const defaultSessionDir = join(root, "sessions");
    const invalidEnvironments = [
      {},
      { DISCORD_TOKEN: "token" },
      { MARVIN_WORKSPACE: workspace },
      { DISCORD_TOKEN: "   ", MARVIN_WORKSPACE: workspace },
      { DISCORD_TOKEN: "token", MARVIN_WORKSPACE: "   " },
      { DISCORD_TOKEN: "token", MARVIN_WORKSPACE: "relative/workspace" },
    ];

    for (const env of invalidEnvironments) {
      await expectConfigFailure(loadConfig({ env, defaultSessionDir }), "invalid_config");
    }
  });

  test("rejects a missing workspace and a workspace that is not a directory", async () => {
    const root = await temporaryRoot();
    const file = join(root, "workspace-file");
    await writeFile(file, "not a directory");

    for (const workspace of [join(root, "missing"), file]) {
      await expectConfigFailure(
        loadConfig({
          env: { DISCORD_TOKEN: "token", MARVIN_WORKSPACE: workspace },
          defaultSessionDir: join(root, "sessions"),
        }),
        "workspace_unavailable",
      );
    }
  });

  test("rejects an explicitly blank model", async () => {
    const root = await temporaryRoot();
    const workspace = await workspaceAt(root);

    await expectConfigFailure(
      loadConfig({
        env: {
          DISCORD_TOKEN: "token",
          MARVIN_MODEL: " \t\n ",
          MARVIN_WORKSPACE: workspace,
        },
        defaultSessionDir: join(root, "sessions"),
      }),
      "invalid_config",
    );
  });
});

describe("loadConfig path and privacy invariants", () => {
  test("trims scalar values, canonicalizes symlinked directories, and preserves an explicit model", async () => {
    const root = await temporaryRoot();
    const workspace = await workspaceAt(root);
    const workspaceLink = join(root, "workspace-link");
    const sessionDir = join(root, "session-target");
    const sessionLink = join(root, "session-link");
    await mkdir(sessionDir, { mode: 0o700 });
    await chmod(sessionDir, 0o700);
    await Promise.all([symlink(workspace, workspaceLink), symlink(sessionDir, sessionLink)]);

    const config = await loadConfig({
      env: {
        DISCORD_TOKEN: "  discord-token  ",
        MARVIN_MODEL: "  provider/model  ",
        MARVIN_SESSION_DIR: `  ${sessionLink}  `,
        MARVIN_WORKSPACE: `  ${workspaceLink}  `,
      },
      defaultSessionDir: join(root, "unused"),
    });

    expect(config).toEqual({
      discordToken: "discord-token",
      model: "provider/model",
      sessionDir: await realpath(sessionDir),
      workspace: await realpath(workspace),
    });
  });

  test("creates a nested default session directory with private permissions", async () => {
    const root = await temporaryRoot();
    const workspace = await workspaceAt(root);
    const defaultSessionDir = join(root, "state", "nested", "sessions");

    const config = await loadConfig({
      env: { DISCORD_TOKEN: "token", MARVIN_WORKSPACE: workspace },
      defaultSessionDir,
    });

    expect(config).toEqual({
      discordToken: "token",
      sessionDir: await realpath(defaultSessionDir),
      workspace: await realpath(workspace),
    });
    expect(Object.hasOwn(config, "model")).toBe(false);
    if (process.platform !== "win32") {
      expect((await stat(defaultSessionDir)).mode & 0o777).toBe(0o700);
    }
  });

  test("uses the default when the session override contains only whitespace", async () => {
    const root = await temporaryRoot();
    const workspace = await workspaceAt(root);
    const defaultSessionDir = join(root, "sessions");

    const config = await loadConfig({
      env: {
        DISCORD_TOKEN: "token",
        MARVIN_SESSION_DIR: " \t ",
        MARVIN_WORKSPACE: workspace,
      },
      defaultSessionDir,
    });

    expect(config.sessionDir).toBe(await realpath(defaultSessionDir));
  });

  test("resolves a relative explicit session path against the process working directory", async () => {
    const root = await temporaryRoot();
    const workspace = await workspaceAt(root);
    const relativeSessionDir = `.marvin-test-session-${crypto.randomUUID()}`;
    const expectedSessionDir = resolve(relativeSessionDir);
    roots.push(expectedSessionDir);

    const config = await loadConfig({
      env: {
        DISCORD_TOKEN: "token",
        MARVIN_SESSION_DIR: relativeSessionDir,
        MARVIN_WORKSPACE: workspace,
      },
      defaultSessionDir: join(root, "unused"),
    });

    expect(config.sessionDir).toBe(await realpath(expectedSessionDir));
  });

  test("rejects session paths that cannot represent a directory", async () => {
    const root = await temporaryRoot();
    const workspace = await workspaceAt(root);
    const sessionFile = join(root, "session-file");
    await writeFile(sessionFile, "not a directory");

    await expectConfigFailure(
      loadConfig({
        env: {
          DISCORD_TOKEN: "token",
          MARVIN_SESSION_DIR: sessionFile,
          MARVIN_WORKSPACE: workspace,
        },
        defaultSessionDir: join(root, "unused"),
      }),
      "session_unavailable",
    );
  });

  test("rejects an explicitly configured session directory accessible by other users", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await temporaryRoot();
    const workspace = await workspaceAt(root);
    const sessionDir = join(root, "shared-sessions");
    await mkdir(sessionDir, { mode: 0o755 });
    await chmod(sessionDir, 0o755);

    await expectConfigFailure(
      loadConfig({
        env: {
          DISCORD_TOKEN: "token",
          MARVIN_SESSION_DIR: sessionDir,
          MARVIN_WORKSPACE: workspace,
        },
        defaultSessionDir: join(root, "unused"),
      }),
      "session_unavailable",
    );
  });
});
