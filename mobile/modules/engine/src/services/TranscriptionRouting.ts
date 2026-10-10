export interface TranscriptionRouteSummary {
  hasCloudSubscriber: boolean
  hasForceLocalSubscriber: boolean
}

export interface TranscriptionSubscriberRoutes {
  cloud: boolean
  forceLocal: boolean
}

export type TranscriptionDeliveryRoute = "default" | "forceLocal" | "all"

export function summarizeTranscriptionRoutes<T>(
  subscribers: Iterable<T>,
  routesFor: (subscriber: T) => TranscriptionSubscriberRoutes,
): TranscriptionRouteSummary {
  let hasCloudSubscriber = false
  let hasForceLocalSubscriber = false
  for (const subscriber of subscribers) {
    const routes = routesFor(subscriber)
    if (routes.cloud) hasCloudSubscriber = true
    if (routes.forceLocal) hasForceLocalSubscriber = true
  }
  return {hasCloudSubscriber, hasForceLocalSubscriber}
}

export function transcriptionDeliveryRoute(
  source: "cloud" | "local",
  routes: TranscriptionSubscriberRoutes,
  cloudConnected: boolean,
): TranscriptionDeliveryRoute | null {
  if (source === "cloud") return routes.cloud ? "default" : null
  if (cloudConnected) return routes.forceLocal ? "forceLocal" : null
  if (routes.cloud && routes.forceLocal) return "all"
  if (routes.forceLocal) return "forceLocal"
  return routes.cloud ? "default" : null
}

// ---------------------------------------------------------------------------
// Translation streams (`translation:<source>:<target>`)
//
// Translation subscriptions carry the same cloud/forceLocal routing flags as
// transcription. A forceLocal translation subscription is served by the
// on-device Apple Speech + Translation pipeline (the Easy2Say stack) and must
// never reach the cloud worker — Soniox collapses script-specific Chinese
// targets (zh-TW → zh) into a single Chinese output.
// ---------------------------------------------------------------------------

export interface TranslationPair {
  /** Wire tag or "*" / "auto" for any-source subscriptions. */
  source: string
  /** Wire tag or "*" for any-target subscriptions. */
  target: string
}

/**
 * Parse a `translation:<source>:<target>` stream key. Returns null for
 * malformed keys (`translation:auto`, `translation:*`, bare `translation`).
 */
export function translationPairFromStream(stream: string): TranslationPair | null {
  if (!stream.startsWith("translation:")) return null
  const parts = stream.split(":")
  if (parts.length !== 3) return null
  const [, source, target] = parts
  if (!source || !target) return null
  return {source, target}
}

/**
 * Every subscription pattern that matches a concrete
 * `translation:<source>:<target>` event key — the same set
 * `LocalMiniappRuntime.forwardEvent` fans out to. Used to decide which
 * delivery routes a subscriber asked for when a local event arrives under a
 * wildcard subscription.
 */
export function translationRoutePatterns(stream: string): string[] {
  const pair = translationPairFromStream(stream)
  if (!pair) return ["translation:auto"]
  return [
    stream,
    "translation:auto",
    "translation:*:*",
    `translation:*:${pair.target}`,
    `translation:${pair.source}:*`,
  ]
}

/**
 * The (source, target) pairs a local pipeline must serve for a set of
 * forceLocal translation subscriptions. Wildcard sources collapse to "auto"
 * (the pipeline arbitrates across its installed speech locales); wildcard
 * targets are dropped — a local pipeline needs a concrete target language.
 */
export function localTranslationPairs(streams: Iterable<string>): TranslationPair[] {
  const seen = new Set<string>()
  const pairs: TranslationPair[] = []
  for (const stream of streams) {
    const pair = translationPairFromStream(stream)
    if (!pair || pair.target === "*") continue
    const source = pair.source === "*" ? "auto" : pair.source
    const key = `${source}${pair.target}`
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push({source, target: pair.target})
  }
  return pairs
}

// ---------------------------------------------------------------------------
// iOS local-translation availability → cloud fallback policy
//
// A forceLocal translation pair is served by the on-device pipeline only when
// the iOS probe says it can run. When the probe is unavailable — or the
// pipeline later reports `local_translation_unavailable` — the pair goes back
// onto the cloud subscription set. The cloud path is Soniox, which collapses
// script-specific Chinese targets (zh-TW → zh); the captain accepted that
// fidelity loss over a silent hop. Android translation is knowingly dropped
// (AC-3): it never probes and never cloud-fallbacks.
// ---------------------------------------------------------------------------

/**
 * Whether a forceLocal translation subscription falls back to the cloud.
 * iOS falls back only when the availability probe says the on-device hop
 * cannot run; every other platform never falls back.
 */

/** Verdict used when `probeLocalTranslation` throws (missing native method, bridge failure). */
export function localTranslationProbeThrew(): {available: false; reason: "probe-failed"} {
  return {available: false, reason: "probe-failed"}
}

export function localTranslationUsesCloudFallback(
  platform: "ios" | "android" | "other",
  probeAvailable: boolean,
): boolean {
  if (platform !== "ios") return false
  return !probeAvailable
}

/**
 * Route flags with the cloud-fallback verdict applied: while the local
 * pipeline is unavailable, a forceLocal subscriber also counts as a cloud
 * subscriber — the pair joins the cloud subscription set and
 * `transcriptionDeliveryRoute("cloud", …)` stops returning null for it.
 */
export function translationRoutesWithCloudFallback(
  routes: TranscriptionSubscriberRoutes,
  cloudFallback: boolean,
): TranscriptionSubscriberRoutes {
  if (!cloudFallback || !routes.forceLocal) return routes
  return {cloud: true, forceLocal: routes.forceLocal}
}

// ---------------------------------------------------------------------------
// Contract A — Apple on-device transcription route
//
// A forceLocal transcription subscription may request an on-device engine:
// "sherpa" (the SherpaOnnx lane that forceLocal always used), "apple" (the
// Apple Speech lanes shared with LocalTranslationPipeline, transcribe-only),
// or "auto" (default): Apple when the locale is Apple-on-device-capable AND
// (Sherpa has no model for it OR it is a Traditional/regional Chinese locale);
// else Sherpa. Apple-routed streams never fall back to cloud — an unavailable
// Apple route surfaces a visible unavailable event instead.
// ---------------------------------------------------------------------------

const TRADITIONAL_CHINESE_MARKERS: Record<string, true> = {hant: true, tw: true, hk: true, mo: true}

export type TranscriptionEngine = "auto" | "sherpa" | "apple"

/**
 * "hant" / "hans" / null — mirrors LocalTranslationLocales.chineseScript on
 * the native side: explicit Hant/Hans subtags or Traditional-script regions
 * (TW/HK/MO) are Traditional; bare zh defaults to Simplified (zh-CN
 * canonical, which is what the Sherpa zh model covers).
 */
export function chineseScript(tag: string): "hant" | "hans" | null {
  const subtags = tag.toLowerCase().split("-")
  if (subtags[0] !== "zh") return null
  return subtags.slice(1).some((s) => TRADITIONAL_CHINESE_MARKERS[s] === true) ? "hant" : "hans"
}

/**
 * Map a transcription stream language tag to a Sherpa model code, or null
 * when no Sherpa model can serve it. Traditional Chinese maps to null even
 * though a "zh" model exists — that model is Simplified (zh-CN).
 */
export function sherpaLanguageCodeForLocale(
  language: string,
  sherpaCodes: Iterable<string>,
): string | null {
  if (chineseScript(language) === "hant") return null
  const base = language.toLowerCase().split("-")[0]
  for (const code of sherpaCodes) {
    if (code === base) return code
  }
  return null
}

/**
 * Contract A auto resolution. `appleCapable` is the native probe verdict for
 * the stream's locale(s) — the coordinator owns probing; this function is the
 * pure policy so bun test locks it.
 *
 * `language` is the stream's language tag; "auto"/"*" means the miniapp did
 * not pin one. An unpinned stream resolves to Apple when the device can run
 * it: the heard language is unknown, so it may be Traditional Chinese, which
 * the Simplified-only Sherpa zh model would silently mangle.
 */
export function resolveAutoTranscriptionEngine(
  language: string,
  appleCapable: boolean,
  sherpaCodes: Iterable<string>,
): "apple" | "sherpa" {
  if (!appleCapable) return "sherpa"
  if (language === "auto" || language === "*") return "apple"
  const sherpaCode = sherpaLanguageCodeForLocale(language, sherpaCodes)
  if (sherpaCode === null || chineseScript(language) === "hant") return "apple"
  return "sherpa"
}

/**
 * Delivery route for a `local_transcription` event, keyed by the event's
 * provider. Apple events deliver only to subscribers whose forceLocal stream
 * resolved to the Apple engine — never as a cloud substitute, never to
 * Sherpa-routed listeners. Sherpa events keep the historical semantics
 * (forceLocal subscribers, plus every subscriber while the cloud is down)
 * but never reach Apple-resolved subscribers: Apple is strictly opt-in, so
 * a Sherpa transcript must not silently stand in for it.
 */
export function localTranscriptionDeliveryRoute(
  provider: "apple-speech" | "sherpa",
  routes: TranscriptionSubscriberRoutes,
  appleResolved: boolean,
  cloudConnected: boolean,
): TranscriptionDeliveryRoute | null {
  if (provider === "apple-speech") {
    return routes.forceLocal && appleResolved ? "forceLocal" : null
  }
  if (appleResolved) return null
  return transcriptionDeliveryRoute("local", routes, cloudConnected)
}

/**
 * Per-subscriber subscription counting for a transcription stream, with the
 * Contract A engine resolution applied. An Apple-resolved forceLocal
 * subscriber counts toward NEITHER the Sherpa local-STT set NOR the cloud
 * set — it drives the transcribe-only Apple pipeline and never falls back
 * to cloud. A Sherpa-resolved (or unresolved) forceLocal subscriber counts
 * exactly as forceLocal always has.
 */
export function transcriptionSubscriberCounts(
  routes: TranscriptionSubscriberRoutes,
  resolvedEngine: "apple" | "sherpa",
): {sherpa: boolean; cloud: boolean} {
  if (routes.forceLocal && resolvedEngine === "apple") return {sherpa: false, cloud: false}
  return {sherpa: routes.forceLocal, cloud: routes.cloud}
}
