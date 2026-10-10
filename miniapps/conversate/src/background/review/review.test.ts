/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import type {TranscriptFinal} from "../../shared/types"
import type {SessionLlm} from "../host"
import {chunkTranscript, generateReview, MAP_CHUNK_TOKENS, renderReviewMarkdown} from "./review"
import {estimateTokens} from "../cues/prompt"

function finals(n: number, wordsEach: number): TranscriptFinal[] {
  return Array.from({length: n}, (_, i) => ({
    t: i * 1000,
    text: Array(wordsEach).fill(`w${i}`).join(" "),
  }))
}

function fakeLlm(handler: (prompt: string) => unknown): SessionLlm {
  return {
    availability: () => Promise.resolve({available: true, contextSize: 4096}),
    generate: (req) => Promise.resolve({json: handler(req.prompt), elapsedMs: 10}),
    cancel: () => Promise.resolve(),
  }
}

describe("chunkTranscript", () => {
  test("chunks fit the map budget and keep order", () => {
    const fs = finals(200, 40) // ~2000 tokens each → several chunks
    const chunks = chunkTranscript(fs)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      const tokens = chunk.reduce((a, f) => a + estimateTokens(f.text), 0)
      expect(tokens).toBeLessThanOrEqual(MAP_CHUNK_TOKENS + estimateTokens(fs[0].text))
    }
    expect(chunks.flat()).toHaveLength(fs.length)
    expect(chunks[0][0]).toBe(fs[0])
  })
})

describe("generateReview", () => {
  test("map-reduce produces a structured review", async () => {
    const llm = fakeLlm((prompt) =>
      prompt.includes("TRANSCRIPT EXCERPT")
        ? {facts: ["fact one"], actionItems: ["do thing"]}
        : {title: "Roadmap Review", overview: "They planned.", highlights: ["h1"], details: ["d1"], nextSteps: ["n1"]},
    )
    const res = await generateReview({
      summarySegments: [],
      unsummarizedFinals: finals(10, 10),
      allFinals: finals(10, 10),
      cues: [],
      startedAt: 0,
      llm,
      run: (req) => llm.generate(req),
    })
    expect(res.aiGenerated).toBe(true)
    expect(res.summary.title).toBe("Roadmap Review")
    expect(res.summary.nextSteps).toContain("n1")
  })

  test("running-summary segments are reused as map output (no re-chunk)", async () => {
    const prompts: string[] = []
    const llm = fakeLlm((prompt) => {
      prompts.push(prompt)
      return prompt.includes("TRANSCRIPT EXCERPT")
        ? {facts: ["tail fact"], actionItems: []}
        : {title: "T", overview: "o", highlights: [], details: [], nextSteps: []}
    })
    const res = await generateReview({
      summarySegments: ["Earlier: budget approved."],
      unsummarizedFinals: finals(3, 5),
      allFinals: finals(30, 5),
      cues: [],
      startedAt: 0,
      llm,
      run: (req) => llm.generate(req),
    })
    expect(res.aiGenerated).toBe(true)
    // The reduce prompt carries the segment; only the tail was mapped.
    const reducePrompt = prompts.find((p) => p.includes("CHUNK SUMMARIES"))!
    expect(reducePrompt).toContain("budget approved")
    expect(reducePrompt).toContain("tail fact")
  })

  test("no LLM → transcript-only fallback, visibly marked", async () => {
    const res = await generateReview({
      summarySegments: [],
      unsummarizedFinals: [],
      allFinals: finals(5, 5),
      cues: [],
      startedAt: 0,
      llm: null,
      run: () => Promise.reject(new Error("should not be called")),
    })
    expect(res.aiGenerated).toBe(false)
    expect(res.note).toContain("unavailable")
  })

  test("guardrail rejection → declined-by-safety-filter label, not 'AI unavailable'", async () => {
    const llm: SessionLlm = {
      availability: () => Promise.resolve({available: true, contextSize: 4096}),
      generate: () => Promise.reject({code: "LLM_GUARDRAIL"}),
      cancel: () => Promise.resolve(),
    }
    const res = await generateReview({
      summarySegments: [],
      unsummarizedFinals: finals(4, 5),
      allFinals: finals(4, 5),
      cues: [{id: "c1", kind: "answer", title: "Taipei weather", body: "b", t: 1}],
      startedAt: Date.UTC(2026, 8, 23, 2, 14),
      llm,
      run: (req) => llm.generate(req),
    })
    expect(res.aiGenerated).toBe(false)
    expect(res.label).toBe("summary declined by the on-device safety filter")
    expect(res.note).toContain("safety filter")
    // Title falls back to the first cue, never a transcript fragment.
    expect(res.summary.title).toBe("Taipei weather")
  })

  test("LLM_UNAVAILABLE carries its reason; CONTEXT_EXCEEDED says so", async () => {
    const failing = (err: unknown): SessionLlm => ({
      availability: () => Promise.resolve({available: true, contextSize: 4096}),
      generate: () => Promise.reject(err),
      cancel: () => Promise.resolve(),
    })
    const unavail = await generateReview({
      summarySegments: [],
      unsummarizedFinals: finals(2, 5),
      allFinals: finals(2, 5),
      cues: [],
      startedAt: 0,
      llm: failing({code: "LLM_UNAVAILABLE", reason: "model-not-ready"}),
      run: (req) => failing({code: "LLM_UNAVAILABLE", reason: "model-not-ready"}).generate(req),
    })
    expect(unavail.label).toContain("model-not-ready")

    const ctx = await generateReview({
      summarySegments: [],
      unsummarizedFinals: finals(2, 5),
      allFinals: finals(2, 5),
      cues: [],
      startedAt: 0,
      llm: failing({code: "LLM_CONTEXT_EXCEEDED"}),
      run: (req) => failing({code: "LLM_CONTEXT_EXCEEDED"}).generate(req),
    })
    expect(ctx.label).toContain("context window")
    // No cues → dated placeholder title.
    expect(ctx.summary.title).toMatch(/^Conversation · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe("renderReviewMarkdown", () => {
  test("renders Summary, Cue List, Transcription", () => {
    const md = renderReviewMarkdown({
      title: "T",
      startedAt: Date.UTC(2026, 8, 22, 10, 30),
      summary: {title: "My Review", overview: " ov ", highlights: ["h"], details: ["d"], nextSteps: ["n"]},
      cues: [{id: "c1", kind: "answer", title: "Q", body: "A", t: Date.UTC(2026, 8, 22, 10, 31)}],
      finals: [{t: Date.UTC(2026, 8, 22, 10, 30), text: "hello", translation: "你好"}],
      aiGenerated: true,
      guardrailSkips: 2,
    })
    expect(md).toContain("# My Review")
    expect(md).toContain("## Summary")
    expect(md).toContain("## Cue List")
    expect(md).toContain("ANSWER · Q")
    expect(md).toContain("## Transcription")
    expect(md).toContain("→ 你好")
    expect(md).toContain("2 cues skipped by on-device safety")
    expect(md).toContain("on-device")
  })

  test("marks AI-unavailable reviews", () => {
    const md = renderReviewMarkdown({
      title: "T",
      startedAt: 0,
      summary: {title: "T", overview: "", highlights: [], details: [], nextSteps: []},
      cues: [],
      finals: [],
      aiGenerated: false,
    })
    expect(md).toContain("AI unavailable")
  })
})