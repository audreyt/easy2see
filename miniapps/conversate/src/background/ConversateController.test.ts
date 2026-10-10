/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import type {SessionLlm} from "./host"
import {ConversateController} from "./ConversateController"

/** Mock session capturing ui sends, renders, and the transcription handler. */
function makeSession(llm: SessionLlm | null) {
  const uiSends: Array<{channel: string; payload: unknown}> = []
  const uiHandlers: Record<string, (p: never) => void> = {}
  const storage = new Map<string, string>()
  let transcriptionHandler: ((d: unknown) => void) | undefined
  const renders: Array<Array<{text?: string}>> = []
  const session = {
    ui: {
      send: (channel: string, payload: unknown) => uiSends.push({channel, payload}),
      on: (channel: string, cb: (p: never) => void) => {
        uiHandlers[channel] = cb
        return () => {}
      },
      onOpen: () => () => {},
      handle: () => () => {},
    },
    storage: {
      get: (k: string) => Promise.resolve(storage.get(k) ?? null),
      set: (k: string, v: string) => {
        storage.set(k, v)
        return Promise.resolve()
      },
    },
    transcription: {
      forLanguage: (_lang: string, h: (d: unknown) => void) => {
        transcriptionHandler = h
        return () => {}
      },
    },
    translation: {to: () => () => {}},
    display: {
      render: (els: Array<{text?: string}>) => {
        renders.push(els)
        return Promise.resolve({status: "displayed"})
      },
    },
    input: {onTouch: () => () => {}},
    events: {subscribe: () => () => {}},
    actions: {handle: () => () => {}},
    mic: {hasPermission: true},
    blob: {
      set: () => Promise.resolve({key: "blob-1"}),
      importFile: () => Promise.resolve(null),
      bytes: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
    },
    capabilities: {display: {width: 576, height: 288}},
    onBeforeDisconnect: () => () => {},
    sendRequest: () => Promise.resolve({}),
    ...(llm ? {llm} : {}),
  }
  return {
    session,
    uiSends,
    uiHandlers,
    renders,
    feed: (d: unknown) => transcriptionHandler?.(d),
  }
}

/** Drain the microtask queue — the cue pipeline is promise-chained, not timed. */
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

async function startedController(llm: SessionLlm | null) {
  const harness = makeSession(llm)
  const controller = new ConversateController(harness.session as never)
  await controller.start()
  harness.uiHandlers["conversate:start"]?.({} as never)
  await flush()
  return {...harness, controller}
}

describe("degrades visibly when session.llm is absent", () => {
  test("transcription still runs; ai-status reports unavailable; no cue is faked", async () => {
    const {feed, uiSends, renders} = await startedController(null)
    feed({text: "What is the plan?", isFinal: true})
    await flush()

    // The final reached the UI — speech works without the model.
    expect(uiSends.some((s) => s.channel === "conversate:final")).toBe(true)
    // The question trigger fired but produced NO cue — nothing is faked.
    expect(uiSends.some((s) => s.channel === "conversate:cue")).toBe(false)
    // The unavailable state is broadcast for the banner.
    const ai = uiSends.find((s) => s.channel === "conversate:ai-status")
    expect(ai).toBeTruthy()
    expect((ai!.payload as {available: boolean}).available).toBe(false)
    // No cue text hit the glasses.
    expect(renders.flat().some((e) => e.text?.includes("ANSWER ·"))).toBe(false)
  })
})

describe("with session.llm present", () => {
  const cueLlm = (impl: (req: {prompt: string}) => Promise<{json?: unknown}>): SessionLlm => ({
    availability: () =>
      Promise.resolve({available: true, contextSize: 4096, supportedLanguages: ["en", "zh-Hant-TW"]}),
    generate: async (req) => ({elapsedMs: 1, ...(await impl(req))}),
    cancel: () => Promise.resolve(),
  })

  test("a question final produces a cue on the UI and the glasses", async () => {
    const llm = cueLlm(() =>
      Promise.resolve({json: {cues: [{kind: "answer", title: "The Plan", body: "Ship Friday."}]}}),
    )
    const {feed, uiSends, renders} = await startedController(llm)
    feed({text: "What is the plan?", isFinal: true})
    await flush()

    const cueMsg = uiSends.find((s) => s.channel === "conversate:cue")
    expect(cueMsg).toBeTruthy()
    expect((cueMsg!.payload as {title: string}).title).toBe("The Plan")
    expect(renders.flat().some((e) => e.text?.includes("ANSWER · The Plan"))).toBe(true)
    // A successful generate proves availability — banner clears.
    const ai = uiSends.filter((s) => s.channel === "conversate:ai-status").pop()
    expect((ai!.payload as {available: boolean}).available).toBe(true)
  })

  test("guardrail rejects skip the cue silently and count the skip", async () => {
    const llm = cueLlm(() =>
      Promise.reject(Object.assign(new Error("LLM_GUARDRAIL"), {code: "LLM_GUARDRAIL"})),
    )
    const {feed, uiSends} = await startedController(llm)
    feed({text: "Sensitive question?", isFinal: true})
    await flush()
    expect(uiSends.some((s) => s.channel === "conversate:cue")).toBe(false)
    // No error broadcast for a guardrail skip — silent by design.
    expect(
      uiSends.every((s) => s.channel !== "conversate:speech-status" || (s.payload as {ok: boolean}).ok),
    ).toBe(true)
  })

  test("LLM_UNAVAILABLE with agreeing availability shows the banner", async () => {
    const llm: SessionLlm = {
      availability: () => Promise.resolve({available: false, reason: "model-not-ready"}),
      generate: () =>
        Promise.reject(
          Object.assign(new Error("LLM_UNAVAILABLE"), {code: "LLM_UNAVAILABLE", reason: "model-not-ready"}),
        ),
      cancel: () => Promise.resolve(),
    }
    const {feed, uiSends} = await startedController(llm)
    feed({text: "Any question?", isFinal: true})
    await flush()
    const ai = uiSends.filter((s) => s.channel === "conversate:ai-status").pop()
    expect((ai!.payload as {available: boolean; reason?: string}).available).toBe(false)
    expect((ai!.payload as {reason?: string}).reason).toBe("model-not-ready")
  })
})