/// <reference types="bun-types" />

import {beforeEach, describe, expect, test} from "bun:test"

import {bluetoothSdk} from "./bluetoothSdkTestMock"
import {MiniappErrorCode} from "@mentra/miniapp"

// Import AFTER the bluetooth-sdk mock is registered (bluetoothSdkTestMock
// patches @mentra/bluetooth-sdk/internal process-wide).
const {LocalLlmHandlers} = await import("../LocalLlmHandlers")

type Sent = {
  packageName: string
  requestId?: string
  ok: boolean
  result?: unknown
  error?: {code: string; message: string} & Record<string, unknown>
}

let sent: Sent[]
let cancels: string[]
let generates: Record<string, unknown>[]
let prewarms: number
let handlers: InstanceType<typeof LocalLlmHandlers>

const sendResult = (
  packageName: string,
  requestId: string | undefined,
  ok: boolean,
  result?: unknown,
  error?: {code: MiniappErrorCode; message: string} & Record<string, unknown>,
) => {
  sent.push({packageName, requestId, ok, result, error})
}
const installNative = (impl: (req: Record<string, unknown>) => Promise<Record<string, unknown>>) => {
  bluetoothSdk.llmGenerate = (req: Record<string, unknown>) => {
    generates.push(req)
    return impl(req)
  }
}

beforeEach(() => {
  sent = []
  cancels = []
  generates = []
  prewarms = 0
  bluetoothSdk.llmAvailability = async () => ({available: true, contextSize: 4096, supportedLanguages: ["en-US"]})
  bluetoothSdk.llmPrewarm = async () => {
    prewarms += 1
  }
  bluetoothSdk.llmCancel = async (id: string) => {
    cancels.push(id)
  }
  installNative(async () => ({ok: true, text: "hello", elapsedMs: 12}))
  handlers = new LocalLlmHandlers(sendResult)
})

const last = () => sent[sent.length - 1]

describe("handleAvailability", () => {
  test("returns the native verdict and prewarms once per app", async () => {
    await handlers.handleAvailability("app.a", "r1")
    await handlers.handleAvailability("app.a", "r2")
    await handlers.handleAvailability("app.b", "r3")

    expect(sent[0]).toMatchObject({ok: true, result: {available: true, contextSize: 4096}})
    expect(prewarms).toBe(2) // app.a once, app.b once
  })

  test("does not prewarm when the model is unavailable", async () => {
    bluetoothSdk.llmAvailability = async () => ({available: false, reason: "model-not-ready"})
    await handlers.handleAvailability("app.a", "r1")
    expect(last()).toMatchObject({ok: true, result: {available: false, reason: "model-not-ready"}})
    expect(prewarms).toBe(0)
  })

  test("a thrown native call resolves unavailable, not INTERNAL", async () => {
    bluetoothSdk.llmAvailability = async () => {
      throw new Error("llmAvailability is not a function")
    }
    await handlers.handleAvailability("app.a", "r1")
    expect(last()).toMatchObject({ok: true, result: {available: false, reason: "unknown"}})
  })
})

describe("handleGenerate", () => {
  const req = {instructions: "sys", prompt: "user prompt", llmRequestId: "gen-1"}

  test("passes the request through and resolves {text, elapsedMs}", async () => {
    await handlers.handleGenerate("app.a", req, "r1")
    expect(generates[0]).toMatchObject({requestId: "gen-1", instructions: "sys", prompt: "user prompt"})
    expect(last()).toMatchObject({ok: true, result: {text: "hello", elapsedMs: 12}})
  })

  test("guided results carry json", async () => {
    installNative(async () => ({ok: true, json: {cues: []}, elapsedMs: 30}))
    await handlers.handleGenerate("app.a", {...req, schema: {type: "object"}}, "r1")
    expect(last()).toMatchObject({ok: true, result: {json: {cues: []}}})
  })

  test("falls back to the bridge requestId when llmRequestId is absent", async () => {
    await handlers.handleGenerate("app.a", {instructions: "s", prompt: "p"}, "bridge-req-9")
    expect(generates[0].requestId).toBe("bridge-req-9")
  })

  test("maps LLM_GUARDRAIL", async () => {
    installNative(async () => ({ok: false, code: "LLM_GUARDRAIL", message: "refused", elapsedMs: 5}))
    await handlers.handleGenerate("app.a", req, "r1")
    expect(last().error?.code).toBe(MiniappErrorCode.LLM_GUARDRAIL)
  })

  test("maps LLM_UNAVAILABLE and preserves the reason field", async () => {
    installNative(async () => ({ok: false, code: "LLM_UNAVAILABLE", reason: "model-not-ready", message: "no model"}))
    await handlers.handleGenerate("app.a", req, "r1")
    expect(last().error).toMatchObject({code: MiniappErrorCode.LLM_UNAVAILABLE, reason: "model-not-ready"})
  })

  test("maps LLM_CONTEXT_EXCEEDED / LLM_CANCELLED / LLM_UNSUPPORTED_LANGUAGE", async () => {
    for (const [native, miniapp] of [
      ["LLM_CONTEXT_EXCEEDED", MiniappErrorCode.LLM_CONTEXT_EXCEEDED],
      ["LLM_CANCELLED", MiniappErrorCode.LLM_CANCELLED],
      ["LLM_UNSUPPORTED_LANGUAGE", MiniappErrorCode.LLM_UNSUPPORTED_LANGUAGE],
    ] as const) {
      installNative(async () => ({ok: false, code: native, message: "x"}))
      await handlers.handleGenerate("app.a", req, "r1")
      expect(last().error?.code).toBe(miniapp)
    }
  })

  test("maps LLM_INVALID_SCHEMA to INVALID_ARGUMENT", async () => {
    installNative(async () => ({ok: false, code: "LLM_INVALID_SCHEMA", message: "bad keyword"}))
    await handlers.handleGenerate("app.a", req, "r1")
    expect(last().error?.code).toBe(MiniappErrorCode.INVALID_ARGUMENT)
  })

  test("unknown native codes degrade to INTERNAL", async () => {
    installNative(async () => ({ok: false, code: "SOMETHING_NEW", message: "x"}))
    await handlers.handleGenerate("app.a", req, "r1")
    expect(last().error?.code).toBe(MiniappErrorCode.INTERNAL)
  })

  test("a thrown native call reports LLM_UNAVAILABLE/unknown", async () => {
    bluetoothSdk.llmGenerate = async () => {
      throw new Error("llmGenerate is not a function")
    }
    await handlers.handleGenerate("app.a", req, "r1")
    expect(last().error).toMatchObject({code: MiniappErrorCode.LLM_UNAVAILABLE, reason: "unknown"})
  })

  test("rejects non-string instructions/prompt without calling native", async () => {
    await handlers.handleGenerate("app.a", {instructions: 1, prompt: "p"}, "r1")
    expect(last().error?.code).toBe(MiniappErrorCode.INVALID_ARGUMENT)
    await handlers.handleGenerate("app.a", {instructions: "s"}, "r2")
    expect(last().error?.code).toBe(MiniappErrorCode.INVALID_ARGUMENT)
    expect(generates).toHaveLength(0)
  })

  test("a newer generate cancels the older in-flight request", async () => {
    let resolveFirst!: (v: Record<string, unknown>) => void
    const first = new Promise<Record<string, unknown>>((res) => (resolveFirst = res))
    let calls = 0
    bluetoothSdk.llmGenerate = (r: Record<string, unknown>) => {
      generates.push(r)
      calls += 1
      return calls === 1 ? first : Promise.resolve({ok: true, text: "second", elapsedMs: 1})
    }

    const p1 = handlers.handleGenerate("app.a", {...req, llmRequestId: "old"}, "r1")
    const p2 = handlers.handleGenerate("app.a", {...req, llmRequestId: "new"}, "r2")
    expect(cancels).toEqual(["old"])

    resolveFirst({ok: false, code: "LLM_CANCELLED", message: "cancelled"})
    await Promise.all([p1, p2])

    expect(sent.find((s) => s.requestId === "r1")?.error?.code).toBe(MiniappErrorCode.LLM_CANCELLED)
    expect(sent.find((s) => s.requestId === "r2")).toMatchObject({ok: true, result: {text: "second"}})
  })

  test("in-flight tracking is per miniapp", async () => {
    let resolveFirst!: (v: Record<string, unknown>) => void
    const first = new Promise<Record<string, unknown>>((res) => (resolveFirst = res))
    let calls = 0
    bluetoothSdk.llmGenerate = () => {
      calls += 1
      return calls === 1 ? first : Promise.resolve({ok: true, text: "b", elapsedMs: 1})
    }
    const p1 = handlers.handleGenerate("app.a", {...req, llmRequestId: "a1"}, "r1")
    const p2 = handlers.handleGenerate("app.b", {...req, llmRequestId: "b1"}, "r2")
    expect(cancels).toEqual([]) // different app — no cancellation
    resolveFirst({ok: true, text: "a", elapsedMs: 1})
    await Promise.all([p1, p2])
  })
})

describe("handleCancel / onDisconnect", () => {
  test("cancel forwards the id to native and resolves ok", async () => {
    await handlers.handleCancel("app.a", {llmRequestId: "gen-7"}, "r1")
    expect(cancels).toEqual(["gen-7"])
    expect(last()).toMatchObject({ok: true})
  })

  test("cancel with a missing id still resolves ok without calling native", async () => {
    await handlers.handleCancel("app.a", {}, "r1")
    expect(cancels).toEqual([])
    expect(last()).toMatchObject({ok: true})
  })

  test("onDisconnect cancels the in-flight generate", async () => {
    const pending = new Promise<Record<string, unknown>>(() => {})
    bluetoothSdk.llmGenerate = () => pending
    void handlers.handleGenerate("app.a", {instructions: "s", prompt: "p", llmRequestId: "live"}, "r1")
    handlers.onDisconnect("app.a")
    expect(cancels).toEqual(["live"])
  })
})

describe("log hygiene", () => {
  test("failures log codes, never prompt or output content", async () => {
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "))
    }
    try {
      installNative(async () => ({ok: false, code: "LLM_GUARDRAIL", message: "refused", elapsedMs: 3}))
      await handlers.handleGenerate("app.a", {instructions: "SECRET-INSTRUCTIONS", prompt: "SECRET-PROMPT"}, "r1")
    } finally {
      console.warn = origWarn
    }
    const joined = warnings.join("\n")
    expect(joined).not.toContain("SECRET-INSTRUCTIONS")
    expect(joined).not.toContain("SECRET-PROMPT")
    expect(joined).toContain("LLM_GUARDRAIL")
  })
})
