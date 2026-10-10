/**
 * UI-side language helpers. The table itself lives in shared/languages.ts so
 * the background JSContext can route the no-speech hint and sanitize stored
 * settings against the same list the picker shows.
 *
 * Only languages that can run ON-DEVICE are listed: the six downloadable
 * Sherpa models plus the Apple on-device speech locales. The cloud app's
 * 60-language picker is gone — an entry with no local route would produce a
 * silent, frozen caption screen.
 */

import {chineseScript, LOCAL_LANGUAGES, type LocalLanguage} from "../../shared/languages"

export {chineseScript, engineFor, isLocalLanguageTag, LOCAL_LANGUAGES, toLocalLanguageTag} from "../../shared/languages"
export type {LocalLanguage, LocalSpeechEngine} from "../../shared/languages"

export type Language = LocalLanguage

/**
 * Look up a language by code. Exact tag match first ("zh-TW" -> Traditional),
 * then a script-aware Chinese check so Traditional-script tags the picker
 * doesn't list verbatim ("zh-MO", "zh-Hant") still resolve to the Traditional
 * entry, then the primary subtag so canonicalized tags ("es" -> "es-ES",
 * stored "zh" -> Simplified) resolve to a flag and name instead of falling
 * back to the raw code + white flag.
 */
function findLanguage(code: string): LocalLanguage | undefined {
  const tag = (code ?? "").toLowerCase()
  const exact = LOCAL_LANGUAGES.find((l) => l.code.toLowerCase() === tag)
  if (exact) return exact
  const script = chineseScript(code)
  if (script) return LOCAL_LANGUAGES.find((l) => chineseScript(l.code) === script)
  const primary = tag.split("-")[0]
  return LOCAL_LANGUAGES.find((l) => l.code.split("-")[0].toLowerCase() === primary)
}

export function getLanguageName(code: string): string {
  return findLanguage(code)?.name || code
}

export function getFlagEmoji(code: string): string {
  return findLanguage(code)?.flag || "🏳️"
}
