/**
 * Session Lane — Per-Agent-Per-Channel Serial Execution Queue
 *
 * Guarantees at most one active agent turn per agentId:channelId pair at any
 * time. Subsequent triggers queue behind the running turn and execute in order.
 * Inspired by OpenClaw's lane-based concurrency model.
 *
 * Phase 4 implementation status:
 * - SessionLane: promise-chain queue; failing tasks don't poison the lane.
 * - SessionLaneRegistry: global singleton, lanes created on demand.
 * - Future phases can add lane metrics, eviction of idle lanes, or priority lanes.
 */

class SessionLane {
  // The tail of the current promise chain. New tasks are chained onto this.
  private queue: Promise<void> = Promise.resolve();

  /**
   * Enqueue a task on this lane. Returns a promise that resolves (or rejects)
   * with the task result. A failing task does not prevent subsequent tasks from
   * running — the lane wrapper swallows the error internally while the outer
   * promise still rejects to the caller.
   */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;

    const outer = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    // Chain onto the queue tail. The inner .catch ensures a failed task doesn't
    // break the chain for future tasks on this lane.
    this.queue = this.queue
      .then(() => task().then(resolve, reject))
      .catch(() => {
        // Swallow so the lane stays healthy after a failing task.
      });

    return outer;
  }
}

export interface ActiveTurnRecord {
  agentId: string;
  channelId: string;
  tempId: string;
  cancel(): void;
  cancelled: boolean;
}

class SessionLaneRegistry {
  private readonly lanes = new Map<string, SessionLane>();
  private readonly activeTurns = new Map<string, ActiveTurnRecord>();

  private buildKey(agentId: string, channelId: string) {
    return `${agentId}:${channelId}`;
  }

  getLane(agentId: string, channelId: string): SessionLane {
    const key = this.buildKey(agentId, channelId);
    let lane = this.lanes.get(key);

    if (!lane) {
      lane = new SessionLane();
      this.lanes.set(key, lane);
    }

    return lane;
  }

  registerActiveTurn(turn: Omit<ActiveTurnRecord, 'cancelled'>) {
    this.activeTurns.set(this.buildKey(turn.agentId, turn.channelId), {
      ...turn,
      cancelled: false,
    });
  }

  getActiveTurn(agentId: string, channelId: string) {
    return this.activeTurns.get(this.buildKey(agentId, channelId)) ?? null;
  }

  clearActiveTurn(agentId: string, channelId: string, tempId?: string) {
    const key = this.buildKey(agentId, channelId);
    const current = this.activeTurns.get(key);

    if (!current) return;
    if (tempId && current.tempId !== tempId) return;

    this.activeTurns.delete(key);
  }

  cancelActiveTurn(agentId: string, channelId: string) {
    const turn = this.getActiveTurn(agentId, channelId);
    if (!turn) return null;

    turn.cancelled = true;
    turn.cancel();
    return turn;
  }
}

export const sessionLaneRegistry = new SessionLaneRegistry();
