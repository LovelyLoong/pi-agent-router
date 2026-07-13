import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getAgentRouterConfigPath, writeStarterRouterConfig } from "../src/config/index.js";
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
  type AgentRouterStatus,
  type RuntimeDoctorResult,
} from "../src/runtime/index.js";
import {
  registerAgentRouterService,
  requireConfiguredAgentRouterService,
} from "../src/service/index.js";

const AUDIT_ENTRY_TYPE = "pi-agent-router.route-audit";
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

function formatStatus(status: AgentRouterStatus): string {
  const candidates = status.candidates.map(
    (candidate) =>
      `${candidate.available ? "✓" : "✗"} ${candidate.candidateId} · ${candidate.executorId}:${candidate.model} · health ${candidate.health}${candidate.reason ? ` · ${candidate.reason}` : ""}`,
  );
  const diagnostics = status.diagnostics.map(
    (diagnostic) =>
      `${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`,
  );
  return [
    `Agent Router ${status.configHash.slice(0, 12)}`,
    `config: ${status.configPath}`,
    `health: ${status.healthPath}`,
    `router: ${status.routerTargets.map((target) => `${target.executorId}:${target.model}@${target.thinkingLevel}`).join(" → ")}`,
    ...candidates,
    ...diagnostics,
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

  pi.registerEntryRenderer(
    STATUS_ENTRY_TYPE,
    (entry, _options, theme) => new Text(theme.fg("toolOutput", String(entry.data ?? "")), 0, 0),
  );
  pi.registerEntryRenderer(
    DOCTOR_ENTRY_TYPE,
    (entry, _options, theme) => new Text(theme.fg("toolOutput", String(entry.data ?? "")), 0, 0),
  );

  pi.events.on(PI_ROUTE_EVENT_BUS_TOPIC, (value) => {
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

  pi.on("session_shutdown", () => {
    routeTasks.clear();
    serviceHost.dispose();
  });

  pi.registerCommand("agent-router", {
    description:
      "Agent Router service, status, setup, or Doctor (usage: /agent-router [service|status|setup|doctor|doctor active])",
    getArgumentCompletions(prefix) {
      const values = ["service", "status", "setup", "doctor", "doctor active"];
      const matches = values
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (rawArgs, ctx) => {
      const args = rawArgs.trim().toLowerCase() || "status";
      if (args === "setup") {
        try {
          const written = await writeStarterRouterConfig(getAgentRouterConfigPath());
          ctx.ui.notify(
            `Wrote explicit starter Agent Router configuration: ${written.path}`,
            "info",
          );
        } catch (error) {
          notifyError(error, ctx.ui.notify.bind(ctx.ui));
        }
        return;
      }
      if (
        args !== "service" &&
        args !== "status" &&
        args !== "doctor" &&
        args !== "doctor active"
      ) {
        ctx.ui.notify(
          "Usage: /agent-router [service|status|setup|doctor|doctor active]",
          "warning",
        );
        return;
      }
      try {
        if (args === "service") {
          const service = await requireConfiguredAgentRouterService(pi.events);
          const configuration = await service.inspectConfiguration();
          pi.appendEntry(
            STATUS_ENTRY_TYPE,
            [
              `Agent Router service v${service.contractVersion}`,
              `instance: ${service.instanceId}`,
              `package: ${service.packageVersion}`,
              `config: ${configuration.state} (${configuration.path})`,
              `authority: ${configuration.admissionAuthority}`,
            ].join("\n"),
          );
          ctx.ui.notify("Agent Router service discovery passed.", "info");
          return;
        }
        const runtime = await AgentRouterRuntime.create({
          modelRegistry: ctx.modelRegistry,
          cwd: ctx.cwd,
        });
        if (args === "status") {
          const text = formatStatus(await runtime.status());
          pi.appendEntry(STATUS_ENTRY_TYPE, text);
          ctx.ui.notify("Agent Router status added to the transcript.", "info");
          return;
        }
        const active = args === "doctor active";
        if (
          active &&
          ctx.hasUI &&
          !(await ctx.ui.confirm(
            "Run paid Agent Router probes?",
            "Active Doctor sends one bounded minimal request to each configured candidate. Static Doctor is free.",
          ))
        ) {
          ctx.ui.notify("Active Doctor cancelled.", "info");
          return;
        }
        const result = await runtime.doctor(active ? "active" : "static");
        pi.appendEntry(DOCTOR_ENTRY_TYPE, formatDoctor(result));
        ctx.ui.notify(`Agent Router ${active ? "active" : "static"} Doctor complete.`, "info");
      } catch (error) {
        notifyError(error, ctx.ui.notify.bind(ctx.ui));
      }
    },
  });
}
