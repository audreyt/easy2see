import {Platform} from "react-native"

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import {isFeatureEnabled} from "../runtime/bootstrap"
import {localTranslationProbeThrew, localTranslationUsesCloudFallback, type TranslationPair} from "./TranscriptionRouting"

/**
 * Drives the on-device Apple Speech + Translation pipeline (the Easy2Say
 * stack) for miniapps whose translation subscriptions carry `forceLocal`.
 *
 * Unlike local STT this is strictly opt-in: cloud translation stays the
 * default for every other miniapp. On iOS the coordinator probes the native
 * side (`BluetoothSdk.probeLocalTranslation`) before activating: iOS < 18,
 * denied speech authorization, no on-device recognizer, or an unsupported /
 * not-yet-installed translation pair all report unavailable, and the pair
 * falls back to the cloud subscription set (Soniox — which collapses
 * script-specific Chinese targets like zh-TW → zh; availability beats
 * fidelity there). A thrown `probeLocalTranslation` (missing native method) is reason `probe-failed` and takes that same fallback without being cached. A `local_translation_unavailable` Bridge event from a
 * running pipeline (prepare/translate threw, or the TranslationSession never
 * arrived) marks the cached probe unavailable and reconciles into the same
 * fallback. Android translation is knowingly dropped (AC-3): no probe, no
 * local hop, no cloud fallback.
 *
 * Activation calls `BluetoothSdk.setLocalTranslation(active, pairs)`; the
 * bluetooth-sdk native side feeds glasses PCM into the pipeline, which emits
 * `local_translation` Bridge events. DeviceEventRouter forwards those to
 * `localMiniappRuntime.forwardEvent` with this coordinator providing the
 * subscription-active gate so translations are never published to miniapps
 * that aren't asking for them.
 */
class LocalTranslationCoordinator {
  private static instance: LocalTranslationCoordinator

  private desiredPairs: TranslationPair[] = []
  private active = false
  /** Probe verdicts keyed by JSON pair list; invalidated by onNativeUnavailable. */
  private probeCache = new Map<string, {available: boolean; reason: string}>()
  /** Pair key + active flag of the last applied native state — skips redundant setLocalTranslation calls. */
  private appliedKey: string | null = null
  private appliedActive = false
  /** Set once a reconcile fully applied; cleared whenever desiredPairs change. */
  private settled = false
  private lastPublished: string | null = null
  private onCloudFallbackChange: ((cloudFallback: boolean) => void) | null = null

  private constructor() {}

  static getInstance(): LocalTranslationCoordinator {
    if (!LocalTranslationCoordinator.instance) {
      LocalTranslationCoordinator.instance = new LocalTranslationCoordinator()
    }
    return LocalTranslationCoordinator.instance
  }

  isActive(): boolean {
    return this.active
  }

  /** First requested target language — fallback tag for events that omit it. */
  getActiveTarget(): string | null {
    return this.desiredPairs[0]?.target ?? null
  }

  /**
   * LocalMiniappRuntime registers exactly one handler at construction; the
   * coordinator never imports the runtime, so there is no import cycle.
   */
  setCloudFallbackHandler(handler: (cloudFallback: boolean) => void): void {
    this.onCloudFallbackChange = handler
  }

  /**
   * Called by LocalMiniappRuntime.updateCloudSubscriptions with the union of
   * every forceLocal translation pair across connected miniapps.
   */
  onSubscriptionChange(pairs: TranslationPair[]): void {
    const key = JSON.stringify(pairs)
    if (key !== JSON.stringify(this.desiredPairs)) {
      this.desiredPairs = pairs
      this.settled = false
    }
    if (this.settled && this.active === this.shouldBeActive()) return
    void this.reconcile()
  }

  /**
   * Called by DeviceEventRouter when the native pipeline emits
   * `local_translation_unavailable` (prepare/translate threw, or the
   * TranslationSession never arrived). Marks the cached probe for the
   * current pairs unavailable and reconciles into the iOS cloud fallback.
   * Ignored while the coordinator is not active — a stale event from a
   * torn-down pipeline must not resurrect anything.
   */
  onNativeUnavailable(reason: string): void {
    if (!this.active) return
    this.log(`native pipeline reported unavailable: ${reason}`)
    this.probeCache.set(JSON.stringify(this.desiredPairs), {available: false, reason})
    this.settled = false
    void this.reconcile()
  }

  private shouldBeActive(): boolean {
    return this.desiredPairs.length > 0 && isFeatureEnabled("onDeviceSpeech")
  }

  private async reconcile(): Promise<void> {
    const pairs = this.desiredPairs
    const key = JSON.stringify(pairs)
    const shouldBeActive = this.shouldBeActive()
    const platform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "other"

    let activate = shouldBeActive
    let fallback = false
    let probeReason: string | null = null
    if (shouldBeActive && platform === "ios") {
      let verdict = this.probeCache.get(key)
      if (!verdict) {
        // Fresh binding. Assigning the outer `verdict` inside try/catch leaves
        // it `T | undefined`: it was undefined on entry, and tsc keeps that.
        let probed: {available: boolean; reason: string}
        try {
          probed = await BluetoothSdk.probeLocalTranslation(pairs)
        } catch (err) {
          // A throw is not "still probing". The likeliest case is JS running
          // against a native build that predates probeLocalTranslation: every
          // call throws, and the pair is already off the cloud set. Take the
          // same iOS unavailable path as a negative probe. Do not cache it —
          // the next reconcile should probe again once the native method exists.
          this.log(`probeLocalTranslation failed: ${err}`)
          probed = localTranslationProbeThrew()
        }
        if (probed.reason !== "probe-failed") {
          this.probeCache.set(key, probed)
        }
        // The probe awaited native work; bail if routing moved on.
        if (JSON.stringify(this.desiredPairs) !== key || this.shouldBeActive() !== shouldBeActive) {
          this.log("local translation probe discarded: routing changed during native call")
          return
        }
        verdict = probed
      }
      activate = verdict.available
      fallback = localTranslationUsesCloudFallback(platform, verdict.available)
      probeReason = verdict.reason
    } else if (shouldBeActive) {
      // Android / other: translation is knowingly dropped — no probe, no
      // local hop, and (per localTranslationUsesCloudFallback) no cloud
      // fallback.
      fallback = localTranslationUsesCloudFallback(platform, false)
    }

    // Local-only deployments (auth.mode "local", e.g. Easy2See) have no cloud
    // to fall back to: an unavailable on-device hop produces no translation
    // rather than opening a cloud path that cannot exist.
    if (!isFeatureEnabled("cloudSpeech")) fallback = false
    if (this.appliedKey !== key || this.appliedActive !== activate) {
      try {
        await BluetoothSdk.setLocalTranslation(activate, pairs, probeReason)
        // Record what the native side actually applied BEFORE checking for a
        // routing change: the call did run (activate or shutdown), so the
        // pipeline now reflects THIS call's args. Leaving appliedKey stale
        // lets a later reconcile skip the native call while reporting the
        // wrong state — e.g. a shutdown superseded by a resubscribe would
        // leave the pipeline dead while the coordinator claims active.
        this.appliedKey = key
        this.appliedActive = activate
        if (JSON.stringify(this.desiredPairs) !== key || this.shouldBeActive() !== shouldBeActive) {
          this.log("local translation activation superseded: routing changed during native call")
          void this.reconcile()
          return
        }
      } catch (err) {
        this.log(`setLocalTranslation failed: ${err}`)
        // An available probe that fails to activate stays unsettled and retries.
        // An iOS cloud-fallback verdict (including probe-failed) still publishes
        // below — native teardown being missing must not leave the pair off both paths.
        if (!fallback) return
      }
    }

    this.active = activate
    this.settled = true
    this.publish(key, activate, fallback)
    this.log(
      activate ? `active pairs=${key}` : fallback ? `cloud fallback (${probeReason ?? "unavailable"})` : "inactive",
    )
  }

  /** Idempotent: identical key+active+fallback never notifies again. */
  private publish(key: string, active: boolean, cloudFallback: boolean): void {
    const signature = `${key}|${active}|${cloudFallback}`
    if (signature === this.lastPublished) return
    this.lastPublished = signature
    this.onCloudFallbackChange?.(cloudFallback)
  }

  private log(msg: string): void {
    console.log(`[LocalTranslation] ${msg}`)
  }
}

const localTranslationCoordinator = LocalTranslationCoordinator.getInstance()
export default localTranslationCoordinator
