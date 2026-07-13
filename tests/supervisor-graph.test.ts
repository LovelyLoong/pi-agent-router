import { describe, expect, it } from "vitest";
import { createStarterSupervisorConfig } from "../src/config/index.js";
import { AgentJobSupervisorCore } from "../src/supervisor/index.js";
import { FakeSupervisorClock } from "./helpers/fake-supervisor-clock.js";
import { jobDescriptor, resource } from "./helpers/supervisor-fixtures.js";

const NOW = Date.parse("2026-07-13T09:00:00.000Z");

function supervisorWithFailurePolicy(taskKinds: string[] = []): AgentJobSupervisorCore {
  const config = createStarterSupervisorConfig();
  config.limits.maxFullAgentWorkers = 2;
  config.limits.providerLimits = [{ provider: "openai-codex", maxActive: 2 }];
  config.dependencies.failureContinueTaskKinds = taskKinds;
  let id = 0;
  return new AgentJobSupervisorCore({
    config,
    clock: new FakeSupervisorClock(NOW),
    idFactory: () => String(++id),
  });
}

describe("Agent job prerequisite DAG", () => {
  it("unblocks a dependent only after every prerequisite succeeds", () => {
    const supervisor = supervisorWithFailurePolicy();
    const first = supervisor.registerJob({
      descriptor: jobDescriptor({ jobId: "job:prerequisite", now: NOW }),
      resource: resource(),
    });
    expect(first.admitted.map((job) => job.jobId)).toEqual(["job:prerequisite"]);

    const dependent = supervisor.registerJob({
      descriptor: jobDescriptor({
        jobId: "job:dependent",
        now: NOW,
        dependsOn: ["job:prerequisite"],
      }),
      resource: resource(),
    });
    expect(dependent.admitted).toEqual([]);
    expect(supervisor.getJob("job:dependent")).toMatchObject({
      lifecycleState: "blocked-on-dependencies",
      blockingDependencyIds: ["job:prerequisite"],
    });
    expect(supervisor.getJob("job:dependent")?.attempt).toBeUndefined();

    const completed = supervisor.completeJob("job:prerequisite", { status: "succeeded" });
    expect(completed.admitted.map((job) => job.jobId)).toEqual(["job:dependent"]);
    expect(supervisor.getJob("job:dependent")).toMatchObject({
      lifecycleState: "starting",
      attempt: { ordinal: 1 },
    });
  });

  it("propagates prerequisite failure without creating an attempt", () => {
    const supervisor = supervisorWithFailurePolicy();
    supervisor.registerJob({
      descriptor: jobDescriptor({ jobId: "job:prerequisite", now: NOW }),
      resource: resource(),
    });
    supervisor.registerJob({
      descriptor: jobDescriptor({
        jobId: "job:dependent",
        now: NOW,
        dependsOn: ["job:prerequisite"],
      }),
      resource: resource(),
    });

    const failed = supervisor.completeJob("job:prerequisite", { status: "failed" });
    expect(failed.admitted).toEqual([]);
    expect(supervisor.getJob("job:dependent")).toMatchObject({
      lifecycleState: "released",
      terminalStatus: "dependency_failed",
    });
    expect(supervisor.getJob("job:dependent")?.attempt).toBeUndefined();
  });
});

describe("Agent job dependency failure policy", () => {
  it("allows failure input only for an explicitly configured task kind", () => {
    const denied = supervisorWithFailurePolicy();
    denied.registerJob({
      descriptor: jobDescriptor({ jobId: "job:denied-prerequisite", now: NOW }),
      resource: resource(),
    });
    expect(() =>
      denied.registerJob({
        descriptor: jobDescriptor({
          jobId: "job:denied",
          now: NOW,
          dependsOn: ["job:denied-prerequisite"],
          onFailure: "continue",
          taskKind: "accept-failure",
        }),
        resource: resource(),
      }),
    ).toThrow(expect.objectContaining({ code: "dependency_continue_not_allowed" }));

    const allowed = supervisorWithFailurePolicy(["accept-failure"]);
    allowed.registerJob({
      descriptor: jobDescriptor({ jobId: "job:allowed-prerequisite", now: NOW }),
      resource: resource(),
    });
    allowed.registerJob({
      descriptor: jobDescriptor({
        jobId: "job:allowed",
        now: NOW,
        dependsOn: ["job:allowed-prerequisite"],
        onFailure: "continue",
        taskKind: "accept-failure",
      }),
      resource: resource(),
    });
    const failed = allowed.completeJob("job:allowed-prerequisite", { status: "failed" });
    expect(failed.admitted.map((job) => job.jobId)).toEqual(["job:allowed"]);
  });
});

describe("Agent job graph admission", () => {
  it("rejects unknown dependencies without mutating the registry", () => {
    const supervisor = supervisorWithFailurePolicy();
    expect(() =>
      supervisor.registerJob({
        descriptor: jobDescriptor({
          jobId: "job:unknown",
          now: NOW,
          dependsOn: ["job:missing"],
        }),
        resource: resource(),
      }),
    ).toThrow(expect.objectContaining({ code: "dependency_unknown" }));
    expect(supervisor.snapshot().jobs).toEqual([]);
  });

  it("rejects dependency and owner cycles atomically in a batch", () => {
    const dependencySupervisor = supervisorWithFailurePolicy();
    expect(() =>
      dependencySupervisor.registerJobs([
        {
          descriptor: jobDescriptor({ jobId: "job:a", now: NOW, dependsOn: ["job:b"] }),
          resource: resource(),
        },
        {
          descriptor: jobDescriptor({ jobId: "job:b", now: NOW, dependsOn: ["job:a"] }),
          resource: resource(),
        },
      ]),
    ).toThrow(expect.objectContaining({ code: "dependency_cycle" }));
    expect(dependencySupervisor.snapshot().jobs).toEqual([]);

    const ownerSupervisor = supervisorWithFailurePolicy();
    expect(() =>
      ownerSupervisor.registerJobs([
        {
          descriptor: jobDescriptor({ jobId: "job:owner-a", now: NOW, parentJobId: "job:owner-b" }),
          resource: resource(),
        },
        {
          descriptor: jobDescriptor({ jobId: "job:owner-b", now: NOW, parentJobId: "job:owner-a" }),
          resource: resource(),
        },
      ]),
    ).toThrow(expect.objectContaining({ code: "owner_cycle" }));
    expect(ownerSupervisor.snapshot().jobs).toEqual([]);
  });
});
