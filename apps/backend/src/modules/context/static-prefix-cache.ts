/**
 * Static Prefix Cache — Context Builder Optimization
 *
 * Caches the static portion of the LLM prompt prefix (soul.md, identity.md,
 * Agent.md, tools.md, user.md, memory.md, project.md, agency.md, runtime-context)
 * so that ContextBuilder.build() can skip the 6+ filesystem reads and DB queries
 * for workspace docs on turns where nothing has changed.
 *
 * Cache correctness is maintained by:
 *   1. A file-hash check: stat() mtimes of the 6 agent doc files are hashed on
 *      every build() call. A mtime change invalidates the cached prefix.
 *   2. A TTL: entries older than STATIC_PREFIX_TTL_MS are evicted unconditionally.
 *   3. Explicit invalidation: workspaceService.writeAgentWorkspaceFile() calls
 *      staticPrefixCache.invalidate(agentId) after each write.
 *
 * Heartbeat.md, conversation summary, and history are never cached — they change
 * every turn and are always rebuilt from the DB.
 *
 * Phase 4 implementation status:
 * - In-memory Map cache with TTL + mtime hash.
 * - invalidate(agentId) clears all channel entries for an agent.
 * - Future phases can add per-entry metrics, LRU eviction, or Redis-backed sharing.
 */

import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { LLMMessage } from '@nextgenchat/types';

import { env } from '@/config/env.js';

/** How long a cached prefix stays valid before forced rebuild (ms). */
const STATIC_PREFIX_TTL_MS = 5 * 60 * 1_000; // 5 minutes

/** The 6 workspace doc files whose mtimes determine the cache key. */
const WATCHED_DOC_FILES = ['soul.md', 'identity.md', 'agent.md', 'user.md', 'memory.md', 'heartbeat.md'];

interface CacheEntry {
  /** The built static prefix messages ready to inject into the prompt. */
  messages: LLMMessage[];
  /** Number of messages in the prefix (for slicing dynamic messages after). */
  prefixCount: number;
  /** SHA-256 of the watched files' mtimes + project content at cache-build time. */
  fileHash: string;
  /** Unix ms when this entry was created. */
  builtAt: number;
}

class StaticPrefixCache {
  private readonly cache = new Map<string, CacheEntry>();

  private cacheKey(agentId: string, channelId: string): string {
    return `${agentId}:${channelId}`;
  }

  /** Compute a fast hash of the watched doc files' modification times. */
  async computeFileHash(agentId: string): Promise<string> {
    const workspaceDir = path.resolve(env.AGENT_WORKSPACES_DIR ?? 'agent-workspaces', agentId);
    const mtimes: number[] = [];

    for (const fileName of WATCHED_DOC_FILES) {
      try {
        const s = await stat(path.join(workspaceDir, fileName));
        mtimes.push(s.mtimeMs);
      } catch {
        // File doesn't exist yet — treat as mtime=0.
        mtimes.push(0);
      }
    }

    return createHash('sha256').update(JSON.stringify(mtimes)).digest('hex');
  }

  /**
   * Retrieve a cached prefix entry. Returns null on miss, TTL expiry, or
   * file-hash mismatch (meaning a workspace doc changed since last build).
   */
  async get(agentId: string, channelId: string): Promise<CacheEntry | null> {
    const entry = this.cache.get(this.cacheKey(agentId, channelId));

    if (!entry) return null;

    // Evict on TTL.
    if (Date.now() - entry.builtAt > STATIC_PREFIX_TTL_MS) {
      this.cache.delete(this.cacheKey(agentId, channelId));
      return null;
    }

    // Evict on file-hash mismatch — workspace docs were edited since last build.
    const currentHash = await this.computeFileHash(agentId);
    if (currentHash !== entry.fileHash) {
      this.cache.delete(this.cacheKey(agentId, channelId));
      return null;
    }

    return entry;
  }

  /** Store a freshly built prefix entry in the cache. */
  set(agentId: string, channelId: string, entry: Omit<CacheEntry, 'builtAt'>): void {
    this.cache.set(this.cacheKey(agentId, channelId), {
      ...entry,
      builtAt: Date.now(),
    });
  }

  /**
   * Invalidate all cached entries for an agent.
   * Called by workspaceService.writeAgentWorkspaceFile() after any doc write.
   */
  invalidate(agentId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${agentId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Invalidate all cached entries for a specific channel (all agents).
   * Called when DB-sourced content changes (project.md, agency.md) since
   * those changes are not captured by the mtime-based file hash.
   */
  invalidateByChannel(channelId: string): void {
    for (const key of this.cache.keys()) {
      if (key.endsWith(`:${channelId}`)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Invalidate ALL cached entries across all agents and channels.
   * Called when workspace-level files (agency.md) change.
   */
  invalidateAll(): void {
    this.cache.clear();
  }
}

export const staticPrefixCache = new StaticPrefixCache();
export type { CacheEntry as StaticPrefixCacheEntry };
