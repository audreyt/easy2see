import {Check, Search, X} from "lucide-react"
import {useState} from "react"

import {TARGET_LANGUAGES, getFlagEmoji, getLanguageName} from "../lib/languages"

interface LanguagePickerProps {
  title: string
  current: string
  accentColor?: string
  onSave: (code: string) => void
  onCancel: () => void
}

/**
 * zh-TW-aware language picker — same list as the translation miniapp's
 * selector (the module is copied, not imported across miniapps).
 */
export function LanguagePicker({title, current, accentColor = "#4F46E5", onSave, onCancel}: LanguagePickerProps) {
  const [selected, setSelected] = useState(current)
  const [searchQuery, setSearchQuery] = useState("")

  const filtered = TARGET_LANGUAGES.filter(
    (lang) =>
      lang.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lang.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (lang.nativeName && lang.nativeName.toLowerCase().includes(searchQuery.toLowerCase())),
  )

  return (
    <div className="flex flex-col h-full bg-zinc-100 dark:bg-zinc-950">
      <div className="px-4 pt-4 pb-2 flex items-center justify-between">
        <span className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</span>
        <button aria-label="Close" onClick={onCancel} className="p-1">
          <X className="w-5 h-5 text-zinc-500" />
        </button>
      </div>
      <div className="px-4 pb-2">
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
          <Search className="w-4 h-4 text-zinc-400" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search languages"
            className="flex-1 bg-transparent text-sm text-zinc-900 dark:text-zinc-100 outline-none"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-hide px-2 pb-24">
        {filtered.map((lang) => (
          <button
            key={lang.code}
            onClick={() => setSelected(lang.code)}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-white dark:hover:bg-zinc-900">
            <span className="text-xl">{lang.flag}</span>
            <span className="flex-1">
              <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{lang.name}</span>
              {lang.nativeName && lang.nativeName !== lang.name && (
                <span className="block text-xs text-zinc-500">{lang.nativeName}</span>
              )}
            </span>
            {selected === lang.code && <Check className="w-4 h-4" style={{color: accentColor}} />}
          </button>
        ))}
      </div>
      <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-zinc-100 dark:from-zinc-950">
        <button
          onClick={() => onSave(selected)}
          className="w-full py-3 rounded-2xl text-white font-semibold"
          style={{backgroundColor: accentColor}}>
          Use {getLanguageName(selected)} {getFlagEmoji(selected)}
        </button>
      </div>
    </div>
  )
}
