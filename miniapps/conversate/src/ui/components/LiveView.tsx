import {Mic, Pause, Play, Square} from "lucide-react"

import type {Cue, SessionState, TranscriptFinal} from "../../shared/types"
import {getFlagEmoji, getLanguageName} from "../lib/languages"

interface LiveViewProps {
  state: SessionState
  cues: Cue[]
  transcript: TranscriptFinal[]
  language: string
  translationEnabled: boolean
  targetLanguage: string
  accentColor: string
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onEnd: () => void
  onPickLanguage: () => void
  onPickTarget: () => void
}

const KIND_STYLE: Record<Cue["kind"], string> = {
  concept: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200",
  bio: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  answer: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  suggestion: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
}

export function LiveView(props: LiveViewProps) {
  const {state, cues, transcript, accentColor} = props
  const running = state === "running"
  const paused = state === "paused"

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Language row */}
      <div className="px-4 py-2 flex items-center gap-2 text-sm">
        <button onClick={props.onPickLanguage} className="px-3 py-1.5 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
          {getFlagEmoji(props.language)} {getLanguageName(props.language)}
        </button>
        {props.translationEnabled && (
          <>
            <span className="text-zinc-400">→</span>
            <button onClick={props.onPickTarget} className="px-3 py-1.5 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
              {getFlagEmoji(props.targetLanguage)} {getLanguageName(props.targetLanguage)}
            </button>
          </>
        )}
      </div>

      {/* Controls */}
      <div className="px-4 py-3 flex items-center justify-center gap-4">
        {!running && !paused && (
          <button
            onClick={props.onStart}
            className="flex items-center gap-2 px-6 py-3 rounded-2xl text-white font-semibold"
            style={{backgroundColor: accentColor}}>
            <Play className="w-5 h-5" /> Start
          </button>
        )}
        {running && (
          <button
            onClick={props.onPause}
            className="flex items-center gap-2 px-6 py-3 rounded-2xl bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-semibold">
            <Pause className="w-5 h-5" /> Pause
          </button>
        )}
        {paused && (
          <button
            onClick={props.onResume}
            className="flex items-center gap-2 px-6 py-3 rounded-2xl text-white font-semibold"
            style={{backgroundColor: accentColor}}>
            <Mic className="w-5 h-5" /> Resume
          </button>
        )}
        {(running || paused) && (
          <button
            onClick={props.onEnd}
            className="flex items-center gap-2 px-6 py-3 rounded-2xl bg-red-600 text-white font-semibold">
            <Square className="w-5 h-5" /> End
          </button>
        )}
        {state === "reviewing" && <span className="text-sm text-zinc-500">Building your review…</span>}
      </div>

      {/* Cue list (newest first) */}
      {cues.length > 0 && (
        <div className="px-4 pb-2">
          <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">Cues</div>
          <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto scrollbar-hide">
            {[...cues].reverse().map((cue) => (
              <div key={cue.id} className="rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${KIND_STYLE[cue.kind]}`}>
                    {cue.kind.toUpperCase()}
                  </span>
                  <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex-1">{cue.title}</span>
                </div>
                <div className="text-sm text-zinc-600 dark:text-zinc-300 mt-0.5 selectable-text">{cue.body}</div>
                {cue.languageNote && <div className="text-[10px] text-zinc-400 mt-0.5">{cue.languageNote}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Transcript (newest last, auto-scroll region) */}
      <div className="flex-1 min-h-0 px-4 pb-3 flex flex-col">
        <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">Transcript</div>
        <div className="flex-1 overflow-y-auto scrollbar-hide rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-3 py-2">
          {transcript.length === 0 ? (
            <div className="text-sm text-zinc-400 py-6 text-center">
              {running ? "Listening…" : "Start a session to transcribe on-device."}
            </div>
          ) : (
            transcript.map((f, i) => (
              <div key={i} className="py-1 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
                <div className="text-sm text-zinc-900 dark:text-zinc-100 selectable-text">{f.text}</div>
                {f.translation && <div className="text-sm text-indigo-600 dark:text-indigo-300 selectable-text">→ {f.translation}</div>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
