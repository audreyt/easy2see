import {Platform} from "react-native"

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import {isFeatureEnabled} from "../runtime/bootstrap"
import {localTranslationProbeThrew, resolveAutoTranscriptionEngine, sherpaLanguageCodeForLocale, type TranscriptionEngine} from "./TranscriptionRouting"

/**
 * A forceLocal transcription subscription that needs an on-device engine
 * decision. `key` is `${packageName}|${stream}` so two miniapps subscribing
 * the same stream with different engines resolve independently.
 */
export interface LocalTranscriptionRequest {
  key: string
  packageName: string
  /** Full stream key, e.g. "transcription:zh-TW" or "transcription:auto". */
  stream: string
  /** Language tag after "transcription:" — "auto" when the miniapp did not pin one. */
  language: string
  engine: TranscriptionEngine
}

/** One miniapp subscription whose Apple route cannot run. */
export interface LocalTranscriptionUnavailable {
  packageName: string
  stream: string
  reason: string
}

/**
 * Drives the Apple on-device transcription route (Contract A) for miniapps
 * whose transcription subscriptions carry `forceLocal` with engine "apple" or
 * "auto". Mirrors LocalTranslationCoordinator: probe → activate → unavailable
 * event, never cloud.
 *
 * Resolution per request:
 *  - "sherpa": always Sherpa — the existing LocalSttFallbackCoordinator path.
 *  - "apple": Apple when the native probe says the locale has an on-device
 *    recognizer; otherwise the stream is reported unavailable to the miniapp.
 *  - "auto" (the default): Apple when the probe is positive AND (Sherpa has
 *    no model for the locale OR it is a Traditional/regional Chinese locale
 *    OR the stream is unpinned — the heard language may be zh-TW); else
 *    Sherpa. When Apple is incapable and Sherpa has no model either, the
 *    stream is reported unavailable rather than silently producing nothing.
 *
 * The coordinator never touches the cloud subscription set: Contract A is
 * never-cloud. It publishes the resolved engine map plus the unavailable
 * list to LocalMiniappRuntime, which recounts Sherpa subscriptions and emits
 * the unavailable events on the affected streams.
 *
 * Activation calls `BluetoothSdk.setLocalTranscription(active, locales)`; the
 * bluetooth-sdk native side feeds glasses PCM into the transcribe-only
 * pipeline, which emits `local_transcription` Bridge events tagged
 * `provider: "apple-speech"`. DeviceEventRouter forwards those to
 * `localMiniappRuntime.forwardEvent` with this coordinator providing the
 * subscription-active gate. A `local_transcription_unavailable` Bridge event
 * from a running pipeline marks the probed locales unavailable and
 * reconciles — the affected streams re-resolve to Sherpa or report
 * unavailable to their miniapps.
 */
class LocalTranscriptionCoordinator {
  private static instance: LocalTranscriptionCoordinator

  private desiredRequests: LocalTranscriptionRequest[] = []
  private active = false
  /** Locales passed to the last successful setLocalTranscription(true, …). */
  private activeLocales: string[] = []
  /** Probe verdicts keyed by locale; invalidated by onNativeUnavailable. */
  private probeCache = new Map<string, {available: boolean; reason: string}>()
  /** Locale key + active flag of the last applied native state — skips redundant setLocalTranscription calls. */
  private appliedKey: string | null = null
  private appliedActive = false
  /** Set once a reconcile fully applied; cleared whenever desiredRequests change. */
  private settled = false
  private lastPublished: string | null = null
  private onResolution: ((resolved: Map<string, "apple" | "sherpa">, unavailable: LocalTranscriptionUnavailable[]) => void) | null =
    null
  /** Sherpa model codes (en/fr/de/es/zh/ko), injected by the runtime from STTModelManager. */
  private sherpaCodes: string[] = []

  private constructor() {}

  static getInstance(): LocalTranscriptionCoordinator {
    if (!LocalTranscriptionCoordinator.instance) {
      LocalTranscriptionCoordinator.instance = new LocalTranscriptionCoordinator()
    }
    return LocalTranscriptionCoordinator.instance
  }

  isActive(): boolean {
    return this.active
  }

  /** First active locale — fallback tag for events that omit transcribeLanguage. */
  getActiveLanguage(): string | null {
    return this.activeLocales[0] ?? null
  }

  /**
   * LocalMiniappRuntime registers exactly one handler at construction; the
   * coordinator never imports the runtime, so there is no import cycle.
   */
  setResolutionHandler(
    handler: (resolved: Map<string, "apple" | "sherpa">, unavailable: LocalTranscriptionUnavailable[]) => void,
  ): void {
    this.onResolution = handler
  }

  /** Sherpa model codes from STTModelManager.getAvailableLanguages() — injected, never imported here. */
  setSherpaLanguageCodes(codes: string[]): void {
    this.sherpaCodes = codes
  }

  /** Test-only: clears cached probes and applied state so each case reconciles fresh. */
  resetForTesting(): void {
    this.desiredRequests = []
    this.active = false
    this.activeLocales = []
    this.probeCache.clear()
    this.appliedKey = null
    this.appliedActive = false
    this.settled = false
    this.lastPublished = null
  }

  /**
   * Called by LocalMiniappRuntime.updateCloudSubscriptions with every
   * forceLocal transcription request across connected miniapps.
   */
  onSubscriptionChange(requests: LocalTranscriptionRequest[]): void {
    const key = JSON.stringify(requests)
    if (key !== JSON.stringify(this.desiredRequests)) {
      this.desiredRequests = requests
      this.settled = false
    }
    if (this.settled) return
    void this.reconcile()
  }

  /**
   * Called by DeviceEventRouter when the native pipeline emits
   * `local_transcription_unavailable` (every speech lane gave up). Marks the
   * cached probes for the active locales unavailable and reconciles — Apple
   * requests re-resolve to Sherpa or report unavailable. Ignored while the
   * coordinator is not active — a stale event from a torn-down pipeline must
   * not resurrect anything.
   */
  onNativeUnavailable(reason: string): void {
    if (!this.active) return
    this.log(`native pipeline reported unavailable: ${reason}`)
    for (const locale of this.activeLocales) {
      this.probeCache.set(locale, {available: false, reason})
    }
    this.settled = false
    void this.reconcile()
  }

  private async reconcile(): Promise<void> {
    const requests = this.desiredRequests
    const key = JSON.stringify(requests)
    const platform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "other"
    const appleSupported = platform === "ios" && isFeatureEnabled("onDeviceSpeech")

    const engines = new Map<string, "apple" | "sherpa">()
    const unavailable: LocalTranscriptionUnavailable[] = []
    const activeLocales: string[] = []

    for (const req of requests) {
      if (req.engine === "sherpa") {
        engines.set(req.key, "sherpa")
        continue
      }
      if (!appleSupported) {
        // Android / other platforms and deployments with on-device speech
        // disabled: explicit "apple" is unavailable; "auto" keeps the
        // historical Sherpa route.
        if (req.engine === "apple") {
          unavailable.push({packageName: req.packageName, stream: req.stream, reason: "unsupported-platform"})
        } else {
          engines.set(req.key, "sherpa")
        }
        continue
      }

      const locale = req.language === "auto" || req.language === "*" ? "auto" : req.language
      let verdict = this.probeCache.get(locale)
      if (!verdict) {
        let probed: {available: boolean; reason: string}
        try {
          probed = await BluetoothSdk.probeLocalTranscription([locale])
        } catch (err) {
          // A throw is not "still probing". The likeliest case is JS running
          // against a native build that predates probeLocalTranscription:
          // every call throws. Take the unavailable path; do not cache — the
          // next reconcile should probe again once the native method exists.
          this.log(`probeLocalTranscription failed: ${err}`)
          probed = localTranslationProbeThrew()
        }
        if (probed.reason !== "probe-failed") {
          this.probeCache.set(locale, probed)
        }
        // The probe awaited native work; bail if routing moved on.
        if (JSON.stringify(this.desiredRequests) !== key) {
          this.log("local transcription probe discarded: routing changed during native call")
          return
        }
        verdict = probed
      }

      if (req.engine === "apple") {
        if (verdict.available) {
          engines.set(req.key, "apple")
          if (!activeLocales.includes(locale)) activeLocales.push(locale)
        } else {
          unavailable.push({packageName: req.packageName, stream: req.stream, reason: verdict.reason})
        }
        continue
      }

      // engine "auto"
      const resolved = resolveAutoTranscriptionEngine(req.language, verdict.available, this.sherpaCodes)
      engines.set(req.key, resolved)
      if (resolved === "apple") {
        if (!activeLocales.includes(locale)) activeLocales.push(locale)
      } else if (
        !verdict.available &&
        req.language !== "auto" &&
        req.language !== "*" &&
        sherpaLanguageCodeForLocale(req.language, this.sherpaCodes) === null
      ) {
        // Apple incapable AND Sherpa has no model for this pinned locale —
        // report unavailable rather than silently producing nothing. An
        // unpinned ("auto") stream legitimately falls back to Sherpa's
        // active model, exactly as forceLocal always has.
        unavailable.push({packageName: req.packageName, stream: req.stream, reason: verdict.reason})
      }
    }

    const activate = activeLocales.length > 0
    const localeKey = JSON.stringify(activeLocales)
    if (this.appliedKey !== localeKey || this.appliedActive !== activate) {
      try {
        await BluetoothSdk.setLocalTranscription(activate, activeLocales)
        // Record what the native side actually applied BEFORE checking for a
        // routing change: the call did run (activate or shutdown), so the
        // pipeline now reflects THIS call's args. Leaving appliedKey stale
        // lets a later reconcile skip the native call while reporting the
        // wrong state — e.g. a shutdown superseded by a resubscribe would
        // leave the pipeline dead while the coordinator claims active.
        this.appliedKey = localeKey
        this.appliedActive = activate
        if (JSON.stringify(this.desiredRequests) !== key) {
          this.log("local transcription activation superseded: routing changed during native call")
          void this.reconcile()
          return
        }
      } catch (err) {
        this.log(`setLocalTranscription failed: ${err}`)
        // An Apple route that fails to activate reports unavailable to its
        // miniapps rather than going silent — the engine map still says
        // "apple" so the streams stay off the Sherpa and cloud paths.
        for (const req of requests) {
          if (engines.get(req.key) === "apple") {
            unavailable.push({packageName: req.packageName, stream: req.stream, reason: "activation-failed"})
          }
        }
      }
    }

    this.active = activate
    this.activeLocales = activate ? activeLocales : []
    this.settled = true
    this.publish(key, engines, unavailable)
    this.log(
      activate
        ? `active locales=${localeKey}`
        : unavailable.length > 0
          ? `inactive, ${unavailable.length} unavailable`
          : "inactive",
    )
  }

  /** Idempotent: identical key+resolution never notifies again. */
  private publish(
    key: string,
    engines: Map<string, "apple" | "sherpa">,
    unavailable: LocalTranscriptionUnavailable[],
  ): void {
    const signature = `${key}|${JSON.stringify([...engines])}|${JSON.stringify(unavailable)}`
    if (signature === this.lastPublished) return
    this.lastPublished = signature
    this.onResolution?.(engines, unavailable)
  }

  private log(msg: string): void {
    console.log(`[LocalTranscription] ${msg}`)
  }
}

const localTranscriptionCoordinator = LocalTranscriptionCoordinator.getInstance()
export default localTranscriptionCoordinator
