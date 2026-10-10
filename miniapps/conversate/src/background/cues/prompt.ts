/**
 * prompt.ts — cue prompt construction inside the on-device context budget.
 *
 * The probe measured contextSize = 4096 tokens on this phone (iOS 27). The
 * budget split is explicit and tested:
 *
 *   instructions        ~250 tok   (fixed system prompt)
 *   prep-note excerpt   ≤ 900 tok  (keyword-retrieved chunks)
 *   running summary     ≤ 400 tok  (compressed older transcript)
 *   recent transcript   ≤ 1500 tok (newest finals, tail-kept)
 *   cue-title history   ≤ 120 tok  (last 8 titles, de-dup pressure)
 *   output cap           220 tok   (maxTokens on generate)
 *   ─────────────────────────────
 *   total               ≤ ~3390 tok of the 4096 window — headroom for the
 *                        schema and the host's own session overhead.
 *
 * Token estimate: chars/4 for Latin, chars/1.5 for CJK (design doc).
 */

import type {Cue, CueKind, TranscriptFinal} from "../../shared/types"
import {chineseScript} from "../../shared/languages"

export const TOKEN_BUDGET = {
  instructions: 250,
  prepNote: 900,
  runningSummary: 400,
  transcript: 1500,
  cueHistory: 120,
  output: 220,
} as const

/** The model's measured context window on this device. */
export const CONTEXT_SIZE_TOKENS = 4096

// ── token estimation ───────────────────────────────────────────────────────

const CJK_RE = /[㐀-鿿豈-﫿぀-ヿ가-힯]/g

/** Estimated token count: CJK chars / 1.5, everything else / 4. */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0
  return Math.ceil(cjk / 1.5 + (text.length - cjk) / 4)
}

/**
 * Keep the NEWEST finals that fit `budget` tokens. Returns the kept slice
 * (never reorders). When a single final exceeds the budget its tail is kept —
 * a truncated recent line beats an empty window.
 */
export function trimFinalsToBudget(finals: TranscriptFinal[], budget: number): TranscriptFinal[] {
  const kept: TranscriptFinal[] = []
  let used = 0
  for (let i = finals.length - 1; i >= 0; i--) {
    const f = finals[i]
    const cost = estimateTokens(f.text) + (f.translation ? estimateTokens(f.translation) : 0)
    if (used + cost > budget) {
      if (kept.length === 0) {
        kept.push({...f, text: tailByTokens(f.text, budget)})
      }
      break
    }
    used += cost
    kept.push(f)
  }
  return kept.reverse()
}

/** Keep the tail of `text` that fits `budget` estimated tokens. */
export function tailByTokens(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text
  // Walk back from the end; CJK chars cost ~1.5x so count them double-ish.
  let units = 0
  const limit = budget * 3 // 3 "units" ≈ 1 token for latin (4 chars), conservative for CJK (2 chars)
  let i = text.length
  while (i > 0) {
    const ch = text[i - 1]
    units += /[㐀-鿿豈-﫿぀-ヿ가-힯]/.test(ch) ? 3 : 1
    if (units > limit) break
    i--
  }
  return "…" + text.slice(i)
}

// ── cue schema + prompt ────────────────────────────────────────────────────

/** Guided-generation schema for one cue request (design §4). */
export const CUE_SCHEMA = {
  type: "object",
  properties: {
    cues: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        properties: {
          kind: {enum: ["concept", "bio", "answer", "suggestion"]},
          title: {type: "string", description: "≤ 6 words"},
          body: {type: "string", description: "≤ 25 words"},
        },
        required: ["kind", "title", "body"],
      },
    },
  },
  required: ["cues"],
} as const

export const CUE_INSTRUCTIONS =
  "You are Easy2Say, an on-device conversation assistant. From the live " +
  "transcript, produce at most two short cues that would genuinely help the " +
  "listener right now: a concept worth defining, a bio of a person or org " +
  "mentioned, an answer to a question just asked, or a suggestion for what " +
  "to say next. Use only the transcript, the prep note, and your own " +
  "knowledge — you have no internet access. Keep every title under 6 words " +
  "and every body under 25 words; they render on a tiny glasses display. " +
  "If nothing would be useful, return an empty cue list — silence beats " +
  "noise on a heads-up display. Never repeat a cue already shown (listed " +
  "under RECENT CUES)."

export interface CuePromptInput {
  /** Newest-first is NOT required — pass chronological finals; trimming keeps the tail. */
  finals: TranscriptFinal[]
  /** Running summary of older transcript, already ≤ its budget. */
  runningSummary: string
  /** Keyword-retrieved prep-note excerpt, already ≤ its budget. */
  prepNoteExcerpt: string
  /** Last N cue titles for de-dup pressure. */
  recentCueTitles: string[]
  /** BCP-47 tag cues should be written in. */
  cueLanguage: string
  /** Transcript token budget — halved on a context-exceeded retry. */
  transcriptBudget?: number
}

export interface CuePrompt {
  instructions: string
  prompt: string
  schema: object
  maxTokens: number
  /** Estimated total prompt tokens (instructions + prompt), for tests. */
  estimatedTokens: number
}

export function buildCuePrompt(input: CuePromptInput): CuePrompt {
  const budget = input.transcriptBudget ?? TOKEN_BUDGET.transcript
  const finals = trimFinalsToBudget(input.finals, budget)

  const parts: string[] = []
  parts.push(`Reply with cues written in ${input.cueLanguage}.`)
  if (input.runningSummary.trim()) {
    parts.push(`\nCONVERSATION SO FAR (summary):\n${input.runningSummary.trim()}`)
  }
  if (input.prepNoteExcerpt.trim()) {
    parts.push(`\nPREP NOTE (user-provided context):\n${input.prepNoteExcerpt.trim()}`)
  }
  if (input.recentCueTitles.length > 0) {
    parts.push(`\nRECENT CUES (do not repeat):\n${input.recentCueTitles.map((t) => `- ${t}`).join("\n")}`)
  }
  if (finals.length > 0) {
    const lines = finals.map((f) => (f.translation ? `${f.text}\n  → ${f.translation}` : f.text))
    parts.push(`\nRECENT TRANSCRIPT:\n${lines.join("\n")}`)
  } else {
    parts.push(`\nRECENT TRANSCRIPT:\n(none yet)`)
  }
  const prompt = parts.join("\n")

  return {
    instructions: CUE_INSTRUCTIONS,
    prompt,
    schema: CUE_SCHEMA,
    maxTokens: TOKEN_BUDGET.output,
    estimatedTokens: estimateTokens(CUE_INSTRUCTIONS) + estimateTokens(prompt),
  }
}

// ── cue parsing ────────────────────────────────────────────────────────────

const CUE_KINDS: Record<string, true> = {concept: true, bio: true, answer: true, suggestion: true}

/** Defensive caps — the prompt asks for <6-word titles / <25-word bodies. */
export const CUE_TITLE_MAX_CHARS = 60
export const CUE_BODY_MAX_CHARS = 200

/** First markup/JSON-leak boundary: '<', '{', '}', or a backslash escape. */
const LEAK_BOUNDARY = /[<{}]|\\["\\/bfnrtu]/
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g
/** Trailing punctuation that only makes sense with a partner or a clause. */
const ORPHAN_TAIL = /["'’”)\]>、，,;；:：·「『]+$/u

const countChar = (s: string, ch: string) => s.split(ch).length - 1

/**
 * Clean one generated cue/summary string. Guided generation guarantees the
 * JSON SHAPE, not clean content — the model can leak markup or raw JSON
 * fragments into a string field (observed on-device: `…。」} }​> <\/div>`).
 *
 *   1. cut at the first markup/JSON-leak boundary
 *   2. strip zero-width characters
 *   3. collapse whitespace
 *   4. strip trailing orphan quote/bracket punctuation — sentence enders
 *      (。！？.!?) and balanced 「…」/『…』 survive
 *   5. cap at maxChars
 *
 * Returns "" when nothing usable remains — callers drop the cue/bullet.
 */
export function sanitizeCueText(raw: string, maxChars = CUE_BODY_MAX_CHARS): string {
  const boundary = LEAK_BOUNDARY.exec(raw)
  let s = boundary ? raw.slice(0, boundary.index) : raw
  s = s.replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim()
  // Orphan closers/quotes first, then unbalanced CJK corner brackets.
  s = s.replace(ORPHAN_TAIL, "")
  while (s.endsWith("」") && countChar(s, "「") < countChar(s, "」")) s = s.slice(0, -1)
  while (s.endsWith("』") && countChar(s, "『") < countChar(s, "』")) s = s.slice(0, -1)
  s = s.trimEnd()
  if (s.length > maxChars) s = s.slice(0, maxChars).trimEnd()
  return s
}

/**
 * Parse the generate() result into cues. Accepts `json` (guided generation)
 * or a `text` payload containing the JSON object. Invalid entries are
 * dropped, never repaired into fake cues.
 */
export function parseCues(result: {json?: unknown; text?: string}, t: number, languageNote?: string): Cue[] {
  let root: unknown = result.json
  if (root === undefined && typeof result.text === "string") {
    try {
      root = JSON.parse(result.text)
    } catch {
      return []
    }
  }
  if (typeof root !== "object" || root === null) return []
  const list = (root as {cues?: unknown}).cues
  if (!Array.isArray(list)) return []
  const cues: Cue[] = []
  for (const item of list.slice(0, 2)) {
    const {kind, title, body} = item as {kind?: unknown; title?: unknown; body?: unknown}
    if (typeof kind !== "string" || CUE_KINDS[kind] !== true) continue
    if (typeof title !== "string" || typeof body !== "string") continue
    const cleanTitle = sanitizeCueText(title, CUE_TITLE_MAX_CHARS)
    const cleanBody = sanitizeCueText(body, CUE_BODY_MAX_CHARS)
    if (!cleanTitle || !cleanBody) continue
    cues.push({
      id: `cue-${t.toString(36)}-${cues.length}`,
      kind: kind as CueKind,
      title: cleanTitle,
      body: cleanBody,
      t,
      ...(languageNote ? {languageNote} : {}),
    })
  }
  return cues
}

// ── cue language decision ──────────────────────────────────────────────────

/**
 * Decide which language cues are generated in. `supportedLanguages` comes
 * from the probe (24 tags incl. zh-Hant-TW, zh-Hant-HK, zh-Hans-CN, en).
 * Matching is language + script aware: a zh-TW conversation needs a Hant
 * tag, not just any zh. Returns the tag to prompt in plus a note when the
 * result is a fallback (English) rather than the requested language.
 */
export function decideCueLanguage(
  requested: string,
  supportedLanguages: string[] | undefined,
): {tag: string; languageNote?: string} {
  const supported = supportedLanguages ?? []
  const match = findSupported(requested, supported)
  if (match) return {tag: match}
  // Fallback: English is on every Apple Intelligence device.
  const english = findSupported("en", supported)
  if (english) {
    return {tag: english, languageNote: `shown in English — on-device AI cannot write ${requested}`}
  }
  // supportedLanguages absent/empty: attempt the requested language anyway —
  // the contract says never refuse on a stale availability read.
  if (supported.length === 0) return {tag: requested}
  return {tag: requested, languageNote: `on-device AI may not support ${requested}`}
}

function findSupported(requested: string, supported: string[]): string | null {
  const req = requested.toLowerCase()
  const reqScript = chineseScript(requested)
  const reqPrimary = req.split("-")[0]
  for (const tag of supported) {
    const t = tag.toLowerCase()
    if (t === req) return tag
    if (t.split("-")[0] !== reqPrimary) continue
    if (reqPrimary === "zh") {
      // Chinese matches on written form: zh-TW/zh-Hant* ↔ hant tags only.
      if (reqScript && chineseScript(tag) === reqScript) return tag
    } else {
      return tag
    }
  }
  return null
}
