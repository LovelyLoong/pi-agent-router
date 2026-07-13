import { describe, expect, it } from "vitest";
import { createStarterSupervisorConfig } from "../src/config/index.js";
import { AgentJobSupervisorCore } from "../src/supervisor/index.js";
import { FakeSupervisorClock } from "./helpers/fake-supervisor-clock.js";
import { jobDescriptor, resource } from "./helpers/supervisor-fixtures.js";

const NOW = Date.parse("2026-07-13T10:00:00.000Z");

function ownerSupervisor(maxJobsPerOwner = 3): AgentJobSupervisorCore {
  const config = createStarterSupervisorConfig();
  config.limits.maxFullAgentWorkers = 4;
  config.limits.maxJobsPerOwner = maxJobsPerOwner;
  config.limits.providerLimits = [{ provider: "openai-codex", maxActive: 4 }];
  config.ownership.serviceTransferTaskKinds = ["memory-review"];
  let id = 0;
  return new AgentJobSupervisorCore({
    config,
    clock: new FakeSupervisorClock(NOW),
    idFactory: () => String(++id),
  });
}

describe("Agent job owner trees", () => {
  it("cascades owner release through child jobs while retaining active leases for cleanup", () => {
    const supervisor = ownerSupervisor();
    supervisor.registerJob({
      descriptor: jobDescriptor({ jobId: "job:parent", now: NOW, ownerId: "session:one" }),
      resource: resource(),
    });
    supervisor.registerJob({
      descriptor: jobDescriptor({
        jobId: "job:child",
        now: NOW,
        ownerId: "plugin:child",
        ownerKind: "plugin",
        parentJobId: "job:parent",
      }),
      resource: resource(),
    });

    expect(supervisor.getOwnedJobIds("session:one")).toEqual(["job:child", "job:parent"]);
    const released = supervisor.releaseOwner("session:one");
    expect(released.cancellationRequested).toEqual([
      { jobId: "job:child", reason: "owner-ended" },
      { jobId: "job:parent", reason: "owner-ended" },
    ]);
    expect(supervisor.getJob("job:parent")).toMatchObject({
      lifecycleState: "cancelling",
      lease: { state: "releasing" },
    });
    expect(supervisor.getJob("job:child")).toMatchObject({
      lifecycleState: "cancelling",
      lease: { state: "releasing" },
    });

    expect(() =>
      supervisor.registerJob({
        descriptor: jobDescriptor({ jobId: "job:late", now: NOW, ownerId: "session:one" }),
        resource: resource(),
      }),
    ).toThrow(expect.objectContaining({ code: "owner_released" }));
  });

  it("cancels queued owner work without creating an attempt", () => {
    const supervisor = ownerSupervisor(1);
    supervisor.registerJob({
      descriptor: jobDescriptor({ jobId: "job:active", now: NOW, ownerId: "session:one" }),
      resource: resource(),
    });
    supervisor.registerJob({
      descriptor: jobDescriptor({ jobId: "job:queued", now: NOW, ownerId: "session:one" }),
      resource: resource(),
    });

    const released = supervisor.releaseOwner("session:one");
    expect(released.cancellationRequested).toEqual([
      { jobId: "job:active", reason: "owner-ended" },
    ]);
    expect(supervisor.getJob("job:queued")).toMatchObject({
      lifecycleState: "released",
      terminalStatus: "cancelled",
    });
    expect(supervisor.getJob("job:queued")?.attempt).toBeUndefined();
  });
});

describe("bounded atomic service ownership transfer", () => {
  it("transfers an allowlisted job once and detaches it from caller cancellation", () => {
    const supervisor = ownerSupervisor();
    supervisor.registerJob({
      descriptor: jobDescriptor({
        jobId: "job:review",
        now: NOW,
        deadlineMs: 60_000,
        ownerId: "session:one",
        taskKind: "memory-review",
        ownerPolicy: {
          mode: "service-transfer",
          ttlMs: 5_000,
          purpose: "Finish an approved memory review after foreground shutdown.",
          maxAttempts: 3,
          maxRuntimeMs: 5_000,
        },
      }),
      resource: resource(),
    });

    const transferred = supervisor.transferOwnership({
      jobId: "job:review",
      serviceOwnerId: "router:service",
      reason: "Developer-approved memory review handoff.",
    });
    expect(transferred.transfer).toMatchObject({
      previousOwnerId: "session:one",
      serviceOwnerId: "router:service",
      deadlineAt: new Date(NOW + 5_000).toISOString(),
    });
    expect(supervisor.getJob("job:review")).toMatchObject({
      owner: { ownerId: "router:service", kind: "service" },
      lease: { ownerId: "router:service" },
      ownershipTransferred: true,
      deadlineAt: new Date(NOW + 5_000).toISOString(),
    });
    expect(supervisor.releaseOwner("session:one").cancellationRequested).toEqual([]);
    expect(supervisor.getJob("job:review")?.lifecycleState).toBe("starting");
    expect(supervisor.snapshot().ownershipTransfers).toHaveLength(1);
    expect(() =>
      supervisor.transferOwnership({
        jobId: "job:review",
        serviceOwnerId: "router:other",
        reason: "Second transfer must fail.",
      }),
    ).toThrow(expect.objectContaining({ code: "ownership_transfer_not_allowed" }));
  });

  it("rejects transfer atomically when the target owner quota is exhausted", () => {
    const supervisor = ownerSupervisor(1);
    supervisor.registerJob({
      descriptor: jobDescriptor({
        jobId: "job:service-active",
        now: NOW,
        ownerId: "router:service",
        ownerKind: "service",
      }),
      resource: resource(),
    });
    supervisor.registerJob({
      descriptor: jobDescriptor({
        jobId: "job:review",
        now: NOW,
        ownerId: "session:one",
        taskKind: "memory-review",
        ownerPolicy: {
          mode: "service-transfer",
          ttlMs: 5_000,
          purpose: "Attempt bounded background review.",
          maxAttempts: 3,
          maxRuntimeMs: 5_000,
        },
      }),
      resource: resource(),
    });

    expect(() =>
      supervisor.transferOwnership({
        jobId: "job:review",
        serviceOwnerId: "router:service",
        reason: "Target is at quota.",
      }),
    ).toThrow(expect.objectContaining({ code: "ownership_transfer_quota" }));
    expect(supervisor.getJob("job:review")).toMatchObject({
      owner: { ownerId: "session:one" },
      ownershipTransferred: false,
    });
    expect(supervisor.snapshot().ownershipTransfers).toEqual([]);
  });
});
