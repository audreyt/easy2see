/**
 * Shared domain types referenced by BOTH the background JSContext and the UI
 * WebView. Both bundlers inline this file at build time, so there's no runtime
 * resolution across the boundary.
 *
 * Rule: anything that crosses the `mentra.send` / `session.ui.send` channel
 * boundary needs its payload shape declared here so each side sees the same
 * TypeScript type.
 */

/** Lifecycle of one Conversate session (a single conversation). */
export type SessionState = "idle" | "running" | "paused" | "reviewing"

/** The four cue kinds, mirroring Even Conversate's Concepts/Bios/Answers/Suggestions. */
export type CueKind = "concept" | "bio" | "answer" | "suggestion"

/** One AI cue. `languageNote` marks cues generated in a fallback language. */
export interface Cue {
  id: string
  kind: CueKind
  title: string
  body: string
  /** Epoch ms when the cue was generated. */
  t: number
  /** Set when the cue was generated in a language other than requested (e.g. English fallback). */
  languageNote?: string
}

/** One final transcript line (interims are never stored). */
export interface TranscriptFinal {
  /** Epoch ms. */
  t: number
  text: string
  /** Translated text, present only when live translation is on. */
  translation?: string
}

/** Which language cues are generated in. */
export type CueLanguage = "auto" | "en" | "zh-TW"

/** Mic preference — the host ranks sources; "auto" leaves it to the host. */
export type MicSource = "auto" | "glasses" | "phone"

/** Conversate settings — persisted in storage, mirrored to the UI. */
export interface ConversateSettings {
  /** Conversation language (BCP-47 registry tag or bare code, e.g. "en", "zh-TW"). */
  language: string
  /** Live translation on/off. */
  translationEnabled: boolean
  /** Translation target language. */
  targetLanguage: string
  /** AI cues on/off. */
  cuesEnabled: boolean
  /** Auto pop-up new cues on the glasses. Off = "● N new cue" until tapped. */
  autoPopup: boolean
  /** Seconds a cue stays on the glasses before auto-dismiss. */
  cueDurationSec: number
  /** Show the live transcript line on the glasses. */
  liveTranscriptOnGlasses: boolean
  /** Preferred cue language; "auto" = conversation language when the model supports it. */
  cueLanguage: CueLanguage
  /** Mic source preference (host ranks the actual source). */
  micSource: MicSource
}

/** On-device AI status surfaced to the UI — never silent. */
export interface AiStatus {
  available: boolean
  /** Host reason code, e.g. "model-not-ready", "unsupported-os". */
  reason?: string
  /** True once the model has answered at least one generate call this session. */
  proven?: boolean
}

/** Speech pipeline status surfaced to the UI. */
export interface SpeechStatus {
  ok: boolean
  reason?: string
}

/** Post-conversation review (reduce-step output). */
export interface ReviewSummary {
  title: string
  overview: string
  highlights: string[]
  details: string[]
  nextSteps: string[]
}

/** History index entry — one past conversation. */
export interface SessionRecordMeta {
  id: string
  /** Epoch ms the session started. */
  startedAt: number
  title: string
  /** Blob key holding the rendered Markdown review. */
  blobKey: string
  cueCount: number
  finalCount: number
  /** True when the Markdown was also exported to Files. */
  exported: boolean
}

/** Full state snapshot pushed to the UI on every WebView open. */
export interface ConversateSnapshot {
  state: SessionState
  settings: ConversateSettings
  prepNote: string
  cues: Cue[]
  transcript: TranscriptFinal[]
  ai: AiStatus
  speech: SpeechStatus
  /** Set while a review is being generated / after it completes. */
  review: {ready: boolean; exported: boolean; exportMessage?: string} | null
  history: SessionRecordMeta[]
}
