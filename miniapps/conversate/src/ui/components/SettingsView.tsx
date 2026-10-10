import type {ReactNode} from "react"

import type {ConversateSettings} from "../../shared/types"
import {getFlagEmoji, getLanguageName} from "../lib/languages"

interface SettingsViewProps {
  settings: ConversateSettings
  accentColor: string
  onPickLanguage: () => void
  onPickTarget: () => void
  onSetTranslation: (enabled: boolean) => void
  onSetCuesEnabled: (enabled: boolean) => void
  onSetAutoPopup: (enabled: boolean) => void
  onSetCueDuration: (seconds: number) => void
  onSetLiveTranscript: (enabled: boolean) => void
  onSetCueLanguage: (cueLanguage: ConversateSettings["cueLanguage"]) => void
  onSetMicSource: (source: ConversateSettings["micSource"]) => void
}

function Toggle({on, onChange, accentColor}: {on: boolean; onChange: (v: boolean) => void; accentColor: string}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="w-11 h-6 rounded-full relative transition-colors"
      style={{backgroundColor: on ? accentColor : "#a1a1aa"}}>
      <span
        className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all"
        style={{left: on ? 22 : 2}}
      />
    </button>
  )
}

function Row({label, detail, children}: {label: string; detail?: string; children: ReactNode}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-3">
      <div className="flex-1">
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</div>
        {detail && <div className="text-xs text-zinc-500 mt-0.5">{detail}</div>}
      </div>
      {children}
    </div>
  )
}

export function SettingsView(props: SettingsViewProps) {
  const s = props.settings
  const accent = props.accentColor
  return (
    <div className="flex-1 overflow-y-auto scrollbar-hide px-4 py-3 flex flex-col gap-3">
      <div className="rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
        <Row label="Conversation language" detail="What the mic listens for">
          <button onClick={props.onPickLanguage} className="px-3 py-1.5 rounded-full border border-zinc-200 dark:border-zinc-700 text-sm">
            {getFlagEmoji(s.language)} {getLanguageName(s.language)}
          </button>
        </Row>
        <Row label="Live translation" detail="On-device translation of the conversation">
          <Toggle on={s.translationEnabled} onChange={props.onSetTranslation} accentColor={accent} />
        </Row>
        {s.translationEnabled && (
          <Row label="Translate into">
            <button onClick={props.onPickTarget} className="px-3 py-1.5 rounded-full border border-zinc-200 dark:border-zinc-700 text-sm">
              {getFlagEmoji(s.targetLanguage)} {getLanguageName(s.targetLanguage)}
            </button>
          </Row>
        )}
      </div>

      <div className="rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
        <Row label="AI cues" detail="Concepts, bios, answers, suggestions on the glasses">
          <Toggle on={s.cuesEnabled} onChange={props.onSetCuesEnabled} accentColor={accent} />
        </Row>
        <Row label="Cue language" detail="“Auto” uses the conversation language when the on-device model supports it">
          <select
            value={s.cueLanguage}
            onChange={(e) => props.onSetCueLanguage(e.target.value as ConversateSettings["cueLanguage"])}
            className="px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-sm bg-transparent">
            <option value="auto">Auto</option>
            <option value="en">English</option>
            <option value="zh-TW">繁體中文</option>
          </select>
        </Row>
        <Row label="Auto pop-up cues" detail="Off shows “● N new cue” until you tap">
          <Toggle on={s.autoPopup} onChange={props.onSetAutoPopup} accentColor={accent} />
        </Row>
        <Row label="Cue duration" detail={`${s.cueDurationSec}s on the lens`}>
          <input
            type="range"
            min={2}
            max={30}
            value={s.cueDurationSec}
            onChange={(e) => props.onSetCueDuration(Number(e.target.value))}
            className="w-28"
          />
        </Row>
        <Row label="Live transcript on glasses" detail="Bottom line shows the latest final">
          <Toggle on={s.liveTranscriptOnGlasses} onChange={props.onSetLiveTranscript} accentColor={accent} />
        </Row>
      </div>

      <div className="rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
        <Row label="Microphone" detail="Preferred source — the phone ranks the actual mic">
          <select
            value={s.micSource}
            onChange={(e) => props.onSetMicSource(e.target.value as ConversateSettings["micSource"])}
            className="px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-sm bg-transparent">
            <option value="auto">Auto</option>
            <option value="glasses">Glasses</option>
            <option value="phone">Phone</option>
          </select>
        </Row>
      </div>

      <div className="text-[11px] text-zinc-400 px-1 pb-4">
        Everything runs on this phone: Apple Speech transcription, on-device translation, and Apple
        Intelligence cues. Nothing is sent to a server.
      </div>
    </div>
  )
}
