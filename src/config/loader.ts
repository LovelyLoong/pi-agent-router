import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RouterDiagnostic } from "../contracts/diagnostics.js";
import { hashRouterConfig } from "./hash.js";
import type { AgentRouterConfig } from "./schema.js";
import { createStarterRouterConfig } from "./starter.js";
import { validateRouterConfig } from "./validate.js";

const MAX_CONFIG_BYTES = 512 * 1024;

export interface LoadedRouterConfig {
  path: string;
  config?: AgentRouterConfig;
  configHash?: string;
  diagnostics: RouterDiagnostic[];
  ok: boolean;
}

export function getAgentRouterConfigPath(agentDir?: string): string {
  const root = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(root, "agent-router.json");
}

function failure(code: string, message: string, path: string): LoadedRouterConfig {
  return { ok: false, path, diagnostics: [{ code, severity: "error", message, path }] };
}

export async function loadRouterConfig(
  path = getAgentRouterConfigPath(),
): Promise<LoadedRouterConfig> {
  let metadata: Stats;
  try {
    metadata = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return failure(
        "config_missing",
        `Agent Router configuration is missing. Create '${path}' or run the setup command.`,
        path,
      );
    }
    return failure(
      "config_stat_failed",
      `Cannot inspect Agent Router configuration: ${String(error)}`,
      path,
    );
  }

  if (!metadata.isFile())
    return failure("config_not_file", "Agent Router configuration is not a file.", path);
  if (metadata.size > MAX_CONFIG_BYTES) {
    return failure(
      "config_too_large",
      `Agent Router configuration is ${metadata.size} bytes; limit is ${MAX_CONFIG_BYTES}.`,
      path,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    return failure(
      "config_json_invalid",
      `Agent Router configuration is not valid JSON: ${String(error)}`,
      path,
    );
  }

  const validated = validateRouterConfig(parsed);
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

export async function writeStarterRouterConfig(
  path = getAgentRouterConfigPath(),
): Promise<{ path: string; configHash: string }> {
  try {
    await access(path);
    throw new Error(`Refusing to overwrite existing Agent Router configuration '${path}'.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const config = createStarterRouterConfig();
  const validated = validateRouterConfig(config);
  if (!validated.ok || !validated.config) {
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
