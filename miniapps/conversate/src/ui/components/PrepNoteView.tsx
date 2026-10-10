import {FileUp} from "lucide-react"
import {useEffect, useState} from "react"

const PREP_NOTE_MAX_CHARS = 5000

interface PrepNoteViewProps {
  prepNote: string
  accentColor: string
  onSave: (text: string) => void
  onImport: () => Promise<{text: string | null; error?: string}>
}

/**
 * Prep-Note editor (design §4): paste or import a .txt, ≤5,000 chars. The
 * background turns it into cue-trigger keywords and prompt excerpts.
 */
export function PrepNoteView({prepNote, accentColor, onSave, onImport}: PrepNoteViewProps) {
  const [draft, setDraft] = useState(prepNote)
  const [importError, setImportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => setDraft(prepNote), [prepNote])

  const remaining = PREP_NOTE_MAX_CHARS - draft.length

  const handleImport = async () => {
    setImporting(true)
    setImportError(null)
    try {
      const res = await onImport()
      if (res.error) setImportError(res.error)
      // res.text arrives via the conversate:prep-note broadcast.
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 px-4 py-3 gap-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Prep Note</div>
          <div className="text-xs text-zinc-500">
            Context the on-device AI uses for cues — keywords in the note also trigger a cue when spoken.
          </div>
        </div>
        <button
          onClick={handleImport}
          disabled={importing}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-sm">
          <FileUp className="w-4 h-4" /> {importing ? "Importing…" : "Import .txt"}
        </button>
      </div>
      {importError && <div className="text-xs text-red-600 dark:text-red-400">{importError}</div>}
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, PREP_NOTE_MAX_CHARS))}
        placeholder="Paste meeting context: who's in the room, topics, names, jargon…"
        className="flex-1 min-h-0 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-3 text-sm text-zinc-900 dark:text-zinc-100 outline-none resize-none"
      />
      <div className="flex items-center justify-between">
        <span className={`text-xs ${remaining < 250 ? "text-amber-600" : "text-zinc-400"}`}>
          {draft.length.toLocaleString()} / {PREP_NOTE_MAX_CHARS.toLocaleString()}
        </span>
        <button
          onClick={() => onSave(draft)}
          className="px-4 py-2 rounded-xl text-white text-sm font-semibold"
          style={{backgroundColor: accentColor}}>
          Save note
        </button>
      </div>
    </div>
  )
}
