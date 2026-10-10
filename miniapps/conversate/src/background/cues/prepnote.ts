/**
 * prepnote.ts — Prep-Note handling: the 5,000-char cap, keyword extraction
 * for the scheduler's prep-note trigger, and keyword-overlap retrieval of
 * note chunks into the cue prompt (design §4: ~300-char chunks ranked by
 * overlap with the last 3 finals; NLEmbedding later if overlap proves weak).
 */

import {estimateTokens, tailByTokens} from "./prompt"

export const PREP_NOTE_MAX_CHARS = 5000
const CHUNK_CHARS = 300
const MAX_KEYWORDS = 200

/** Clamp a prep note to the 5,000-char contract (UI also enforces). */
export function clampPrepNote(text: string): string {
  return text.length > PREP_NOTE_MAX_CHARS ? text.slice(0, PREP_NOTE_MAX_CHARS) : text
}

/**
 * Keywords that trigger a cue when they appear in a final: distinct Latin
 * words ≥4 chars and CJK runs ≥3 chars, capped. Deliberately simple — these
 * are "the note is now relevant" tripwires, not search.
 */
export function extractKeywords(note: string): string[] {
  const out: string[] = []
  const seen: Record<string, true> = {}
  const push = (k: string) => {
    const key = k.toLowerCase()
    if (!seen[key] && out.length < MAX_KEYWORDS) {
      seen[key] = true
      out.push(key)
    }
  }
  for (const m of note.matchAll(/[\p{L}\p{N}]{4,}/gu)) {
    if (!/^[㐀-鿿豈-﫿぀-ヿ가-힯]+$/.test(m[0])) push(m[0])
  }
  for (const m of note.matchAll(/[㐀-鿿豈-﫿]{3,}/g)) push(m[0])
  return out
}

/** Split the note into retrieval chunks: one per line, long lines hard-split. */
export function chunkPrepNote(note: string): string[] {
  // One chunk per line so unrelated lines never share a chunk; a line longer
  // than CHUNK_CHARS hard-splits on space boundaries.
  const chunks: string[] = []
  for (const line of note.split("\n")) {
    let rest = line.trim()
    while (rest.length > CHUNK_CHARS) {
      let cut = rest.lastIndexOf(" ", CHUNK_CHARS)
      if (cut < CHUNK_CHARS / 2) cut = CHUNK_CHARS
      chunks.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) chunks.push(rest)
  }
  return chunks
}

/**
 * Rank note chunks by keyword overlap with `queryText` (the last ~3 finals)
 * and return the top chunks re-ordered into document order, joined, capped
 * at `tokenBudget` estimated tokens. No overlap → empty string (the note
 * earns its prompt budget only when relevant).
 */
export function retrievePrepNote(note: string, queryText: string, tokenBudget: number): string {
  if (!note.trim() || !queryText.trim()) return ""
  const chunks = chunkPrepNote(note)
  const terms = queryTerms(queryText)
  if (terms.length === 0) return ""

  const scored = chunks
    .map((text, index) => ({text, index, score: overlapScore(text, terms)}))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)

  const picked: typeof scored = []
  let used = 0
  for (const s of scored) {
    const cost = estimateTokens(s.text)
    if (used + cost > tokenBudget) continue
    used += cost
    picked.push(s)
  }
  picked.sort((a, b) => a.index - b.index)
  return tailByTokens(picked.map((p) => p.text).join("\n…\n"), tokenBudget)
}

/** Distinct query terms: Latin words ≥3 chars + CJK bigrams. */
function queryTerms(text: string): string[] {
  const terms: string[] = []
  const seen: Record<string, true> = {}
  const push = (t: string) => {
    if (!seen[t]) {
      seen[t] = true
      terms.push(t)
    }
  }
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]{3,}/gu)) {
    if (!/^[㐀-鿿豈-﫿぀-ヿ가-힯]+$/.test(m[0])) push(m[0])
  }
  const cjk = text.match(/[㐀-鿿豈-﫿]+/g) ?? []
  for (const run of cjk) {
    for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2))
  }
  return terms
}

function overlapScore(chunk: string, terms: string[]): number {
  const lower = chunk.toLowerCase()
  let score = 0
  for (const t of terms) {
    if (lower.includes(t)) score += 1
  }
  return score
}
