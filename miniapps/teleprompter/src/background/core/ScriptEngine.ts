/**
 * ScriptEngine — script content, reading position, and voice matching.
 *
 * Layout comes from the host: MentraOS owns wrapping and reports line
 * boundaries through render results (acceptLayout). The engine keeps the
 * word index, pacing weights, and voice anchoring on top of that.
 *
 * Tokenization is CJK-aware and shared with the spoken probe: Han
 * characters become one token each and Traditional folds to Simplified for
 * comparison only — display text always comes from the unmodified source.
 */
import type {RenderTextLayout} from "@mentra/miniapp/background"
import {foldHantToHans} from "./HanFold"

/**
 * CJK unified ideographs plus hiragana/katakana. Single-character tokens:
 * these scripts have no spaces, so a whitespace split would collapse a
 * whole sentence into one token and voice anchoring could never match.
 * (Inlined from the retired vendor script-detection tables.)
 */
function isCJKCharacter(char: string): boolean {
  const cp = char.codePointAt(0)
  if (cp === undefined) return false
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x3040 && cp <= 0x309f) ||
    (cp >= 0x30a0 && cp <= 0x30ff) ||
    (cp >= 0x31f0 && cp <= 0x31ff)
  )
}

/**
 * Pacing weight of a single CJK character token, relative to one Latin word.
 * Chinese averages ~2 characters per word, so each Han char counts as half a
 * "word" — keeps the WPM dial meaningful for Chinese scripts instead of
 * silently halving the effective speed.
 */
const CJK_TOKEN_WEIGHT = 0.5

/**
 * Lowercase, strip everything but letters/digits, then fold Traditional Han
 * characters to Simplified. The fold is comparison-only: the on-device Sherpa
 * "zh" model emits Simplified Chinese, so a Traditional script must be
 * compared in the same script the transcripts arrive in. Rendered text never
 * passes through here — display text comes from the unmodified source via
 * textFrom, not the norms.
 */
export function normalizeWord(raw: string): string {
  return foldHantToHans(raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""))
}

/**
 * Split arbitrary spoken/script text into normalized, non-empty word tokens.
 *
 * CJK-aware: Chinese (and Japanese) is written without spaces, so a
 * whitespace split would collapse a whole sentence into ONE token and the
 * trailing-word anchor could never match. CJK characters therefore become
 * one token each; every other run (Latin words, Korean syllable blocks,
 * digits) stays a single token exactly as before. The SAME function builds
 * the script's word index and the spoken probe — the two sides must tokenize
 * identically or the cursor→line mapping corrupts.
 */
export function normalizeWords(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\s+/)) {
    const n = normalizeWord(raw)
    if (!n) continue
    let run = ""
    for (const ch of n) {
      if (isCJKCharacter(ch)) {
        if (run) {
          out.push(run)
          run = ""
        }
        out.push(ch)
      } else {
        run += ch
      }
    }
    if (run) out.push(run)
  }
  return out
}

export class ScriptEngine {
  private text = ""
  private wordNorms: string[] = []
  private wordStarts: number[] = []
  private wordEnds: number[] = []
  private lineStarts = [0]
  private numberOfLines: number

  /** cumWeights[i] = total pacing weight of tokens 0..i inclusive. */
  private cumWeights: number[] = []

  constructor(config: {numberOfLines: number}) {
    this.numberOfLines = config.numberOfLines
  }

  setScript(text: string): void {
    this.text = text ?? ""
    this.wordNorms = []
    this.wordStarts = []
    this.wordEnds = []
    this.cumWeights = []
    // Same tokenization as normalizeWords — each whitespace run splits into
    // CJK singles + runs — plus source offsets and pacing weights. Offsets
    // stay exact: normalization (case/strip/fold) never crosses a piece
    // boundary, so each piece maps back to its own slice of the token.
    for (const match of this.text.matchAll(/\S+/gu)) {
      const token = match[0]
      const tokenStart = match.index!
      let run = ""
      let runStart = 0
      let offset = 0
      const push = (piece: string, pieceOffset: number) => {
        const norm = normalizeWord(piece)
        if (!norm) return
        this.wordNorms.push(norm)
        this.wordStarts.push(tokenStart + pieceOffset)
        this.wordEnds.push(tokenStart + pieceOffset + piece.length)
        // A single CJK character reads in roughly half an English word's
        // time (Chinese averages ~2 chars per word) — without this, "words
        // per minute" would run about 2x too slow on Chinese scripts.
        const w = norm.length === 1 && isCJKCharacter(norm) ? CJK_TOKEN_WEIGHT : 1
        this.cumWeights.push((this.cumWeights.length > 0 ? this.cumWeights[this.cumWeights.length - 1] : 0) + w)
      }
      for (const ch of token) {
        if (isCJKCharacter(ch)) {
          if (run) {
            push(run, runStart)
            run = ""
          }
          push(ch, offset)
        } else {
          if (!run) runStart = offset
          run += ch
        }
        offset += ch.length
      }
      if (run) push(run, runStart)
    }
    this.invalidateLayout()
  }

  invalidateLayout(): void {
    this.lineStarts = [0]
  }
  setLines(lines: number): void {
    this.numberOfLines = Math.max(1, lines)
  }

  /** These boundaries come from a render result, never from app font tables. */
  acceptLayout(sourceStart: number, result: RenderTextLayout): void {
    this.lineStarts = [
      ...this.lineStarts.filter((start) => start < sourceStart),
      ...result.lineStarts.map((start) => sourceStart + start),
    ]
    if (!this.lineStarts.length) this.lineStarts = [0]
    this.numberOfLines = Math.max(1, result.capacity)
  }

  get viewportLines(): number {
    return this.numberOfLines
  }
  get totalWords(): number {
    return this.wordNorms.length
  }
  get totalLines(): number {
    return this.lineStarts.length
  }
  get maxTopLine(): number {
    return Math.max(0, this.totalLines - this.numberOfLines)
  }
  sourceStartForLine(line: number): number {
    return this.lineStarts[Math.max(0, Math.min(line, this.totalLines - 1))] ?? 0
  }
  textFrom(sourceStart: number): string {
    return this.text.slice(sourceStart)
  }

  lineForWord(word: number): number {
    const offset = this.wordStarts[Math.min(word, this.totalWords - 1)] ?? 0
    let line = 0
    while (line + 1 < this.lineStarts.length && this.lineStarts[line + 1] <= offset) line++
    return line
  }
  topLineForWord(word: number): number {
    return Math.min(this.lineForWord(word), this.maxTopLine)
  }
  firstWordOfLine(line: number): number {
    const start = this.sourceStartForLine(line)
    const word = this.wordEnds.findIndex((end) => end > start)
    return word < 0 ? this.totalWords : word
  }
  /** Total pacing weight — what "words per minute" actually divides into. */
  get totalWeight(): number {
    return this.cumWeights.length > 0 ? this.cumWeights[this.cumWeights.length - 1] : 0
  }
  /** Pacing weight of all tokens BEFORE `wordIndex` — the read portion. */
  weightBefore(wordIndex: number): number {
    if (this.cumWeights.length === 0 || wordIndex <= 0) return 0
    return this.cumWeights[Math.min(wordIndex, this.cumWeights.length) - 1]
  }

  /**
   * Cursor position after `weight` words' worth of pacing — the count of
   * tokens fully covered by that weight. Inverse of weightBefore, used by
   * the WPM driver to convert elapsed time into a cursor. For all-Latin
   * scripts every weight is 1, so this is exactly `min(floor(weight), n)`
   * plus exact-integer boundaries — identical to the old token arithmetic.
   */
  wordForWeight(weight: number): number {
    const n = this.cumWeights.length
    if (n === 0 || weight <= 0) return 0
    if (weight >= this.cumWeights[n - 1]) return n
    // First index with cumWeights[i] > weight.
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.cumWeights[mid] > weight) hi = mid
      else lo = mid + 1
    }
    return lo
  }

  /** Convert a 0–100 scrub fraction to a word cursor. */
  wordForPercent(percent: number): number {
    if (this.totalWords === 0) return 0
    const p = Math.max(0, Math.min(100, percent)) / 100
    return this.wordForWeight(Math.round(p * this.totalWeight))
  }

  /** Read progress (0–100) for a cursor. */
  progressForWord(wordIndex: number): number {
    if (this.totalWeight === 0) return 0
    return Math.max(0, Math.min(100, Math.round((this.weightBefore(wordIndex) / this.totalWeight) * 100)))
  }

  // ── Voice following ────────────────────────────────────────────────────────

  /**
   * Anchor recently-spoken words against the upcoming script and return the
   * new cursor. Forward-only by default: speech never scrolls the prompter
   * backwards.
   *
   * `probe` is the tail of what the speaker just said (already normalized).
   * We look for the position whose preceding words best match the probe's
   * tail, within a forward window of the current cursor.
   *
   * `allowBackward` is for stall recovery only: when the timed fallback
   * drifted the cursor ahead of the speaker, a fresh transcript must be able
   * to pull the cursor back to the spoken position. Backward moves require
   * at least a two-word run — a lone word behind the cursor is too weak to
   * trust — and the whole script is searched, since drift is unbounded.
   */
  matchSpoken(probe: string[], cursor: number, allowBackward = false): number {
    if (probe.length === 0 || this.totalWords === 0) return cursor

    const AHEAD = 60 // how far ahead we'll let a jump land (skipped a paragraph)
    const BACK = 4 // tolerate a touch of backward drift from interim noise
    const MAX_RUN = 6 // cap the backward-match run we score

    const start = allowBackward ? 0 : Math.max(0, cursor - BACK)
    const end = Math.min(this.totalWords, cursor + AHEAD)

    let bestPos = -1
    let bestScore = 0
    for (let i = start; i < end; i++) {
      let score = 0
      let pi = probe.length - 1
      let si = i
      while (pi >= 0 && si >= 0 && probe[pi] === this.wordNorms[si]) {
        score++
        pi--
        si--
        if (score >= MAX_RUN) break
      }
      if (score > bestScore) {
        bestScore = score
        bestPos = i
      } else if (score === bestScore && score > 0 && bestPos >= 0) {
        // Tie: prefer the match nearest the current cursor so a repeated phrase
        // later in the script doesn't yank us forward.
        if (Math.abs(i - cursor) < Math.abs(bestPos - cursor)) bestPos = i
      }
    }

    if (bestPos < 0) return cursor
    const needed = probe.length === 1 ? 1 : 2
    if (bestScore < needed) return cursor

    const candidate = bestPos + 1
    if (candidate <= cursor) {
      // Backward re-anchor (recovery only): a two-word run is decent evidence
      // the speaker is behind the drifted cursor; a single word is not.
      if (allowBackward && bestScore >= 2) return candidate
      return cursor
    }
    // A lone single-word match is weak evidence — only honor it close to home.
    if (bestScore === 1 && candidate > cursor + 8) return cursor
    return Math.min(candidate, this.totalWords)
  }
}
