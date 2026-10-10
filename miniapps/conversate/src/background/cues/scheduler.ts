/**
 * CueScheduler — decides WHEN a cue request fires, per the design:
 *
 *   Fire a cue request when ANY of:
 *     - a final ends in a question (?/？/嗎/呢, or interrogative lead words)
 *       → Answer cue, high priority
 *     - ≥ ~40 new words (or ~80 CJK chars) since the last cue
 *     - ≥ 20 s since the last cue with new speech
 *     - a Prep-Note keyword appears in a final
 *   Never more than one in flight; never more often than every 6 s; drop the
 *   request if speech moved on (stale).
 *
 * The scheduler owns no LLM and no timers of its own: the host injects
 * `now()` and `defer(fn, ms)` so tests drive a manual clock, and `request`
 * is the single dispatch point the controller hangs generation off.
 */

export type CueTriggerKind = "question" | "volume" | "cadence" | "prepnote"

export interface CueTrigger {
  kind: CueTriggerKind
  /** The final text that caused the trigger (question/prepnote), if any. */
  cause?: string
}

export interface CueSchedulerOptions {
  /** Words of new Latin speech that trigger a cue. Default 40. */
  wordThreshold?: number
  /** CJK chars of new speech that trigger a cue. Default 80. */
  cjkThreshold?: number
  /** Ms since the last cue (with new speech) that trigger a cue. Default 20000. */
  cadenceMs?: number
  /** Minimum ms between cue dispatches. Default 6000. */
  minSpacingMs?: number
  /** A pending trigger older than this is dropped as stale. Default 30000. */
  staleMs?: number
  /** A pending trigger is stale once this many newer finals arrived. Default 2. */
  staleFinals?: number
  /** Prep-note keywords that trigger a cue when they appear in a final. */
  prepKeywords?: string[]
  /** Injectable clock (ms). */
  now?: () => number
  /** Injectable scheduler for the spacing retry. */
  defer?: (fn: () => void, ms: number) => void
}

const QUESTION_TAIL = /[?？]\s*$|[嗎呢]\s*$/
const INTERROGATIVE_LEAD =
  /(?:^|[.!?。！？]\s*)(?:who|what|when|where|why|how|which|whose|whom|is|are|was|were|do|does|did|can|could|should|would|will|shall|may|might|是不是|為什麼|为什么|什麼|什么|怎麼|怎么|哪裡|哪里|誰|谁|何時|何时|多少)/i

const PRIORITY: Record<CueTriggerKind, number> = {
  question: 3,
  prepnote: 2,
  volume: 1,
  cadence: 0,
}

interface PendingTrigger extends CueTrigger {
  queuedAt: number
  /** finalsSeen when queued — staleness is measured against speech moving on. */
  mark: number
}

export class CueScheduler {
  private readonly wordThreshold: number
  private readonly cjkThreshold: number
  private readonly cadenceMs: number
  private readonly minSpacingMs: number
  private readonly staleMs: number
  private readonly staleFinals: number
  private readonly prepKeywords: string[]
  private readonly now: () => number
  private readonly defer: (fn: () => void, ms: number) => void

  private enabled = false
  private finalsSeen = 0
  private wordsSinceCue = 0
  private cjkSinceCue = 0
  private finalsSinceCue = 0
  private lastCueAt = 0
  private lastDispatchAt = Number.NEGATIVE_INFINITY
  private inFlight = false
  private pending: PendingTrigger | null = null
  private retryArmed = false

  constructor(
    private readonly request: (trigger: CueTrigger) => void,
    options: CueSchedulerOptions = {},
  ) {
    this.wordThreshold = options.wordThreshold ?? 40
    this.cjkThreshold = options.cjkThreshold ?? 80
    this.cadenceMs = options.cadenceMs ?? 20_000
    this.minSpacingMs = options.minSpacingMs ?? 6_000
    this.staleMs = options.staleMs ?? 30_000
    this.staleFinals = options.staleFinals ?? 2
    this.prepKeywords = (options.prepKeywords ?? []).map((k) => k.toLowerCase())
    this.now = options.now ?? Date.now
    this.defer = options.defer ?? ((fn, ms) => setTimeout(fn, ms))
  }

  /** Arm/disarm cue generation. Disarming drops any pending trigger. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.pending = null
  }

  /** Reset per-session counters (new conversation). */
  reset(): void {
    this.finalsSeen = 0
    this.wordsSinceCue = 0
    this.cjkSinceCue = 0
    this.finalsSinceCue = 0
    this.lastCueAt = this.now()
    this.lastDispatchAt = Number.NEGATIVE_INFINITY
    this.inFlight = false
    this.pending = null
    this.retryArmed = false
  }

  /** Update the prep-note keyword set (editor changed). */
  setPrepKeywords(keywords: string[]): void {
    this.prepKeywords.length = 0
    for (const k of keywords) this.prepKeywords.push(k.toLowerCase())
  }

  /** Feed one transcript final. */
  onFinal(text: string): void {
    this.finalsSeen += 1
    this.finalsSinceCue += 1
    this.wordsSinceCue += countWords(text)
    this.cjkSinceCue += countCjk(text)

    if (!this.enabled) return

    if (isQuestion(text)) {
      this.trigger({kind: "question", cause: text})
      return
    }
    if (this.prepKeywords.length > 0 && containsKeyword(text, this.prepKeywords)) {
      this.trigger({kind: "prepnote", cause: text})
      return
    }
    if (this.wordsSinceCue >= this.wordThreshold || this.cjkSinceCue >= this.cjkThreshold) {
      this.trigger({kind: "volume"})
      return
    }
    if (this.finalsSinceCue > 0 && this.now() - this.lastCueAt >= this.cadenceMs) {
      this.trigger({kind: "cadence"})
    }
  }

  /** Heartbeat so the 20 s cadence can fire between finals. */
  tick(): void {
    if (!this.enabled) return
    if (this.finalsSinceCue > 0 && this.now() - this.lastCueAt >= this.cadenceMs) {
      this.trigger({kind: "cadence"})
    }
    this.maybeDispatch()
  }

  /**
   * The controller calls this when the in-flight generate settles (success,
   * guardrail skip, or failure). Returns true when the settled request's
   * result should be DROPPED because speech moved on while it generated —
   * the stale-drop rule applied to in-flight work.
   */
  requestSettled(mark: number): {stale: boolean} {
    this.inFlight = false
    const stale = this.finalsSeen - mark >= this.staleFinals
    this.maybeDispatch()
    return {stale}
  }

  /** Mark to compare against at requestSettled — capture before generate(). */
  speechMark(): number {
    return this.finalsSeen
  }

  /** True while a cue request is generating. */
  get busy(): boolean {
    return this.inFlight
  }

  // ── internals ──────────────────────────────────────────────────────────

  private trigger(t: CueTrigger): void {
    const candidate: PendingTrigger = {...t, queuedAt: this.now(), mark: this.finalsSeen}
    if (!this.pending || PRIORITY[t.kind] >= PRIORITY[this.pending.kind]) {
      this.pending = candidate
    }
    this.maybeDispatch()
  }

  private maybeDispatch(): void {
    if (!this.enabled || this.inFlight || !this.pending) return

    // Stale drop: speech moved on (or too much time passed) since the trigger
    // queued — the cue would answer a conversation that no longer exists.
    if (this.finalsSeen - this.pending.mark >= this.staleFinals || this.now() - this.pending.queuedAt > this.staleMs) {
      this.pending = null
      return
    }

    const wait = this.minSpacingMs - (this.now() - this.lastDispatchAt)
    if (wait > 0) {
      if (!this.retryArmed) {
        this.retryArmed = true
        this.defer(() => {
          this.retryArmed = false
          this.maybeDispatch()
        }, wait)
      }
      return
    }

    const t = this.pending
    this.pending = null
    this.inFlight = true
    this.lastCueAt = this.now()
    this.lastDispatchAt = this.now()
    this.wordsSinceCue = 0
    this.cjkSinceCue = 0
    this.finalsSinceCue = 0
    this.request({kind: t.kind, cause: t.cause})
  }
}

/** Question heuristic: terminal ?/？/嗎/呢, or an interrogative lead word. */
export function isQuestion(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (QUESTION_TAIL.test(t)) return true
  return INTERROGATIVE_LEAD.test(t)
}

/** Latin word count (whitespace-separated tokens containing a letter/digit). */
export function countWords(text: string): number {
  let n = 0
  for (const tok of text.split(/\s+/)) {
    if (/[\p{L}\p{N}]/u.test(tok) && !/^\p{Script=Han}+$/u.test(tok)) n += 1
  }
  return n
}

/** CJK character count. */
export function countCjk(text: string): number {
  const m = text.match(/[㐀-鿿豈-﫿]/g)
  return m ? m.length : 0
}

function containsKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase()
  return keywords.some((k) => k.length > 0 && lower.includes(k))
}
