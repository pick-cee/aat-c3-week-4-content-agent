import { AsyncLocalStorage } from "node:async_hooks";

// Every paid provider call checks the lease again. A cancelled request or a
// worker that lost its lease must not start another chargeable operation.
const execution = new AsyncLocalStorage<{ assertActive: () => Promise<void>; leaseId?: string }>();

export function withExecution<T>(assertActive: () => Promise<void>, run: () => Promise<T>, leaseId?: string): Promise<T> {
  return execution.run({ assertActive, leaseId }, run);
}

export async function assertExecutionActive(): Promise<void> {
  await execution.getStore()?.assertActive();
}

export function executionLeaseId(): string | undefined { return execution.getStore()?.leaseId; }
