/**
 * LocalLlmHandlers — `session.llm` request handlers for LocalMiniappRuntime.
 *
 * Contract B (on-device Apple Foundation Models):
 *   - LLM_AVAILABILITY → BluetoothSdk.llmAvailability(); the first call per
 *     miniapp also kicks a native prewarm so the first generate is faster.
 *   - LLM_GENERATE → BluetoothSdk.llmGenerate(). Stateless: every call is a
 *     fresh LanguageModelSession natively. ONE in-flight generate per miniapp —
 *     a newer request cancels the older (the older settles LLM_CANCELLED).
 *   - LLM_CANCEL → BluetoothSdk.llmCancel(requestId). Best-effort, resolves.
 *
 * Availability-trap policy (verified on-device): `availability` can stay stale
 * after the model download finishes, so the host NEVER refuses a generate up
 * front. The native side attempts the generation and only reports
 * LLM_UNAVAILABLE when the attempt fails AND the model is not .available.
 *
 * Native errors arrive as a result envelope {ok:false, code, reason?, message}
 * (never thrown), so mapping to MiniappErrorCode is deterministic. Unknown
 * codes degrade to INTERNAL. No prompt, instructions, schema, or output
 * content is ever logged — lengths and codes only.
 */

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import {MiniappErrorCode} from "@mentra/miniapp"

const LOG_TAG = "LocalMiniappRuntime"


type SendResult = (
  packageName: string,
  requestId: string | undefined,
  ok: boolean,
  result?: unknown,
  error?: {code: MiniappErrorCode; message: string} & Record<string, unknown>,
) => void

/** Wire shape the native side returns for llmGenerate (never throws). */
interface LlmNativeResult {
  ok?: boolean
  text?: string
  json?: unknown
  elapsedMs?: number
  code?: string
  reason?: string
  message?: string
}

/** Native LLM_* codes → contract MiniappErrorCode. */
const NATIVE_CODE_MAP: Record<string, MiniappErrorCode> = {
  LLM_UNAVAILABLE: MiniappErrorCode.LLM_UNAVAILABLE,
  LLM_GUARDRAIL: MiniappErrorCode.LLM_GUARDRAIL,
  LLM_CONTEXT_EXCEEDED: MiniappErrorCode.LLM_CONTEXT_EXCEEDED,
  LLM_CANCELLED: MiniappErrorCode.LLM_CANCELLED,
  LLM_UNSUPPORTED_LANGUAGE: MiniappErrorCode.LLM_UNSUPPORTED_LANGUAGE,
  // A schema outside the supported JSON-Schema subset is a caller error.
  LLM_INVALID_SCHEMA: MiniappErrorCode.INVALID_ARGUMENT,
}

export class LocalLlmHandlers {
  /** packageName → native requestId of the in-flight generate (one per app). */
  private readonly inFlight = new Map<string, string>()
  /** Apps that already triggered the one-time native prewarm. */
  private readonly prewarmed = new Set<string>()

  constructor(private readonly sendResult: SendResult) {}

  /**
   * Miniapp teardown: cancel any in-flight generate so a dead app's request
   * can't keep the model busy, and let the next launch prewarm again.
   */
  onDisconnect(packageName: string): void {
    const id = this.inFlight.get(packageName)
    if (id) {
      this.inFlight.delete(packageName)
      void Promise.resolve(BluetoothSdk.llmCancel(id)).catch(() => {})
    }
    this.prewarmed.delete(packageName)
  }

  async handleAvailability(packageName: string, requestId?: string): Promise<void> {
    try {
      const result = await BluetoothSdk.llmAvailability()
      this.sendResult(packageName, requestId, true, result)
      if (result?.available && !this.prewarmed.has(packageName)) {
        this.prewarmed.add(packageName)
        void Promise.resolve(BluetoothSdk.llmPrewarm()).catch(() => {})
      }
    } catch (err) {
      // A thrown call means the native build predates llmAvailability — report
      // unavailable rather than INTERNAL so the miniapp degrades visibly.
      console.warn(`${LOG_TAG}: llmAvailability threw for ${packageName}: ${(err as Error)?.message ?? err}`)
      this.sendResult(packageName, requestId, true, {available: false, reason: "unknown"})
    }
  }

  async handleGenerate(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const instructions = payload.instructions
    const prompt = payload.prompt
    if (typeof instructions !== "string" || typeof prompt !== "string") {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INVALID_ARGUMENT,
        message: "llm.generate requires string instructions and prompt",
      })
      return
    }
    if (payload.schema !== undefined && (typeof payload.schema !== "object" || payload.schema === null)) {
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.INVALID_ARGUMENT,
        message: "llm.generate schema must be a JSON-Schema object",
      })
      return
    }

    // One in-flight per miniapp: a newer generate cancels the older. The
    // superseded request settles LLM_CANCELLED when its native call returns.
    const previousId = this.inFlight.get(packageName)
    const nativeRequestId =
      typeof payload.llmRequestId === "string" && payload.llmRequestId.length > 0
        ? payload.llmRequestId
        : (requestId ?? `llm-${Date.now()}`)
    this.inFlight.set(packageName, nativeRequestId)
    if (previousId && previousId !== nativeRequestId) {
      void Promise.resolve(BluetoothSdk.llmCancel(previousId)).catch(() => {})
    }

    try {
      const result = (await BluetoothSdk.llmGenerate({
        requestId: nativeRequestId,
        instructions,
        prompt,
        schema: payload.schema,
        maxTokens: payload.maxTokens as number | undefined,
        temperature: payload.temperature as number | undefined,
      })) as LlmNativeResult
      if (result?.ok) {
        this.sendResult(packageName, requestId, true, {
          text: result.text,
          json: result.json,
          elapsedMs: result.elapsedMs ?? 0,
        })
      } else {
        const code = NATIVE_CODE_MAP[result?.code ?? ""] ?? MiniappErrorCode.INTERNAL
        console.warn(
          `${LOG_TAG}: llmGenerate failed for ${packageName} code=${result?.code ?? "unknown"} elapsedMs=${result?.elapsedMs ?? "?"}`,
        )
        this.sendResult(packageName, requestId, false, undefined, {
          code,
          message: result?.message ?? "On-device generation failed",
          ...(result?.reason ? {reason: result.reason} : {}),
        })
      }
    } catch (err) {
      // Bridge-level throw (native build predates llmGenerate). Degrade
      // visibly as unavailable rather than INTERNAL.
      console.warn(`${LOG_TAG}: llmGenerate threw for ${packageName}: ${(err as Error)?.message ?? err}`)
      this.sendResult(packageName, requestId, false, undefined, {
        code: MiniappErrorCode.LLM_UNAVAILABLE,
        message: "On-device language model is unavailable in this build",
        reason: "unknown",
      })
    } finally {
      if (this.inFlight.get(packageName) === nativeRequestId) {
        this.inFlight.delete(packageName)
      }
    }
  }

  async handleCancel(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const id = payload.llmRequestId
    if (typeof id === "string" && id.length > 0) {
      if (this.inFlight.get(packageName) === id) this.inFlight.delete(packageName)
      try {
        await BluetoothSdk.llmCancel(id)
      } catch {
        // Best-effort: a stale/unknown id still resolves — the generate that
        // owned it already settled.
      }
    }
    this.sendResult(packageName, requestId, true)
  }
}
