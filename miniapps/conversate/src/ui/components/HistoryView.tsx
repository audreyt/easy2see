import {Download, Search, Trash2} from "lucide-react"
import {useState} from "react"

import type {SessionRecordMeta} from "../../shared/types"

interface HistoryViewProps {
  history: SessionRecordMeta[]
  accentColor: string
  onDelete: (id: string) => void
  getReview: (id: string) => Promise<{markdown: string | null; error?: string}>
  exportReview: (id: string) => Promise<{uri?: string; error?: string}>
}

/**
 * History — past conversations stored on-device (design §4). Tapping a
 * record opens its rendered Markdown review; export re-sends it to Files.
 */
export function HistoryView({history, accentColor, onDelete, getReview, exportReview}: HistoryViewProps) {
  const [query, setQuery] = useState("")
  const [openId, setOpenId] = useState<string | null>(null)
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const filtered = history.filter((r) => r.title.toLowerCase().includes(query.trim().toLowerCase()))

  const open = async (id: string) => {
    if (openId === id) {
      setOpenId(null)
      setMarkdown(null)
      return
    }
    setOpenId(id)
    setMarkdown(null)
    const res = await getReview(id)
    setMarkdown(res.markdown ?? res.error ?? "Review unavailable")
  }

  const doExport = async (id: string) => {
    const res = await exportReview(id)
    setNotice(res.uri ? `Exported to Files: ${res.uri}` : (res.error ?? "Export failed"))
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 px-4 py-3 gap-2">
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
        <Search className="w-4 h-4 text-zinc-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search past conversations"
          className="flex-1 bg-transparent text-sm text-zinc-900 dark:text-zinc-100 outline-none"
        />
      </div>
      {notice && <div className="text-xs text-zinc-500 px-1">{notice}</div>}
      <div className="flex-1 overflow-y-auto scrollbar-hide flex flex-col gap-2">
        {filtered.length === 0 && (
          <div className="text-sm text-zinc-400 text-center py-8">No past conversations yet.</div>
        )}
        {filtered.map((rec) => (
          <div key={rec.id} className="rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
            <button onClick={() => void open(rec.id)} className="w-full text-left px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex-1">{rec.title}</span>
                <span className="text-[10px] text-zinc-400">
                  {new Date(rec.startedAt).toLocaleDateString()} {new Date(rec.startedAt).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}
                </span>
              </div>
              <div className="text-xs text-zinc-500 mt-0.5">
                {rec.finalCount} lines · {rec.cueCount} cues{rec.exported ? " · in Files" : ""}
              </div>
            </button>
            {openId === rec.id && (
              <div className="border-t border-zinc-100 dark:border-zinc-800 px-3 py-2">
                <div className="flex gap-2 pb-2">
                  <button
                    onClick={() => void doExport(rec.id)}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-white"
                    style={{backgroundColor: accentColor}}>
                    <Download className="w-3.5 h-3.5" /> Export to Files
                  </button>
                  <button
                    onClick={() => onDelete(rec.id)}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300">
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                </div>
                <pre className="text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap selectable-text max-h-72 overflow-y-auto scrollbar-hide">
                  {markdown ?? "Loading…"}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
