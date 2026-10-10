/**
 * @fileoverview LlmModule — on-device Apple Foundation Models (SystemLanguageModel)
 * behind `session.llm`. Everything runs on the phone; nothing leaves the device.
 *
 * Contract (Contract B):
 *   - `availability()` reports whether the on-device model can serve requests,
 *     with a machine-readable `reason` when it cannot.
 *   - `generate()` is STATELESS: every call is a fresh LanguageModelSession on
 *     the host — the miniapp owns whatever context it wants by putting it in
 *     `instructions`/`prompt`. Pass `schema` (a JSON-Schema subset) for guided
 *     generation and the result comes back parsed in `json`.
 *   - One in-flight generate per miniapp: a newer request cancels the older.
 *     `cancel(requestId)` cancels an in-flight request explicitly.
 *
 * Errors reject with MiniappRequestError carrying one of the LLM_* codes:
 * LLM_UNAVAILABLE (+reason), LLM_GUARDRAIL, LLM_CONTEXT_EXCEEDED,
 * LLM_CANCELLED, LLM_UNSUPPORTED_LANGUAGE.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

/** Why the on-device model cannot serve requests right now. */
export type LlmUnavailableReason =
  | "unsupported-os"
  | "device-not-eligible"
  | "apple-intelligence-not-enabled"
  | "model-not-ready"
  | "unknown"

export interface LlmAvailability {
  available: boolean
  /** Present when `available` is false. */
  reason?: LlmUnavailableReason
  /** Model context window in tokens, when the host can report it. */
  contextSize?: number
  /** BCP-47 tags the model supports. */
  supportedLanguages?: string[]
}

export interface LlmGenerateRequest {
  /** System prompt for this call (fresh session per call — always required). */
  instructions: string
  /** User prompt. */
  prompt: string
  /**
   * JSON Schema subset for guided generation: object, array, string, number,
   * integer, boolean, enum, required, description, maxItems. Unsupported
   * keywords reject with INVALID_ARGUMENT. When present the result's `json`
   * field carries the parsed structured output.
   */
  schema?: object
  /** Cap on generated tokens (GenerationOptions.maximumResponseTokens). */
  maxTokens?: number
  /** Sampling temperature (GenerationOptions.temperature). */
  temperature?: number
  /** Caller-chosen id; enables `cancel(requestId)`. */
  requestId?: string
}

export interface LlmGenerateResult {
  /** Plain-text response (no schema requested). */
  text?: string
  /** Parsed structured response (schema requested). */
  json?: unknown
  /** Wall-clock generation time measured on the host. */
  elapsedMs: number
}

/**
 * Generation can legitimately run for minutes (post-conversation review
 * map-reduce). The default 60s bridge ceiling would cut those off, so
 * generate() uses a generous backstop; the host still answers every request
 * and disconnect teardown settles the rest.
 */
const LLM_GENERATE_TIMEOUT_MS = 300_000

export class LlmModule {
  constructor(private readonly session: MiniappSession) {}

  /**
   * Whether the on-device model can serve requests right now. Never throws
   * for "model unavailable" — that is the return value. The host prewarms the
   * model on the first call.
   */
  availability(): Promise<LlmAvailability> {
    return this.session.sendRequest<LlmAvailability>({type: MiniappRequestType.LLM_AVAILABILITY})
  }

  /**
   * One stateless generation. A newer generate for this miniapp cancels the
   * older one (it rejects with LLM_CANCELLED). Do NOT pre-check availability
   * and refuse — the availability probe can be stale; the host attempts the
   * generation and only reports LLM_UNAVAILABLE when the attempt fails AND
   * the model is genuinely unavailable.
   */
  generate(req: LlmGenerateRequest): Promise<LlmGenerateResult> {
    return this.session.sendRequest<LlmGenerateResult>(
      {
        type: MiniappRequestType.LLM_GENERATE,
        instructions: req.instructions,
        prompt: req.prompt,
        schema: req.schema,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        llmRequestId: req.requestId,
      },
      {timeoutMs: LLM_GENERATE_TIMEOUT_MS},
    )
  }

  /** Cancel an in-flight generate by the `requestId` it was sent with. */
  async cancel(requestId: string): Promise<void> {
    await this.session.sendRequest<void>({type: MiniappRequestType.LLM_CANCEL, llmRequestId: requestId})
  }
}
