/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import type {Cue} from "../../shared/types"
import {GlassesDisplay, wrapLensText, type GlassesRenderElement} from "./glasses"

function makeClock(start = 0) {
  let now = start
  const deferred: Array<{at: number; fn: () => void}> = []
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
      deferred.sort((a, b) => a.at - b.at)
      while (deferred.length > 0 && deferred[0].at <= now) deferred.shift()!.fn()
    },
    defer: (fn: () => void, ms: number) => deferred.push({at: now + ms, fn}),
  }
}

function cue(title: string, kind: Cue["kind"] = "concept", languageNote?: string): Cue {
  return {id: `c-${title}`, kind, title, body: `Body for ${title}.`, t: 1, ...(languageNote ? {languageNote} : {})}
}

function makeDisplay(opts: Record<string, unknown> = {}) {
  const clock = makeClock()
  const frames: GlassesRenderElement[][] = []
  const display = new GlassesDisplay((els) => frames.push(els), {
    now: clock.now,
    defer: clock.defer,
    ...opts,
  })
  return {display, frames, clock}
}

const lastFrame = (frames: GlassesRenderElement[][]) => frames[frames.length - 1]
const frameText = (els: GlassesRenderElement[]) => els.map((e) => e.text).join("\n")

describe("wrapLensText", () => {
  test("wraps to the cell budget and caps lines", () => {
    const lines = wrapLensText("one two three four five six seven eight nine ten", 10, 3)
    expect(lines.length).toBeLessThanOrEqual(3)
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(10)
  })

  test("CJK counts double-width", () => {
    const lines = wrapLensText("繁體中文顯示測試", 6, 2)
    expect(lines.length).toBeLessThanOrEqual(2)
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(3)
  })
})

describe("auto pop-up mode", () => {
  test("new cue renders KIND · title + body immediately", () => {
    const {display, frames} = makeDisplay({autoPopup: true})
    display.addCue(cue("Semantic Search"))
    const text = frameText(lastFrame(frames))
    expect(text).toContain("CONCEPT · Semantic Search")
    expect(text).toContain("Body for Semantic Search.")
  })

  test("cue auto-dismisses after the cue duration", () => {
    const {display, frames, clock} = makeDisplay({autoPopup: true, cueDurationMs: 8_000})
    display.addCue(cue("Roadmap"))
    clock.advance(8_001)
    const text = frameText(lastFrame(frames))
    expect(text).not.toContain("Roadmap")
  })

  test("language note renders under the cue", () => {
    const {display, frames} = makeDisplay({autoPopup: true})
    display.addCue(cue("개념", "concept", "shown in English — on-device AI cannot write ko"))
    const text = frameText(lastFrame(frames))
    expect(text).toContain("shown in English")
  })
})

describe("manual mode (auto pop-up off)", () => {
  test("new cue shows only ● N new cue until tapped", () => {
    const {display, frames} = makeDisplay({autoPopup: false})
    display.addCue(cue("Hidden Cue"))
    const text = frameText(lastFrame(frames))
    expect(text).toContain("● 1 new cue")
    expect(text).not.toContain("Hidden Cue")
    display.addCue(cue("Second Cue"))
    expect(frameText(lastFrame(frames))).toContain("● 2 new cues")
  })

  test("single_tap expands the newest cue", () => {
    const {display, frames} = makeDisplay({autoPopup: false})
    display.addCue(cue("Hidden Cue"))
    display.tap()
    const text = frameText(lastFrame(frames))
    expect(text).toContain("CONCEPT · Hidden Cue")
  })
})

describe("live transcript line", () => {
  test("live line shows the last final, or its translation", () => {
    const {display, frames} = makeDisplay({liveLine: true})
    display.setLiveLine({t: 1, text: "你好嗎", translation: "How are you"})
    expect(frameText(lastFrame(frames))).toContain("How are you")
    display.setLiveLine({t: 2, text: "plain english"})
    expect(frameText(lastFrame(frames))).toContain("plain english")
  })

  test("live line stays under a visible cue", () => {
    const {display, frames} = makeDisplay({autoPopup: true, liveLine: true})
    display.setLiveLine({t: 1, text: "live words"})
    display.addCue(cue("Cue Title"))
    const text = frameText(lastFrame(frames))
    expect(text).toContain("Cue Title")
    expect(text).toContain("live words")
  })
})

describe("swipe paging", () => {
  test("swipe pages through cues with an index marker", () => {
    const {display, frames} = makeDisplay({autoPopup: true})
    display.addCue(cue("First"))
    display.addCue(cue("Second"))
    display.pageBack()
    const text = frameText(lastFrame(frames))
    expect(text).toContain("First")
    expect(text).toContain("(1/2)")
    display.pageForward()
    expect(frameText(lastFrame(frames))).toContain("Second")
  })

  test("paging pins the cue — no auto-dismiss", () => {
    const {display, frames, clock} = makeDisplay({autoPopup: true, cueDurationMs: 5_000})
    display.addCue(cue("Pinned"))
    display.pageBack()
    clock.advance(10_000)
    expect(frameText(lastFrame(frames))).toContain("Pinned")
  })
})

describe("clear", () => {
  test("clear empties the lens", () => {
    const {display, frames} = makeDisplay({autoPopup: true})
    display.addCue(cue("Gone"))
    display.clear()
    expect(lastFrame(frames)).toHaveLength(0)
  })
})