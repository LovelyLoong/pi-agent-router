import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { hashRouterConfig } from "./hash.js";
import type { AgentRouterConfigV1, AgentRouterConfigV2 } from "./schema.js";
import { createStarterComplianceConfig, createStarterSupervisorConfig } from "./starter.js";
import { validateRouterConfig, validateRouterConfigV2 } from "./validate.js";

const MAX_MIGRATION_CONFIG_BYTES = 512 * 1024;

export interface RouterConfigV2MigrationResult {
  path: string;
  backupPath: string;
  previousVersion: 1;
  configVersion: 2;
  configHash: string;
}

function diagnosticMessages(diagnostics: Array<{ code: string; message: string }>): string {
  return diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ");
}

async function writeSyncedExclusive(path: string, contents: string): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceFromContents(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeSyncedExclusive(temporary, contents);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function migrateRouterConfigV1ToV2(value: unknown): AgentRouterConfigV2 {
  const validatedV1 = validateRouterConfig(value);
  if (!validatedV1.ok || !validatedV1.config) {
    throw new Error(
      `Cannot migrate invalid V1 Agent Router configuration: ${diagnosticMessages(validatedV1.diagnostics)}`,
    );
  }

  const { configVersion: _configVersion, ...shared } = validatedV1.config;
  const migrated: AgentRouterConfigV2 = {
    configVersion: 2,
    ...shared,
    supervisor: createStarterSupervisorConfig(),
    compliance: createStarterComplianceConfig(),
  };
  const validatedV2 = validateRouterConfigV2(migrated);
  if (!validatedV2.ok || !validatedV2.config) {
    throw new Error(
      `Built-in V2 migration produced an invalid configuration: ${diagnosticMessages(validatedV2.diagnostics)}`,
    );
  }
  return validatedV2.config;
}

export async function migrateRouterConfigFileToV2(
  path: string,
  options: { backupPath?: string } = {},
): Promise<RouterConfigV2MigrationResult> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Refusing to migrate symbolic-link configuration '${path}'.`);
  }
  if (!metadata.isFile()) throw new Error(`Agent Router configuration '${path}' is not a file.`);
  if (metadata.size > MAX_MIGRATION_CONFIG_BYTES) {
    throw new Error(
      `Agent Router configuration is ${metadata.size} bytes; migration limit is ${MAX_MIGRATION_CONFIG_BYTES}.`,
    );
  }

  const originalContents = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(originalContents) as unknown;
  } catch (error) {
    throw new Error(`Cannot migrate malformed Agent Router JSON: ${String(error)}`);
  }

  const alreadyV2 = validateRouterConfigV2(parsed);
  if (alreadyV2.ok) {
    throw new Error(
      `Agent Router configuration '${path}' is already V2; no migration was written.`,
    );
  }
  const migrated = migrateRouterConfigV1ToV2(parsed);
  const migratedContents = `${JSON.stringify(migrated, null, 2)}\n`;
  const backupPath =
    options.backupPath ??
    `${path}.before-v2.${new Date().toISOString().replaceAll(":", "-")}.${randomUUID()}.json`;

  await mkdir(dirname(backupPath), { recursive: true });
  await writeSyncedExclusive(backupPath, originalContents);

  try {
    await replaceFromContents(path, migratedContents);
    const persisted = validateRouterConfigV2(JSON.parse(await readFile(path, "utf8")) as unknown);
    if (!persisted.ok || !persisted.config) {
      throw new Error(
        `Persisted V2 configuration failed verification: ${diagnosticMessages(persisted.diagnostics)}`,
      );
    }
  } catch (error) {
    try {
      await replaceFromContents(path, originalContents);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `V2 migration failed and rollback from '${backupPath}' also failed.`,
      );
    }
    throw error;
  }

  return {
    path,
    backupPath,
    previousVersion: 1,
    configVersion: 2,
    configHash: hashRouterConfig(migrated),
  };
}

export function asRouterConfigV1(value: unknown): AgentRouterConfigV1 {
  const validated = validateRouterConfig(value);
  if (!validated.ok || !validated.config) {
    throw new Error(
      `Expected valid V1 configuration: ${diagnosticMessages(validated.diagnostics)}`,
    );
  }
  return validated.config;
}
