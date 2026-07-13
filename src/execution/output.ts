import type { TaskContract } from "../contracts/task.js";

export interface OutputValidationResult<TResult = unknown> {
  ok: boolean;
  value?: TResult;
  message?: string;
}

export interface OutputContract<TResult = unknown> {
  readonly name: string;
  validate(value: unknown): OutputValidationResult<TResult>;
}

export class OutputContractRegistry {
  readonly #contracts = new Map<string, OutputContract>();

  register<TResult>(contract: OutputContract<TResult>): void {
    if (this.#contracts.has(contract.name)) {
      throw new Error(`Output contract '${contract.name}' is already registered.`);
    }
    this.#contracts.set(contract.name, contract as OutputContract);
  }

  assertTaskContract(task: TaskContract): void {
    const output = task.requirements.output;
    if (output.kind !== "text" && !output.contractName) {
      throw new Error(`Task '${task.taskId}' requires an explicit ${output.kind} output contract.`);
    }
    if (output.contractName && !this.#contracts.has(output.contractName)) {
      throw new Error(
        `Task '${task.taskId}' references unregistered output contract '${output.contractName}'.`,
      );
    }
  }

  validate(task: TaskContract, value: unknown): OutputValidationResult {
    const contractName = task.requirements.output.contractName;
    if (contractName) {
      const contract = this.#contracts.get(contractName);
      if (!contract)
        return { ok: false, message: `Output contract '${contractName}' is unavailable.` };
      try {
        return contract.validate(value);
      } catch (error) {
        return {
          ok: false,
          message: `Output contract '${contractName}' threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    if (task.requirements.output.kind === "text" && typeof value === "string" && value.trim()) {
      return { ok: true, value };
    }
    return { ok: false, message: "Execution did not return non-empty text." };
  }
}
