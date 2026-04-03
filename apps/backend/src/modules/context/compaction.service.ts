/**
 * Auto-Compaction Service
 *
 * Triggered when a conversation's token count exceeds the context budget.
 * Summarizes old messages to free space for recent context.
 *
 * Algorithm:
 * 1. Determine which messages need summarization (overflow beyond budget)
 * 2. Call a cheap LLM model (gpt-4o-mini or claude-haiku) with:
 *    "Summarize this conversation, preserving key decisions, facts, outcomes"
 * 3. Store result in ConversationSummary table:
 *    { channelId, agentId, summary, tokenCount, coversFromMsgId, covesToMsgId }
 * 4. Future ContextBuilder calls load summary instead of raw old messages
 *
 * CRITICAL: Compaction runs ASYNC via BullMQ (job: compaction:process).
 * It NEVER blocks the current LLM call. The current call uses truncated
 * history; compacted context benefits all future calls.
 *
 * If summaries accumulate and themselves overflow, summarize-the-summaries
 * (recursive, max 3 levels deep).
 */

// TODO: Implement compaction service
export {};
