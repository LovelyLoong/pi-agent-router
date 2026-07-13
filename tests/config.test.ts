import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStarterRouterConfig,
  hashRouterConfig,
  loadRouterConfig,
  validateRouterConfig,
  writeStarterRouterConfig,
} from "../src/config/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-agent-router-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Agent Router configuration", () => {
  it("creates a strict balanced starter config without max reasoning", () => {
    const config = createStarterRouterConfig();
    const result = validateRouterConfig(config);

    expect(result.ok).toBe(true);
    expect(config.router.targets).toEqual([
      {
        executorId: "pi",
        model: "openai-codex/gpt-5.4-mini",
        thinkingLevel: "low",
      },
      {
        executorId: "pi",
        model: "openai-codex/gpt-5.6-luna",
        thinkingLevel: "low",
      },
    ]);
    expect(config.candidates.map((candidate) => candidate.model)).toEqual([
      "openai-codex/gpt-5.4-mini",
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-terra",
      "openai-codex/gpt-5.6-sol",
    ]);
    expect(config.candidates.flatMap((candidate) => candidate.allowedThinkingLevels)).not.toContain(
      "max",
    );
  });

  it("rejects unknown properties instead of silently accepting policy", () => {
    const config = { ...createStarterRouterConfig(), implicitDiscovery: true };
    const result = validateRouterConfig(config);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((item) => item.code === "config_schema_invalid")).toBe(true);
  });

  it("rejects duplicate candidates and static priorities", () => {
    const config = createStarterRouterConfig();
    const first = config.candidates[0];
    const second = config.candidates[1];
    if (!first || !second) throw new Error("Starter config must provide two candidates.");
    config.candidates[1] = {
      ...second,
      id: first.id,
      staticPriority: first.staticPriority,
    };
    const result = validateRouterConfig(config);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["candidate_id_duplicate", "candidate_priority_duplicate"]),
    );
  });
});

describe("Agent Router V1 configuration files", () => {
  it("fails closed when the config file is missing", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "agent-router.json");
    const result = await loadRouterConfig(path);

    expect(result.ok).toBe(false);
    expect(result.config).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("config_missing");
  });

  it("writes an explicit starter once and refuses overwrite", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "agent-router.json");

    const written = await writeStarterRouterConfig(path);
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    expect(validateRouterConfig(parsed).ok).toBe(true);
    expect(written.configHash).toBe(hashRouterConfig(parsed));
    await expect(writeStarterRouterConfig(path)).rejects.toThrow("Refusing to overwrite");
  });

  it("reports malformed JSON without replacing it", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "agent-router.json");
    await writeFile(path, "{not-json", "utf8");

    const result = await loadRouterConfig(path);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("config_json_invalid");
    expect(await readFile(path, "utf8")).toBe("{not-json");
  });

  it("hashes objects canonically while preserving array order", () => {
    expect(hashRouterConfig({ b: 2, a: { d: 4, c: 3 } })).toBe(
      hashRouterConfig({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(hashRouterConfig({ values: [1, 2] })).not.toBe(hashRouterConfig({ values: [2, 1] }));
  });
});
