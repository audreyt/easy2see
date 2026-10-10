import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

/// Error carried across the Expo bridge as a result envelope (never thrown
/// to JS): `code` is the contract code, `reason` the availability sub-reason.
/// Internal to the SDK — BluetoothSdkModule maps it into [String: Any].
struct LocalLlmError: Error {
    let code: String
    let reason: String?
    let message: String

    init(code: String, reason: String? = nil, message: String) {
        self.code = code
        self.reason = reason
        self.message = message
    }
}

/// Sendable wrapper so the generate Task can capture the bridge payload
/// without tripping strict-concurrency checks (the dict only ever crosses
/// the Expo bridge, which already serialized it).
private struct LlmRequestBox: @unchecked Sendable {
    let raw: [String: Any]
}

/// Sendable result of one generation; converted to [String: Any] at the edge.
/// Internal (not private) so tests can assert the envelope fields.
struct LlmOutcome: @unchecked Sendable {
    let dictionary: [String: Any]

    static func success(text: String?, json: Any?, elapsedMs: Int) -> LlmOutcome {
        var dict: [String: Any] = ["ok": true, "elapsedMs": elapsedMs]
        if let text { dict["text"] = text }
        if let json { dict["json"] = json }
        return LlmOutcome(dictionary: dict)
    }

    static func failure(code: String, reason: String? = nil, message: String, elapsedMs: Int) -> LlmOutcome {
        var dict: [String: Any] = ["ok": false, "code": code, "message": message, "elapsedMs": elapsedMs]
        if let reason { dict["reason"] = reason }
        return LlmOutcome(dictionary: dict)
    }
}

/// Registry of in-flight generations keyed by the caller's requestId —
/// `llmCancel` and the host's one-in-flight-per-miniapp policy land here.
private actor LlmTaskRegistry {
    static let shared = LlmTaskRegistry()
    private var tasks: [String: Task<LlmOutcome, Never>] = [:]

    func register(_ id: String, task: Task<LlmOutcome, Never>) {
        tasks[id] = task
    }

    func unregister(_ id: String) {
        tasks.removeValue(forKey: id)
    }

    func cancel(_ id: String) {
        tasks.removeValue(forKey: id)?.cancel()
    }
}

/**
 * On-device Apple Foundation Models (SystemLanguageModel) behind
 * `session.llm`. iOS 26+ / macOS 26+; weak-linked so the pod still targets
 * iOS 15.1 — every entry point degrades to `unsupported-os` when the
 * framework or OS is missing.
 *
 * Contract B:
 *   - availability(): SystemLanguageModel availability + reason, contextSize,
 *     supportedLanguages as BCP-47 tags.
 *   - generate(): STATELESS — a fresh LanguageModelSession(instructions:) per
 *     call. Optional JSON-Schema subset → DynamicGenerationSchema →
 *     GenerationSchema for guided output (GenerationSchema(root:) is iOS 26.0).
 *   - cancel(requestId): cancels the Task wrapping respond().
 *
 * Availability trap (verified on-device): `availability` can stay stale after
 * the model download finishes, so generate() NEVER refuses up front — it
 * attempts respond() and only reports LLM_UNAVAILABLE when the attempt fails
 * AND the model is not .available.
 */
enum LocalLanguageModel {

    // MARK: - Bridge entry points (always safe to call)

    /// {available, reason?, contextSize?, supportedLanguages?}
    static func availability() async -> [String: Any] {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            return availabilityResult()
        }
        #endif
        return ["available": false, "reason": "unsupported-os"]
    }

    /// Warm the model so the first generate is faster. Fire-and-forget.
    static func prewarm() async {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            LanguageModelSession().prewarm()
        }
        #endif
    }

    /// One stateless generation. Returns a result envelope — errors never
    /// throw across the bridge so the host maps codes deterministically.
    static func generate(request: [String: Any]) async -> [String: Any] {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            let requestId = (request["requestId"] as? String) ?? UUID().uuidString
            let box = LlmRequestBox(raw: request)
            let task = Task<LlmOutcome, Never> {
                await runGenerate(request: box.raw)
            }
            await LlmTaskRegistry.shared.register(requestId, task: task)
            let outcome = await task.value
            await LlmTaskRegistry.shared.unregister(requestId)
            return outcome.dictionary
        }
        #endif
        return LlmOutcome.failure(
            code: "LLM_UNAVAILABLE",
            reason: "unsupported-os",
            message: "On-device language model requires iOS 26",
            elapsedMs: 0
        ).dictionary
    }

    /// Cancel an in-flight generate by requestId. Best-effort: unknown or
    /// already-settled ids are a no-op.
    static func cancel(requestId: String) async {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            await LlmTaskRegistry.shared.cancel(requestId)
        }
        #endif
    }

    // MARK: - Availability

    #if canImport(FoundationModels)
    @available(iOS 26.0, macOS 26.0, *)
    private static func availabilityResult() -> [String: Any] {
        let model = SystemLanguageModel.default
        var result: [String: Any] = [
            "contextSize": model.contextSize,
            "supportedLanguages": model.supportedLanguages.map { $0.maximalIdentifier }.sorted(),
        ]
        switch model.availability {
        case .available:
            result["available"] = true
        case .unavailable:
            result["available"] = false
            result["reason"] = unavailableReason()
        }
        return result
    }

    @available(iOS 26.0, macOS 26.0, *)
    private static func unavailableReason() -> String {
        switch SystemLanguageModel.default.availability {
        case .available:
            return "unknown"
        case .unavailable(let reason):
            switch reason {
            case .deviceNotEligible: return "device-not-eligible"
            case .appleIntelligenceNotEnabled: return "apple-intelligence-not-enabled"
            case .modelNotReady: return "model-not-ready"
            default: return "unknown"
            }
        }
    }
    #endif

    // MARK: - Generation

    #if canImport(FoundationModels)
    @available(iOS 26.0, macOS 26.0, *)
    private static func runGenerate(request: [String: Any]) async -> LlmOutcome {
        let started = Date()
        func elapsed() -> Int { Int(Date().timeIntervalSince(started) * 1000) }

        guard let instructions = request["instructions"] as? String,
              let prompt = request["prompt"] as? String else {
            return .failure(code: "INVALID_ARGUMENT", message: "instructions and prompt are required", elapsedMs: elapsed())
        }

        var schema: GenerationSchema? = nil
        if let rawSchema = request["schema"], !(rawSchema is NSNull) {
            do {
                let root = try LlmSchemaMapper.dynamicSchema(
                    rawSchema,
                    name: LlmSchemaMapper.rootName(rawSchema),
                    path: "$"
                )
                schema = try GenerationSchema(root: root, dependencies: [])
            } catch let error as LocalLlmError {
                return .failure(code: error.code, reason: error.reason, message: error.message, elapsedMs: elapsed())
            } catch {
                return .failure(code: "LLM_INVALID_SCHEMA", message: String(describing: error), elapsedMs: elapsed())
            }
        }

        do {
            // Stateless: a fresh session per call — the miniapp owns context.
            let session = LanguageModelSession(instructions: instructions)
            let options = generationOptions(from: request)
            if let schema {
                let response = try await session.respond(to: prompt, schema: schema, options: options)
                let jsonString = response.content.jsonString
                let parsed = (try? JSONSerialization.jsonObject(with: Data(jsonString.utf8))) ?? jsonString
                return .success(text: nil, json: parsed, elapsedMs: elapsed())
            } else {
                let response = try await session.respond(to: prompt, options: options)
                return .success(text: response.content, json: nil, elapsedMs: elapsed())
            }
        } catch {
            return failure(from: error, elapsedMs: elapsed())
        }
    }

    @available(iOS 26.0, macOS 26.0, *)
    private static func generationOptions(from request: [String: Any]) -> GenerationOptions {
        GenerationOptions(
            temperature: (request["temperature"] as? NSNumber)?.doubleValue,
            maximumResponseTokens: (request["maxTokens"] as? NSNumber)?.intValue
        )
    }

    /// Map a thrown error to a contract code. Order matters: our own errors
    /// first, then cancellation, then the availability trap (a failed attempt
    /// while the model is not .available reports LLM_UNAVAILABLE regardless
    /// of the thrown error), then the typed FoundationModels errors.
    @available(iOS 26.0, macOS 26.0, *)
    private static func failure(from error: Error, elapsedMs: Int) -> LlmOutcome {
        let modelAvailable: Bool
        let reason: String
        if case .available = SystemLanguageModel.default.availability {
            modelAvailable = true
            reason = "unknown"
        } else {
            modelAvailable = false
            reason = unavailableReason()
        }
        return failureOutcome(from: error, modelAvailable: modelAvailable, unavailableReason: reason, elapsedMs: elapsedMs)
    }

    /// The error→code decision with availability injected, so the
    /// availability-trap policy is unit-testable without a real model state.
    @available(iOS 26.0, macOS 26.0, *)
    static func failureOutcome(from error: Error, modelAvailable: Bool, unavailableReason: String, elapsedMs: Int) -> LlmOutcome {
        if let error = error as? LocalLlmError {
            return .failure(code: error.code, reason: error.reason, message: error.message, elapsedMs: elapsedMs)
        }
        if error is CancellationError {
            return .failure(code: "LLM_CANCELLED", message: "Generation cancelled", elapsedMs: elapsedMs)
        }
        if !modelAvailable {
            return .failure(
                code: "LLM_UNAVAILABLE",
                reason: unavailableReason,
                message: "On-device language model is unavailable",
                elapsedMs: elapsedMs
            )
        }

        if #available(iOS 27.0, macOS 27.0, *) {
            if let error = error as? LanguageModelError {
                switch error {
                case .contextSizeExceeded:
                    return .failure(code: "LLM_CONTEXT_EXCEEDED", message: "Prompt exceeds the model context window", elapsedMs: elapsedMs)
                case .guardrailViolation, .refusal:
                    return .failure(code: "LLM_GUARDRAIL", message: "Guardrails refused this request", elapsedMs: elapsedMs)
                case .unsupportedLanguageOrLocale:
                    return .failure(code: "LLM_UNSUPPORTED_LANGUAGE", message: "Unsupported language or locale", elapsedMs: elapsedMs)
                case .unsupportedGenerationGuide:
                    return .failure(code: "LLM_INVALID_SCHEMA", message: "Unsupported guided-generation schema", elapsedMs: elapsedMs)
                default:
                    return .failure(code: "INTERNAL", message: error.errorDescription ?? "Generation failed", elapsedMs: elapsedMs)
                }
            }
            if let error = error as? SystemLanguageModel.Error, case .assetsUnavailable = error {
                return .failure(code: "LLM_UNAVAILABLE", reason: "model-not-ready", message: "Model assets unavailable", elapsedMs: elapsedMs)
            }
            if error is LanguageModelSession.Error {
                return .failure(code: "INTERNAL", message: "Language model session error", elapsedMs: elapsedMs)
            }
        } else {
            // iOS 26.x throws the (later deprecated) GenerationError enum.
            if let error = error as? LanguageModelSession.GenerationError {
                switch error {
                case .exceededContextWindowSize:
                    return .failure(code: "LLM_CONTEXT_EXCEEDED", message: "Prompt exceeds the model context window", elapsedMs: elapsedMs)
                case .guardrailViolation, .refusal:
                    return .failure(code: "LLM_GUARDRAIL", message: "Guardrails refused this request", elapsedMs: elapsedMs)
                case .unsupportedLanguageOrLocale:
                    return .failure(code: "LLM_UNSUPPORTED_LANGUAGE", message: "Unsupported language or locale", elapsedMs: elapsedMs)
                case .assetsUnavailable:
                    return .failure(code: "LLM_UNAVAILABLE", reason: "model-not-ready", message: "Model assets unavailable", elapsedMs: elapsedMs)
                case .unsupportedGuide, .decodingFailure:
                    return .failure(code: "LLM_INVALID_SCHEMA", message: "Unsupported guided-generation schema", elapsedMs: elapsedMs)
                default:
                    return .failure(code: "INTERNAL", message: error.errorDescription ?? "Generation failed", elapsedMs: elapsedMs)
                }
            }
        }
        return .failure(code: "INTERNAL", message: String(describing: error), elapsedMs: elapsedMs)
    }
    #endif
}

// MARK: - JSON-Schema subset → DynamicGenerationSchema

#if canImport(FoundationModels)
/**
 * Maps the contract's JSON-Schema subset to DynamicGenerationSchema:
 * object (properties/required), array (items/maxItems/minItems), string,
 * number, integer, boolean, enum (string values only), description, title.
 * Any other keyword (format, pattern, additionalProperties, $ref, anyOf,
 * const, default, …) throws LLM_INVALID_SCHEMA naming the keyword — a silent
 * drop would let a miniapp believe a constraint applies when it does not.
 */
enum LlmSchemaMapper {
    private static let allowedKeywords: Set<String> = [
        "type", "properties", "items", "required", "enum",
        "description", "title", "maxItems", "minItems",
    ]

    /// Root schema name — GenerationSchema wants a named root; use the
    /// schema's title when present.
    static func rootName(_ schema: Any) -> String {
        ((schema as? [String: Any])?["title"] as? String) ?? "Response"
    }

    @available(iOS 26.0, macOS 26.0, *)
    static func dynamicSchema(_ node: Any, name: String, path: String) throws -> DynamicGenerationSchema {
        guard let dict = node as? [String: Any] else {
            throw LocalLlmError(code: "LLM_INVALID_SCHEMA", message: "schema node at \(path) must be an object")
        }
        for key in dict.keys where !allowedKeywords.contains(key) {
            throw LocalLlmError(code: "LLM_INVALID_SCHEMA", message: "unsupported schema keyword \"\(key)\" at \(path)")
        }
        let description = dict["description"] as? String

        if let enumValues = dict["enum"] {
            guard let strings = enumValues as? [String], !strings.isEmpty else {
                throw LocalLlmError(code: "LLM_INVALID_SCHEMA", message: "enum at \(path) must be a non-empty array of strings")
            }
            return DynamicGenerationSchema(name: name, description: description, anyOf: strings)
        }

        let type = (dict["type"] as? String) ?? inferredType(dict)
        switch type {
        case "object":
            let rawProps = dict["properties"] as? [String: Any] ?? [:]
            let required = Set(dict["required"] as? [String] ?? [])
            var properties: [DynamicGenerationSchema.Property] = []
            for key in rawProps.keys.sorted() {
                let child = try dynamicSchema(rawProps[key] as Any, name: key, path: "\(path).\(key)")
                properties.append(
                    DynamicGenerationSchema.Property(
                        name: key,
                        description: (rawProps[key] as? [String: Any])?["description"] as? String,
                        schema: child,
                        isOptional: !required.contains(key)
                    )
                )
            }
            return DynamicGenerationSchema(name: name, description: description, properties: properties)

        case "array":
            guard let items = dict["items"] else {
                throw LocalLlmError(code: "LLM_INVALID_SCHEMA", message: "array at \(path) requires items")
            }
            let itemSchema = try dynamicSchema(items, name: "\(name)Item", path: "\(path)[]")
            return DynamicGenerationSchema(
                arrayOf: itemSchema,
                minimumElements: (dict["minItems"] as? NSNumber)?.intValue,
                maximumElements: (dict["maxItems"] as? NSNumber)?.intValue
            )

        case "string":
            return DynamicGenerationSchema(type: String.self)
        case "number":
            return DynamicGenerationSchema(type: Double.self)
        case "integer":
            return DynamicGenerationSchema(type: Int.self)
        case "boolean":
            return DynamicGenerationSchema(type: Bool.self)
        default:
            throw LocalLlmError(
                code: "LLM_INVALID_SCHEMA",
                message: "unsupported schema type \"\(type ?? "<missing>")\" at \(path)"
            )
        }
    }

    /// `type` may be omitted when the shape is unambiguous.
    private static func inferredType(_ dict: [String: Any]) -> String? {
        if dict["properties"] != nil { return "object" }
        if dict["items"] != nil { return "array" }
        return nil
    }
}
#endif
