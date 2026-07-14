import { describe, expect, it } from "vitest";
import { createStarterSupervisorConfig } from "../src/config/index.js";
import { AgentJobSupervisorCore } from "../src/supervisor/index.js";
import { FakeSupervisorClock } from "./helpers/fake-supervisor-clock.js";
import { jobDescriptor, resource } from "./helpers/supervisor-fixtures.js";

const NOW = Date.parse("2026-07-13T11:00:00.000Z");

describe("singleton Agent job registry core", () => {
  it("finishes a routing failure without fabricating an attempt or lease", () => {
    const supervisor = new AgentJobSupervisorCore({
      config: createStarterSupervisorConfig(),
      clock: new FakeSupervisorClock(NOW),
    });
    supervisor.registerJob({
      descriptor: jobDescriptor({ jobId: "job:routing-failed", now: NOW }),
    });

    const routing = supervisor.getJob("job:routing-failed");
    expect(routing).toMatchObject({ lifecycleState: "routing" });
    expect(routing).not.toHaveProperty("attempt");
    expect(routing).not.toHaveProperty("lease");
    expect(supervisor.finishJobWithoutAttempt("job:routing-failed", "failed")).toMatchObject({
      terminal: [{ jobId: "job:routing-failed", status: "failed" }],
    });
    const terminal = supervisor.getJob("job:routing-failed");
    expect(terminal).toMatchObject({
      lifecycleState: "released",
      terminalStatus: "failed",
    });
    expect(terminal).not.toHaveProperty("attempt");
    expect(terminal).not.toHaveProperty("lease");
    expect(() => supervisor.stop()).not.toThrow();
  });

  it("tracks concurrent plugin jobs with unique immutable job, attempt, and lease identities", () => {
    const config = createStarterSupervisorConfig();
    let id = 0;
    const supervisor = new AgentJobSupervisorCore({
      config,
      clock: new FakeSupervisorClock(NOW),
      idFactory: () => String(++id),
    });
    const first = supervisor.registerJob({
      descriptor: jobDescriptor({
        jobId: "job:plugin-one",
        now: NOW,
        ownerId: "plugin:one",
        ownerKind: "plugin",
      }),
      resource: resource(),
    });
    const second = supervisor.registerJob({
      descriptor: jobDescriptor({
        jobId: "job:plugin-two",
        now: NOW,
        ownerId: "plugin:two",
        ownerKind: "plugin",
      }),
      resource: resource(),
    });

    expect(supervisor.snapshot()).toMatchObject({
      jobs: [
        { jobId: "job:plugin-one", owner: { ownerId: "plugin:one" }, lifecycleState: "starting" },
        { jobId: "job:plugin-two", owner: { ownerId: "plugin:two" }, lifecycleState: "starting" },
      ],
      activeJobIds: ["job:plugin-one", "job:plugin-two"],
    });
    expect(
      new Set([first.admitted[0]?.attempt.attemptId, second.admitted[0]?.attempt.attemptId]).size,
    ).toBe(2);
    expect(
      new Set([first.admitted[0]?.lease.leaseId, second.admitted[0]?.lease.leaseId]).size,
    ).toBe(2);

    const detached = supervisor.getJob("job:plugin-one");
    if (!detached) throw new Error("Expected registered job snapshot.");
    detached.owner.ownerId = "mutated:outside";
    expect(supervisor.getJob("job:plugin-one")?.owner.ownerId).toBe("plugin:one");
    expect(() =>
      supervisor.registerJob({
        descriptor: jobDescriptor({ jobId: "job:plugin-one", now: NOW }),
        resource: resource(),
      }),
    ).toThrow(expect.objectContaining({ code: "job_duplicate" }));
  });
});
