import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkerToParentFrame } from "./protocol.js";
import { AgentWorkerProtocolError } from "./protocol.js";

const execFileAsync = promisify(execFile);
type WorkerHello = Extract<WorkerToParentFrame, { type: "worker.hello" }>;

export interface OwnedWorkerProcess {
  pid?: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit" | "close", listener: () => void): unknown;
  off(event: "exit" | "close", listener: () => void): unknown;
}

export function workerProcessHasExited(child: OwnedWorkerProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function assertOwnedWorkerProcess(
  child: OwnedWorkerProcess,
  hello: WorkerHello | undefined,
): void {
  if (!Number.isInteger(child.pid) || Number(child.pid) <= 0 || workerProcessHasExited(child)) {
    throw new AgentWorkerProtocolError("worker_disconnected", "Worker process is no longer owned.");
  }
  if (hello && (hello.processId !== child.pid || !hello.nonce)) {
    throw new AgentWorkerProtocolError("identity_mismatch", "Worker PID/nonce ownership mismatch.");
  }
}

export function waitForOwnedProcessExit(
  child: OwnedWorkerProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (workerProcessHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(workerProcessHasExited(child)), Math.max(1, timeoutMs));
    timer.unref?.();
    child.once("exit", onExit);
    child.once("close", onExit);
    if (workerProcessHasExited(child)) finish(true);
  });
}

export async function terminateOwnedProcessTree(
  child: OwnedWorkerProcess,
  hello: WorkerHello | undefined,
): Promise<void> {
  assertOwnedWorkerProcess(child, hello);
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
      return;
    } catch (error) {
      if (workerProcessHasExited(child)) return;
      throw new AgentWorkerProtocolError(
        "worker_disconnected",
        `Windows process-tree termination failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!child.kill("SIGKILL") && !workerProcessHasExited(child)) {
    throw new AgentWorkerProtocolError(
      "worker_disconnected",
      `Process-tree termination did not signal worker ${String(child.pid)}.`,
    );
  }
}
