@testable import MentraBluetoothSDK
import XCTest

/// Locks the Easy2Say lane-error disposition table ported into
/// `LocalTranslationLocales.laneErrorDisposition`. Each branch of the table
/// gets a case, including the quota-text override that turns the otherwise
/// transient code-203 bucket into a hard stop.
final class LocalTranslationDispositionTests: XCTestCase {
    private let kAF = "kAFAssistantErrorDomain"

    func testNonAssistantDomainRetriesWithBackoff() {
        for domain in ["NSCocoaErrorDomain", "kAFAssistantErrorDomain2", ""] {
            XCTAssertEqual(
                LocalTranslationLocales.laneErrorDisposition(domain: domain, code: 1110),
                .retryWithBackoff,
                domain
            )
        }
    }

    func testQuotaMessageStopsAndSurfaces() {
        // Code 203 is Apple's bucket for both transient faults and the
        // server quota rejection — only the quota text earns a hard stop.
        for message in [
            "You have exceeded your quota",
            "QUOTA reached for this device",
            "retry later, quota",
        ] {
            XCTAssertEqual(
                LocalTranslationLocales.laneErrorDisposition(domain: kAF, code: 203, message: message),
                .stopAndSurface,
                message
            )
        }
        // Quota text wins even on codes that would otherwise be ignored.
        XCTAssertEqual(
            LocalTranslationLocales.laneErrorDisposition(domain: kAF, code: 216, message: "quota exceeded"),
            .stopAndSurface
        )
    }

    func testBenignCodesAreIgnored() {
        for code in [216, 301] {
            XCTAssertEqual(
                LocalTranslationLocales.laneErrorDisposition(domain: kAF, code: code),
                .ignore,
                "code \(code)"
            )
        }
    }

    func testNoSpeechDetectedRestartsImmediately() {
        // 1110 "No speech detected" — the recognizer ended the utterance;
        // restarting must not consume the backoff budget.
        XCTAssertEqual(
            LocalTranslationLocales.laneErrorDisposition(
                domain: kAF, code: 1110, message: "No speech detected"
            ),
            .restartImmediately
        )
    }

    func testOtherAssistantCodesRetryWithBackoff() {
        // Code 203 without quota text is a transient fault; unknown codes
        // get the same bounded retry.
        for code in [203, 1, 500, 1100, 1111, -1] {
            XCTAssertEqual(
                LocalTranslationLocales.laneErrorDisposition(domain: kAF, code: code),
                .retryWithBackoff,
                "code \(code)"
            )
        }
    }
}
