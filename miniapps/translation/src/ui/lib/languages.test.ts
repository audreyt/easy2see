import {describe, expect, test} from "bun:test"

import {TARGET_LANGUAGES, getFlagEmoji, getLanguageName} from "./languages"

describe("language lookup", () => {
  test("puts preferred targets first and keeps the remaining languages alphabetical", () => {
    expect(TARGET_LANGUAGES.slice(0, 4).map(({code}) => code)).toEqual(["en", "de", "fr", "ja"])
    const remainingNames = TARGET_LANGUAGES.slice(4).map(({name}) => name)
    expect(remainingNames).toEqual([...remainingNames].sort())
    expect(new Set(TARGET_LANGUAGES.map(({code}) => code)).size).toBe(61)
  })

  test("offers the complete Soniox translation language set", () => {
    expect(TARGET_LANGUAGES).toHaveLength(61)
    expect(TARGET_LANGUAGES.map(({code}) => code)).toEqual(
      expect.arrayContaining(["af", "bn", "he", "ru", "sw", "th", "uk", "ur", "cy"]),
    )
    expect(TARGET_LANGUAGES.every(({flag}) => flag && flag !== "🏳️")).toBe(true)
  })

  test("lists Traditional Chinese (zh-TW) separately from Simplified (zh-CN)", () => {
    const codes = TARGET_LANGUAGES.map(({code}) => code)
    expect(codes).toContain("zh-TW")
    expect(codes).toContain("zh-CN")
    expect(codes).not.toContain("zh") // bare zh is ambiguous — the registry canonicalizes it to zh-CN
    const traditional = TARGET_LANGUAGES.find((l) => l.code === "zh-TW")
    expect(traditional?.nativeName).toBe("繁體中文")
    expect(getLanguageName("zh-TW")).toBe("Chinese (Traditional)")
    expect(getFlagEmoji("zh-TW")).toBe("🇹🇼")
    expect(getLanguageName("zh-CN")).toBe("Chinese (Simplified)")
    expect(getFlagEmoji("zh-CN")).toBe("🇨🇳")
  })

  test("Chinese tags resolve by written form, not just the zh primary subtag", () => {
    // Registry tags and provider-emitted script forms must not collapse to
    // the Simplified entry.
    expect(getLanguageName("zh-HK")).toBe("Chinese (Traditional)")
    expect(getLanguageName("zh-Hant")).toBe("Chinese (Traditional)")
    expect(getLanguageName("zh-Hant-TW")).toBe("Chinese (Traditional)")
    expect(getLanguageName("zh-Hans")).toBe("Chinese (Simplified)")
    // Bare "zh" canonicalizes to zh-CN in the platform registry.
    expect(getLanguageName("zh")).toBe("Chinese (Simplified)")
  })

  test("resolves bare codes", () => {
    expect(getLanguageName("es")).toBe("Spanish")
    expect(getFlagEmoji("es")).toBe("🇪🇸")
  })

  test("resolves BCP-47 tags by primary subtag (not the white-flag fallback)", () => {
    expect(getLanguageName("es-ES")).toBe("Spanish")
    expect(getFlagEmoji("es-ES")).toBe("🇪🇸")
    expect(getLanguageName("en-US")).toBe("English")
    expect(getFlagEmoji("en-US")).toBe("🇺🇸")
    expect(getFlagEmoji("PT-BR")).toBe("🇵🇹")
  })

  test("unknown codes fall back to the raw code and white flag", () => {
    expect(getLanguageName("xx-YY")).toBe("xx-YY")
    expect(getFlagEmoji("xx-YY")).toBe("🏳️")
  })
})
