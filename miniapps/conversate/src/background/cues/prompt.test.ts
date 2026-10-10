/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import type {TranscriptFinal} from "../../shared/types"
import {
  buildCuePrompt,
  decideCueLanguage,
  estimateTokens,
  parseCues,
  sanitizeCueText,
  tailByTokens,
  TOKEN_BUDGET,
  trimFinalsToBudget,
} from "./prompt"
import {dedupeCues} from "./dedupe"
import {chunkPrepNote, clampPrepNote, extractKeywords, retrievePrepNote, PREP_NOTE_MAX_CHARS} from "./prepnote"

function finals(n: number, wordsEach: number, cjk = false): TranscriptFinal[] {
  const word = cjk ? "字" : "word"
  return Array.from({length: n}, (_, i) => ({
    t: i,
    text: cjk ? word.repeat(wordsEach) : Array(wordsEach).fill(`${word}${i}`).join(" "),
  }))
}

describe("token estimation", () => {
  test("Latin ≈ chars/4, CJK ≈ chars/1.5", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100)
    expect(estimateTokens("字".repeat(150))).toBe(100)
  })
})

describe("prompt budget", () => {
  test("long English transcript stays within the 4096 budget", () => {
    // ~20k words of transcript — far beyond the window.
    const prompt = buildCuePrompt({
      finals: finals(400, 60),
      runningSummary: "Earlier they discussed the roadmap and hiring plan.",
      prepNoteExcerpt: "Meridian proposal; budget review; hiring freeze.",
      recentCueTitles: ["Roadmap", "Hiring plan"],
      cueLanguage: "en",
    })
    expect(prompt.estimatedTokens).toBeLessThanOrEqual(
      TOKEN_BUDGET.instructions + TOKEN_BUDGET.prepNote + TOKEN_BUDGET.runningSummary + TOKEN_BUDGET.transcript + TOKEN_BUDGET.cueHistory + 50,
    )
    expect(prompt.estimatedTokens).toBeLessThan(4096)
    expect(prompt.maxTokens).toBe(TOKEN_BUDGET.output)
  })

  test("long CJK transcript stays within the 4096 budget", () => {
    const prompt = buildCuePrompt({
      finals: finals(300, 200, true),
      runningSummary: "先前討論了路線圖與招聘計畫。",
      prepNoteExcerpt: "子午線提案；預算審查；招聘凍結。",
      recentCueTitles: ["路線圖"],
      cueLanguage: "zh-Hant-TW",
    })
    expect(prompt.estimatedTokens).toBeLessThan(4096)
  })

  test("trimFinalsToBudget keeps the newest finals", () => {
    const fs = finals(10, 100)
    const kept = trimFinalsToBudget(fs, 500)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept[kept.length - 1]).toBe(fs[9])
    expect(kept[0].t).toBeGreaterThan(0)
  })

  test("tailByTokens truncates from the front", () => {
    const tail = tailByTokens("x".repeat(4000), 100)
    expect(estimateTokens(tail)).toBeLessThanOrEqual(110)
    expect(tail.startsWith("…")).toBe(true)
  })
})

describe("cue parsing + de-dup", () => {
  const valid = {
    cues: [
      {kind: "answer", title: "Capital of France", body: "Paris — about 2.1M people in the city proper."},
      {kind: "concept", title: "Semantic search", body: "Retrieval by meaning via embeddings, not keywords."},
      {kind: "bogus", title: "Bad", body: "dropped"},
    ],
  }

  test("parses guided JSON, drops invalid entries, caps at 2", () => {
    const cues = parseCues({json: valid}, 1000)
    expect(cues).toHaveLength(2)
    expect(cues[0].kind).toBe("answer")
    expect(cues[1].kind).toBe("concept")
  })

  test("parses JSON carried in text", () => {
    const cues = parseCues({text: JSON.stringify(valid)}, 1000)
    expect(cues).toHaveLength(2)
  })

  test("empty cue list is valid (silence beats noise)", () => {
    expect(parseCues({json: {cues: []}}, 1000)).toHaveLength(0)
    expect(parseCues({text: "not json"}, 1000)).toHaveLength(0)
  })

  test("dedupe by normalized title", () => {
    const existing = parseCues({json: valid}, 1000)
    const dup = parseCues(
      {json: {cues: [{kind: "answer", title: "capital of france!", body: "Paris again."}]}},
      2000,
    )
    expect(dedupeCues(dup, existing)).toHaveLength(0)
    const fresh = parseCues(
      {json: {cues: [{kind: "bio", title: "Ada Lovelace", body: "First programmer."}]}},
      2000,
    )
    expect(dedupeCues(fresh, existing)).toHaveLength(1)
  })
})

describe("sanitizeCueText", () => {
  test("cuts the observed on-device markup/JSON leak", () => {
    // Real first-run pollution: `裝置上翻譯優先處理部分結果。」} }​> <\/div><div class=`
    const dirty = "裝置上翻譯優先處理部分結果。」} }\u200B> <\\/div><div class="
    expect(sanitizeCueText(dirty)).toBe("裝置上翻譯優先處理部分結果。")
  })

  test("clean en/zh cues pass through unchanged", () => {
    expect(sanitizeCueText("Paris is the capital of France.")).toBe("Paris is the capital of France.")
    expect(sanitizeCueText("量子糾纏是一種關聯。")).toBe("量子糾纏是一種關聯。")
  })

  test("markup-only input sanitizes to empty (cue is dropped)", () => {
    expect(sanitizeCueText("<div class=\"x\">")).toBe("")
    expect(sanitizeCueText("{\"cues\":[]}")).toBe("")
    expect(parseCues({json: {cues: [{kind: "answer", title: "T", body: "<div>"}]}}, 1)).toHaveLength(0)
  })

  test("balanced 「…」 is kept; orphan 」 is stripped", () => {
    expect(sanitizeCueText("所謂「群體智慧」就是這個。")).toBe("所謂「群體智慧」就是這個。")
    expect(sanitizeCueText("就是這個」")).toBe("就是這個")
  })

  test("zero-width chars and stray escapes are removed", () => {
    expect(sanitizeCueText("hello\u200Bworld")).toBe("helloworld")
    expect(sanitizeCueText("trailing\\nmore")).toBe("trailing")
  })

  test("caps at maxChars", () => {
    expect(sanitizeCueText("x".repeat(300), 100)).toHaveLength(100)
  })
})

describe("cue language decision", () => {
  const supported = ["en", "zh-Hant-TW", "zh-Hant-HK", "zh-Hans-CN", "ja", "fr"]

  test("zh-TW conversation matches a Hant tag, never Hans", () => {
    expect(decideCueLanguage("zh-TW", supported).tag).toBe("zh-Hant-TW")
    expect(decideCueLanguage("zh-Hant", supported).tag).toMatch(/Hant/)
    expect(decideCueLanguage("zh-CN", supported).tag).toBe("zh-Hans-CN")
  })

  test("unsupported language falls back to English with a note", () => {
    const d = decideCueLanguage("ko", supported)
    expect(d.tag).toBe("en")
    expect(d.languageNote).toContain("English")
  })

  test("empty supported list attempts the requested language", () => {
    expect(decideCueLanguage("de", []).tag).toBe("de")
    expect(decideCueLanguage("de", undefined).tag).toBe("de")
  })
})

describe("prep note", () => {
  test("clamps to 5,000 chars", () => {
    expect(clampPrepNote("x".repeat(6000))).toHaveLength(PREP_NOTE_MAX_CHARS)
  })

  test("extracts Latin + CJK keywords", () => {
    const kw = extractKeywords("Discuss the Meridian proposal and 量子計算 roadmap")
    expect(kw).toContain("meridian")
    expect(kw).toContain("proposal")
    expect(kw.some((k) => k.includes("量子"))).toBe(true)
  })

  test("chunks to ~300 chars", () => {
    const chunks = chunkPrepNote("para one. ".repeat(100))
    expect(chunks.length).toBeGreaterThan(2)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(310)
  })

  test("retrieval returns only overlapping chunks within budget", () => {
    const note =
      "Meridian proposal details: budget 2M, timeline Q3, owner Ada.\n" +
      "Unrelated cooking recipe: flour, water, salt, yeast.\n" +
      "More Meridian notes: the board wants a pilot in Taipei."
    const excerpt = retrievePrepNote(note, "let's review the meridian pilot", 900)
    expect(excerpt).toContain("Meridian")
    expect(excerpt).not.toContain("cooking recipe")
    expect(estimateTokens(excerpt)).toBeLessThanOrEqual(900)
  })

  test("no overlap → empty excerpt (note earns budget only when relevant)", () => {
    expect(retrievePrepNote("cooking recipe only", "quantum computing discussion", 900)).toBe("")
  })
})