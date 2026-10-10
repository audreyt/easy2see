/**
 * Cue de-duplication — normalized-title match against the session's cue list
 * (design §4). Normalization lowercases, strips punctuation/diacritics-lite,
 * and collapses whitespace so "Semantic Search" and "semantic search!" dedupe.
 */

import type {Cue} from "../../shared/types"

export function normalizeCueTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** True when `title` duplicates any cue already shown this session. */
export function isDuplicateCue(title: string, existing: Cue[]): boolean {
  const norm = normalizeCueTitle(title)
  if (!norm) return true
  return existing.some((c) => normalizeCueTitle(c.title) === norm)
}

/** Drop cues whose titles duplicate earlier cues (or each other). */
export function dedupeCues(incoming: Cue[], existing: Cue[]): Cue[] {
  const out: Cue[] = []
  for (const cue of incoming) {
    if (isDuplicateCue(cue.title, existing) || isDuplicateCue(cue.title, out)) continue
    out.push(cue)
  }
  return out
}
