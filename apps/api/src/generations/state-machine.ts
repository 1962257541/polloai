import { TaskStatus } from "@packages/shared";

const order: TaskStatus[] = ["queued", "running", "succeeded", "failed", "cancelled"];

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) {
    return true;
  }

  if (isTerminalStatus(from)) {
    return false;
  }

  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  return toIndex >= fromIndex;
}

