@testable import MentraBluetoothSDK
import XCTest

/// Locks the partial-result lane arbitration in
/// `LocalTranslationLocales.bestPartialLaneIndex`. Apple only populates
/// SFTranscriptionSegment.confidence on FINAL results — it is 0 on
/// partials — so partials pick the lane with the longest transcript,
/// tie-broken by the most recent result, UNLESS a preferred lane (the
/// most recent final winner) has non-empty text — raw length is
/// script-biased, so finals stickiness beats it. Finals still use
/// confidence.
final class LocalTranslationPartialArbitrationTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    func testLongestTranscriptWins() {
        let lanes: [(textCount: Int, resultAt: Date)] = [
            (12, t0),
            (48, t0.addingTimeInterval(-5)),
            (30, t0.addingTimeInterval(-1)),
        ]
        XCTAssertEqual(LocalTranslationLocales.bestPartialLaneIndex(lanes), 1)
    }

    func testTieGoesToMostRecentResult() {
        let lanes: [(textCount: Int, resultAt: Date)] = [
            (40, t0.addingTimeInterval(-10)),
            (40, t0),
        ]
        XCTAssertEqual(LocalTranslationLocales.bestPartialLaneIndex(lanes), 1)
    }

    func testEmptyInputReturnsNil() {
        XCTAssertNil(LocalTranslationLocales.bestPartialLaneIndex([]))
    }

    func testSingleLaneWins() {
        XCTAssertEqual(
            LocalTranslationLocales.bestPartialLaneIndex([(7, t0)]),
            0
        )
    }

    func testPreferredLaneWinsEvenWhenShorter() {
        // The zh-TW lane's real transcript is shorter than the en-US
        // lane's phonetic gibberish — the final winner still keeps the
        // partial arbitration.
        let lanes: [(textCount: Int, resultAt: Date)] = [
            (400, t0),
            (12, t0.addingTimeInterval(-1)),
        ]
        XCTAssertEqual(
            LocalTranslationLocales.bestPartialLaneIndex(lanes, preferredLaneIndex: 1),
            1
        )
    }

    func testEmptyPreferredLaneFallsBackToLongest() {
        let lanes: [(textCount: Int, resultAt: Date)] = [
            (400, t0),
            (0, t0),
        ]
        XCTAssertEqual(
            LocalTranslationLocales.bestPartialLaneIndex(lanes, preferredLaneIndex: 1),
            0
        )
    }

    func testNilPreferenceKeepsLongestBehaviour() {
        let lanes: [(textCount: Int, resultAt: Date)] = [
            (12, t0),
            (48, t0.addingTimeInterval(-5)),
        ]
        XCTAssertEqual(
            LocalTranslationLocales.bestPartialLaneIndex(lanes, preferredLaneIndex: nil),
            1
        )
    }

    func testOutOfBoundsPreferenceFallsBackToLongest() {
        let lanes: [(textCount: Int, resultAt: Date)] = [
            (12, t0),
            (48, t0),
        ]
        XCTAssertEqual(
            LocalTranslationLocales.bestPartialLaneIndex(lanes, preferredLaneIndex: 7),
            1
        )
    }
}
