import Foundation

/**
 * Wire-tag → Apple speech-locale mapping for the on-device translation
 * pipeline. UIKit-free so it is unit-testable and usable from any target.
 *
 * Resolution order (Easy2Say LanguageCatalog rules):
 * 1. Chinese wire tags map by script: zh-TW/zh-HK/zh-MO/zh-Hant* → zh-TW;
 *    zh-CN/zh-SG/zh-Hans* and bare zh → zh-CN (the platform registry
 *    canonicalizes bare zh to zh-CN).
 * 2. The Easy2Say speech table (bare language codes → regional defaults).
 *    The picker code "no" maps to "nb-NO", Apple's recognizer id for
 *    Norwegian Bokmål — the table itself only carries "nb".
 * 3. Anything else passes through unchanged.
 */
enum LocalTranslationLocales {
    static func speechLocaleIdentifier(for tag: String) -> String {
        switch chineseScript(tag) {
        case "hant": return "zh-TW"
        case "hans": return "zh-CN"
        default: break
        }
        switch tag {
        case "en": return "en-US"
        case "zh-Hans": return "zh-CN"
        case "zh-Hant": return "zh-TW"
        case "nan": return "nan-TW"
        case "yue": return "yue-CN"
        case "es": return "es-ES"
        case "de": return "de-DE"
        case "ja": return "ja-JP"
        case "fr": return "fr-FR"
        case "it": return "it-IT"
        case "ko": return "ko-KR"
        case "ar": return "ar-SA"
        case "pt": return "pt-BR"
        case "ca": return "ca-ES"
        case "cs": return "cs-CZ"
        case "da": return "da-DK"
        case "fi": return "fi-FI"
        case "el": return "el-GR"
        case "he": return "he-IL"
        case "hi": return "hi-IN"
        case "hr": return "hr-HR"
        case "hu": return "hu-HU"
        case "id": return "id-ID"
        case "ms": return "ms-MY"
        case "nb", "no": return "nb-NO"
        case "nl": return "nl-NL"
        case "pl": return "pl-PL"
        case "ro": return "ro-RO"
        case "ru": return "ru-RU"
        case "sk": return "sk-SK"
        case "sv": return "sv-SE"
        case "th": return "th-TH"
        case "tr": return "tr-TR"
        case "uk": return "uk-UA"
        case "vi": return "vi-VN"
        default: return tag
        }
    }

    /// "hant" / "hans" / nil — mirrors the miniapp's chineseScript helper:
    /// explicit Hant/Hans subtags or Traditional-script regions (TW/HK/MO)
    /// are Traditional; bare zh defaults to Simplified (zh-CN canonical).
    static func chineseScript(_ tag: String) -> String? {
        let subtags = tag.lowercased().split(separator: "-").map(String.init)
        guard subtags.first == "zh" else { return nil }
        let traditionalMarkers: Set<String> = ["hant", "tw", "hk", "mo"]
        return subtags.dropFirst().contains(where: { traditionalMarkers.contains($0) }) ? "hant" : "hans"
    }

    /**
     * Availability verdict for the on-device translation hop, evaluated by
     * `LocalTranslationPipeline.probe(pairs:)`. Pure and Foundation-only so
     * `swift test` locks the policy on macOS.
     *
     * `translationStatus` is the aggregate LanguageAvailability verdict for
     * the requested pairs: "installed" | "supported" | "unsupported" |
     * "unknown". "supported" means the pair is offered but its models are not
     * downloaded — available, but the pipeline must start Apple Translation
     * so the system can fetch them; it is not an immediate cloud hop.
     */
    static func probeDecision(
        isIOS18OrNewer: Bool,
        speechAuthorized: Bool,
        hasOnDeviceLane: Bool,
        translationStatus: String
    ) -> (available: Bool, reason: String) {
        guard isIOS18OrNewer else { return (false, "ios-version") }
        guard speechAuthorized else { return (false, "speech-denied") }
        guard hasOnDeviceLane else { return (false, "no-on-device-recognizer") }
        switch translationStatus {
        case "installed": return (true, "ok")
        case "supported": return (true, "needs-download")
        default: return (false, "translation-unsupported")
        }
    }

    /// What a speech-lane recognition-task error means for the lane.
    /// Ported from Easy2Say's
    /// LiveTranscriptionSession.LegacyRecognitionErrorDisposition.
    enum LaneErrorDisposition: Equatable {
        case ignore
        case restartImmediately
        case retryWithBackoff
        case stopAndSurface
    }

    /**
     * Decides what to do about a lane's recognition-task error.
     *
     * `message` is the error's localized description. Code 203 is a bucket
     * Apple uses for unrelated failures — the transient "Retry"/"Corrupt"
     * faults that a restart clears, and the server quota rejection that no
     * amount of retrying clears — so only the quota text earns a hard stop.
     * Pure and Foundation-only so `swift test` locks the table on macOS.
     */
    static func laneErrorDisposition(
        domain: String,
        code: Int,
        message: String = ""
    ) -> LaneErrorDisposition {
        guard domain == "kAFAssistantErrorDomain" else {
            return .retryWithBackoff
        }

        if message.range(of: "quota", options: .caseInsensitive) != nil {
            return .stopAndSurface
        }

        switch code {
        case 216, 301:
            return .ignore
        case 1110:
            return .restartImmediately
        default:
            return .retryWithBackoff
        }
    }

    /**
     * Availability verdict for the transcribe-only Apple Speech route
     * (Contract A), evaluated by `LocalTranslationPipeline.probeTranscription`.
     * No iOS-18 or Translation-availability gate — the lanes only need speech
     * authorization and an on-device recognizer for the locale. Pure and
     * Foundation-only so `swift test` locks the policy on macOS.
     */
    static func transcriptionProbeDecision(
        speechAuthorized: Bool,
        hasOnDeviceLane: Bool
    ) -> (available: Bool, reason: String) {
        guard speechAuthorized else { return (false, "speech-denied") }
        guard hasOnDeviceLane else { return (false, "no-on-device-recognizer") }
        return (true, "ok")
    }

    /**
     * Partial-result lane arbitration. Apple only populates
     * `SFTranscriptionSegment.confidence` on FINAL results — it is 0 on
     * partials — so partials pick the lane with the longest transcript,
     * tie-broken by the most recent result. Finals still use confidence.
     *
     * `preferredLaneIndex` makes partials sticky: raw length is
     * script-biased (a wrong-script lane's phonetic gibberish out-grows
     * the real transcript), so once a lane has won a FINAL arbitration
     * its partials keep winning while non-empty. A nil or empty
     * preferred lane falls back to longest+recency. Pure and
     * Foundation-only so `swift test` locks the policy on macOS.
     */
    static func bestPartialLaneIndex(
        _ lanes: [(textCount: Int, resultAt: Date)],
        preferredLaneIndex: Int? = nil
    ) -> Int? {
        if let preferred = preferredLaneIndex,
           lanes.indices.contains(preferred),
           lanes[preferred].textCount > 0 {
            return preferred
        }
        return lanes.indices.max { a, b in
            lanes[a].textCount != lanes[b].textCount
                ? lanes[a].textCount < lanes[b].textCount
                : lanes[a].resultAt < lanes[b].resultAt
        }
    }

    /// Outcome of the stable-partial promotion check: should this lane's
    /// request be endAudio'd now?
    enum PartialPromotion {
        /// Keep listening - text is still changing or nothing heard yet.
        case none
        /// Partial unchanged for the stable window - promote to final.
        case promote
        /// Utterance exceeded the hard cap - force a rollover even though
        /// the text is still changing.
        case rollover
    }

    /**
     * Utterance-promotion policy for locales that never emit isFinal
     * (zh-TW among them): a partial whose text has been stable for
     * `stableMs` is promoted; any utterance older than `maxUtteranceMs`
     * rolls over regardless. Rollover wins over promote - a runaway
     * utterance must end even if the text just changed. `.distantPast`
     * timestamps mean "never happened". Pure and Foundation-only so
     * `swift test` locks the policy on macOS.
     */
    static func partialPromotionDecision(
        now: Date,
        lastChangeAt: Date,
        utteranceStartAt: Date,
        textIsEmpty: Bool,
        stableMs: TimeInterval = 1.2,
        maxUtteranceMs: TimeInterval = 30
    ) -> PartialPromotion {
        guard !textIsEmpty else { return .none }
        if utteranceStartAt != .distantPast,
           now.timeIntervalSince(utteranceStartAt) >= maxUtteranceMs {
            return .rollover
        }
        guard lastChangeAt != .distantPast else { return .none }
        return now.timeIntervalSince(lastChangeAt) >= stableMs ? .promote : .none
    }
}
