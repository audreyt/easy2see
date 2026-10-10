/**
 * host.ts — the ONE typed adapter for SDK surface that does not exist yet in
 * this tree. Everything the rest of the miniapp needs from the in-flight host
 * contracts goes through here so the app compiles today and picks up the real
 * implementations the moment they land:
 *
 *   Contract B — `session.llm` (Easy2SeeHostLLM):
 *     availability() / generate() / cancel() against FoundationModels.
 *   Contract A — transcription `engine` option (Easy2SeeHostSpeech):
 *     forLanguage(lang, handler, {forceLocal, engine: "auto"}).
 *   Session-recording export (Easy2SeeSessionRecording):
 *     session.blob.exportToFiles(key, {folder, filename, keepBlob}).
 *
 * Rules honored here: nothing in this file touches the network; every
 * degradation is returned as data so callers can show it — never faked.
 */

import type {
  MiniappSession,
  TranscriptionData,
  TranslationData,
  UnsubscribeFn,
} from "@mentra/miniapp/background"

// ── Contract B: session.llm ────────────────────────────────────────────────

export type LlmUnavailableReason =
  | "unsupported-os"
  | "device-not-eligible"
  | "apple-intelligence-not-enabled"
  | "model-not-ready"
  | "unknown"

export interface LlmAvailability {
  available: boolean
  reason?: LlmUnavailableReason
  contextSize?: number
  /** BCP-47 tags the model can generate in. */
  supportedLanguages?: string[]
}

export interface LlmGenerateRequest {
  instructions: string
  prompt: string
  /** JSON Schema subset — mapped to DynamicGenerationSchema host-side. */
  schema?: object
  maxTokens?: number
  temperature?: number
  requestId?: string
}

export interface LlmGenerateResult {
  text?: string
  json?: unknown
  elapsedMs: number
}

export interface SessionLlm {
  availability(): Promise<LlmAvailability>
  generate(req: LlmGenerateRequest): Promise<LlmGenerateResult>
  cancel(requestId: string): Promise<void>
}

/** Contract B error codes the host may reject generate() with. */
export type LlmErrorCode =
  | "LLM_UNAVAILABLE"
  | "LLM_GUARDRAIL"
  | "LLM_CONTEXT_EXCEEDED"
  | "LLM_CANCELLED"
  | "LLM_UNSUPPORTED_LANGUAGE"

/**
 * Extract a Contract-B error code from a rejected generate() promise. The
 * host may reject with `{code}` objects or `Error` instances whose message
 * carries the code — accept both, return null for anything else.
 */
export function llmErrorCode(err: unknown): LlmErrorCode | null {
  const text =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as {code: unknown}).code)
      : err instanceof Error
        ? err.message
        : String(err)
  for (const code of [
    "LLM_UNAVAILABLE",
    "LLM_GUARDRAIL",
    "LLM_CONTEXT_EXCEEDED",
    "LLM_CANCELLED",
    "LLM_UNSUPPORTED_LANGUAGE",
  ] as const) {
    if (text.includes(code)) return code
  }
  return null
}

/** Extract the availability reason from an LLM_UNAVAILABLE error, if carried. */
export function llmErrorReason(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "reason" in err) {
    const r = (err as {reason: unknown}).reason
    if (typeof r === "string" && r) return r
  }
  return undefined
}

/**
 * The `session.llm` module, or null when the host SDK predates Contract B.
 * Callers MUST treat null as "on-device AI unavailable" and keep every other
 * feature running — never fake a cue, never reach for a network fallback.
 */
export function getLlm(session: MiniappSession): SessionLlm | null {
  const candidate = (session as unknown as {llm?: unknown}).llm
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof (candidate as SessionLlm).availability === "function" &&
    typeof (candidate as SessionLlm).generate === "function"
  ) {
    return candidate as SessionLlm
  }
  return null
}

// ── Contract A: transcription engine option ────────────────────────────────

/**
 * Subscribe to on-device transcription finals/interims for one language.
 * Passes Contract A's `engine: "auto"` (Apple Speech lanes for locales Sherpa
 * lacks or Traditional/regional Chinese, Sherpa otherwise). SDKs that predate
 * the option ignore the extra field and still honor `forceLocal`.
 */
export function subscribeTranscription(
  session: MiniappSession,
  language: string,
  handler: (data: TranscriptionData) => void,
): UnsubscribeFn {
  const options = {forceLocal: true, engine: "auto"} as Parameters<
    MiniappSession["transcription"]["forLanguage"]
  >[2]
  return session.transcription.forLanguage(language as never, handler, options)
}

/** Subscribe to on-device any-source → target translation (originalText + text). */
export function subscribeTranslation(
  session: MiniappSession,
  targetLanguage: string,
  handler: (data: TranslationData) => void,
): UnsubscribeFn {
  return session.translation.to(targetLanguage as never, handler, {forceLocal: true})
}

/**
 * Subscribe to the host's speech-unavailable signal. The native pipeline
 * emits `local_translation_unavailable` with `{reason}`; Contract A forwards
 * it to miniapps. Uses the EventManager escape hatch because no typed module
 * wraps the stream yet.
 */
export function onSpeechUnavailable(
  session: MiniappSession,
  handler: (reason: string) => void,
): UnsubscribeFn {
  return session.events.subscribe("local_translation_unavailable", (data: unknown) => {
    const reason =
      typeof data === "object" && data !== null && "reason" in data
        ? String((data as {reason: unknown}).reason)
        : "unavailable"
    handler(reason || "unavailable")
  })
}

// ── Prep-note TXT import via session.blob ──────────────────────────────────

export interface PrepNoteImport {
  text: string | null
  error?: string
}

/**
 * Open the OS file picker for a .txt file and return its decoded contents.
 * Bytes go through session.blob (host-side file, chunked read) — no network,
 * no WebView file access. Returns {text: null} when the user cancels.
 */
export async function importTextFile(session: MiniappSession): Promise<PrepNoteImport> {
  try {
    const meta = await session.blob.importFile({mimeType: "text/plain"})
    if (!meta) return {text: null}
    const bytes = await session.blob.bytes(meta.key)
    if (!bytes) return {text: null, error: "Could not read the selected file"}
    return {text: new TextDecoder().decode(bytes)}
  } catch (err) {
    return {text: null, error: err instanceof Error ? err.message : String(err)}
  }
}

// ── Session-recording Files export ─────────────────────────────────────────

/** Folder under the app's Documents dir reviews are exported into. */
export const REVIEW_EXPORT_FOLDER = "Recordings/Easy2Say"

/** Explicit export request type — MiniappRequestType.BLOB_EXPORT on new SDKs. */
const BLOB_EXPORT_REQUEST_TYPE = "miniapp_blob_export"

export interface ExportResult {
  /** Files-visible URI when the export succeeded. */
  uri?: string
  /** Blob key the Markdown is stored under (always set on success path). */
  blobKey?: string
  /** Human-readable failure — the UI shows this verbatim. */
  error?: string
}

interface BlobExportHint {
  folder: string
  filename: string
  keepBlob?: boolean
}

interface BlobMetaLike {
  key: string
  exportedTo?: string
  exportError?: string
}

/**
 * Persist `markdown` as a blob and export it to Files under
 * Recordings/Easy2Say. Three export paths, newest first:
 *   1. blob.exportToFiles (session-recording contract)
 *   2. create-time {export} hint honored at commit (meta.exportedTo)
 *   3. the raw miniapp_blob_export request
 * When none exists (older host), the blob is still committed and the result
 * carries an error — the session stays in local history and the UI says so.
 */
export async function exportMarkdown(
  session: MiniappSession,
  filename: string,
  markdown: string,
): Promise<ExportResult> {
  const blob = session.blob
  if (!blob) return {error: "On-device storage is unavailable on this host"}

  const bytes = new TextEncoder().encode(markdown)
  let meta: BlobMetaLike | null = null
  try {
    meta = (await blob.set(`review-${Date.now().toString(36)}`, bytes, {
      mimeType: "text/markdown",
      name: filename,
      meta: {title: filename},
      export: {folder: REVIEW_EXPORT_FOLDER, filename, keepBlob: true},
    } as never)) as BlobMetaLike | null
  } catch (err) {
    return {error: `Could not save the review: ${err instanceof Error ? err.message : String(err)}`}
  }
  const key = meta?.key
  if (!key) return {error: "Could not save the review: the host returned no blob key"}

  // Path 2 already resolved at commit time.
  if (typeof meta?.exportedTo === "string" && meta.exportedTo) {
    return {uri: meta.exportedTo, blobKey: key}
  }
  if (typeof meta?.exportError === "string" && meta.exportError) {
    return {blobKey: key, error: `Could not export to Files: ${meta.exportError}`}
  }

  // Path 1: the session-recording contract method.
  const withExport = blob as unknown as {
    exportToFiles?: (key: string, opts: BlobExportHint) => Promise<{uri: string; filename: string}>
  }
  if (typeof withExport.exportToFiles === "function") {
    try {
      const res = await withExport.exportToFiles(key, {
        folder: REVIEW_EXPORT_FOLDER,
        filename,
        keepBlob: true,
      })
      if (res?.uri) return {uri: res.uri, blobKey: key}
      return {blobKey: key, error: "Could not export to Files: the host returned no destination"}
    } catch (err) {
      return {blobKey: key, error: `Could not export to Files: ${err instanceof Error ? err.message : String(err)}`}
    }
  }

  // Path 3: raw request for hosts that implement the wire type without the
  // SDK method.
  try {
    const res = await session.sendRequest<{uri?: string}>({
      type: BLOB_EXPORT_REQUEST_TYPE,
      key,
      folder: REVIEW_EXPORT_FOLDER,
      filename,
      keepBlob: true,
    })
    if (res?.uri) return {uri: res.uri, blobKey: key}
    return {blobKey: key, error: "Could not export to Files: the host returned no destination"}
  } catch {
    return {
      blobKey: key,
      error: "Saved to in-app history — this host cannot export to Files",
    }
  }
}
