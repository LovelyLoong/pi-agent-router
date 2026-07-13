import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkerToParentFrame } from "./protocol.js";
import { AgentWorkerProtocolError } from "./protocol.js";

const execFileAsync = promisify(execFile);
type WorkerHello = Extract<WorkerToParentFrame, { type: "worker.hello" }>;

export interface OwnedWorkerProcess {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export function assertOwnedWorkerProcess(
  child: OwnedWorkerProcess,
  hello: WorkerHello | undefined,
): void {
  if (!Number.isInteger(child.pid) || child.pid <= 0 || child.exitCode !== null) {
    throw new AgentWorkerProtocolError("worker_disconnected", "Worker process is no longer owned.");
  }
  if (hello && (hello.processId !== child.pid || !hello.nonce)) {
    throw new AgentWorkerProtocolError("identity_mismatch", "Worker PID/nonce ownership mismatch.");
  }
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
      if (child.exitCode !== null) return;
      throw new AgentWorkerProtocolError(
        "worker_disconnected",
        `Windows process-tree termination failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  child.kill("SIGKILL");
}
