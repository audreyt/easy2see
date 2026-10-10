/**
 * glasses.ts — the 576×288 G2 lens renderer (design §4).
 *
 * Modes:
 *   - auto pop-up ON : a new cue renders immediately as `KIND · title` + body,
 *                      auto-dismissed after the cue duration (default 8 s).
 *   - auto pop-up OFF: only `● N new cue` shows; single_tap expands the latest.
 *   - live line      : optional bottom line with the last transcript final
 *                      (or its translation when translation is on).
 *   - swipe_up/down  : page through the session's cues (pinned — no dismiss).
 *   - double_tap     : ends the session (handled by the controller, which
 *                      subscribes onTouch and calls display gestures here).
 *
 * Rendering is replace-the-frame via session.display.render; text is
 * pre-wrapped here because the lens is monospace-ish and the host clips.
 */

import type {Cue, TranscriptFinal} from "../../shared/types"

export interface GlassesRenderElement {
  type: "text"
  id?: string
  box: {x: number; y: number; w: number; h: number}
  text: string
  style?: {overflow?: "clip" | "ellipsis"; breakMode?: "word" | "character"}
}

export type GlassesRender = (elements: GlassesRenderElement[]) => void

export interface GlassesDisplayOptions {
  width?: number
  height?: number
  /** Cue auto-dismiss ms. Default 8000. */
  cueDurationMs?: number
  /** Show the live transcript line. */
  liveLine?: boolean
  /** Auto pop-up new cues. */
  autoPopup?: boolean
  now?: () => number
  defer?: (fn: () => void, ms: number) => void
}

const KIND_LABEL: Record<Cue["kind"], string> = {
  concept: "CONCEPT",
  bio: "BIO",
  answer: "ANSWER",
  suggestion: "SUGGESTION",
}

/** CJK glyphs are ~2x a Latin cell on the lens. */
function cellWidth(ch: string): number {
  return /[㐀-鿿豈-﫿぀-ヿ가-힯　-〿＀-￯]/.test(ch) ? 2 : 1
}

/** Wrap text to `cells` display cells; returns at most `maxLines` lines. */
export function wrapLensText(text: string, cells: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  const lines: string[] = []
  let cur = ""
  let curW = 0
  const pushWord = (w: string) => {
    const wW = [...w].reduce((a, c) => a + cellWidth(c), 0)
    const gap = cur ? 1 : 0
    if (curW + gap + wW <= cells) {
      cur = cur ? cur + " " + w : w
      curW += gap + wW
      return true
    }
    return false
  }
  let dropped = false
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (pushWord(word)) continue
    if (cur) {
      lines.push(cur)
      cur = ""
      curW = 0
      if (lines.length >= maxLines) {
        dropped = true
        break
      }
    }
    // Word longer than a line: hard-split by cells (CJK or URLs).
    let rest = word
    while ([...rest].reduce((a, c) => a + cellWidth(c), 0) > cells && lines.length < maxLines) {
      let take = 0
      let w = 0
      for (const ch of rest) {
        if (w + cellWidth(ch) > cells) break
        w += cellWidth(ch)
        take += ch.length
      }
      lines.push(rest.slice(0, take))
      rest = rest.slice(take)
    }
    if (lines.length >= maxLines) {
      dropped = true
      break
    }
    cur = rest
    curW = [...rest].reduce((a, c) => a + cellWidth(c), 0)
  }
  if (lines.length < maxLines && cur) lines.push(cur)
  // Ellipsize the last line when content was dropped.
  if (dropped && lines.length > 0) {
    const last = lines[lines.length - 1]
    lines[lines.length - 1] = last.length > 1 ? last.slice(0, -1) + "…" : last + "…"
  }
  return lines
}

export class GlassesDisplay {
  private readonly width: number
  private readonly height: number
  private readonly now: () => number
  private readonly defer: (fn: () => void, ms: number) => void

  private cues: Cue[] = []
  private pageIndex = -1 // -1 = "latest"
  private pendingCount = 0
  private cueVisible = false
  private pinned = false
  private liveText = ""
  private dismissArmed = false

  autoPopup: boolean
  liveLine: boolean
  cueDurationMs: number

  constructor(
    private readonly render: GlassesRender,
    options: GlassesDisplayOptions = {},
  ) {
    this.width = options.width ?? 576
    this.height = options.height ?? 288
    this.now = options.now ?? Date.now
    this.defer = options.defer ?? ((fn, ms) => setTimeout(fn, ms))
    this.autoPopup = options.autoPopup ?? true
    this.liveLine = options.liveLine ?? false
    this.cueDurationMs = options.cueDurationMs ?? 8_000
  }

  /** Approximate monospace cells per line on the lens (~8px cell at 576px). */
  private get cellsPerLine(): number {
    return Math.floor(this.width / 8.5)
  }

  private get bodyLines(): number {
    // Title takes one line; live line takes one; ~5 lines total on 288px.
    return this.liveLine ? 3 : 4
  }

  /** A new cue arrived from the LLM. */
  addCue(cue: Cue): void {
    this.cues.push(cue)
    if (this.autoPopup) {
      this.pageIndex = this.cues.length - 1
      this.showCue()
    } else {
      this.pendingCount += 1
      this.renderFrame()
    }
  }

  /** Update the live transcript line (last final or its translation). */
  setLiveLine(final: TranscriptFinal | null): void {
    this.liveText = final ? (final.translation ?? final.text) : ""
    if (!this.cueVisible) this.renderFrame()
  }

  /** single_tap: expand the newest pending cue, or re-show the last cue. */
  tap(): void {
    if (this.pendingCount > 0 || this.cues.length > 0) {
      this.pendingCount = 0
      this.pageIndex = this.cues.length - 1
      this.showCue()
    }
  }

  /** swipe_up: page to an older cue (pinned). */
  pageBack(): void {
    if (this.cues.length === 0) return
    const idx = this.pageIndex < 0 ? this.cues.length - 1 : this.pageIndex
    this.pageIndex = Math.max(0, idx - 1)
    this.pin()
  }

  /** swipe_down: page to a newer cue (pinned). */
  pageForward(): void {
    if (this.cues.length === 0) return
    const idx = this.pageIndex < 0 ? this.cues.length - 1 : this.pageIndex
    this.pageIndex = Math.min(this.cues.length - 1, idx + 1)
    this.pin()
  }

  /** Clear the lens (session end / pause). */
  clear(): void {
    this.cueVisible = false
    this.pinned = false
    this.pendingCount = 0
    this.render([])
  }

  /** Number of cues held (for tests/snapshots). */
  get cueCount(): number {
    return this.cues.length
  }

  // ── internals ──────────────────────────────────────────────────────────

  private pin(): void {
    this.pinned = true
    this.cueVisible = true
    this.renderFrame()
  }

  private showCue(): void {
    this.cueVisible = true
    this.pinned = false
    this.renderFrame()
    if (!this.dismissArmed) {
      this.dismissArmed = true
      this.defer(() => {
        this.dismissArmed = false
        if (this.cueVisible && !this.pinned) {
          this.cueVisible = false
          this.renderFrame()
        }
      }, this.cueDurationMs)
    }
  }

  private renderFrame(): void {
    const els: GlassesRenderElement[] = []
    const cells = this.cellsPerLine

    if (this.cueVisible && this.cues.length > 0) {
      const idx = this.pageIndex < 0 ? this.cues.length - 1 : this.pageIndex
      const cue = this.cues[idx]
      const header =
        `${KIND_LABEL[cue.kind]} · ${cue.title}` +
        (this.pinned && this.cues.length > 1 ? `  (${idx + 1}/${this.cues.length})` : "") +
        (cue.languageNote ? "  ⓘ" : "")
      const titleLines = wrapLensText(header, cells, 1)
      const bodyLines = wrapLensText(cue.body, cells, this.bodyLines)
      const text = [...titleLines, ...bodyLines]
      els.push({
        type: "text",
        id: "conversate-cue",
        box: {x: 8, y: 8, w: this.width - 16, h: this.height - (this.liveLine ? 48 : 16)},
        text: text.join("\n"),
        style: {overflow: "ellipsis", breakMode: "word"},
      })
      if (cue.languageNote) {
        els.push({
          type: "text",
          id: "conversate-cue-lang",
          box: {x: 8, y: this.height - (this.liveLine ? 72 : 40), w: this.width - 16, h: 24},
          text: wrapLensText(cue.languageNote, cells, 1).join(""),
          style: {overflow: "ellipsis"},
        })
      }
    } else if (this.pendingCount > 0) {
      els.push({
        type: "text",
        id: "conversate-pending",
        box: {x: 8, y: 8, w: this.width - 16, h: 40},
        text: `● ${this.pendingCount} new cue${this.pendingCount > 1 ? "s" : ""}`,
      })
    }

    if (this.liveLine && this.liveText) {
      els.push({
        type: "text",
        id: "conversate-live",
        box: {x: 8, y: this.height - 32, w: this.width - 16, h: 28},
        text: wrapLensText(this.liveText, cells, 1).join(""),
        style: {overflow: "ellipsis"},
      })
    }

    this.render(els)
  }
}
