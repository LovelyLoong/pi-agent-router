import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RouterDiagnostic } from "../contracts/diagnostics.js";
import { hashRouterConfig } from "./hash.js";
import type { AgentRouterConfig, AgentRouterConfigV2 } from "./schema.js";
import { createStarterRouterConfig, createStarterRouterConfigV2 } from "./starter.js";
import { validateRouterConfig, validateRouterConfigV2 } from "./validate.js";

const MAX_CONFIG_BYTES = 512 * 1024;

interface LoadedConfigBase {
  path: string;
  configHash?: string;
  diagnostics: RouterDiagnostic[];
  ok: boolean;
}

export interface LoadedRouterConfig extends LoadedConfigBase {
  config?: AgentRouterConfig;
}

export interface LoadedRouterConfigV2 extends LoadedConfigBase {
  config?: AgentRouterConfigV2;
}

type ParsedConfigResult =
  | { ok: true; parsed: unknown }
  | { ok: false; diagnostic: RouterDiagnostic };

export function getAgentRouterConfigPath(agentDir?: string): string {
  const root = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(root, "agent-router.json");
}

function failure<T extends LoadedConfigBase>(code: string, message: string, path: string): T {
  return { ok: false, path, diagnostics: [{ code, severity: "error", message, path }] } as T;
}

async function readParsedConfig(path: string): Promise<ParsedConfigResult> {
  let metadata: Stats;
  try {
    metadata = await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      diagnostic: {
        code: code === "ENOENT" ? "config_missing" : "config_stat_failed",
        severity: "error",
        message:
          code === "ENOENT"
            ? `Agent Router configuration is missing. Create '${path}' or run the setup command.`
            : `Cannot inspect Agent Router configuration: ${String(error)}`,
        path,
      },
    };
  }

  if (!metadata.isFile()) {
    return {
      ok: false,
      diagnostic: {
        code: "config_not_file",
        severity: "error",
        message: "Agent Router configuration is not a file.",
        path,
      },
    };
  }
  if (metadata.size > MAX_CONFIG_BYTES) {
    return {
      ok: false,
      diagnostic: {
        code: "config_too_large",
        severity: "error",
        message: `Agent Router configuration is ${metadata.size} bytes; limit is ${MAX_CONFIG_BYTES}.`,
        path,
      },
    };
  }

  try {
    return { ok: true, parsed: JSON.parse(await readFile(path, "utf8")) as unknown };
  } catch (error) {
    return {
      ok: false,
      diagnostic: {
        code: "config_json_invalid",
        severity: "error",
        message: `Agent Router configuration is not valid JSON: ${String(error)}`,
        path,
      },
    };
  }
}

export async function loadRouterConfig(
  path = getAgentRouterConfigPath(),
): Promise<LoadedRouterConfig> {
  const read = await readParsedConfig(path);
  if (!read.ok) return failure(read.diagnostic.code, read.diagnostic.message, path);

  const validated = validateRouterConfig(read.parsed);
  if (!validated.ok || !validated.config) {
    return {
      ok: false,
      path,
      diagnostics: validated.diagnostics.map((item) => ({ ...item, path: item.path ?? path })),
    };
  }

  return {
    ok: true,
    path,
    config: validated.config,
    configHash: hashRouterConfig(validated.config),
    diagnostics: [],
  };
}

export async function loadRouterConfigV2(
  path = getAgentRouterConfigPath(),
): Promise<LoadedRouterConfigV2> {
  const read = await readParsedConfig(path);
  if (!read.ok) return failure(read.diagnostic.code, read.diagnostic.message, path);

  if (
    read.parsed &&
    typeof read.parsed === "object" &&
    (read.parsed as { configVersion?: unknown }).configVersion === 1 &&
    validateRouterConfig(read.parsed).ok
  ) {
    return failure(
      "config_migration_required",
      `Agent Router configuration '${path}' is V1. Run the explicit backed-up V2 migration before starting the V2 supervisor service.`,
      path,
    );
  }

  const validated = validateRouterConfigV2(read.parsed);
  if (!validated.ok || !validated.config) {
    return {
      ok: false,
      path,
      diagnostics: validated.diagnostics.map((item) => ({ ...item, path: item.path ?? path })),
    };
  }

  return {
    ok: true,
    path,
    config: validated.config,
    configHash: hashRouterConfig(validated.config),
    diagnostics: [],
  };
}

async function writeStarterConfig<TConfig>(
  path: string,
  config: TConfig,
  validate: (value: unknown) => { ok: boolean; diagnostics: RouterDiagnostic[] },
): Promise<{ path: string; configHash: string }> {
  try {
    await access(path);
    throw new Error(`Refusing to overwrite existing Agent Router configuration '${path}'.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const validated = validate(config);
  if (!validated.ok) {
    throw new Error(
      `Built-in starter configuration is invalid: ${validated.diagnostics.map((item) => item.message).join("; ")}`,
    );
  }

  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }

  return { path, configHash: hashRouterConfig(config) };
}

export async function writeStarterRouterConfig(
  path = getAgentRouterConfigPath(),
): Promise<{ path: string; configHash: string }> {
  return writeStarterConfig(path, createStarterRouterConfig(), validateRouterConfig);
}

export async function writeStarterRouterConfigV2(
  path = getAgentRouterConfigPath(),
): Promise<{ path: string; configHash: string }> {
  return writeStarterConfig(path, createStarterRouterConfigV2(), validateRouterConfigV2);
}
