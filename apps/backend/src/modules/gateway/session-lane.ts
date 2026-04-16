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

interface LiveToolCallRecord {
  toolCallId: string;
  toolName: string;
  status: 'running' | 'success' | 'failed';
  arguments?: unknown;
  output?: string;
  durationMs?: number;
  success?: boolean;
}

interface LiveTurnSnapshot {
  tempId: string;
  agentId: string;
  text: string;
  toolCalls: LiveToolCallRecord[];
}

interface LiveTodoSnapshot {
  agentId: string;
  agentName: string;
  todos: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    priority: 'high' | 'medium' | 'low';
  }>;
}

interface ChannelExecutionSnapshot {
  channelId: string;
  agentState: 'idle' | 'queued' | 'streaming' | 'error';
  turns: Map<string, LiveTurnSnapshot>;
  todos: Map<string, LiveTodoSnapshot>;
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
  private readonly channelSnapshots = new Map<string, ChannelExecutionSnapshot>();

  private buildKey(agentId: string, channelId: string) {
    return `${agentId}:${channelId}`;
  }

  private getChannelSnapshot(channelId: string) {
    let snapshot = this.channelSnapshots.get(channelId);
    if (!snapshot) {
      snapshot = {
        channelId,
        agentState: 'idle',
        turns: new Map(),
        todos: new Map(),
      };
      this.channelSnapshots.set(channelId, snapshot);
    }
    return snapshot;
  }

  private syncChannelState(channelId: string) {
    const snapshot = this.getChannelSnapshot(channelId);
    if (snapshot.turns.size === 0 && snapshot.agentState === 'streaming') {
      snapshot.agentState = 'idle';
    }
    if (snapshot.turns.size === 0 && snapshot.todos.size === 0 && snapshot.agentState === 'idle') {
      return;
    }
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
    const snapshot = this.getChannelSnapshot(turn.channelId);
    snapshot.agentState = 'streaming';
    snapshot.turns.set(turn.tempId, {
      tempId: turn.tempId,
      agentId: turn.agentId,
      text: '',
      toolCalls: [],
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
    if (tempId) {
      const snapshot = this.getChannelSnapshot(channelId);
      snapshot.turns.delete(tempId);
      this.syncChannelState(channelId);
    }
  }

  cancelActiveTurn(agentId: string, channelId: string) {
    const turn = this.getActiveTurn(agentId, channelId);
    if (!turn) return null;

    turn.cancelled = true;
    turn.cancel();
    return turn;
  }

  appendTurnText(channelId: string, tempId: string, delta: string) {
    const turn = this.getChannelSnapshot(channelId).turns.get(tempId);
    if (!turn) return;
    turn.text += delta;
  }

  updateToolCall(channelId: string, tempId: string, toolCall: LiveToolCallRecord) {
    const turn = this.getChannelSnapshot(channelId).turns.get(tempId);
    if (!turn) return;
    const index = turn.toolCalls.findIndex((entry) => entry.toolCallId === toolCall.toolCallId);
    if (index >= 0) {
      turn.toolCalls[index] = { ...turn.toolCalls[index], ...toolCall };
      return;
    }
    turn.toolCalls.push(toolCall);
  }

  updateTodos(channelId: string, todoSnapshot: LiveTodoSnapshot) {
    const snapshot = this.getChannelSnapshot(channelId);
    snapshot.todos.set(todoSnapshot.agentId, todoSnapshot);
  }

  markChannelError(channelId: string) {
    this.getChannelSnapshot(channelId).agentState = 'error';
  }

  getLiveState(channelId: string) {
    const snapshot = this.getChannelSnapshot(channelId);
    return {
      channelId,
      agentState: snapshot.agentState,
      turns: Array.from(snapshot.turns.values()),
      todos: Array.from(snapshot.todos.values()),
    };
  }
}

export const sessionLaneRegistry = new SessionLaneRegistry();
