/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

import {bluetoothSdk} from "./bluetoothSdkTestMock"
import {reactNativePlatform as platform} from "./reactNativeTestMock"

// The coordinator destructures `Platform` at import time, and bun links the
// react-native mock once per process, so every suite mutates the one shared
// object from reactNativeTestMock instead of installing its own.
platform.OS = "ios"
platform.Version = "27.0"

const featureFlags: Record<string, boolean> = {}
// The coordinator lives at src/services/, so bootstrap is ../../runtime — the
// previous "../runtime/bootstrap" specifier resolved nowhere and the mock was
// silently a no-op (the real isFeatureEnabled defaults every flag on).
mock.module("../../runtime/bootstrap", () => ({
  isFeatureEnabled: (name: string) => featureFlags[name] !== false,
}))

// Import AFTER the mocks are registered: the coordinator is a module-level
// singleton that captures `Platform` and the native SDK at import time.
const {default: coordinator} = await import("../LocalTranscriptionCoordinator")

type Verdict = {available: boolean; reason: string}
type Request = {
  key: string
  packageName: string
  stream: string
  language: string
  engine: "auto" | "sherpa" | "apple"
}
type Unavailable = {packageName: string; stream: string; reason: string}

let probeCalls: string[][] = []
let activationCalls: [boolean, string[]][] = []
let resolved: Map<string, "apple" | "sherpa"> = new Map()
let unavailable: Unavailable[] = []

/**
 * `onSubscriptionChange` and `onNativeUnavailable` kick off `reconcile()`
 * without awaiting it; a few microtask turns let the probe + activation
 * chain settle before asserting.
 */
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

/** Distinct language per case: the coordinator caches probe verdicts by locale. */
let seq = 0
const freshLang = () => `x${(++seq).toString(36)}-ZZ`

const req = (
  language: string,
  engine: "auto" | "sherpa" | "apple",
  packageName = "com.test.app",
): Request => ({
  key: `${packageName}|transcription:${language}`,
  packageName,
  stream: `transcription:${language}`,
  language,
  engine,
})

const installProbe = (verdict: Verdict | Error) => {
  bluetoothSdk.probeLocalTranscription = async (locales: string[]) => {
    probeCalls.push(locales)
    if (verdict instanceof Error) throw verdict
    return verdict
  }
}

beforeEach(() => {
  probeCalls = []
  activationCalls = []
  resolved = new Map()
  unavailable = []
  platform.OS = "ios"
  for (const key of Object.keys(featureFlags)) delete featureFlags[key]
  coordinator.resetForTesting()
  bluetoothSdk.setLocalTranscription = async (active: boolean, locales: string[]) => {
    activationCalls.push([active, locales])
  }
  coordinator.setSherpaLanguageCodes(["en", "fr", "de", "es", "zh", "ko"])
  coordinator.setResolutionHandler((engines, unavail) => {
    resolved = engines
    unavailable = unavail
  })
})

describe("local transcription coordinator (Contract A)", () => {
  test("zh-TW auto resolves to apple and activates the native hop", async () => {
    installProbe({available: true, reason: "ok"})
    const r = req("zh-TW", "auto")

    coordinator.onSubscriptionChange([r])
    await settle()

    expect(probeCalls).toEqual([["zh-TW"]])
    expect(activationCalls).toEqual([[true, ["zh-TW"]]])
    expect(coordinator.isActive()).toBe(true)
    expect(resolved.get(r.key)).toBe("apple")
    expect(unavailable).toEqual([])
  })

  test("en auto with a Sherpa model resolves to sherpa and never probes the hop on", async () => {
    installProbe({available: true, reason: "ok"})
    const r = req("en-US", "auto")

    coordinator.onSubscriptionChange([r])
    await settle()

    expect(resolved.get(r.key)).toBe("sherpa")
    // No Apple-resolved locale → the native hop is told to stay off.
    expect(activationCalls).toEqual([[false, []]])
    expect(coordinator.isActive()).toBe(false)
    expect(unavailable).toEqual([])
  })

  test("ja auto resolves to apple — Sherpa has no ja model", async () => {
    installProbe({available: true, reason: "ok"})
    const r = req("ja-JP", "auto")

    coordinator.onSubscriptionChange([r])
    await settle()

    expect(resolved.get(r.key)).toBe("apple")
    expect(activationCalls).toEqual([[true, ["ja-JP"]]])
    expect(unavailable).toEqual([])
  })

  test("explicit sherpa is honored without probing", async () => {
    installProbe({available: true, reason: "ok"})
    const r = req("zh-TW", "sherpa")

    coordinator.onSubscriptionChange([r])
    await settle()

    expect(probeCalls).toEqual([])
    expect(resolved.get(r.key)).toBe("sherpa")
    expect(activationCalls).toEqual([[false, []]])
    expect(unavailable).toEqual([])
  })

  test("explicit apple on Android is unavailable — no probe, no activation", async () => {
    installProbe({available: true, reason: "ok"})
    platform.OS = "android"
    const r = req("en-US", "apple")

    coordinator.onSubscriptionChange([r])
    await settle()

    expect(probeCalls).toEqual([])
    expect(activationCalls).toEqual([[false, []]])
    expect(resolved.get(r.key)).toBeUndefined()
    expect(unavailable).toEqual([
      {packageName: r.packageName, stream: r.stream, reason: "unsupported-platform"},
    ])
  })

  test("explicit apple on iOS with a denied probe reports the native reason", async () => {
    installProbe({available: false, reason: "speech-denied"})
    const r = req("en-US", "apple")

    coordinator.onSubscriptionChange([r])
    await settle()

    expect(activationCalls).toEqual([[false, []]])
    expect(resolved.get(r.key)).toBeUndefined()
    expect(unavailable).toEqual([
      {packageName: r.packageName, stream: r.stream, reason: "speech-denied"},
    ])
  })

  test("auto with Apple incapable and no Sherpa model reports unavailable", async () => {
    installProbe({available: false, reason: "no-on-device-recognizer"})
    const r = req("zh-TW", "auto")

    coordinator.onSubscriptionChange([r])
    await settle()

    // zh-TW → apple in auto, but the probe failed and Sherpa's zh model is
    // Simplified-only: the stream is reported unavailable, never silently
    // routed to a recognizer that would mangle Traditional Chinese.
    expect(resolved.get(r.key)).toBe("sherpa")
    expect(unavailable).toEqual([
      {packageName: r.packageName, stream: r.stream, reason: "no-on-device-recognizer"},
    ])
  })

  test("a late native failure re-resolves apple streams to sherpa or unavailable", async () => {
    installProbe({available: true, reason: "ok"})
    const r = req("ja-JP", "auto")

    coordinator.onSubscriptionChange([r])
    await settle()
    expect(coordinator.isActive()).toBe(true)
    expect(resolved.get(r.key)).toBe("apple")

    coordinator.onNativeUnavailable("speech-recognizer-failed")
    await settle()

    expect(coordinator.isActive()).toBe(false)
    // ja has no Sherpa model → unavailable, not a silent Sherpa route.
    expect(unavailable).toEqual([
      {packageName: r.packageName, stream: r.stream, reason: "speech-recognizer-failed"},
    ])
    expect(activationCalls.at(-1)).toEqual([false, []])
  })

  test("a thrown probe is not cached and resolves auto to sherpa", async () => {
    installProbe(new Error("probeLocalTranscription is not a function"))
    const r = req("en-US", "auto")

    coordinator.onSubscriptionChange([r])
    await settle()

    expect(resolved.get(r.key)).toBe("sherpa")
    expect(unavailable).toEqual([])

    // Not cached: a changed request set reconciles and probes the native
    // side again for the same locale.
    installProbe({available: true, reason: "ok"})
    coordinator.onSubscriptionChange([req("en-US", "auto", "com.test.app2")])
    await settle()

    expect(probeCalls.length).toBe(2)
  })

  test("onDeviceSpeech off resolves auto to sherpa and apple to unavailable", async () => {
    featureFlags["onDeviceSpeech"] = false
    installProbe({available: true, reason: "ok"})
    const autoR = req("en-US", "auto")
    const appleR = req("en-US", "apple", "com.test.other")

    coordinator.onSubscriptionChange([autoR, appleR])
    await settle()

    expect(probeCalls).toEqual([])
    expect(resolved.get(autoR.key)).toBe("sherpa")
    expect(unavailable).toEqual([
      {packageName: appleR.packageName, stream: appleR.stream, reason: "unsupported-platform"},
    ])
  })

  test("a resubscribe during an in-flight shutdown re-activates the pipeline", async () => {
    // Captions' set-language handler unsubscribes then resubscribes within a
    // tick. The [] reconcile's setLocalTranscription(false) is in flight when
    // the resubscribe lands; if that reconcile returns without re-reconciling,
    // appliedKey stays stale and the [zh-TW] reconcile skips re-activation —
    // the pipeline stays dead while the coordinator reports active.
    installProbe({available: true, reason: "ok"})
    const r = req("zh-TW", "auto")

    coordinator.onSubscriptionChange([r])
    await settle()
    expect(coordinator.isActive()).toBe(true)
    expect(activationCalls).toEqual([[true, ["zh-TW"]]])

    // Gate the next native call so the resubscribe lands mid-flight.
    let release: (() => void) | null = null
    let gated = false
    bluetoothSdk.setLocalTranscription = async (active: boolean, locales: string[]) => {
      activationCalls.push([active, locales])
      if (gated) return
      gated = true
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    coordinator.onSubscriptionChange([])
    // Let the [] reconcile reach its await, then resubscribe before it resumes.
    await settle()
    coordinator.onSubscriptionChange([r])
    release?.()
    await settle()

    // The shutdown applied, then the superseded reconcile re-ran and
    // re-activated — the pipeline must not be left dead.
    expect(activationCalls).toEqual([
      [true, ["zh-TW"]],
      [false, []],
      [true, ["zh-TW"]],
    ])
    expect(coordinator.isActive()).toBe(true)
  })
})
