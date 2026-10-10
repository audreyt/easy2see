import {describe, expect, test} from "bun:test"

import {SUPPORTED_TRANSCRIPTION_LANGUAGES} from "../../../../cloud-v2/packages/protocol/src/languages"
import {LOCAL_LANGUAGES, engineFor, toLocalLanguageTag} from "./languages"

// The two on-device engines the host can actually serve (Contract A):
//   sherpa — downloadable Sherpa-ONNX streaming zipformer (six locales)
//   apple  — Apple Speech lanes; the host's LocalTranslationLocales
//            speechLocaleIdentifier table maps these wire tags to Apple
//            recognizer ids (zh-HK reaches the zh-TW lane via the hant rule).
// If the host grows a locale the picker stays conservative until this list
// is updated on purpose.
const SHERPA_CODES: Record<string, true> = {
  "en-US": true,
  "fr-FR": true,
  "de-DE": true,
  "es-ES": true,
  "zh-CN": true,
  "ko-KR": true,
}
const APPLE_CODES: Record<string, true> = {
  "ar-SA": true,
  "ca-ES": true,
  "cs-CZ": true,
  "da-DK": true,
  "de-DE": true,
  "el-GR": true,
  "en-US": true,
  "es-ES": true,
  "fi-FI": true,
  "fr-FR": true,
  "he-IL": true,
  "hi-IN": true,
  "hr-HR": true,
  "hu-HU": true,
  "id-ID": true,
  "it-IT": true,
  "ja-JP": true,
  "ko-KR": true,
  "ms-MY": true,
  "nb-NO": true,
  "nl-NL": true,
  "pl-PL": true,
  "pt-BR": true,
  "ro-RO": true,
  "ru-RU": true,
  "sk-SK": true,
  "sv-SE": true,
  "th-TH": true,
  "tr-TR": true,
  "uk-UA": true,
  "vi-VN": true,
  "zh-CN": true,
  "zh-TW": true,
  "zh-HK": true,
}
describe("local language table", () => {
  test("every picker entry is a valid registry language", () => {
    const registryCodes = new Set<string>(SUPPORTED_TRANSCRIPTION_LANGUAGES)
    for (const lang of LOCAL_LANGUAGES) {
      expect(registryCodes.has(lang.code)).toBe(true)
    }
  })

  test("every picker entry routes to an on-device engine", () => {
    for (const lang of LOCAL_LANGUAGES) {
      const engine = engineFor(lang.code)
      expect(engine === "sherpa" || engine === "apple").toBe(true)
      if (engine === "sherpa") {
        expect(lang.code in SHERPA_CODES).toBe(true)
      } else {
        expect(lang.code in APPLE_CODES).toBe(true)
      }
    }
  })

  test("codes are unique and every Sherpa locale is offered", () => {
    const codes = LOCAL_LANGUAGES.map((l) => l.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const code of Object.keys(SHERPA_CODES)) {
      expect(codes).toContain(code)
    }
  })

  test("Traditional Chinese is offered as zh-TW / zh-HK, not mislabeled", () => {
    const zhTW = LOCAL_LANGUAGES.find((l) => l.code === "zh-TW")
    const zhHK = LOCAL_LANGUAGES.find((l) => l.code === "zh-HK")
    const zhCN = LOCAL_LANGUAGES.find((l) => l.code === "zh-CN")
    expect(zhTW?.name).toContain("Traditional")
    expect(zhHK?.name).toContain("Traditional")
    expect(zhCN?.name).toContain("Simplified")
    // zh-TW/zh-HK need the Apple route (or a host download), never Sherpa.
    expect(engineFor("zh-TW")).toBe("apple")
    expect(engineFor("zh-HK")).toBe("apple")
    expect(engineFor("zh-CN")).toBe("sherpa")
  })

  test("downloadable-model entries are labeled needsDownload", () => {
    for (const lang of LOCAL_LANGUAGES) {
      if (lang.engine === "sherpa") {
        expect(lang.needsDownload).toBe(true)
      }
    }
  })
})

describe("toLocalLanguageTag", () => {
  test("normalizes stored codes and names to registry tags", () => {
    expect(toLocalLanguageTag("zh-Hant")).toBe("zh-TW")
    expect(toLocalLanguageTag("zh-Hans")).toBe("zh-CN")
    expect(toLocalLanguageTag("fr")).toBe("fr-FR")
    expect(toLocalLanguageTag("en")).toBe("en-US")
    expect(toLocalLanguageTag("zh-TW")).toBe("zh-TW")
  })

  test("rejects languages no on-device engine can serve", () => {
    expect(toLocalLanguageTag("sw")).toBeNull() // Swahili — cloud only
    expect(toLocalLanguageTag("Chinese (Pinyin)")).toBeNull()
    expect(toLocalLanguageTag("auto")).toBeNull()
    expect(toLocalLanguageTag(undefined)).toBeNull()
    expect(toLocalLanguageTag("")).toBeNull()
  })
})
