import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStarterRouterConfigV2,
  loadRouterConfigV2,
  migrateRouterConfigFileToV2,
  validateRouterConfigV2,
  writeStarterRouterConfig,
  writeStarterRouterConfigV2,
} from "../src/config/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-agent-router-v2-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Agent Router V2 supervisor configuration", () => {
  it("defines strict balanced supervisor and isolation defaults", () => {
    const config = createStarterRouterConfigV2();

    expect(validateRouterConfigV2(config)).toMatchObject({ ok: true, diagnostics: [] });
    expect(config.configVersion).toBe(2);
    expect(config.supervisor.limits).toMatchObject({
      maxFullAgentWorkers: 4,
      maxCompletionWorkers: 8,
      maxJobsPerOwner: 3,
      maxControlPlaneJobs: 2,
      queueCapacity: 32,
    });
    expect(config.supervisor.priorityOrder).toEqual(["interactive", "maintenance", "background"]);
    expect(config.supervisor.isolation).toEqual({
      fullAgent: "process",
      completion: "process",
      controlPlane: "process",
    });
    expect(config.supervisor.retention.defaultMode).toBe("ephemeral");
    expect(config.supervisor.dependencies.failureContinueTaskKinds).toEqual([]);
    expect(config.candidates.flatMap((candidate) => candidate.allowedThinkingLevels)).not.toContain(
      "max",
    );
  });

  it("rejects unsafe or ambiguous supervisor policy", () => {
    const config = createStarterRouterConfigV2();
    config.supervisor.priorityOrder = ["background", "maintenance", "interactive"];
    config.supervisor.deadlines.cleanupDeadlineMs = 5_000;
    config.supervisor.ipc.maxFrameBytes = 1_024;
    config.supervisor.limits.maxJobsPerOwner = 64;
    const providerLimit = config.supervisor.limits.providerLimits[0];
    if (!providerLimit) throw new Error("Starter V2 config must include a provider limit.");
    providerLimit.maxActive = 64;
    config.supervisor.limits.providerLimits.push({ provider: "openai-codex", maxActive: 2 });

    const result = validateRouterConfigV2(config);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "supervisor_priority_order_invalid",
        "supervisor_cleanup_deadline_invalid",
        "supervisor_ipc_limit_invalid",
        "supervisor_provider_limit_duplicate",
        "supervisor_owner_limit_exceeds_global",
        "supervisor_provider_limit_exceeds_global",
      ]),
    );
  });
});

describe("Agent Router V2 configuration files", () => {
  it("requires explicit V1-to-V2 migration without changing the source file", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "agent-router.json");
    await writeStarterRouterConfig(path);
    const before = await readFile(path, "utf8");

    const loaded = await loadRouterConfigV2(path);
    expect(loaded.ok).toBe(false);
    expect(loaded.diagnostics[0]?.code).toBe("config_migration_required");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("backs up and atomically migrates V1 configuration to strict V2", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "agent-router.json");
    const backupPath = join(directory, "agent-router.v1.backup.json");
    await writeStarterRouterConfig(path);
    const before = await readFile(path, "utf8");

    const migrated = await migrateRouterConfigFileToV2(path, { backupPath });
    const loaded = await loadRouterConfigV2(path);

    expect(migrated).toMatchObject({ path, backupPath, previousVersion: 1, configVersion: 2 });
    expect(await readFile(backupPath, "utf8")).toBe(before);
    expect(loaded.ok).toBe(true);
    expect(loaded.config?.supervisor.limits.queueCapacity).toBe(32);
    expect(loaded.config?.supervisor.retention.defaultMode).toBe("ephemeral");
    await expect(migrateRouterConfigFileToV2(path, { backupPath })).rejects.toThrow("already V2");
  });

  it("writes a V2 starter only when the path does not exist", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "agent-router.json");

    await writeStarterRouterConfigV2(path);
    expect((await loadRouterConfigV2(path)).ok).toBe(true);
    await expect(writeStarterRouterConfigV2(path)).rejects.toThrow("Refusing to overwrite");
  });
});
