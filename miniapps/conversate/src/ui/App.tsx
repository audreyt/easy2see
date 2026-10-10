import {useState} from "react"
import {useColorScheme, useSafeArea} from "@mentra/miniapp/ui"

import {BottomNav, type ConversateTab} from "./components/BottomNav"
import {Header} from "./components/Header"
import {HistoryView} from "./components/HistoryView"
import {LanguagePicker} from "./components/LanguagePicker"
import {LiveView} from "./components/LiveView"
import {PrepNoteView} from "./components/PrepNoteView"
import {SettingsView} from "./components/SettingsView"
import {useConversate} from "./hooks/useConversate"

const ACCENT = "#4F46E5"

/**
 * App — the WebView root for Conversate. Four tabs (Live / Prep / History /
 * Settings) over the background channel bus; language pickers overlay the
 * content area. All state lives in the background JSContext — this view
 * re-hydrates from conversate:snapshot on every open.
 */
export function App() {
  const [activeTab, setActiveTab] = useState<ConversateTab>("live")
  const [picker, setPicker] = useState<"language" | "target" | null>(null)
  const isDark = useColorScheme() === "dark"
  const {insets} = useSafeArea()
  const c = useConversate()

  const appBarBackground = isDark ? "#312e81" : ACCENT

  if (picker && c.settings) {
    return (
      <div className="h-full flex flex-col" style={{paddingTop: insets.top}}>
        <LanguagePicker
          title={picker === "language" ? "Conversation language" : "Translate into"}
          current={picker === "language" ? c.settings.language : c.settings.targetLanguage}
          accentColor={ACCENT}
          onSave={(code) => {
            if (picker === "language") c.setLanguage(code)
            else c.setTranslation(true, code)
            setPicker(null)
          }}
          onCancel={() => setPicker(null)}
        />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col" style={{paddingTop: insets.top, paddingBottom: insets.bottom}}>
      <Header state={c.state} ai={c.ai} speech={c.speech} appBarBackground={appBarBackground} />

      {c.review?.exportMessage && (
        <div className="px-4 py-1.5 text-xs text-zinc-500 bg-zinc-100 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
          {c.review.exportMessage}
        </div>
      )}

      {!c.hydrated || !c.settings ? (
        <div className="flex-1 flex items-center justify-center text-sm text-zinc-400">Loading…</div>
      ) : (
        <>
          {activeTab === "live" && (
            <LiveView
              state={c.state}
              cues={c.cues}
              transcript={c.transcript}
              language={c.settings.language}
              translationEnabled={c.settings.translationEnabled}
              targetLanguage={c.settings.targetLanguage}
              accentColor={ACCENT}
              onStart={c.start}
              onPause={c.pause}
              onResume={c.resume}
              onEnd={c.end}
              onPickLanguage={() => setPicker("language")}
              onPickTarget={() => setPicker("target")}
            />
          )}
          {activeTab === "prep" && (
            <PrepNoteView prepNote={c.prepNote} accentColor={ACCENT} onSave={c.setPrepNote} onImport={c.importPrepNote} />
          )}
          {activeTab === "history" && (
            <HistoryView
              history={c.history}
              accentColor={ACCENT}
              onDelete={c.deleteHistory}
              getReview={c.getReview}
              exportReview={c.exportReview}
            />
          )}
          {activeTab === "settings" && (
            <SettingsView
              settings={c.settings}
              accentColor={ACCENT}
              onPickLanguage={() => setPicker("language")}
              onPickTarget={() => setPicker("target")}
              onSetTranslation={c.setTranslation}
              onSetCuesEnabled={c.setCuesEnabled}
              onSetAutoPopup={c.setAutoPopup}
              onSetCueDuration={c.setCueDuration}
              onSetLiveTranscript={c.setLiveTranscript}
              onSetCueLanguage={c.setCueLanguage}
              onSetMicSource={c.setMicSource}
            />
          )}
        </>
      )}

      <BottomNav activeTab={activeTab} onTabChange={setActiveTab} accentColor={ACCENT} />
    </div>
  )
}

export default App
