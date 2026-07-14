import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  getAgentRouterConfigPath,
  migrateRouterConfigFileToV2,
  writeStarterRouterConfigV2,
} from "../src/config/index.js";
import type { RouteEvent } from "../src/contracts/index.js";
import {
  buildRouteAudit,
  PI_ROUTE_EVENT_BUS_TOPIC,
  type RouteAuditRecord,
  renderRouteAudit,
} from "../src/observability/index.js";
import {
  AgentRouterRuntime,
  AgentRouterSetupError,
  type RuntimeDoctorResult,
} from "../src/runtime/index.js";
import {
  AGENT_ROUTER_JOB_AUDIT_TOPIC_V2,
  AGENT_ROUTER_SUPERVISOR_STATUS_TOPIC_V2,
  type AgentRouterJobAuditRecordV2,
  type AgentRouterJobInspectionV2,
  type AgentRouterJobTreeNodeV2,
  type AgentRouterSupervisorDoctorV2,
  type AgentRouterSupervisorStatusV2,
  discoverAgentRouterServiceV2,
  registerAgentRouterService,
  registerAgentRouterServiceV2,
  requireConfiguredAgentRouterServiceV2,
} from "../src/service/index.js";

const AUDIT_ENTRY_TYPE = "pi-agent-router.route-audit";
const JOB_AUDIT_ENTRY_TYPE = "pi-agent-router.job-audit";
const STATUS_ENTRY_TYPE = "pi-agent-router.status";
const DOCTOR_ENTRY_TYPE = "pi-agent-router.doctor";

function isRouteEvent(value: unknown): value is RouteEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { contractVersion?: unknown; routeId?: unknown; type?: unknown };
  return (
    candidate.contractVersion === 1 &&
    typeof candidate.routeId === "string" &&
    typeof candidate.type === "string"
  );
}

function isAuditRecord(value: unknown): value is RouteAuditRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { version?: unknown; routeId?: unknown; taskKind?: unknown };
  return (
    candidate.version === 1 &&
    typeof candidate.routeId === "string" &&
    typeof candidate.taskKind === "string"
  );
}

function isJobAuditRecord(value: unknown): value is AgentRouterJobAuditRecordV2 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { contractVersion?: unknown; jobId?: unknown; auditId?: unknown };
  return (
    candidate.contractVersion === 2 &&
    typeof candidate.jobId === "string" &&
    typeof candidate.auditId === "string"
  );
}

function formatSupervisorStatus(status: AgentRouterSupervisorStatusV2): string {
  return [
    `Agent Router Supervisor · ${status.state}`,
    `active: ${status.activeFullAgentJobs + status.activeCompletionJobs + status.activeControlPlaneJobs}`,
    `queued: ${status.queuedJobs}`,
    `owners: ${status.activeOwners}`,
    `full-agent: ${status.activeFullAgentJobs} · completion: ${status.activeCompletionJobs} · control-plane: ${status.activeControlPlaneJobs}`,
    `quarantine: ${status.quarantinedCleanupItems}`,
    ...status.degradedReasons.map((reason) => `DEGRADED ${reason}`),
  ].join("\n");
}

function formatJobs(jobs: AgentRouterJobInspectionV2[]): string {
  if (jobs.length === 0) return "Agent Router jobs · active 0 · queued 0";
  return [
    `Agent Router jobs · ${jobs.length}`,
    ...jobs.map(
      (job) =>
        `${job.jobId} · ${job.jobClass} · ${job.lifecycleState}${job.terminalStatus ? `/${job.terminalStatus}` : ""} · owner ${job.owner.kind}:${job.owner.ownerId} · deadline ${job.deadlineAt}`,
    ),
  ].join("\n");
}

function formatTree(nodes: AgentRouterJobTreeNodeV2[], depth = 0): string {
  return nodes
    .flatMap((node) => [
      `${"  ".repeat(depth)}${node.job.jobId} · ${node.job.lifecycleState}${node.job.terminalStatus ? `/${node.job.terminalStatus}` : ""}${node.job.dependencyIds.length ? ` · depends ${node.job.dependencyIds.join(",")}` : ""}`,
      formatTree(node.children, depth + 1),
    ])
    .filter(Boolean)
    .join("\n");
}

function formatAudit(records: AgentRouterJobAuditRecordV2[]): string {
  if (records.length === 0) return "Agent Router audit · no matching terminal records";
  return [
    `Agent Router audit · ${records.length}`,
    ...records.map(
      (record) =>
        `${record.jobId} · ${record.terminalStatus} · ${record.ownerKind} · cleanup ${record.cleanup.ok ? "ok" : "failed"}${record.processEscalated ? " · escalated" : ""}`,
    ),
  ].join("\n");
}

function formatSupervisorDoctor(result: AgentRouterSupervisorDoctorV2): string {
  return [
    `Agent Router Supervisor Doctor · ${result.ok ? "ok" : "failed"}`,
    ...result.findings.map(
      (finding) => `${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}`,
    ),
  ].join("\n");
}

function formatDoctor(result: RuntimeDoctorResult): string {
  const rows = result.report.results.map((candidate) => {
    const staticMessage =
      candidate.staticMessages.length > 0 ? ` · ${candidate.staticMessages.join("; ")}` : "";
    const activeMessage = candidate.activeMessage ? ` · ${candidate.activeMessage}` : "";
    return `${candidate.candidateId} · static ${candidate.staticStatus} · active ${candidate.activeStatus}${staticMessage}${activeMessage}`;
  });
  return [
    `Agent Router Doctor (${result.report.mode})`,
    ...rows,
    ...result.diagnostics.map(
      (diagnostic) =>
        `${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`,
    ),
  ].join("\n");
}

function notifyError(error: unknown, notify: (message: string, level: "error") => void): void {
  if (error instanceof AgentRouterSetupError) {
    notify(error.diagnostics.map((item) => item.message).join("\n"), "error");
    return;
  }
  notify(error instanceof Error ? error.message : String(error), "error");
}

export default function agentRouterExtension(pi: ExtensionAPI): void {
  const routeTasks = new Map<string, Extract<RouteEvent, { type: "route.requested" }>["task"]>();
  const serviceHost = registerAgentRouterService(pi.events);
  const serviceHostV2 = registerAgentRouterServiceV2(pi.events);
  let currentContext: ExtensionContext | undefined;
  const updateIndicator = (status: AgentRouterSupervisorStatusV2) => {
    const active =
      status.activeFullAgentJobs + status.activeCompletionJobs + status.activeControlPlaneJobs;
    currentContext?.ui.setStatus(
      "pi-agent-router",
      `agents ${active} · queued ${status.queuedJobs} · degraded ${status.quarantinedCleanupItems}`,
    );
  };

  pi.registerEntryRenderer(AUDIT_ENTRY_TYPE, (entry, { expanded }, theme) => {
    if (!isAuditRecord(entry.data))
      return new Text(theme.fg("error", "Invalid route audit record."), 0, 0);
    const rendered = renderRouteAudit(entry.data, expanded);
    return new Text(
      entry.data.success ? theme.fg("success", rendered) : theme.fg("error", rendered),
      0,
      0,
    );
  });

  pi.registerEntryRenderer(JOB_AUDIT_ENTRY_TYPE, (entry, _options, theme) => {
    if (!isJobAuditRecord(entry.data))
      return new Text(theme.fg("error", "Invalid Agent job audit record."), 0, 0);
    const rendered = formatAudit([entry.data]);
    return new Text(
      entry.data.terminalStatus === "succeeded"
        ? theme.fg("success", rendered)
        : theme.fg("error", rendered),
      0,
      0,
    );
  });

  pi.registerEntryRenderer(
    STATUS_ENTRY_TYPE,
    (entry, _options, theme) => new Text(theme.fg("toolOutput", String(entry.data ?? "")), 0, 0),
  );
  pi.registerEntryRenderer(
    DOCTOR_ENTRY_TYPE,
    (entry, _options, theme) => new Text(theme.fg("toolOutput", String(entry.data ?? "")), 0, 0),
  );

  const unsubscribeJobAudit = pi.events.on(AGENT_ROUTER_JOB_AUDIT_TOPIC_V2, (value) => {
    if (isJobAuditRecord(value)) pi.appendEntry(JOB_AUDIT_ENTRY_TYPE, value);
  });
  const unsubscribeSupervisorStatus = pi.events.on(
    AGENT_ROUTER_SUPERVISOR_STATUS_TOPIC_V2,
    (value) => {
      if (value && typeof value === "object" && "state" in value) {
        updateIndicator(value as AgentRouterSupervisorStatusV2);
      }
    },
  );
  const unsubscribeRouteEvents = pi.events.on(PI_ROUTE_EVENT_BUS_TOPIC, (value) => {
    if (!isRouteEvent(value)) return;
    if (value.type === "route.requested") {
      routeTasks.set(value.routeId, value.task);
      return;
    }
    if (value.type !== "route.finished") return;
    const task = routeTasks.get(value.routeId);
    routeTasks.delete(value.routeId);
    if (!task) return;
    pi.appendEntry(AUDIT_ENTRY_TYPE, buildRouteAudit({ task, outcome: value.outcome }));
  });

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    try {
      updateIndicator(await serviceHostV2.service.inspectSupervisor());
    } catch {
      ctx.ui.setStatus("pi-agent-router", undefined);
    }
  });

  pi.on("session_shutdown", async () => {
    await serviceHostV2.dispose("session-shutdown");
    routeTasks.clear();
    unsubscribeJobAudit();
    unsubscribeSupervisorStatus();
    unsubscribeRouteEvents();
    serviceHost.dispose();
    currentContext?.ui.setStatus("pi-agent-router", undefined);
    currentContext = undefined;
  });

  pi.registerCommand("agent-router", {
    description:
      "Agent Router V2 service operations (service, status, jobs, job, tree, audit, janitor, doctor, drain, setup, migrate-v2)",
    getArgumentCompletions(prefix) {
      const values = [
        "service",
        "status",
        "jobs",
        "job ",
        "tree",
        "audit",
        "janitor",
        "doctor",
        "doctor active",
        "drain",
        "setup",
        "migrate-v2",
      ];
      const matches = values
        .filter((value) => value.startsWith(prefix.toLowerCase()))
        .map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (rawArgs, ctx) => {
      const trimmed = rawArgs.trim();
      const separator = trimmed.indexOf(" ");
      const verb =
        (separator < 0 ? trimmed : trimmed.slice(0, separator)).toLowerCase() || "status";
      const operand = separator < 0 ? "" : trimmed.slice(separator + 1).trim();
      const usage =
        "Usage: /agent-router [service|status|jobs|job <id>|tree|audit [job-id]|janitor|doctor|doctor active|drain|setup|migrate-v2]";
      try {
        if (verb === "setup") {
          const written = await writeStarterRouterConfigV2(getAgentRouterConfigPath());
          ctx.ui.notify(
            `Wrote explicit V2 Agent Router configuration: ${written.path}. Reload Pi to activate it.`,
            "info",
          );
          return;
        }
        if (verb === "migrate-v2") {
          const migrated = await migrateRouterConfigFileToV2(getAgentRouterConfigPath());
          ctx.ui.notify(
            `Migrated Agent Router configuration to V2; backup: ${migrated.backupPath}. Reload Pi to activate it.`,
            "info",
          );
          return;
        }
        if (verb === "service") {
          const service = await discoverAgentRouterServiceV2(pi.events);
          const configuration = await service.inspectConfiguration();
          pi.appendEntry(
            STATUS_ENTRY_TYPE,
            [
              `Agent Router service v${service.contractVersion}`,
              `instance: ${service.instanceId}`,
              `package: ${service.packageVersion}`,
              `config: ${configuration.state} (${configuration.path})`,
              `authority: ${configuration.admissionAuthority}`,
              ...(configuration.state === "migration-required"
                ? [`action: ${configuration.migrationCommand}`]
                : []),
            ].join("\n"),
          );
          ctx.ui.notify("Agent Router V2 service discovery passed.", "info");
          return;
        }
        if (verb === "doctor" && operand.toLowerCase() === "active") {
          if (
            ctx.hasUI &&
            !(await ctx.ui.confirm(
              "Run paid Agent Router probes?",
              "Active Doctor sends one bounded minimal request to each configured candidate. Static supervisor Doctor is free.",
            ))
          ) {
            ctx.ui.notify("Active Doctor cancelled.", "info");
            return;
          }
          const runtime = await AgentRouterRuntime.create({
            modelRegistry: ctx.modelRegistry,
            cwd: ctx.cwd,
          });
          const result = await runtime.doctor("active");
          pi.appendEntry(DOCTOR_ENTRY_TYPE, formatDoctor(result));
          ctx.ui.notify("Agent Router active Doctor complete.", "info");
          return;
        }
        const service = await requireConfiguredAgentRouterServiceV2(pi.events);
        const updateIndicator = async () => {
          const status = await service.inspectSupervisor();
          const active =
            status.activeFullAgentJobs +
            status.activeCompletionJobs +
            status.activeControlPlaneJobs;
          ctx.ui.setStatus(
            "pi-agent-router",
            `agents ${active} · queued ${status.queuedJobs} · degraded ${status.quarantinedCleanupItems}`,
          );
          return status;
        };
        if (verb === "status") {
          pi.appendEntry(STATUS_ENTRY_TYPE, formatSupervisorStatus(await updateIndicator()));
          ctx.ui.notify("Agent Router supervisor status added to the transcript.", "info");
          return;
        }
        if (verb === "jobs") {
          pi.appendEntry(STATUS_ENTRY_TYPE, formatJobs(await service.inspectJobs()));
          await updateIndicator();
          return;
        }
        if (verb === "job" && operand) {
          pi.appendEntry(
            STATUS_ENTRY_TYPE,
            formatJobs(
              await service.inspectJobs({ jobId: operand, includeTerminal: true, limit: 1 }),
            ),
          );
          await updateIndicator();
          return;
        }
        if (verb === "tree") {
          const rendered = formatTree(await service.inspectJobTree({ includeTerminal: true }));
          pi.appendEntry(STATUS_ENTRY_TYPE, rendered || "Agent Router tree · no jobs");
          await updateIndicator();
          return;
        }
        if (verb === "audit") {
          pi.appendEntry(
            STATUS_ENTRY_TYPE,
            formatAudit(
              await service.inspectAudit({ ...(operand ? { jobId: operand } : {}), limit: 50 }),
            ),
          );
          await updateIndicator();
          return;
        }
        if (verb === "janitor") {
          const result = await service.runJanitor();
          pi.appendEntry(
            STATUS_ENTRY_TYPE,
            `Agent Router janitor · attempted ${result.attempted} · reclaimed ${result.reclaimed} · remaining ${result.remaining}`,
          );
          await updateIndicator();
          return;
        }
        if (verb === "doctor" && !operand) {
          pi.appendEntry(DOCTOR_ENTRY_TYPE, formatSupervisorDoctor(await service.doctor()));
          await updateIndicator();
          return;
        }
        if (verb === "drain") {
          if (
            ctx.hasUI &&
            !(await ctx.ui.confirm(
              "Drain the Agent Router supervisor?",
              "This stops new admission and cancels all queued or running Router jobs.",
            ))
          ) {
            ctx.ui.notify("Supervisor drain cancelled.", "info");
            return;
          }
          await service.drain("operator-command");
          await updateIndicator();
          ctx.ui.notify("Agent Router supervisor drained.", "info");
          return;
        }
        ctx.ui.notify(usage, "warning");
      } catch (error) {
        notifyError(error, ctx.ui.notify.bind(ctx.ui));
      }
    },
  });
}
