/**
 * review.ts — post-conversation review via map-reduce over the 4096-token
 * context (design §4 + Main's running-summary rule).
 *
 *   Map   : split the transcript into chunks that fit (~2,500 tokens) and
 *           summarize each into bullet facts + action items. When the live
 *           session already produced running-summary segments, those ARE the
 *           map output — no second pass over the same speech.
 *   Reduce: combine chunk summaries into {title, overview, highlights[],
 *           details[], nextSteps[]}.
 *
 * Everything degrades: no LLM → a transcript-only review with the reason
 * shown; a failed chunk → that chunk contributes nothing rather than
 * failing the review.
 */

import type {Cue, ReviewSummary, TranscriptFinal} from "../../shared/types"
import type {SessionLlm} from "../host"
import {llmErrorCode, llmErrorReason} from "../host"
import {estimateTokens, sanitizeCueText} from "../cues/prompt"

/** Map-chunk token budget (~2,500 per the design). */
export const MAP_CHUNK_TOKENS = 2500
const MAP_MAX_TOKENS = 300
const REDUCE_MAX_TOKENS = 700

export const MAP_SCHEMA = {
  type: "object",
  properties: {
    facts: {type: "array", maxItems: 12, items: {type: "string"}},
    actionItems: {type: "array", maxItems: 6, items: {type: "string"}},
  },
  required: ["facts", "actionItems"],
} as const

export const REDUCE_SCHEMA = {
  type: "object",
  properties: {
    title: {type: "string", description: "≤ 8 words"},
    overview: {type: "string", description: "2-3 sentences"},
    highlights: {type: "array", maxItems: 8, items: {type: "string"}},
    details: {type: "array", maxItems: 12, items: {type: "string"}},
    nextSteps: {type: "array", maxItems: 8, items: {type: "string"}},
  },
  required: ["title", "overview", "highlights", "details", "nextSteps"],
} as const

const MAP_INSTRUCTIONS =
  "Summarize this excerpt of a conversation transcript into bullet facts " +
  "and action items. Facts: what was said/decided, names, numbers. Action " +
  "items: commitments and follow-ups. Be terse; each bullet ≤ 15 words."

const REDUCE_INSTRUCTIONS =
  "Combine these per-chunk summaries of one conversation into a final " +
  "review: a short title, a 2-3 sentence overview, highlights (the moments " +
  "worth remembering), details (facts worth keeping), and next steps " +
  "(commitments and follow-ups). Terse bullets, ≤ 15 words each."

export interface ChunkSummary {
  facts: string[]
  actionItems: string[]
}

/** Split finals into chronological chunks each ≤ `budget` estimated tokens. */
export function chunkTranscript(finals: TranscriptFinal[], budget = MAP_CHUNK_TOKENS): TranscriptFinal[][] {
  const chunks: TranscriptFinal[][] = []
  let cur: TranscriptFinal[] = []
  let used = 0
  for (const f of finals) {
    const cost = estimateTokens(f.text) + (f.translation ? estimateTokens(f.translation) : 0)
    if (used + cost > budget && cur.length > 0) {
      chunks.push(cur)
      cur = []
      used = 0
    }
    cur.push(f)
    used += cost
  }
  if (cur.length > 0) chunks.push(cur)
  return chunks
}

export interface ReviewInput {
  /** Running-summary segments from the live session (map output reuse). */
  summarySegments: string[]
  /** Finals the running summary never covered (its leftover buffer). */
  unsummarizedFinals: TranscriptFinal[]
  /** All finals — used only for the transcript-only fallback. */
  allFinals: TranscriptFinal[]
  /** Session cues — the fallback title takes the first cue's title. */
  cues: Cue[]
  /** Session start (ms) — the dated fallback title uses it. */
  startedAt: number
  llm: SessionLlm | null
  /** Serialized generate runner — the controller owns the one-in-flight rule. */
  run: (req: {
    instructions: string
    prompt: string
    schema?: object
    maxTokens?: number
  }) => Promise<{json?: unknown; text?: string}>
}
export interface ReviewResult {
  summary: ReviewSummary
  /** True when the LLM produced the review; false = transcript-only fallback. */
  aiGenerated: boolean
  /** Full degradation sentence rendered inside the Summary section. */
  note?: string
  /** Short parenthetical for the header line, e.g. "summary declined by the on-device safety filter". */
  label?: string
}

/** Map one chunk to facts + action items. */
async function mapChunk(run: ReviewInput["run"], chunk: TranscriptFinal[]): Promise<ChunkSummary> {
  const lines = chunk.map((f) => (f.translation ? `${f.text} (${f.translation})` : f.text)).join("\n")
  const res = await run({
    instructions: MAP_INSTRUCTIONS,
    prompt: `TRANSCRIPT EXCERPT:\n${lines}`,
    schema: MAP_SCHEMA,
    maxTokens: MAP_MAX_TOKENS,
  })
  return parseChunkSummary(res) ?? {facts: [], actionItems: []}
}

function parseChunkSummary(res: {json?: unknown; text?: string}): ChunkSummary | null {
  let root: unknown = res.json
  if (root === undefined && typeof res.text === "string") {
    try {
      root = JSON.parse(res.text)
    } catch {
      return null
    }
  }
  if (typeof root !== "object" || root === null) return null
  const facts = "facts" in root ? root.facts : undefined
  const actionItems = "actionItems" in root ? root.actionItems : undefined
  const clean = (v: unknown) =>
    Array.isArray(v) ? v.filter((f): f is string => typeof f === "string").map((f) => sanitizeCueText(f)).filter((f) => f.length > 0) : []
  return {facts: clean(facts), actionItems: clean(actionItems)}
}

function parseReviewSummary(res: {json?: unknown; text?: string}): ReviewSummary | null {
  let root: unknown = res.json
  if (root === undefined && typeof res.text === "string") {
    try {
      root = JSON.parse(res.text)
    } catch {
      return null
    }
  }
  if (typeof root !== "object" || root === null) return null
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
  // root is a JSON.parse'd object (narrowed above); index it for field reads.
  const r = root as Record<string, unknown>
  const field = (name: string) => (name in r ? r[name] : undefined)
  const title = sanitizeCueText(str(field("title")), 80)
  if (!title) return null
  const clean = (v: unknown) => arr(v).map((x) => sanitizeCueText(x)).filter((x) => x.length > 0)
  return {
    title,
    overview: sanitizeCueText(str(field("overview")), 400),
    highlights: clean(field("highlights")),
    details: clean(field("details")),
    nextSteps: clean(field("nextSteps")),
  }
}

/**
 * Build the review. Reuses running-summary segments as map output; only the
 * unsummarized tail (or the whole transcript when no segments exist) is
 * chunked and mapped.
 */
export async function generateReview(input: ReviewInput): Promise<ReviewResult> {
  const {summarySegments, unsummarizedFinals, allFinals, cues, startedAt, llm, run} = input
  const fallback = () => fallbackSummary(allFinals, cues, startedAt)

  if (!llm) {
    return {
      aiGenerated: false,
      label: "on-device AI unavailable",
      note: "On-device AI unavailable — transcript and cue list only.",
      summary: fallback(),
    }
  }

  // Map: reuse segments; chunk whatever the running summary never covered.
  // Every failure is classified so the review can say WHY it degraded.
  let guardrail = false
  let unavailableReason: string | null = null
  let contextExceeded = false
  const classify = (err: unknown) => {
    const code = llmErrorCode(err)
    if (code === "LLM_GUARDRAIL") guardrail = true
    else if (code === "LLM_CONTEXT_EXCEEDED") contextExceeded = true
    else if (code === "LLM_UNAVAILABLE") unavailableReason = llmErrorReason(err) ?? "unknown"
  }

  const mappedTexts: string[] = [...summarySegments]
  const chunks = chunkTranscript(unsummarizedFinals)
  const chunkSummaries: ChunkSummary[] = []
  for (const chunk of chunks) {
    try {
      chunkSummaries.push(await mapChunk(run, chunk))
    } catch (err) {
      classify(err)
      chunkSummaries.push({facts: [], actionItems: []})
    }
  }
  for (const cs of chunkSummaries) {
    const text = [...cs.facts, ...cs.actionItems.map((a) => `→ ${a}`)].join("; ")
    if (text) mappedTexts.push(text)
  }

  if (mappedTexts.length === 0) {
    return {aiGenerated: false, ...degradedNote(guardrail, unavailableReason, contextExceeded), summary: fallback()}
  }

  // Reduce.
  try {
    const res = await run({
      instructions: REDUCE_INSTRUCTIONS,
      prompt: `CHUNK SUMMARIES:\n${mappedTexts.map((t, i) => `${i + 1}. ${t}`).join("\n")}`,
      schema: REDUCE_SCHEMA,
      maxTokens: REDUCE_MAX_TOKENS,
    })
    const summary = parseReviewSummary(res)
    if (summary) return {aiGenerated: true, summary}
  } catch (err) {
    classify(err)
  }
  return {aiGenerated: false, ...degradedNote(guardrail, unavailableReason, contextExceeded), summary: fallback()}
}

/** The degradation sentence + header label for a transcript-only review. */
function degradedNote(
  guardrail: boolean,
  unavailableReason: string | null,
  contextExceeded: boolean,
): {note: string; label: string} {
  if (guardrail) {
    return {
      label: "summary declined by the on-device safety filter",
      note: "Summary declined by the on-device safety filter — transcript and cue list only.",
    }
  }
  if (unavailableReason !== null) {
    return {
      label: `on-device AI unavailable (${unavailableReason})`,
      note: `On-device AI unavailable: ${unavailableReason} — transcript and cue list only.`,
    }
  }
  if (contextExceeded) {
    return {
      label: "transcript exceeded the on-device context window",
      note: "The transcript exceeded the on-device context window — transcript and cue list only.",
    }
  }
  return {
    label: "summary generation failed",
    note: "Summary generation failed — transcript and cue list only.",
  }
}

function fallbackSummary(finals: TranscriptFinal[], cues: Cue[], startedAt: number): ReviewSummary {
  // Title: first cue's title, else a dated placeholder — never a transcript
  // fragment (a mid-word first final makes a terrible H1).
  const title = cues[0]?.title?.trim() || `Conversation · ${reviewStamp(startedAt)}`
  return {
    title,
    overview: `${finals.length} transcript lines captured on-device.`,
    highlights: [],
    details: [],
    nextSteps: [],
  }
}

/** "YYYY-MM-DD HH:mm" — same stamp the Markdown header prints. */
function reviewStamp(startedAt: number): string {
  const d = new Date(startedAt)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Render the review + cue list + transcript to Markdown (design §4). */
export function renderReviewMarkdown(args: {
  title: string
  startedAt: number
  summary: ReviewSummary
  cues: Cue[]
  finals: TranscriptFinal[]
  aiGenerated: boolean
  /** Short parenthetical for the header line when aiGenerated is false. */
  label?: string
  note?: string
  guardrailSkips?: number
}): string {
  const {summary, cues, finals} = args
  const d = new Date(args.startedAt)
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`

  const out: string[] = []
  out.push(`# ${summary.title}`)
  out.push("")
  out.push(`_Easy2Say · ${stamp} · on-device review${args.aiGenerated ? "" : ` (${args.label ?? "AI unavailable — transcript only"})`}_`)
  out.push("")
  out.push(`## Summary`)
  out.push("")
  if (args.aiGenerated && summary.overview) out.push(summary.overview, "")
  if (!args.aiGenerated && args.note) out.push(`> ${args.note}`, "")
  if (summary.highlights.length > 0) {
    out.push(`### Highlights`)
    for (const h of summary.highlights) out.push(`- ${h}`)
    out.push("")
  }
  if (summary.details.length > 0) {
    out.push(`### Details`)
    for (const s of summary.details) out.push(`- ${s}`)
    out.push("")
  }
  if (summary.nextSteps.length > 0) {
    out.push(`### Next Steps`)
    for (const s of summary.nextSteps) out.push(`- [ ] ${s}`)
    out.push("")
  }

  out.push(`## Cue List`)
  out.push("")
  if (cues.length === 0) {
    out.push(`_No cues were generated._`, "")
  } else {
    for (const c of [...cues].sort((a, b) => a.t - b.t)) {
      const cd = new Date(c.t)
      out.push(`- **${c.kind.toUpperCase()} · ${c.title}** — ${c.body} _(${pad(cd.getHours())}:${pad(cd.getMinutes())})_`)
    }
    out.push("")
  }

  out.push(`## Transcription`)
  out.push("")
  for (const f of finals) {
    const fd = new Date(f.t)
    out.push(`- [${pad(fd.getHours())}:${pad(fd.getMinutes())}] ${f.text}`)
    if (f.translation) out.push(`  - → ${f.translation}`)
  }
  out.push("")
  out.push(`---`)
  const footerBits = [`${finals.length} lines`, `${cues.length} cues`]
  if (args.guardrailSkips && args.guardrailSkips > 0) {
    footerBits.push(`${args.guardrailSkips} cue${args.guardrailSkips > 1 ? "s" : ""} skipped by on-device safety`)
  }
  footerBits.push(`generated entirely on-device`)
  out.push(`_${footerBits.join(" · ")}_`)
  out.push("")
  return out.join("\n")
}
