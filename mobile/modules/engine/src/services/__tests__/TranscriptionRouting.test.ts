/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {
  chineseScript,
  localTranscriptionDeliveryRoute,
  localTranslationPairs,
  localTranslationProbeThrew,
  localTranslationUsesCloudFallback,
  resolveAutoTranscriptionEngine,
  sherpaLanguageCodeForLocale,
  summarizeTranscriptionRoutes,
  transcriptionSubscriberCounts,
  transcriptionDeliveryRoute,
  translationPairFromStream,
  translationRoutePatterns,
  translationRoutesWithCloudFallback,
} from "../TranscriptionRouting"

describe("transcription routing", () => {
  test("keeps cloud enabled for mixed subscribers and starts local for forced subscribers", () => {
    const forced = new Set(["local-app"])
    expect(
      summarizeTranscriptionRoutes(["cloud-app", "local-app"], (app) => ({
        cloud: !forced.has(app),
        forceLocal: forced.has(app),
      })),
    ).toEqual({hasCloudSubscriber: true, hasForceLocalSubscriber: true})
  })

  test("does not subscribe cloud when every subscriber is forceLocal", () => {
    expect(summarizeTranscriptionRoutes(["one", "two"], () => ({cloud: false, forceLocal: true}))).toEqual({
      hasCloudSubscriber: false,
      hasForceLocalSubscriber: true,
    })
  })

  test("one subscriber can require both cloud and forceLocal routes", () => {
    expect(summarizeTranscriptionRoutes(["mixed-app"], () => ({cloud: true, forceLocal: true}))).toEqual({
      hasCloudSubscriber: true,
      hasForceLocalSubscriber: true,
    })
  })

  test("isolates cloud and local events while connected", () => {
    expect(transcriptionDeliveryRoute("cloud", {cloud: true, forceLocal: true}, true)).toBe("default")
    expect(transcriptionDeliveryRoute("local", {cloud: true, forceLocal: true}, true)).toBe("forceLocal")
    expect(transcriptionDeliveryRoute("cloud", {cloud: false, forceLocal: true}, true)).toBeNull()
    expect(transcriptionDeliveryRoute("local", {cloud: true, forceLocal: false}, true)).toBeNull()
  })

  test("delivers local fallback to every subscriber while cloud is disconnected", () => {
    expect(transcriptionDeliveryRoute("local", {cloud: true, forceLocal: true}, false)).toBe("all")
    expect(transcriptionDeliveryRoute("local", {cloud: true, forceLocal: false}, false)).toBe("default")
    expect(transcriptionDeliveryRoute("local", {cloud: false, forceLocal: true}, false)).toBe("forceLocal")
  })
})

describe("translation routing", () => {
  test("parses concrete translation stream keys", () => {
    expect(translationPairFromStream("translation:zh-TW:en")).toEqual({source: "zh-TW", target: "en"})
    expect(translationPairFromStream("translation:*:zh-TW")).toEqual({source: "*", target: "zh-TW"})
    expect(translationPairFromStream("translation:auto")).toBeNull()
    expect(translationPairFromStream("transcription:en-US")).toBeNull()
  })

  test("route patterns match the forwardEvent wildcard fan-out", () => {
    expect(translationRoutePatterns("translation:en-US:zh-TW")).toEqual([
      "translation:en-US:zh-TW",
      "translation:auto",
      "translation:*:*",
      "translation:*:zh-TW",
      "translation:en-US:*",
    ])
  })

  test("local pairs collapse wildcard sources to auto and drop wildcard targets", () => {
    expect(
      localTranslationPairs([
        "translation:*:zh-TW",
        "translation:en-US:zh-TW",
        "translation:en-US:*",
        "translation:auto",
      ]),
    ).toEqual([
      {source: "auto", target: "zh-TW"},
      {source: "en-US", target: "zh-TW"},
    ])
  })

  test("iOS falls back to cloud only when the probe is unavailable", () => {
    expect(localTranslationUsesCloudFallback("ios", false)).toBe(true)
    expect(localTranslationUsesCloudFallback("ios", true)).toBe(false)
  })

  test("android and other platforms never cloud-fallback", () => {
    // Android translation is knowingly dropped (AC-3): no probe, no fallback.
    expect(localTranslationUsesCloudFallback("android", false)).toBe(false)
    expect(localTranslationUsesCloudFallback("android", true)).toBe(false)
    expect(localTranslationUsesCloudFallback("other", false)).toBe(false)
    expect(localTranslationUsesCloudFallback("other", true)).toBe(false)
  })

  test("cloud fallback makes a forceLocal subscriber a cloud subscriber", () => {
    const forced = {cloud: false, forceLocal: true}
    expect(translationRoutesWithCloudFallback(forced, true)).toEqual({cloud: true, forceLocal: true})
    // Fallback on: a cloud event now delivers to the forceLocal subscriber.
    expect(
      transcriptionDeliveryRoute("cloud", translationRoutesWithCloudFallback(forced, true), true),
    ).toBe("default")
  })

  test("no fallback leaves forceLocal pairs off the cloud route", () => {
    const forced = {cloud: false, forceLocal: true}
    expect(translationRoutesWithCloudFallback(forced, false)).toEqual(forced)
    expect(transcriptionDeliveryRoute("cloud", translationRoutesWithCloudFallback(forced, false), true)).toBeNull()
    // Fallback never invents a forceLocal route for a cloud-only subscriber.
    expect(translationRoutesWithCloudFallback({cloud: true, forceLocal: false}, true)).toEqual({
      cloud: true,
      forceLocal: false,
    })
  })

  test("a thrown probe is an iOS cloud fallback and not an Android one", () => {
    const verdict = localTranslationProbeThrew()
    expect(verdict).toEqual({available: false, reason: "probe-failed"})
    expect(localTranslationUsesCloudFallback("ios", verdict.available)).toBe(true)
    expect(localTranslationUsesCloudFallback("android", verdict.available)).toBe(false)
  })
})
describe("Contract A — Apple on-device transcription route", () => {
  const sherpaCodes = ["en", "fr", "de", "es", "zh", "ko"]

  test("chineseScript marks Traditional locales hant and bare zh hans", () => {
    expect(chineseScript("zh-TW")).toBe("hant")
    expect(chineseScript("zh-Hant")).toBe("hant")
    expect(chineseScript("zh-HK")).toBe("hant")
    expect(chineseScript("zh-MO")).toBe("hant")
    expect(chineseScript("zh")).toBe("hans")
    expect(chineseScript("zh-CN")).toBe("hans")
    expect(chineseScript("zh-Hans")).toBe("hans")
    expect(chineseScript("en-US")).toBeNull()
  })

  test("sherpaLanguageCodeForLocale maps base codes and refuses Traditional Chinese", () => {
    expect(sherpaLanguageCodeForLocale("en-US", sherpaCodes)).toBe("en")
    expect(sherpaLanguageCodeForLocale("zh-CN", sherpaCodes)).toBe("zh")
    expect(sherpaLanguageCodeForLocale("zh-TW", sherpaCodes)).toBeNull()
    expect(sherpaLanguageCodeForLocale("ja-JP", sherpaCodes)).toBeNull()
  })

  test("auto resolves zh-TW to apple when the probe is positive", () => {
    expect(resolveAutoTranscriptionEngine("zh-TW", true, sherpaCodes)).toBe("apple")
  })

  test("auto resolves en to sherpa when a Sherpa model exists", () => {
    expect(resolveAutoTranscriptionEngine("en-US", true, sherpaCodes)).toBe("sherpa")
  })

  test("auto resolves ja to apple — no Sherpa model", () => {
    expect(resolveAutoTranscriptionEngine("ja-JP", true, sherpaCodes)).toBe("apple")
  })

  test("auto resolves an unpinned stream to apple — the heard language may be zh-TW", () => {
    expect(resolveAutoTranscriptionEngine("auto", true, sherpaCodes)).toBe("apple")
    expect(resolveAutoTranscriptionEngine("*", true, sherpaCodes)).toBe("apple")
  })

  test("auto resolves to sherpa whenever Apple is incapable", () => {
    expect(resolveAutoTranscriptionEngine("zh-TW", false, sherpaCodes)).toBe("sherpa")
    expect(resolveAutoTranscriptionEngine("ja-JP", false, sherpaCodes)).toBe("sherpa")
    expect(resolveAutoTranscriptionEngine("auto", false, sherpaCodes)).toBe("sherpa")
  })

  test("apple events deliver only to apple-resolved forceLocal subscribers", () => {
    const routes = {cloud: false, forceLocal: true}
    expect(localTranscriptionDeliveryRoute("apple-speech", routes, true, true)).toBe("forceLocal")
    // Sherpa-resolved subscribers never see Apple events.
    expect(localTranscriptionDeliveryRoute("apple-speech", routes, false, true)).toBeNull()
    // Cloud subscribers never see Apple events — Contract A is never-cloud.
    expect(localTranscriptionDeliveryRoute("apple-speech", {cloud: true, forceLocal: false}, true, true)).toBeNull()
  })

  test("sherpa events never reach apple-resolved subscribers", () => {
    const routes = {cloud: false, forceLocal: true}
    expect(localTranscriptionDeliveryRoute("sherpa", routes, true, true)).toBeNull()
    expect(localTranscriptionDeliveryRoute("sherpa", routes, false, true)).toBe("forceLocal")
    // Cloud outage keeps the historical local-fallback delivery: a
    // cloud-only subscriber still hears local events on the default route.
    expect(localTranscriptionDeliveryRoute("sherpa", {cloud: true, forceLocal: false}, false, false)).toBe("default")
  })

  test("an apple-routed stream counts as neither Sherpa nor cloud subscription", () => {
    // forceLocal + apple: drives the transcribe-only pipeline only.
    expect(transcriptionSubscriberCounts({cloud: false, forceLocal: true}, "apple")).toEqual({
      sherpa: false,
      cloud: false,
    })
    // Even an includeCloud subscriber resolved to Apple stays off the cloud
    // set — Contract A is never-cloud.
    expect(transcriptionSubscriberCounts({cloud: true, forceLocal: true}, "apple")).toEqual({
      sherpa: false,
      cloud: false,
    })
    // Sherpa-resolved keeps the historical counting.
    expect(transcriptionSubscriberCounts({cloud: false, forceLocal: true}, "sherpa")).toEqual({
      sherpa: true,
      cloud: false,
    })
    expect(transcriptionSubscriberCounts({cloud: true, forceLocal: true}, "sherpa")).toEqual({
      sherpa: true,
      cloud: true,
    })
    // Cloud-only subscribers are unaffected by engine resolution.
    expect(transcriptionSubscriberCounts({cloud: true, forceLocal: false}, "sherpa")).toEqual({
      sherpa: false,
      cloud: true,
    })
  })
})
