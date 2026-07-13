import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWorkerClient } from "../src/worker/index.js";
import { echoCapability, workerRequest } from "./helpers/worker-fixtures.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-agent-worker-protocol-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function faultClient(fault: string): AgentWorkerClient {
  return new AgentWorkerClient({
    environment: {
      PI_AGENT_ROUTER_TEST_MODE: "deterministic",
      PI_AGENT_ROUTER_TEST_FAULT: fault,
    },
  });
}

describe("versioned worker protocol validation", () => {
  it.each([
    ["malformed", "invalid_protocol"],
    ["oversize", "frame_too_large"],
    ["disconnect", "worker_disconnected"],
    ["identity-mismatch", "identity_mismatch"],
    ["unknown-capability", "capability_unknown"],
    ["schema-violation", "capability_schema"],
    ["oversize-arguments", "frame_too_large"],
  ] as const)("fails closed for %s worker frames", async (fault, code) => {
    const request = await workerRequest(await temporaryDirectory(), {
      capabilities: [echoCapability()],
    });
    await expect(faultClient(fault).runAttempt(request)).rejects.toMatchObject({ code });
  });

  it("rejects an oversized private run payload before spawning", async () => {
    const request = await workerRequest(await temporaryDirectory());
    if (request.capsule.execution.kind !== "agent") throw new Error("Expected Agent fixture.");
    request.capsule.execution.prompt = "x".repeat(request.capsule.limits.maxRunPayloadBytes);

    await expect(faultClient("").runAttempt(request)).rejects.toMatchObject({
      code: "payload_too_large",
    });
  }, 20_000);

  it("does not invoke a closure after its job is no longer active", async () => {
    const observed: unknown[] = [];
    const request = await workerRequest(await temporaryDirectory(), {
      capabilities: [echoCapability(observed)],
    });
    request.isActive = () => false;

    await expect(
      new AgentWorkerClient({
        environment: { PI_AGENT_ROUTER_TEST_MODE: "deterministic" },
      }).runAttempt(request),
    ).rejects.toMatchObject({ code: "capability_revoked" });
    expect(observed).toEqual([]);
  }, 20_000);

  it("fails the attempt when a parent capability result exceeds its bound", async () => {
    const request = await workerRequest(await temporaryDirectory(), {
      capabilities: [echoCapability([], "x".repeat(1_048_576))],
    });

    await expect(
      new AgentWorkerClient({
        environment: { PI_AGENT_ROUTER_TEST_MODE: "deterministic" },
      }).runAttempt(request),
    ).rejects.toMatchObject({ code: "frame_too_large" });
  }, 20_000);

  it("rejects malformed identity before spawning", async () => {
    const request = await workerRequest(await temporaryDirectory());
    request.identity.jobId = "";

    await expect(faultClient("").runAttempt(request)).rejects.toMatchObject({
      code: "invalid_protocol",
    });
  }, 20_000);

  it("rejects duplicate capability ids and names before spawning", async () => {
    const first = echoCapability();
    const second = { ...echoCapability(), capabilityId: first.capabilityId };
    const request = await workerRequest(await temporaryDirectory(), {
      capabilities: [first, second],
    });

    await expect(faultClient("").runAttempt(request)).rejects.toMatchObject({
      code: "invalid_protocol",
    });
  }, 20_000);
});
