@testable import MentraBluetoothSDK
import XCTest

final class LocalTranslationLocalesTests: XCTestCase {
    func testTraditionalChineseTagsResolveToZhTW() {
        for tag in ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW"] {
            XCTAssertEqual(LocalTranslationLocales.speechLocaleIdentifier(for: tag), "zh-TW", tag)
        }
    }

    func testSimplifiedChineseTagsResolveToZhCN() {
        for tag in ["zh", "zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN"] {
            XCTAssertEqual(LocalTranslationLocales.speechLocaleIdentifier(for: tag), "zh-CN", tag)
        }
    }

    func testTraditionalAndSimplifiedStayDistinct() {
        XCTAssertNotEqual(
            LocalTranslationLocales.speechLocaleIdentifier(for: "zh-TW"),
            LocalTranslationLocales.speechLocaleIdentifier(for: "zh-CN")
        )
    }

    func testSpeechTableDefaults() {
        XCTAssertEqual(LocalTranslationLocales.speechLocaleIdentifier(for: "en"), "en-US")
        XCTAssertEqual(LocalTranslationLocales.speechLocaleIdentifier(for: "ja"), "ja-JP")
        XCTAssertEqual(LocalTranslationLocales.speechLocaleIdentifier(for: "pt"), "pt-BR")
        XCTAssertEqual(LocalTranslationLocales.speechLocaleIdentifier(for: "nb"), "nb-NO")
    }

    func testNorwegianPickerCodeMapsToAppleRecognizerId() {
        XCTAssertEqual(LocalTranslationLocales.speechLocaleIdentifier(for: "no"), "nb-NO")
    }

    func testUnknownTagsPassThrough() {
        XCTAssertEqual(LocalTranslationLocales.speechLocaleIdentifier(for: "sw"), "sw")
        XCTAssertEqual(LocalTranslationLocales.speechLocaleIdentifier(for: "en-GB"), "en-GB")
    }

    // MARK: - probeDecision (iOS availability → cloud fallback policy)

    func testProbeDecisionRejectsPreIOS18() {
        let decision = LocalTranslationLocales.probeDecision(
            isIOS18OrNewer: false,
            speechAuthorized: true,
            hasOnDeviceLane: true,
            translationStatus: "installed"
        )
        XCTAssertEqual(decision.available, false)
        XCTAssertEqual(decision.reason, "ios-version")
    }

    func testProbeDecisionRejectsDeniedSpeechAuthorization() {
        let decision = LocalTranslationLocales.probeDecision(
            isIOS18OrNewer: true,
            speechAuthorized: false,
            hasOnDeviceLane: true,
            translationStatus: "installed"
        )
        XCTAssertEqual(decision.available, false)
        XCTAssertEqual(decision.reason, "speech-denied")
    }

    func testProbeDecisionRejectsMissingOnDeviceLane() {
        let decision = LocalTranslationLocales.probeDecision(
            isIOS18OrNewer: true,
            speechAuthorized: true,
            hasOnDeviceLane: false,
            translationStatus: "installed"
        )
        XCTAssertEqual(decision.available, false)
        XCTAssertEqual(decision.reason, "no-on-device-recognizer")
    }

    func testProbeDecisionRejectsUnsupportedAndUnknownTranslation() {
        for status in ["unsupported", "unknown"] {
            let decision = LocalTranslationLocales.probeDecision(
                isIOS18OrNewer: true,
                speechAuthorized: true,
                hasOnDeviceLane: true,
                translationStatus: status
            )
            XCTAssertEqual(decision.available, false, status)
            XCTAssertEqual(decision.reason, "translation-unsupported", status)
        }
    }

    func testProbeDecisionMarksSupportedAsNeedsDownload() {
        // "supported" is available: the pipeline starts Apple Translation so
        // the system can download the models — not an immediate cloud hop.
        let decision = LocalTranslationLocales.probeDecision(
            isIOS18OrNewer: true,
            speechAuthorized: true,
            hasOnDeviceLane: true,
            translationStatus: "supported"
        )
        XCTAssertEqual(decision.available, true)
        XCTAssertEqual(decision.reason, "needs-download")
    }

    func testProbeDecisionMarksInstalledAsOk() {
        let decision = LocalTranslationLocales.probeDecision(
            isIOS18OrNewer: true,
            speechAuthorized: true,
            hasOnDeviceLane: true,
            translationStatus: "installed"
        )
        XCTAssertEqual(decision.available, true)
        XCTAssertEqual(decision.reason, "ok")
    }

    // MARK: - transcriptionProbeDecision (Contract A transcribe-only route)

    func testTranscriptionProbeDecisionRejectsDeniedSpeechAuthorization() {
        let verdict = LocalTranslationLocales.transcriptionProbeDecision(
            speechAuthorized: false,
            hasOnDeviceLane: true
        )
        XCTAssertFalse(verdict.available)
        XCTAssertEqual(verdict.reason, "speech-denied")
    }

    func testTranscriptionProbeDecisionRejectsMissingOnDeviceLane() {
        let verdict = LocalTranslationLocales.transcriptionProbeDecision(
            speechAuthorized: true,
            hasOnDeviceLane: false
        )
        XCTAssertFalse(verdict.available)
        XCTAssertEqual(verdict.reason, "no-on-device-recognizer")
    }

    func testTranscriptionProbeDecisionMarksCapableAsOk() {
        let verdict = LocalTranslationLocales.transcriptionProbeDecision(
            speechAuthorized: true,
            hasOnDeviceLane: true
        )
        XCTAssertTrue(verdict.available)
        XCTAssertEqual(verdict.reason, "ok")
    }
}
