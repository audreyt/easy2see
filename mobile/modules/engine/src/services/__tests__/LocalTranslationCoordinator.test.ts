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
const {default: coordinator} = await import("../LocalTranslationCoordinator")

type Verdict = {available: boolean; reason: string}
type Pair = {source: string; target: string}

let probeCalls: Pair[][] = []
let activationCalls: [boolean, unknown, string | null | undefined][] = []
let published: boolean[] = []

/**
 * `onSubscriptionChange` and `onNativeUnavailable` kick off `reconcile()`
 * without returning its promise. Every awaited call inside it is an
 * already-resolved mock, so draining the microtask queue settles it — no
 * wall-clock timer.
 */
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** Distinct target per case: the coordinator caches probe verdicts by pair key. */
let seq = 0
const freshPairs = (): Pair[] => [{source: "en-US", target: `zh-TW-${++seq}`}]

const installProbe = (verdict: Verdict | Error) => {
  bluetoothSdk.probeLocalTranslation = async (pairs: Pair[]) => {
    probeCalls.push(pairs)
    if (verdict instanceof Error) throw verdict
    return verdict
  }
}

beforeEach(() => {
  probeCalls = []
  activationCalls = []
  published = []
  platform.OS = "ios"
  for (const key of Object.keys(featureFlags)) delete featureFlags[key]
  bluetoothSdk.setLocalTranslation = async (active: boolean, pairs: unknown, probeReason?: string | null) => {
    activationCalls.push([active, pairs, probeReason])
  }
  coordinator.setCloudFallbackHandler((cloudFallback: boolean) => {
    published.push(cloudFallback)
  })
})

describe("local translation coordinator", () => {
  test("an available probe activates the on-device hop and never falls back to cloud", async () => {
    installProbe({available: true, reason: "ok"})
    const pairs = freshPairs()

    coordinator.onSubscriptionChange(pairs)
    await settle()

    expect(probeCalls).toEqual([pairs])
    expect(activationCalls).toEqual([[true, pairs, "ok"]])
    expect(coordinator.isActive()).toBe(true)
    expect(published).toEqual([false])
  })

  test("an unavailable probe leaves the hop off and publishes the cloud fallback", async () => {
    // What an iOS Simulator actually reports: no on-device recognizer lane.
    installProbe({available: false, reason: "no-on-device-recognizer"})
    const pairs = freshPairs()

    coordinator.onSubscriptionChange(pairs)
    await settle()

    expect(activationCalls).toEqual([[false, pairs, "no-on-device-recognizer"]])
    expect(coordinator.isActive()).toBe(false)
    expect(published).toEqual([true])
  })

  test("a thrown probe falls back to cloud and is not cached", async () => {
    installProbe(new Error("probeLocalTranslation is not a function"))
    const pairs = freshPairs()

    coordinator.onSubscriptionChange(pairs)
    await settle()

    expect(activationCalls).toEqual([[false, pairs, "probe-failed"]])
    expect(published).toEqual([true])

    // Not cached: reconciling the same pairs probes the native side again.
    installProbe({available: true, reason: "ok"})
    coordinator.onSubscriptionChange([...pairs])
    await settle()

    expect(probeCalls.length).toBe(2)
    expect(activationCalls.at(-1)).toEqual([true, [...pairs], "ok"])
  })

  test("a late native failure returns an active hop to the cloud", async () => {
    installProbe({available: true, reason: "needs-download"})
    const pairs = freshPairs()

    coordinator.onSubscriptionChange(pairs)
    await settle()
    expect(coordinator.isActive()).toBe(true)
    expect(published).toEqual([false])

    coordinator.onNativeUnavailable("prepare-threw")
    await settle()

    expect(coordinator.isActive()).toBe(false)
    expect(published).toEqual([false, true])
    expect(activationCalls.at(-1)).toEqual([false, pairs, "prepare-threw"])
  })

  test("android never probes and never falls back to cloud", async () => {
    installProbe({available: true, reason: "ok"})
    platform.OS = "android"
    const pairs = freshPairs()

    coordinator.onSubscriptionChange(pairs)
    await settle()

    expect(probeCalls).toEqual([])
    expect(activationCalls).toEqual([[true, pairs, null]])
    expect(published).toEqual([false])
  })
  test("cloudSpeech off (local-only deployment) suppresses the cloud fallback entirely", async () => {
    // Easy2See: no Core/Runtime exists, so an unavailable on-device hop must
    // produce silence — never a cloud subscription attempt.
    featureFlags["cloudSpeech"] = false
    installProbe({available: false, reason: "no-on-device-recognizer"})
    const pairs = freshPairs()

    coordinator.onSubscriptionChange(pairs)
    await settle()

    expect(activationCalls).toEqual([[false, pairs, "no-on-device-recognizer"]])
    expect(coordinator.isActive()).toBe(false)
    expect(published).toEqual([false])
  })
})
