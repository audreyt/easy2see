import {useEffect, useRef, useState} from "react"

import type {
  AiStatus,
  ConversateSettings,
  ConversateSnapshot,
  Cue,
  SessionRecordMeta,
  SessionState,
  SpeechStatus,
  TranscriptFinal,
} from "../../shared/types"

/**
 * useConversate — the single hook over the background channel bus. Reads come
 * from `conversate:snapshot` (hydration) plus the per-topic update channels;
 * writes go out as `conversate:*` broadcasts / `mentra.request` RPCs.
 */
export function useConversate() {
  const [state, setState] = useState<SessionState>("idle")
  const [settings, setSettings] = useState<ConversateSettings | null>(null)
  const [prepNote, setPrepNote] = useState("")
  const [cues, setCues] = useState<Cue[]>([])
  const [transcript, setTranscript] = useState<TranscriptFinal[]>([])
  const [ai, setAi] = useState<AiStatus>({available: false})
  const [speech, setSpeech] = useState<SpeechStatus>({ok: true})
  const [review, setReview] = useState<ConversateSnapshot["review"]>(null)
  const [history, setHistory] = useState<SessionRecordMeta[]>([])
  const [hydrated, setHydrated] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    const offs: Array<() => void> = []
    const on = mentra.on as (c: string, cb: (p: unknown) => void) => () => void

    offs.push(
      on("conversate:snapshot", (p) => {
        if (!mountedRef.current) return
        const s = p as ConversateSnapshot
        setState(s.state)
        setSettings(s.settings)
        setPrepNote(s.prepNote)
        setCues(s.cues)
        setTranscript(s.transcript)
        setAi(s.ai)
        setSpeech(s.speech)
        setReview(s.review)
        setHistory(s.history)
        setHydrated(true)
      }),
      on("conversate:state", (p) => mountedRef.current && setState((p as {state: SessionState}).state)),
      on("conversate:cue", (p) => mountedRef.current && setCues((prev) => [...prev, p as Cue])),
      on("conversate:final", (p) => mountedRef.current && setTranscript((prev) => [...prev.slice(-499), p as TranscriptFinal])),
      on("conversate:settings", (p) => mountedRef.current && setSettings(p as ConversateSettings)),
      on("conversate:prep-note", (p) => mountedRef.current && setPrepNote((p as {text: string}).text)),
      on("conversate:ai-status", (p) => mountedRef.current && setAi(p as AiStatus)),
      on("conversate:speech-status", (p) => mountedRef.current && setSpeech(p as SpeechStatus)),
      on("conversate:review", (p) => mountedRef.current && setReview(p as ConversateSnapshot["review"])),
      on("conversate:history", (p) => mountedRef.current && setHistory((p as {history: SessionRecordMeta[]}).history)),
    )

    mentra.send("conversate:request-snapshot", {})

    return () => {
      mountedRef.current = false
      for (const off of offs) off()
    }
  }, [])

  return {
    hydrated,
    state,
    settings,
    prepNote,
    cues,
    transcript,
    ai,
    speech,
    review,
    history,
    start: () => mentra.send("conversate:start", {}),
    pause: () => mentra.send("conversate:pause", {}),
    resume: () => mentra.send("conversate:resume", {}),
    end: () => mentra.send("conversate:end", {}),
    setLanguage: (language: string) => mentra.send("conversate:set-language", {language}),
    setTranslation: (enabled: boolean, targetLanguage?: string) =>
      mentra.send("conversate:set-translation", {enabled, targetLanguage}),
    setCuesEnabled: (enabled: boolean) => mentra.send("conversate:set-cues-enabled", {enabled}),
    setAutoPopup: (enabled: boolean) => mentra.send("conversate:set-auto-popup", {enabled}),
    setCueDuration: (seconds: number) => mentra.send("conversate:set-cue-duration", {seconds}),
    setLiveTranscript: (enabled: boolean) => mentra.send("conversate:set-live-transcript", {enabled}),
    setCueLanguage: (cueLanguage: ConversateSettings["cueLanguage"]) =>
      mentra.send("conversate:set-cue-language", {cueLanguage}),
    setMicSource: (micSource: ConversateSettings["micSource"]) =>
      mentra.send("conversate:set-mic-source", {micSource}),
    setPrepNote: (text: string) => mentra.send("conversate:set-prep-note", {text}),
    deleteHistory: (id: string) => mentra.send("conversate:delete-history", {id}),
    importPrepNote: () => mentra.request("conversate:import-prep-note", {}),
    getReview: (id: string) => mentra.request("conversate:get-review", {id}),
    exportReview: (id: string) => mentra.request("conversate:export-review", {id}),
  }
}
