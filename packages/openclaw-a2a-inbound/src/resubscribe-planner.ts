import type { Task } from "@a2a-js/sdk";
import { A2ALiveExecutionRegistry } from "./live-execution-registry.js";
import {
  isActiveExecutionTaskState,
  isQuiescentTaskState,
  isTerminalTaskState,
} from "./response-mapping.js";
import {
  A2ATaskRuntimeStore,
  type PreparedTaskResubscription,
  type TaskJournalSubscriptionHandle,
} from "./task-store.js";

export type PreparedResubscribePlan =
  | {
      kind: "snapshot-only";
      snapshot: Task;
      reason: "terminal" | "quiescent" | "orphaned";
    }
  | {
      kind: "live-tail";
      snapshot: Task;
      subscription: TaskJournalSubscriptionHandle;
    };

function mapSnapshotOnlyReason(
  prepared: Extract<PreparedTaskResubscription, { kind: "snapshot-only" }>,
  allowLiveTail: boolean,
): "terminal" | "quiescent" | "orphaned" {
  const state = prepared.snapshot.status.state;

  if (isTerminalTaskState(state)) {
    return "terminal";
  }

  if (isQuiescentTaskState(state)) {
    return "quiescent";
  }

  if (isActiveExecutionTaskState(state) && !allowLiveTail) {
    return "orphaned";
  }

  throw new Error(
    `Unsupported snapshot-only resubscribe state ${state} for allowLiveTail=${String(allowLiveTail)}.`,
  );
}

export class A2AResubscribePlanner {
  constructor(
    private readonly taskRuntime: A2ATaskRuntimeStore,
    private readonly liveExecutions: A2ALiveExecutionRegistry,
  ) {}

  async prepare(taskId: string): Promise<PreparedResubscribePlan | undefined> {
    const allowLiveTail = this.liveExecutions.has(taskId);
    const prepared = await this.taskRuntime.prepareResubscribe(taskId, {
      allowLiveTail,
    });

    if (!prepared) {
      return undefined;
    }

    switch (prepared.kind) {
      case "live-tail":
        return prepared;
      case "snapshot-only":
        return {
          kind: "snapshot-only",
          snapshot: prepared.snapshot,
          reason: mapSnapshotOnlyReason(prepared, allowLiveTail),
        };
    }
  }
}
