import {describe, expect, test} from "bun:test"

import {normalizeWord, normalizeWords, ScriptEngine} from "./ScriptEngine"

describe("normalizeWords tokenization", () => {
  test("Latin text tokenizes exactly as before — whitespace words only", () => {
    expect(normalizeWords("Welcome to your teleprompter.")).toEqual(["welcome", "to", "your", "teleprompter"])
    expect(normalizeWords("  Hello,   WORLD!  ")).toEqual(["hello", "world"])
    expect(normalizeWords("don't stop")).toEqual(["dont", "stop"])
  })

  test("CJK text tokenizes per character", () => {
    expect(normalizeWords("我們今天")).toEqual(["我", "们", "今", "天"])
    expect(normalizeWords("你好 world")).toEqual(["你", "好", "world"])
  })

  test("Korean stays word-tokenized (non-CJK unaffected)", () => {
    expect(normalizeWords("안녕하세요 세계")).toEqual(["안녕하세요", "세계"])
  })
})

describe("Hant→Hans fold (comparison path only)", () => {
  test("Traditional folds to Simplified in normalized tokens", () => {
    expect(normalizeWord("繁體")).toBe("繁体")
    expect(normalizeWords("我們今天要討論三個主題")).toEqual([
      "我",
      "们",
      "今",
      "天",
      "要",
      "讨",
      "论",
      "三",
      "个",
      "主",
      "题",
    ])
  })

  test("Simplified and already-folded text pass through unchanged", () => {
    expect(normalizeWords("我们今天")).toEqual(["我", "们", "今", "天"])
    expect(normalizeWord("hello")).toBe("hello")
  })
})

describe("voice anchoring across scripts", () => {
  test("Simplified speech advances the cursor on a Traditional script", () => {
    const engine = new ScriptEngine({numberOfLines: 4})
    engine.setScript("我們今天要討論三個主題")
    expect(engine.totalWords).toBe(11)
    const next = engine.matchSpoken(normalizeWords("我们今天要讨论三个主题"), 0)
    expect(next).toBe(11)
    // Display text keeps the user's original Traditional text.
    expect(engine.textFrom(0)).toContain("討論")
    expect(engine.textFrom(0)).not.toContain("讨论")
  })

  test("partial Simplified speech advances partway, not to the end", () => {
    const engine = new ScriptEngine({numberOfLines: 4})
    engine.setScript("我們今天要討論三個主題")
    const next = engine.matchSpoken(normalizeWords("我们今天要"), 0)
    expect(next).toBe(5)
  })

  test("allowBackward re-anchors behind a drifted cursor on a two-word run", () => {
    const engine = new ScriptEngine({numberOfLines: 4})
    engine.setScript("one two three four five six seven eight nine ten")
    // Timed fallback drifted the cursor to word 8; the speaker is actually at
    // "three four". Default matching never moves backwards…
    expect(engine.matchSpoken(["three", "four"], 8)).toBe(8)
    // …but recovery mode pulls the cursor back to just past the spoken run.
    expect(engine.matchSpoken(["three", "four"], 8, true)).toBe(4)
  })

  test("allowBackward still refuses a lone-word backward match", () => {
    const engine = new ScriptEngine({numberOfLines: 4})
    engine.setScript("one two three four five six seven eight nine ten")
    // A single word far behind the cursor is too weak to trust even in
    // recovery — the cursor stays put rather than jumping on noise.
    expect(engine.matchSpoken(["three"], 8, true)).toBe(8)
  })
})

describe("pacing weights", () => {
  test("Latin scripts keep word-per-token pacing — identical to before", () => {
    const engine = new ScriptEngine({numberOfLines: 4})
    engine.setScript("one two three four five six")
    expect(engine.totalWeight).toBe(6)
    expect(engine.wordForWeight(3)).toBe(3)
    expect(engine.weightBefore(4)).toBe(4)
    expect(engine.wordForPercent(50)).toBe(3)
    expect(engine.progressForWord(3)).toBe(50)
  })

  test("CJK characters pace at half a word each", () => {
    const engine = new ScriptEngine({numberOfLines: 4})
    engine.setScript("我們今天要討論三個主題") // 11 chars → 5.5 weight
    expect(engine.totalWeight).toBe(5.5)
    // At 130 wpm the same dial now yields ~260 chars/min, not ~130.
    expect(engine.wordForWeight(2.5)).toBe(5)
  })
})
