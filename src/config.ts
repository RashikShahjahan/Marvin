import { access, chmod, mkdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const APPROVED_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;

export interface MarvinConfig {
  discordToken: string;
  workspace: string;
  sessionDir: string;
  model?: string;
}

export type ConfigFailureReason =
  | "invalid_config"
  | "workspace_unavailable"
  | "session_unavailable";

export class ConfigError extends Error {
  constructor(readonly reason: ConfigFailureReason) {
    super(reason);
    this.name = "ConfigError";
  }
}

async function canonicalDirectory(path: string, reason: ConfigFailureReason): Promise<string> {
  try {
    const canonical = await realpath(path);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) {
      throw new ConfigError(reason);
    }
    await access(canonical, constants.R_OK | constants.X_OK);
    return canonical;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(reason);
  }
}

export async function loadConfig(options: {
  env?: Readonly<Record<string, string | undefined>>;
  defaultSessionDir: string;
}): Promise<MarvinConfig> {
  const env = options.env ?? process.env;
  const discordToken = env.DISCORD_TOKEN?.trim();
  const configuredWorkspace = env.MARVIN_WORKSPACE?.trim();

  if (!discordToken || !configuredWorkspace || !isAbsolute(configuredWorkspace)) {
    throw new ConfigError("invalid_config");
  }

  const workspace = await canonicalDirectory(configuredWorkspace, "workspace_unavailable");
  const configuredSessionDir = env.MARVIN_SESSION_DIR?.trim();
  const requestedSessionDir = resolve(configuredSessionDir || options.defaultSessionDir);

  try {
    await mkdir(requestedSessionDir, { recursive: true, mode: 0o700 });
    const sessionDir = await canonicalDirectory(requestedSessionDir, "session_unavailable");
    await access(sessionDir, constants.R_OK | constants.W_OK | constants.X_OK);

    const metadata = await stat(sessionDir);
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new ConfigError("session_unavailable");
    }

    // mkdir's mode is affected by umask; enforce the private policy for newly created defaults.
    if (!configuredSessionDir) {
      await chmod(sessionDir, 0o700);
    }

    const configuredModel = env.MARVIN_MODEL;
    if (configuredModel !== undefined && configuredModel.trim() === "") {
      throw new ConfigError("invalid_config");
    }

    return {
      discordToken,
      workspace,
      sessionDir,
      ...(configuredModel === undefined ? {} : { model: configuredModel.trim() }),
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError("session_unavailable");
  }
}
