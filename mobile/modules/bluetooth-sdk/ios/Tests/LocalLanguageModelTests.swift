@testable import MentraBluetoothSDK
import XCTest

#if canImport(FoundationModels)
import FoundationModels
#endif

/// Contract B verification for LocalLanguageModel. The schema-mapper tests are
/// pure; the generation tests exercise the REAL SystemLanguageModel on this
/// machine (macOS 26+, Apple Intelligence enabled) and skip cleanly when the
/// model is unavailable rather than faking a pass.
final class LocalLanguageModelTests: XCTestCase {

    /// The Conversate cue schema from the design doc — the exact shape the
    /// miniapp sends for guided cue generation.
    private let cueSchema: [String: Any] = [
        "type": "object",
        "properties": [
            "cues": [
                "type": "array",
                "maxItems": 2,
                "items": [
                    "type": "object",
                    "properties": [
                        "kind": ["enum": ["concept", "bio", "answer", "suggestion"]],
                        "title": ["type": "string", "description": "≤ 6 words"],
                        "body": ["type": "string", "description": "≤ 25 words"],
                    ],
                    "required": ["kind", "title", "body"],
                ],
            ],
        ],
        "required": ["cues"],
    ]

    private func modelAvailable() async -> Bool {
        let result = await LocalLanguageModel.availability()
        return result["available"] as? Bool == true
    }

    // MARK: - availability

    func testAvailabilityReportsLiveModelState() async throws {
        let result = await LocalLanguageModel.availability()
        XCTAssertNotNil(result["available"] as? Bool)
        guard result["available"] as? Bool == true else {
            throw XCTSkip("SystemLanguageModel unavailable: \(result["reason"] ?? "unknown")")
        }
        // Live values — never hardcoded (4096 on iOS 26, 8192 on this Mac).
        XCTAssertGreaterThan(result["contextSize"] as? Int ?? 0, 0)
        let languages = result["supportedLanguages"] as? [String] ?? []
        XCTAssertFalse(languages.isEmpty)
        // Script must be preserved so callers can tell zh-Hant from zh-Hans.
        XCTAssertTrue(languages.contains { $0.contains("-") }, "expected BCP-47 tags, got \(languages)")
    }

    // MARK: - schema mapper (pure)

    func testMapperAcceptsTheCueSchema() throws {
        guard #available(iOS 26.0, macOS 26.0, *) else { throw XCTSkip("OS too old") }
        #if canImport(FoundationModels)
        _ = try LlmSchemaMapper.dynamicSchema(cueSchema, name: "CueList", path: "$")
        #else
        throw XCTSkip("FoundationModels not importable")
        #endif
    }

    func testMapperRejectsUnsupportedKeyword() throws {
        guard #available(iOS 26.0, macOS 26.0, *) else { throw XCTSkip("OS too old") }
        #if canImport(FoundationModels)
        for bad in ["format", "pattern", "additionalProperties", "$ref", "anyOf", "const", "default", "minimum"] {
            let schema: [String: Any] = ["type": "string", bad: "x"]
            XCTAssertThrowsError(try LlmSchemaMapper.dynamicSchema(schema, name: "S", path: "$")) { error in
                guard let error = error as? LocalLlmError else {
                    return XCTFail("expected LocalLlmError, got \(error)")
                }
                XCTAssertEqual(error.code, "LLM_INVALID_SCHEMA")
                XCTAssertTrue(error.message.contains(bad), "message should name the keyword: \(error.message)")
            }
        }
        #else
        throw XCTSkip("FoundationModels not importable")
        #endif
    }

    func testMapperRejectsNonStringEnum() throws {
        guard #available(iOS 26.0, macOS 26.0, *) else { throw XCTSkip("OS too old") }
        #if canImport(FoundationModels)
        XCTAssertThrowsError(try LlmSchemaMapper.dynamicSchema(["enum": [1, 2]], name: "S", path: "$")) { error in
            XCTAssertEqual((error as? LocalLlmError)?.code, "LLM_INVALID_SCHEMA")
        }
        #else
        throw XCTSkip("FoundationModels not importable")
        #endif
    }

    func testMapperRejectsArrayWithoutItems() throws {
        guard #available(iOS 26.0, macOS 26.0, *) else { throw XCTSkip("OS too old") }
        #if canImport(FoundationModels)
        XCTAssertThrowsError(try LlmSchemaMapper.dynamicSchema(["type": "array"], name: "S", path: "$")) { error in
            XCTAssertEqual((error as? LocalLlmError)?.code, "LLM_INVALID_SCHEMA")
        }
        #else
        throw XCTSkip("FoundationModels not importable")
        #endif
    }

    // MARK: - error mapping (injected availability — the trap policy)

    func testFailureOutcomeHonoursTheAvailabilityTrap() throws {
        guard #available(iOS 26.0, macOS 26.0, *) else { throw XCTSkip("OS too old") }
        #if canImport(FoundationModels)
        struct SomeError: Error {}

        // Attempt failed AND model is not .available → LLM_UNAVAILABLE with
        // the probe reason, regardless of the thrown error.
        let trapped = LocalLanguageModel.failureOutcome(
            from: SomeError(), modelAvailable: false, unavailableReason: "model-not-ready", elapsedMs: 1
        )
        XCTAssertEqual(trapped.dictionary["code"] as? String, "LLM_UNAVAILABLE")
        XCTAssertEqual(trapped.dictionary["reason"] as? String, "model-not-ready")

        // Same failure while the model IS available → typed mapping, not
        // a false unavailable.
        let mapped = LocalLanguageModel.failureOutcome(
            from: SomeError(), modelAvailable: true, unavailableReason: "unknown", elapsedMs: 1
        )
        XCTAssertEqual(mapped.dictionary["code"] as? String, "INTERNAL")

        // Cancellation wins over the trap.
        let cancelled = LocalLanguageModel.failureOutcome(
            from: CancellationError(), modelAvailable: false, unavailableReason: "model-not-ready", elapsedMs: 1
        )
        XCTAssertEqual(cancelled.dictionary["code"] as? String, "LLM_CANCELLED")

        if #available(iOS 27.0, macOS 27.0, *) {
            let contextError = LanguageModelError.contextSizeExceeded(
                .init(contextSize: 4096, tokenCount: 5000, debugDescription: "too long")
            )
            let outcome = LocalLanguageModel.failureOutcome(
                from: contextError, modelAvailable: true, unavailableReason: "unknown", elapsedMs: 1
            )
            XCTAssertEqual(outcome.dictionary["code"] as? String, "LLM_CONTEXT_EXCEEDED")
        }
        #else
        throw XCTSkip("FoundationModels not importable")
        #endif
    }

    // MARK: - real generation (this Mac, Apple Intelligence)

    func testPlainGenerationReturnsText() async throws {
        guard try await modelAvailable() else {
            throw XCTSkip("SystemLanguageModel unavailable on this machine")
        }
        let result = await LocalLanguageModel.generate(request: [
            "requestId": "test-plain",
            "instructions": "You are a terse assistant. Answer in one short sentence.",
            "prompt": "What is the capital of Taiwan?",
            "maxTokens": 60,
        ])
        XCTAssertEqual(result["ok"] as? Bool, true, "generate failed: \(result)")
        let text = result["text"] as? String ?? ""
        XCTAssertFalse(text.isEmpty)
        print("[LLM-TEST] plain generation elapsedMs=\(result["elapsedMs"] ?? "?") text=\(text)")
    }

    func testGuidedGenerationReturnsSchemaValidCues() async throws {
        guard try await modelAvailable() else {
            throw XCTSkip("SystemLanguageModel unavailable on this machine")
        }
        guard #available(iOS 26.0, macOS 26.0, *) else {
            throw XCTSkip("Guided generation requires OS 26.0")
        }
        let result = await LocalLanguageModel.generate(request: [
            "requestId": "test-guided",
            "instructions": """
                You emit at most two short context cues for a smart-glasses HUD \
                during a conversation. Return an empty cues list when nothing is \
                useful — silence beats noise on a HUD.
                """,
            "prompt": """
                Recent transcript:
                A: Have you read the new paper on speculative decoding?
                B: Not yet — is it the DeepSeek one about multi-token prediction?
                """,
            "schema": cueSchema,
            "maxTokens": 220,
        ])
        XCTAssertEqual(result["ok"] as? Bool, true, "generate failed: \(result)")

        // Schema-valid JSON: {cues: [{kind, title, body}]} with kind ∈ enum.
        let json = result["json"] as? [String: Any]
        XCTAssertNotNil(json, "expected parsed json, got \(result)")
        let cues = json?["cues"] as? [[String: Any]] ?? []
        XCTAssertLessThanOrEqual(cues.count, 2)
        for cue in cues {
            XCTAssertTrue(["concept", "bio", "answer", "suggestion"].contains(cue["kind"] as? String ?? ""))
            XCTAssertFalse((cue["title"] as? String ?? "").isEmpty)
            XCTAssertFalse((cue["body"] as? String ?? "").isEmpty)
        }
        print("[LLM-TEST] guided generation elapsedMs=\(result["elapsedMs"] ?? "?") json=\(json ?? [:])")
    }

    func testCancelSettlesInFlightGenerate() async throws {
        guard await modelAvailable() else {
            throw XCTSkip("SystemLanguageModel unavailable on this machine")
        }
        async let outcome = LocalLanguageModel.generate(request: [
            "requestId": "test-cancel",
            "instructions": "Write a very long essay.",
            "prompt": "Tell me everything about the history of computing, in exhaustive detail.",
        ])
        // Give the task a beat to register, then cancel it.
        try await Task.sleep(nanoseconds: 50_000_000)
        await LocalLanguageModel.cancel(requestId: "test-cancel")
        let result = await outcome
        // Either the cancel landed (LLM_CANCELLED) or the model finished
        // first (ok) — both are correct; a hang is the only failure.
        let code = result["code"] as? String
        XCTAssertTrue(result["ok"] as? Bool == true || code == "LLM_CANCELLED", "unexpected: \(result)")
        print("[LLM-TEST] cancel outcome ok=\(result["ok"] ?? "?") code=\(code ?? "-")")
    }
}
