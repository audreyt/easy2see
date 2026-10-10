@testable import MentraBluetoothSDK
import XCTest

final class LocalTranslationPromotionTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    private func decide(
        now: TimeInterval,
        lastChangeAt: TimeInterval,
        utteranceStartAt: TimeInterval,
        textIsEmpty: Bool,
        stableMs: TimeInterval = 1.2,
        maxUtteranceMs: TimeInterval = 30
    ) -> LocalTranslationLocales.PartialPromotion {
        LocalTranslationLocales.partialPromotionDecision(
            now: t0.addingTimeInterval(now),
            lastChangeAt: lastChangeAt == -.infinity
                ? .distantPast
                : t0.addingTimeInterval(lastChangeAt),
            utteranceStartAt: utteranceStartAt == -.infinity
                ? .distantPast
                : t0.addingTimeInterval(utteranceStartAt),
            textIsEmpty: textIsEmpty,
            stableMs: stableMs,
            maxUtteranceMs: maxUtteranceMs
        )
    }

    // MARK: - Stable partial promotes

    func testStablePartialPromotes() {
        // Text last changed 1.3s ago, utterance 5s old -> promote.
        XCTAssertEqual(
            decide(now: 10, lastChangeAt: 8.7, utteranceStartAt: 5, textIsEmpty: false),
            .promote
        )
    }

    func testStillGrowingPartialDoesNotPromote() {
        // Text changed 0.3s ago -> still growing, keep listening.
        XCTAssertEqual(
            decide(now: 10, lastChangeAt: 9.7, utteranceStartAt: 5, textIsEmpty: false),
            .none
        )
    }

    func testEmptyTextNeverPromotes() {
        XCTAssertEqual(
            decide(now: 10, lastChangeAt: 0, utteranceStartAt: 0, textIsEmpty: true),
            .none
        )
    }

    func testNoChangeTimestampDoesNotPromote() {
        // Defensive: non-empty text without a change stamp must not
        // promote (distantPast would otherwise read as infinitely stale).
        XCTAssertEqual(
            decide(now: 10, lastChangeAt: -.infinity, utteranceStartAt: 5, textIsEmpty: false),
            .none
        )
    }

    // MARK: - Rollover

    func testExceedingMaxUtteranceRollsOver() {
        // Utterance 35s old, text still changing -> rollover anyway.
        XCTAssertEqual(
            decide(now: 40, lastChangeAt: 39.9, utteranceStartAt: 5, textIsEmpty: false),
            .rollover
        )
    }

    func testRolloverBeatsStablePromotion() {
        // Both conditions true -> rollover wins so the reason is accurate.
        XCTAssertEqual(
            decide(now: 40, lastChangeAt: 30, utteranceStartAt: 5, textIsEmpty: false),
            .rollover
        )
    }

    func testNoUtteranceStartDoesNotRollOver() {
        XCTAssertEqual(
            decide(now: 100, lastChangeAt: 50, utteranceStartAt: -.infinity, textIsEmpty: false),
            .promote
        )
    }

    // MARK: - Timer reset on text change

    func testTimerResetsWhenTextChanges() {
        // Same utterance, but the last change was recent -> no promote.
        XCTAssertEqual(
            decide(now: 10, lastChangeAt: 9.5, utteranceStartAt: 2, textIsEmpty: false),
            .none
        )
        // Once the change ages past the stable window it promotes.
        XCTAssertEqual(
            decide(now: 11, lastChangeAt: 9.5, utteranceStartAt: 2, textIsEmpty: false),
            .promote
        )
    }

    // MARK: - Boundaries

    func testBoundaryValues() {
        // Exactly at the stable boundary promotes.
        XCTAssertEqual(
            decide(now: 10, lastChangeAt: 8.8, utteranceStartAt: 5, textIsEmpty: false),
            .promote
        )
        // Exactly at the max-utterance boundary rolls over.
        XCTAssertEqual(
            decide(now: 35, lastChangeAt: 34.9, utteranceStartAt: 5, textIsEmpty: false),
            .rollover
        )
    }
}
