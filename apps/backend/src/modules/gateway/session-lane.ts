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

class SessionLaneRegistry {
  private readonly lanes = new Map<string, SessionLane>();

  getLane(agentId: string, channelId: string): SessionLane {
    const key = `${agentId}:${channelId}`;
    let lane = this.lanes.get(key);

    if (!lane) {
      lane = new SessionLane();
      this.lanes.set(key, lane);
    }

    return lane;
  }
}

export const sessionLaneRegistry = new SessionLaneRegistry();
