/**
 * running.ts — the carried-forward RUNNING SUMMARY (Main's 8k-wall rule).
 *
 * A real meeting crosses the 4096-token context in ~15-25 min of speech.
 * Cue requests are stateless (a fresh LanguageModelSession each), so the
 * only way to keep early context is to compress it: every ~4 minutes of new
 * finals — or sooner when the unsummarized buffer exceeds its token budget —
 * the oldest buffered finals are summarized by one schema'd generate call
 * and folded into `segments`. Cue prompts then carry the summary (≤400 tok)
 * in place of the old transcript; the post-conversation review reuses the
 * segments as its map step.
 *
 * This class owns buffering and accounting only — the controller supplies
 * the actual generate call so all LLM traffic stays serialized.
 */

import type {TranscriptFinal} from "../../shared/types"
import {estimateTokens, tailByTokens, TOKEN_BUDGET} from "../cues/prompt"

export interface RunningSummaryOptions {
  /** Summarize after this much new speech (ms). Default 4 min. */
  intervalMs?: number
  /** Summarize early when the buffer exceeds this many tokens. Default 1200. */
  bufferTokenLimit?: number
  /** Injectable clock. */
  now?: () => number
}

/** Guided-generation schema for one summarization pass. */
export const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Running summary of the conversation so far: key facts, names, decisions, open questions. ≤ 60 words.",
    },
  },
  required: ["summary"],
} as const

export const SUMMARY_INSTRUCTIONS =
  "You maintain a running summary of a live conversation for an on-device " +
  "assistant. Merge the previous summary (if any) with the new transcript " +
  "lines into one compact brief: key facts, names and who they are, " +
  "decisions made, and questions still open. Drop filler. ≤ 60 words."

export class RunningSummary {
  private readonly intervalMs: number
  private readonly bufferTokenLimit: number
  private readonly now: () => number

  /** Completed per-window summaries, oldest first. Reused by the review map step. */
  readonly segments: string[] = []
  /** Finals not yet folded into a segment. */
  private buffer: TranscriptFinal[] = []
  private bufferTokens = 0
  private lastSummarizedAt = 0

  constructor(options: RunningSummaryOptions = {}) {
    this.intervalMs = options.intervalMs ?? 4 * 60_000
    this.bufferTokenLimit = options.bufferTokenLimit ?? 1200
    this.now = options.now ?? Date.now
    this.lastSummarizedAt = this.now()
  }

  reset(): void {
    this.segments.length = 0
    this.buffer = []
    this.bufferTokens = 0
    this.lastSummarizedAt = this.now()
  }

  add(final: TranscriptFinal): void {
    this.buffer.push(final)
    this.bufferTokens += estimateTokens(final.text) + (final.translation ? estimateTokens(final.translation) : 0)
  }

  /** True when the buffer should be summarized now (interval or overflow). */
  due(): boolean {
    if (this.buffer.length === 0) return false
    return this.bufferTokens > this.bufferTokenLimit || this.now() - this.lastSummarizedAt >= this.intervalMs
  }

  /** The buffered finals to feed the summarizer (oldest first). */
  pendingFinals(): TranscriptFinal[] {
    return this.buffer
  }

  /** The summary text the cue prompt carries (≤ its token budget). */
  promptText(): string {
    if (this.segments.length === 0) return ""
    // Newest segments first until the budget is spent — recent context
    // matters most for the next cue.
    const picked: string[] = []
    let used = 0
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const cost = estimateTokens(this.segments[i])
      if (used + cost > TOKEN_BUDGET.runningSummary) break
      used += cost
      picked.unshift(this.segments[i])
    }
    return tailByTokens(picked.join(" "), TOKEN_BUDGET.runningSummary)
  }

  /**
   * Fold a completed summary into the state: append the segment, clear the
   * buffer, restart the interval clock. Called by the controller after the
   * generate resolves (or with a fallback text on failure — never fake
   * content: the fallback is the raw buffer text trimmed, marked as such by
   * the caller choosing to skip instead).
   */
  commit(summaryText: string): void {
    const text = summaryText.trim()
    if (text) this.segments.push(text)
    this.buffer = []
    this.bufferTokens = 0
    this.lastSummarizedAt = this.now()
  }

  /** Drop the buffer without a summary (session end — review handles it raw). */
  flushBuffer(): TranscriptFinal[] {
    const out = this.buffer
    this.buffer = []
    this.bufferTokens = 0
    return out
  }

  /** Build the generate() request for the pending buffer. */
  buildRequest(): {instructions: string; prompt: string; schema: object; maxTokens: number} {
    const prior = this.promptText()
    const lines = this.buffer.map((f) => f.text).join("\n")
    const prompt =
      (prior ? `PREVIOUS SUMMARY:\n${prior}\n\n` : "") +
      `NEW TRANSCRIPT LINES:\n${lines}\n\nUpdate the running summary.`
    return {
      instructions: SUMMARY_INSTRUCTIONS,
      prompt,
      schema: SUMMARY_SCHEMA,
      maxTokens: 160,
    }
  }
}
