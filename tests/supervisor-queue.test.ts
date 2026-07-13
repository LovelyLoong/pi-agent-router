import { describe, expect, it } from "vitest";
import { createStarterSupervisorConfig } from "../src/config/index.js";
import { AgentJobSupervisorCore } from "../src/supervisor/index.js";
import { FakeSupervisorClock } from "./helpers/fake-supervisor-clock.js";
import { jobDescriptor, resource, SUCCESS } from "./helpers/supervisor-fixtures.js";

const NOW = Date.parse("2026-07-13T08:00:00.000Z");

function ids(): () => string {
  let value = 0;
  return () => String(++value);
}

describe("Agent job stable priority queue", () => {
  it("prioritizes interactive work and preserves FIFO within each priority", () => {
    const config = createStarterSupervisorConfig();
    config.limits.maxFullAgentWorkers = 1;
    config.limits.providerLimits = [{ provider: "openai-codex", maxActive: 1 }];
    const supervisor = new AgentJobSupervisorCore({
      config,
      clock: new FakeSupervisorClock(NOW),
      idFactory: ids(),
    });

    expect(
      supervisor
        .registerJob({
          descriptor: jobDescriptor({ jobId: "job:active", now: NOW }),
          resource: resource(),
        })
        .admitted.map((job) => job.jobId),
    ).toEqual(["job:active"]);

    for (const [jobId, priority] of [
      ["job:background-1", "background"],
      ["job:background-2", "background"],
      ["job:interactive-1", "interactive"],
      ["job:interactive-2", "interactive"],
    ] as const) {
      expect(
        supervisor.registerJob({
          descriptor: jobDescriptor({ jobId, now: NOW, priority }),
          resource: resource(),
        }).admitted,
      ).toEqual([]);
    }

    expect(supervisor.snapshot().queuedJobIds).toEqual([
      "job:interactive-1",
      "job:interactive-2",
      "job:background-1",
      "job:background-2",
    ]);
    const first = supervisor.completeJob("job:active", { status: SUCCESS });
    expect(first.admitted.map((job) => job.jobId)).toEqual(["job:interactive-1"]);
    const second = supervisor.completeJob("job:interactive-1", { status: SUCCESS });
    expect(second.admitted.map((job) => job.jobId)).toEqual(["job:interactive-2"]);
    const third = supervisor.completeJob("job:interactive-2", { status: SUCCESS });
    expect(third.admitted.map((job) => job.jobId)).toEqual(["job:background-1"]);
    const fourth = supervisor.completeJob("job:background-1", { status: SUCCESS });
    expect(fourth.admitted.map((job) => job.jobId)).toEqual(["job:background-2"]);
  });
});

describe("Agent job bounded queue capacity", () => {
  it("fails a new waiting job closed when queue capacity is exhausted", () => {
    const config = createStarterSupervisorConfig();
    config.limits.maxFullAgentWorkers = 1;
    config.limits.maxJobsPerOwner = 1;
    config.limits.queueCapacity = 2;
    config.limits.providerLimits = [{ provider: "openai-codex", maxActive: 1 }];
    const supervisor = new AgentJobSupervisorCore({
      config,
      clock: new FakeSupervisorClock(NOW),
      idFactory: ids(),
    });

    for (const jobId of ["job:active", "job:queued-1", "job:queued-2", "job:overflow"]) {
      supervisor.registerJob({
        descriptor: jobDescriptor({ jobId, now: NOW }),
        resource: resource(),
      });
    }

    expect(supervisor.getJob("job:overflow")).toMatchObject({
      lifecycleState: "released",
      terminalStatus: "queue_full",
    });
    expect(supervisor.getJob("job:overflow")?.attempt).toBeUndefined();
    expect(supervisor.snapshot().queuedJobIds).toEqual(["job:queued-1", "job:queued-2"]);
  });
});

describe("Balanced default queue bound", () => {
  it("returns queue_full without an attempt when thirty-two jobs are already waiting", () => {
    const config = createStarterSupervisorConfig();
    const supervisor = new AgentJobSupervisorCore({
      config,
      clock: new FakeSupervisorClock(NOW),
      idFactory: ids(),
    });
    for (let index = 1; index <= 36; index += 1) {
      supervisor.registerJob({
        descriptor: jobDescriptor({
          jobId: `job:balanced-${index}`,
          now: NOW,
          ownerId: `owner:balanced-${index}`,
        }),
        resource: resource(),
      });
    }
    expect(supervisor.snapshot()).toMatchObject({
      activeJobIds: expect.arrayContaining([
        "job:balanced-1",
        "job:balanced-2",
        "job:balanced-3",
        "job:balanced-4",
      ]),
      queuedJobIds: expect.arrayContaining(["job:balanced-5", "job:balanced-36"]),
    });
    expect(supervisor.snapshot().queuedJobIds).toHaveLength(32);

    const overflow = supervisor.registerJob({
      descriptor: jobDescriptor({
        jobId: "job:balanced-overflow",
        now: NOW,
        ownerId: "owner:balanced-overflow",
      }),
      resource: resource(),
    });
    expect(overflow.terminal).toEqual([{ jobId: "job:balanced-overflow", status: "queue_full" }]);
    expect(supervisor.getJob("job:balanced-overflow")?.attempt).toBeUndefined();
  });
});

describe("Agent job routed resource assignment", () => {
  it("registers before routing and admits only after a configured resource is assigned", () => {
    const config = createStarterSupervisorConfig();
    const supervisor = new AgentJobSupervisorCore({
      config,
      clock: new FakeSupervisorClock(NOW),
      idFactory: ids(),
    });
    expect(
      supervisor.registerJob({
        descriptor: jobDescriptor({ jobId: "job:routing", now: NOW }),
      }).admitted,
    ).toEqual([]);
    expect(supervisor.getJob("job:routing")?.lifecycleState).toBe("routing");
    expect(() =>
      supervisor.assignResource("job:routing", resource("other/model", "other-provider")),
    ).toThrow(expect.objectContaining({ code: "resource_limit_missing" }));
    expect(supervisor.getJob("job:routing")?.resource).toBeUndefined();
    expect(supervisor.assignResource("job:routing", resource()).admitted).toHaveLength(1);
  });
});

describe("Agent job hierarchical quotas", () => {
  it("enforces per-owner, per-model, provider, class, and control-plane quotas", () => {
    const config = createStarterSupervisorConfig();
    config.limits.maxFullAgentWorkers = 4;
    config.limits.maxCompletionWorkers = 2;
    config.limits.maxControlPlaneJobs = 1;
    config.limits.maxJobsPerOwner = 1;
    config.limits.providerLimits = [
      { provider: "openai-codex", maxActive: 7 },
      { provider: "openai-codex", model: "openai-codex/model-a", maxActive: 1 },
    ];
    const supervisor = new AgentJobSupervisorCore({
      config,
      clock: new FakeSupervisorClock(NOW),
      idFactory: ids(),
    });

    const submit = (
      jobId: string,
      ownerId: string,
      model: string,
      jobClass: "full-agent" | "completion" | "router-control-plane" = "full-agent",
    ) =>
      supervisor.registerJob({
        descriptor: jobDescriptor({ jobId, now: NOW, ownerId, jobClass }),
        resource: resource(model),
      });

    expect(submit("job:model-a-1", "owner:a", "openai-codex/model-a").admitted).toHaveLength(1);
    expect(submit("job:owner-limited", "owner:a", "openai-codex/model-b").admitted).toEqual([]);
    expect(submit("job:model-limited", "owner:b", "openai-codex/model-a").admitted).toEqual([]);
    expect(submit("job:model-b", "owner:c", "openai-codex/model-b").admitted).toHaveLength(1);
    expect(
      submit("job:control-1", "owner:control-1", "openai-codex/model-b", "router-control-plane")
        .admitted,
    ).toHaveLength(1);
    expect(
      submit("job:control-2", "owner:control-2", "openai-codex/model-b", "router-control-plane")
        .admitted,
    ).toEqual([]);
    expect(
      submit("job:completion-1", "owner:completion-1", "openai-codex/model-b", "completion")
        .admitted,
    ).toHaveLength(1);
    expect(
      submit("job:completion-2", "owner:completion-2", "openai-codex/model-b", "completion")
        .admitted,
    ).toHaveLength(1);
    expect(
      submit("job:completion-3", "owner:completion-3", "openai-codex/model-b", "completion")
        .admitted,
    ).toEqual([]);

    expect(supervisor.snapshot().queuedJobIds).toEqual(
      expect.arrayContaining([
        "job:owner-limited",
        "job:model-limited",
        "job:control-2",
        "job:completion-3",
      ]),
    );
  });
});

describe("Agent job queue deadlines", () => {
  it("never admits expired work and expires queued work on the inherited deadline", () => {
    const config = createStarterSupervisorConfig();
    config.limits.maxFullAgentWorkers = 1;
    config.limits.providerLimits = [{ provider: "openai-codex", maxActive: 1 }];
    const clock = new FakeSupervisorClock(NOW);
    const terminalFromTimer: string[][] = [];
    const supervisor = new AgentJobSupervisorCore({
      config,
      clock,
      idFactory: ids(),
      onTimedMutation: (result) => terminalFromTimer.push(result.terminal.map((job) => job.jobId)),
    });

    const expired = supervisor.registerJob({
      descriptor: jobDescriptor({
        jobId: "job:already-expired",
        now: NOW - 2_000,
        deadlineMs: 1_000,
      }),
      resource: resource(),
    });
    expect(expired.admitted).toEqual([]);
    expect(expired.terminal).toEqual([{ jobId: "job:already-expired", status: "timed_out" }]);
    supervisor.registerJob({
      descriptor: jobDescriptor({ jobId: "job:active", now: NOW, deadlineMs: 5_000 }),
      resource: resource(),
    });
    supervisor.registerJob({
      descriptor: jobDescriptor({ jobId: "job:queued", now: NOW, deadlineMs: 1_000 }),
      resource: resource(),
    });

    clock.advanceBy(1_000);
    expect(supervisor.getJob("job:queued")).toMatchObject({
      terminalStatus: "timed_out",
      lifecycleState: "released",
    });
    expect(terminalFromTimer).toEqual([["job:queued"]]);
    supervisor.cancelJob("job:active");
    supervisor.completeJob("job:active", { status: "cancelled" });
    supervisor.stop();
  });
});

describe("Agent job active deadlines", () => {
  it("requests active cancellation and retains the lease until completion", () => {
    const config = createStarterSupervisorConfig();
    const clock = new FakeSupervisorClock(NOW);
    const cancellations: string[][] = [];
    const supervisor = new AgentJobSupervisorCore({
      config,
      clock,
      idFactory: ids(),
      onTimedMutation: (result) =>
        cancellations.push(result.cancellationRequested.map((job) => job.jobId)),
    });
    supervisor.registerJob({
      descriptor: jobDescriptor({ jobId: "job:active", now: NOW, deadlineMs: 1_000 }),
      resource: resource(),
    });

    clock.advanceBy(1_000);
    expect(supervisor.getJob("job:active")).toMatchObject({
      lifecycleState: "cancelling",
      attempt: { state: "cancelling" },
      lease: { state: "releasing" },
    });
    expect(supervisor.snapshot().activeJobIds).toEqual(["job:active"]);
    expect(cancellations).toEqual([["job:active"]]);
    supervisor.completeJob("job:active", { status: "timed_out" });
    supervisor.stop();
    expect(clock.pendingTimerCount()).toBe(0);
  });
});
