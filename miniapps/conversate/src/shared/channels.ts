/**
 * Typed channel registry — the single source of truth for every name that
 * flows between this miniapp's background JSContext and its UI WebView. Both
 * halves import this file at build time; the bundler inlines the declarations
 * so there's no runtime cross-boundary I/O.
 *
 * Broadcast channels carry state updates; Rpc channels carry request/response
 * calls (file import, review fetch, Files export).
 */

import type {MentraTyped, Rpc} from "@mentra/miniapp/ui"

import type {
  AiStatus,
  ConversateSettings,
  ConversateSnapshot,
  Cue,
  CueLanguage,
  MicSource,
  SessionRecordMeta,
  SessionState,
  SpeechStatus,
  TranscriptFinal,
} from "./types"

export interface Channels {
  // ── background → UI ────────────────────────────────────────────────────

  /** Full hydration snapshot, sent on every session.ui.onOpen. */
  "conversate:snapshot": ConversateSnapshot
  /** Session lifecycle change (idle/running/paused/reviewing). */
  "conversate:state": {state: SessionState}
  /** One new AI cue. */
  "conversate:cue": Cue
  /** One new transcript final. */
  "conversate:final": TranscriptFinal
  /** Settings update. */
  "conversate:settings": ConversateSettings
  /** Prep-note content update. */
  "conversate:prep-note": {text: string}
  /** On-device AI status change. */
  "conversate:ai-status": AiStatus
  /** Speech pipeline status change. */
  "conversate:speech-status": SpeechStatus
  /** Review progress/result notice. */
  "conversate:review": {ready: boolean; exported: boolean; exportMessage?: string}
  /** History index update. */
  "conversate:history": {history: SessionRecordMeta[]}

  // ── UI → background (broadcast) ────────────────────────────────────────

  "conversate:start": Record<string, never>
  "conversate:pause": Record<string, never>
  "conversate:resume": Record<string, never>
  "conversate:end": Record<string, never>
  "conversate:set-language": {language: string}
  "conversate:set-translation": {enabled: boolean; targetLanguage?: string}
  "conversate:set-cues-enabled": {enabled: boolean}
  "conversate:set-auto-popup": {enabled: boolean}
  "conversate:set-cue-duration": {seconds: number}
  "conversate:set-live-transcript": {enabled: boolean}
  "conversate:set-cue-language": {cueLanguage: CueLanguage}
  "conversate:set-mic-source": {micSource: MicSource}
  "conversate:set-prep-note": {text: string}
  "conversate:delete-history": {id: string}
  /** Explicit hydration request after the WebView has registered listeners. */
  "conversate:request-snapshot": Record<string, never>

  // ── UI → background (RPC) ──────────────────────────────────────────────

  /** Open the OS file picker, import a .txt prep note. */
  "conversate:import-prep-note": Rpc<Record<string, never>, {text: string | null; error?: string}>
  /** Fetch the rendered Markdown review for a history record (or the live one). */
  "conversate:get-review": Rpc<{id: string}, {markdown: string | null; error?: string}>
  /** Re-export a history record's Markdown to Files. */
  "conversate:export-review": Rpc<{id: string}, {uri?: string; error?: string}>
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: MentraTyped<Channels>
}
