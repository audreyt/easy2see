/**
 * Shared language-tag helpers referenced by BOTH the background JSContext and
 * the UI WebView (same build-time inlining rule as shared/types.ts).
 *
 * The platform registry (cloud-v2/packages/protocol/src/languages.ts) keys
 * Chinese subscription tags by region — "zh-CN" (canonical for bare "zh"),
 * "zh-TW", "zh-HK" — and never emits a script subtag. But provider events and
 * stored settings can carry script forms ("zh-Hant", "zh-Hant-TW"), and a
 * primary-subtag compare cannot tell Simplified from Traditional. This helper
 * is the single place that decides which side of that split a tag lands on.
 */

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
