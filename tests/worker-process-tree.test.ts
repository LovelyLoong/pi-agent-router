import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  assertOwnedWorkerProcess,
  waitForOwnedProcessExit,
  workerProcessHasExited,
} from "../src/worker/process-tree.js";

class FakeOwnedProcess extends EventEmitter {
  pid: number | undefined = 42;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    return true;
  }
}

const hello = {
  protocolVersion: 1 as const,
  type: "worker.hello" as const,
  nonce: "worker-nonce",
  processId: 42,
};

describe("owned worker process identity and exit confirmation", () => {
  it("accepts only a live child whose hello PID and nonce match", () => {
    const child = new FakeOwnedProcess();

    expect(() => assertOwnedWorkerProcess(child, hello)).not.toThrow();
    expect(() => assertOwnedWorkerProcess(child, { ...hello, processId: 99 })).toThrowError(
      /ownership mismatch/i,
    );

    child.exitCode = 0;
    expect(workerProcessHasExited(child)).toBe(true);
    expect(() => assertOwnedWorkerProcess(child, hello)).toThrowError(/no longer owned/i);
  });

  it("resolves true on an observed exit and releases temporary listeners", async () => {
    const child = new FakeOwnedProcess();
    const waiting = waitForOwnedProcessExit(child, 1_000);

    child.exitCode = 0;
    child.emit("exit");

    await expect(waiting).resolves.toBe(true);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  });

  it("returns false at the bounded deadline and releases temporary listeners", async () => {
    const child = new FakeOwnedProcess();

    await expect(waitForOwnedProcessExit(child, 5)).resolves.toBe(false);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  });
});
