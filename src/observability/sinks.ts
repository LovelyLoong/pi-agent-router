import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { FeedbackRecord, RouteEvent, RouteEventSink } from "../contracts/events.js";
import { redactFeedback, redactRouteEvent } from "./redact.js";

export const PI_ROUTE_EVENT_BUS_TOPIC = "pi-agent-router:route-event";
export const PI_FEEDBACK_EVENT_BUS_TOPIC = "pi-agent-router:feedback";

interface EventEnvelope<T> {
  schema: "pi-agent-router.event" | "pi-agent-router.feedback";
  version: 1;
  record: T;
}

export interface JsonlRouteEventSinkOptions {
  path: string;
  maxBytes?: number;
  maxRecordBytes?: number;
}

export class JsonlRouteEventSink implements RouteEventSink {
  readonly #path: string;
  readonly #maxBytes: number;
  readonly #maxRecordBytes: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: JsonlRouteEventSinkOptions) {
    this.#path = options.path;
    this.#maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.#maxRecordBytes = options.maxRecordBytes ?? 256 * 1024;
  }

  emit(value: RouteEvent): Promise<void> {
    return this.#enqueue({
      schema: "pi-agent-router.event",
      version: 1,
      record: redactRouteEvent(value),
    });
  }

  recordFeedback(value: FeedbackRecord): Promise<void> {
    return this.#enqueue({
      schema: "pi-agent-router.feedback",
      version: 1,
      record: redactFeedback(value),
    });
  }

  async flush(): Promise<void> {
    await this.#queue;
  }

  #enqueue<T>(envelope: EventEnvelope<T>): Promise<void> {
    const line = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(line, "utf8") > this.#maxRecordBytes) {
      return Promise.reject(
        new Error(`Redacted audit record exceeds ${this.#maxRecordBytes} bytes.`),
      );
    }
    const pending = this.#queue.catch(() => undefined).then(() => this.#append(line));
    this.#queue = pending;
    return pending;
  }

  async #append(line: string): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    let size = 0;
    try {
      size = (await stat(this.#path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (size + Buffer.byteLength(line, "utf8") > this.#maxBytes) {
      const backup = `${this.#path}.1`;
      await rm(backup, { force: true });
      await rename(this.#path, backup).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await appendFile(this.#path, line, { encoding: "utf8", mode: 0o600 });
  }
}

export class CompositeRouteEventSink implements RouteEventSink {
  constructor(readonly sinks: RouteEventSink[]) {}

  async emit(value: RouteEvent): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.emit(value)));
  }

  async recordFeedback(value: FeedbackRecord): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.recordFeedback?.(value)));
  }
}

export interface PiEventBusLike {
  emit(name: string, value: unknown): void;
}

export class PiEventBusRouteSink implements RouteEventSink {
  constructor(readonly events: PiEventBusLike) {}

  emit(value: RouteEvent): void {
    this.events.emit(PI_ROUTE_EVENT_BUS_TOPIC, redactRouteEvent(value));
  }

  recordFeedback(value: FeedbackRecord): void {
    this.events.emit(PI_FEEDBACK_EVENT_BUS_TOPIC, redactFeedback(value));
  }
}
