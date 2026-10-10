import {MessageSquareText} from "lucide-react"

import type {AiStatus, SessionState, SpeechStatus} from "../../shared/types"

interface HeaderProps {
  state: SessionState
  ai: AiStatus
  speech: SpeechStatus
  appBarBackground: string
}

const STATE_LABEL: Record<SessionState, string> = {
  idle: "Ready",
  running: "Listening",
  paused: "Paused",
  reviewing: "Reviewing…",
}

export function Header({state, ai, speech, appBarBackground}: HeaderProps) {
  return (
    <div className="w-full flex flex-col">
      <div
        className="relative w-full h-[46px] px-6 backdrop-blur-lg flex justify-center items-center"
        style={{backgroundColor: appBarBackground}}>
        {/* Status pinned to the LEFT edge — the host's floating minimize/close
            capsule overlays the top-right, so nothing may render there. */}
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-white/85 text-sm font-medium">{STATE_LABEL[state]}</span>
        <div className="flex justify-start items-center gap-2">
          <MessageSquareText className="w-5 h-5 text-white" aria-hidden="true" />
          <span className="text-white text-lg font-semibold">Easy2Say</span>
        </div>
      </div>

      {/* On-device AI unavailable — visible, never silent (design §4). */}
      {!ai.available && (
        <div className="w-full px-4 py-2 bg-amber-50 dark:bg-amber-950 border-b border-amber-200 dark:border-amber-900">
          <span className="text-amber-800 dark:text-amber-200 text-xs">
            On-device AI unavailable{ai.reason ? `: ${ai.reason}` : ""} — Settings › Apple Intelligence &amp; Siri.
            Transcription still works; AI cues are off.
          </span>
        </div>
      )}

      {/* Speech pipeline failure — host-reported reason shown verbatim. */}
      {!speech.ok && (
        <div className="w-full px-4 py-2 bg-red-50 dark:bg-red-950 border-b border-red-200 dark:border-red-900">
          <span className="text-red-800 dark:text-red-200 text-xs">
            Speech unavailable{speech.reason ? `: ${speech.reason}` : ""}
          </span>
        </div>
      )}
    </div>
  )
}
