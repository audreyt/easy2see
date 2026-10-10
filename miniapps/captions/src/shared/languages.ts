/**
 * Shared local-language table referenced by BOTH the background JSContext and
 * the UI WebView (same build-time inlining rule as shared/types.ts).
 *
 * Easy2See captions run on-device only. Two engines can serve a subscription:
 *
 *   "sherpa" — the downloadable Sherpa-ONNX streaming models. The host's
 *              STTModelManager ships exactly six: en, fr, de, es, zh (its zh
 *              model emits Simplified Chinese), ko. Each needs a one-time
 *              model download (Settings › Speech in the host app).
 *   "apple"  — Apple Speech lanes with requiresOnDeviceRecognition (the
 *              LocalTranslationPipeline locale table). zh-TW/zh-HK/zh-MO/
 *              zh-Hant* all resolve to the zh-TW lane, so Traditional Chinese
 *              is genuinely Traditional here — unlike the Sherpa zh model.
 *
 * `engine: "auto"` on the subscription lets the host pick: Apple when the
 * locale is Apple-capable and Sherpa lacks it (or it is a Traditional/
 * regional Chinese locale), else Sherpa. `engineFor` below mirrors that
 * routing so the UI and the no-speech hint can say which engine — and which
 * remedy — applies.
 *
 * Codes are the platform registry's subscription tags
 * (SUPPORTED_TRANSCRIPTION_LANGUAGES): bare codes canonicalize to the
 * registry default, so Chinese is split into zh-CN / zh-TW / zh-HK and
 * Portuguese/Norwegian/Arabic use the registry tags that match Apple's
 * recognizer ids (pt-BR, nb-NO, ar-SA).
 */

export type LocalSpeechEngine = "sherpa" | "apple"

export interface LocalLanguage {
  /** Registry subscription tag passed to transcription.forLanguage. */
  code: string
  name: string
  nativeName?: string
  flag: string
  /** Which on-device engine `engine:"auto"` routes this tag to. */
  engine: LocalSpeechEngine
  /** True when the engine needs a one-time model download before it can run. */
  needsDownload: boolean
}

const sherpa = (code: string, name: string, nativeName: string, flag: string): LocalLanguage => ({
  code,
  name,
  nativeName,
  flag,
  engine: "sherpa",
  needsDownload: true,
})

const apple = (code: string, name: string, nativeName: string, flag: string): LocalLanguage => ({
  code,
  name,
  nativeName,
  flag,
  engine: "apple",
  needsDownload: false,
})

/**
 * Every language that can run on-device, sorted by English name. Anything not
 * listed here has no local route and must not be offered — a picker entry
 * that silently produces no transcript is worse than no entry.
 */
export const LOCAL_LANGUAGES: LocalLanguage[] = [
  apple("ar-SA", "Arabic", "العربية", "🇸🇦"),
  apple("ca-ES", "Catalan", "Català", "🇪🇸"),
  sherpa("zh-CN", "Chinese (Simplified)", "简体中文", "🇨🇳"),
  apple("zh-TW", "Chinese (Traditional)", "繁體中文", "🇹🇼"),
  apple("zh-HK", "Chinese (Traditional, Hong Kong)", "繁體中文", "🇭🇰"),
  apple("hr-HR", "Croatian", "Hrvatski", "🇭🇷"),
  apple("cs-CZ", "Czech", "Čeština", "🇨🇿"),
  apple("da-DK", "Danish", "Dansk", "🇩🇰"),
  apple("nl-NL", "Dutch", "Nederlands", "🇳🇱"),
  sherpa("en-US", "English", "English", "🇺🇸"),
  apple("fi-FI", "Finnish", "Suomi", "🇫🇮"),
  sherpa("fr-FR", "French", "Français", "🇫🇷"),
  sherpa("de-DE", "German", "Deutsch", "🇩🇪"),
  apple("el-GR", "Greek", "Ελληνικά", "🇬🇷"),
  apple("he-IL", "Hebrew", "עברית", "🇮🇱"),
  apple("hi-IN", "Hindi", "हिन्दी", "🇮🇳"),
  apple("hu-HU", "Hungarian", "Magyar", "🇭🇺"),
  apple("id-ID", "Indonesian", "Bahasa Indonesia", "🇮🇩"),
  apple("it-IT", "Italian", "Italiano", "🇮🇹"),
  apple("ja-JP", "Japanese", "日本語", "🇯🇵"),
  sherpa("ko-KR", "Korean", "한국어", "🇰🇷"),
  apple("ms-MY", "Malay", "Bahasa Melayu", "🇲🇾"),
  apple("nb-NO", "Norwegian", "Norsk", "🇳🇴"),
  apple("pl-PL", "Polish", "Polski", "🇵🇱"),
  apple("pt-BR", "Portuguese", "Português", "🇧🇷"),
  apple("ro-RO", "Romanian", "Română", "🇷🇴"),
  apple("ru-RU", "Russian", "Русский", "🇷🇺"),
  apple("sk-SK", "Slovak", "Slovenčina", "🇸🇰"),
  sherpa("es-ES", "Spanish", "Español", "🇪🇸"),
  apple("sv-SE", "Swedish", "Svenska", "🇸🇪"),
  apple("th-TH", "Thai", "ไทย", "🇹🇭"),
  apple("tr-TR", "Turkish", "Türkçe", "🇹🇷"),
  apple("uk-UA", "Ukrainian", "Українська", "🇺🇦"),
  apple("vi-VN", "Vietnamese", "Tiếng Việt", "🇻🇳"),
]

/** Traditional-script markers: explicit Hant, or a Traditional-script region. */
const TRADITIONAL_ZH_SUBTAGS: Record<string, true> = {hant: true, tw: true, hk: true, mo: true}

/**
 * Which written form of Chinese a BCP-47 tag denotes, or null for non-Chinese
 * tags. "zh", "zh-CN", "zh-Hans", "zh-SG" -> "hans"; "zh-TW", "zh-HK",
 * "zh-MO", "zh-Hant", "zh-Hant-TW" -> "hant". Bare "zh" defaults to "hans"
 * because the platform registry canonicalizes "zh" -> "zh-CN".
 */
export function chineseScript(code: string | undefined): "hans" | "hant" | null {
  const subtags = (code ?? "").toLowerCase().split("-")
  if (subtags[0] !== "zh") return null
  return subtags.slice(1).some((s) => TRADITIONAL_ZH_SUBTAGS[s]) ? "hant" : "hans"
}

/**
 * Normalize a stored/entered language value to a local subscription tag, or
 * null when nothing on-device can serve it. Exact tag first, then the
 * script-aware Chinese check (zh-Hant/zh-MO -> zh-TW, zh/zh-Hans -> zh-CN),
 * then the primary subtag ("en" -> "en-US").
 */
export function toLocalLanguageTag(code: string | undefined): string | null {
  const tag = (code ?? "").trim()
  if (!tag) return null
  const exact = LOCAL_LANGUAGES.find((l) => l.code.toLowerCase() === tag.toLowerCase())
  if (exact) return exact.code
  const script = chineseScript(tag)
  if (script) return script === "hant" ? "zh-TW" : "zh-CN"
  const primary = tag.toLowerCase().split("-")[0]
  return LOCAL_LANGUAGES.find((l) => l.code.split("-")[0].toLowerCase() === primary)?.code ?? null
}

/** True when the tag can be served by an on-device engine. */
export function isLocalLanguageTag(code: string | undefined): boolean {
  return toLocalLanguageTag(code) !== null
}

/**
 * Which engine `engine:"auto"` routes a tag to — mirrors the host's Contract A
 * rule (Apple for Traditional/regional Chinese and for locales Sherpa lacks,
 * Sherpa otherwise). Unknown/"auto" resolves to "sherpa": the current host
 * serves every forceLocal subscription from the Sherpa model.
 */
export function engineFor(code: string | undefined): LocalSpeechEngine {
  const tag = toLocalLanguageTag(code)
  if (!tag) return "sherpa"
  return LOCAL_LANGUAGES.find((l) => l.code === tag)?.engine ?? "sherpa"
}
