#if !os(macOS)
import AVFoundation
import Speech
import SwiftUI
import Translation
import UIKit

/**
 * On-device speech + translation pipeline — the Easy2Say stack
 * (SFSpeechRecognizer lanes + Apple's Translation framework) driven by
 * glasses PCM instead of the phone microphone.
 *
 * One SFSpeechRecognizer lane runs per candidate source language. Each lane
 * streams the same PCM feed; the lane with the highest mean segment
 * confidence is treated as the heard language, mirroring Easy2Say's
 * dual-lane arbitration. The winning lane's text is translated on-device via
 * a view-anchored TranslationSession and emitted as `local_translation`
 * Bridge events.
 *
 * v1 scope: a single target language per activation (the first pair's
 * target). Additional distinct targets are logged and unserved — the
 * Translation framework anchors one session per language pair.
 *
 * The class itself is ungated so DeviceManager can hold it as a stored
 * property; every Translation-framework type lives inside the iOS-18-gated
 * LocalTranslationEngine held as AnyObject.
 */
@MainActor
final class LocalTranslationPipeline {
    /// Max simultaneous speech-recognizer lanes.
    private static let maxLanes = 3
    /// Minimum confidence for a lane to win arbitration.
    private static let minLaneConfidence: Float = 0.05
    /// retryWithBackoff budget per failure streak: 0.5s doubling, capped at
    /// 8s, at most this many scheduled restarts before the lane gives up.
    private static let maxLaneRetries = 5
    private static let retryBaseDelay: TimeInterval = 0.5
    private static let retryMaxDelay: TimeInterval = 8
    /// Utterance promotion: some locales (zh-TW among them) never emit
    /// isFinal, so consumers that commit only on finals stall forever. A
    /// partial whose text has been stable this long is promoted by
    /// endAudio'ing the request so Apple emits a genuine final.
    private static let stablePartialPromoteMs: TimeInterval = 1.2
    /// Hard cap: an utterance older than this rolls over even while the
    /// text is still changing.
    private static let maxUtteranceMs: TimeInterval = 30
    /// After a promoted endAudio, wait this long for Apple's final before
    /// committing the last partial as final ourselves.
    private static let promotionFallbackMs: TimeInterval = 1.5
    /// Promotion evaluation cadence.
    private static let promotionTickNanos: UInt64 = 250_000_000
    /// Dev-only experiment switches (overnight device lab), read from the
    /// launch-argument domain like the other E2S flags. E2S_PROMOTE=0
    /// disables the promotion loop entirely; E2S_START_GAP_MS>0 makes
    /// startLane wait that long after a torn-down request before creating
    /// the next one, and staggers startLanes by the same gap per lane.
    private static var promotionEnabled: Bool {
        guard let raw = UserDefaults.standard.string(forKey: "E2S_PROMOTE") else { return true }
        return raw != "0"
    }
    private static var startGapMs: Int {
        Int(UserDefaults.standard.string(forKey: "E2S_START_GAP_MS") ?? "0") ?? 0
    }

    /// Transcribe-only (Contract A) vs. speech+translation. Transcription
    /// mode shares the lane machinery but skips the Translation engine and
    /// emits `local_transcription` events instead.
    private enum Mode {
        case translation
        case transcription
    }
    private var mode: Mode = .translation

    // MARK: - Lane state

    private final class Lane {
        let wireSource: String
        let speechLocale: Locale
        let recognizer: SFSpeechRecognizer
        var request: SFSpeechAudioBufferRecognitionRequest?
        var task: SFSpeechRecognitionTask?
        /// Bumped every (re)start; a recognition callback stamped with an
        /// older generation no-ops, so cancelling a task can never schedule
        /// another start.
        var generation = 0
        /// Consecutive retryWithBackoff restarts scheduled for the current
        /// failure streak; cleared by a real result or an utterance reset.
        var retryAttempt = 0
        /// Pending backoff restart, if any. Cancelled when the lane is
        /// restarted by another path or torn down.
        var retryTask: Task<Void, Never>?
        /// Lane gave up: stopAndSurface, or the backoff budget ran out.
        /// A new utterance (resetLanes) is a fresh restart budget.
        var failed = false
        /// PCM buffers appended to the current request — diagnostics only.
        var appendedBuffers = 0
        /// Per-request converter to the request's nativeAudioFormat (Easy2Say
        /// pattern): recreated when a new request's native format differs.
        var audioConverter: AVAudioConverter?
        var converterInputSignature: AudioFormatSignature?
        var lastText = ""
        var lastConfidence: Float = 0
        /// Wall-clock of the most recent recognition result — partial
        /// arbitration tiebreak (segment confidence is 0 on non-finals).
        var lastResultAt = Date.distantPast
        /// Wall-clock of the last change to lastText — a partial stable
        /// for stablePartialPromoteMs is promoted to a final.
        var partialChangedAt = Date.distantPast
        /// Wall-clock when the current utterance's text first became
        /// non-empty — the maxUtteranceMs rollover clock.
        var utteranceStartAt = Date.distantPast
        /// Set after a promoted endAudio while we wait for Apple's final;
        /// cleared by a real final or a restart.
        var awaitingPromotion = false
        /// Fallback timer that commits the last partial as final when no
        /// Apple final arrives within promotionFallbackMs of a promoted
        /// endAudio.
        var promotionTask: Task<Void, Never>?

        init(wireSource: String, speechLocale: Locale, recognizer: SFSpeechRecognizer) {
            self.wireSource = wireSource
            self.speechLocale = speechLocale
            self.recognizer = recognizer
        }
    }

    /// One-shot: the first PCM buffer accepted after each configure is
    /// logged (bytes + frameCount) so audio starvation is provable.
    private var loggedFirstAudioBuffer = false
    /// Rolling 5s audio-feed window: buffers/bytes accepted and the window
    /// start. A summary line logs at most once per 5s while audio flows.
    private var audioWindowStart: TimeInterval = 0
    private var audioWindowBuffers = 0
    private var audioWindowBytes = 0
    /// One-shot: emitted local_translation_unavailable with a
    /// speech-specific reason once every lane gave up. Cleared when a lane
    /// later produces a result so a transient outage can re-report.
    private var emittedSpeechUnavailable = false

    private var lanes: [Lane] = []
    private var targetWireTag: String?
    private var active = false
    private var authorizationRequested = false
    private var lastEmittedPartial = ""
    private var utteranceCounter = 0
    /// Bumped on every configure/teardown so a late authorization callback
    /// from a superseded configure cannot start the new lanes twice.
    private var configureGeneration = 0
    /// Repeating task that promotes stable partials to finals — the fix
    /// for locales that never emit isFinal.
    private var promotionLoopTask: Task<Void, Never>?
    /// Lane that won the most recent final arbitration — partials stay
    /// sticky to it while non-empty (raw partial length is script-biased).
    /// Weak: lanes are owned by `lanes`; cleared on teardown.
    private weak var preferredPartialLane: Lane?
    private var loggedSameLanguage = false

    /// LocalTranslationEngine on iOS 18+; AnyObject so this class compiles on
    /// every deployment target (stored properties can't carry @available).
    private var engine: AnyObject?

    // MARK: - Configuration

    /**
     * (Re)configure the pipeline for the requested pairs. `source` may be a
     * BCP-47 wire tag, "auto", or "*"; "auto"/"*" expands to the device's
     * preferred languages filtered by available on-device recognizers.
     *
     * Reconfiguring tears down the previous lanes, recognition tasks, and
     * translation host before installing new ones; the speech-authorization
     * grant is kept so a reconfigure does not re-prompt.
     */
    func configure(pairs: [[String: String]], probeReason: String? = nil) {
        Bridge.log("LocalTranslation: configure pairs=\(pairs) probeReason=\(probeReason ?? "nil")")
        mode = .translation
        guard #available(iOS 18.0, *) else {
            Bridge.log("LocalTranslation: Apple Translation requires iOS 18; pipeline disabled")
            return
        }

        teardownPipeline(reason: "configure")
        loggedFirstAudioBuffer = false
        audioWindowStart = 0
        audioWindowBuffers = 0
        audioWindowBytes = 0
        emittedSpeechUnavailable = false

        let parsed: [(source: String, target: String)] = pairs.compactMap { pair in
            guard let target = pair["target"], !target.isEmpty else { return nil }
            return (source: pair["source"] ?? "auto", target: target)
        }
        guard let first = parsed.first else {
            return
        }

        targetWireTag = first.target
        if parsed.contains(where: { $0.target != first.target }) {
            Bridge.log("LocalTranslation: multiple targets requested; serving only \(first.target) in v1")
        }

        // Resolve candidate source locales.
        var speechLocales: [(wire: String, locale: Locale)] = []
        var seen = Set<String>()
        outer: for pair in parsed {
            let sources = (pair.source == "auto" || pair.source == "*")
                ? Locale.preferredLanguages
                : [pair.source]
            for source in sources {
                let speechId = LocalTranslationLocales.speechLocaleIdentifier(for: source)
                guard !seen.contains(speechId) else { continue }
                seen.insert(speechId)
                speechLocales.append((wire: source, locale: Locale(identifier: speechId)))
                if speechLocales.count >= Self.maxLanes { break outer }
            }
        }

        // Keep only locales with an on-device recognizer — this hop is
        // on-device; there is no server-fallback lane.
        lanes = speechLocales.compactMap { candidate in
            guard let recognizer = SFSpeechRecognizer(locale: candidate.locale) else {
                Bridge.log("LocalTranslation: no recognizer for \(candidate.locale.identifier); lane dropped")
                return nil
            }
            guard recognizer.supportsOnDeviceRecognition else {
                Bridge.log("LocalTranslation: \(candidate.locale.identifier) lacks on-device recognition; lane dropped")
                return nil
            }
            return Lane(wireSource: candidate.wire, speechLocale: candidate.locale, recognizer: recognizer)
        }

        guard !lanes.isEmpty else {
            Bridge.log("LocalTranslation: no usable on-device speech recognizer lanes; pipeline inactive")
            return
        }

        let translationEngine = LocalTranslationEngine(targetWireTag: first.target, probeReason: probeReason)
        translationEngine.onEvent = { event in
            Bridge.sendLocalTranslation(translation: event)
        }
        translationEngine.attachHost()
        engine = translationEngine

        let generation = configureGeneration
        requestAuthorizationIfNeeded { [weak self] granted in
            guard let self, self.configureGeneration == generation else { return }
            if granted {
                self.active = true
                self.startLanes()
            } else {
                Bridge.log("LocalTranslation: speech recognition authorization denied")
            }
        }
    }

    func shutdown() {
        Bridge.log("LocalTranslation: shutdown")
        teardownPipeline(reason: "shutdown")
    }

    // MARK: - Availability probe

    /**
     * Whether the on-device hop can serve `pairs` right now. Mirrors
     * configure's lane filter exactly — same speech-locale resolution,
     * same supportsOnDeviceRecognition drop, same maxLanes cap — so the
     * verdict cannot disagree with what configure would build. Requests
     * speech authorization once when undetermined (the system only shows
     * the dialog once). The policy itself lives in
     * LocalTranslationLocales.probeDecision so `swift test` locks it.
     */
    static func probe(pairs: [[String: String]]) async -> (available: Bool, reason: String) {
        guard #available(iOS 18.0, *) else {
            return LocalTranslationLocales.probeDecision(
                isIOS18OrNewer: false,
                speechAuthorized: false,
                hasOnDeviceLane: false,
                translationStatus: "unknown"
            )
        }

        var speechAuthorized = SFSpeechRecognizer.authorizationStatus() == .authorized
        if !speechAuthorized, SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            speechAuthorized = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status == .authorized)
                }
            }
        }

        let parsed: [(source: String, target: String)] = pairs.compactMap { pair in
            guard let target = pair["target"], !target.isEmpty else { return nil }
            return (source: pair["source"] ?? "auto", target: target)
        }

        var speechLocales: [Locale] = []
        var seen = Set<String>()
        outer: for pair in parsed {
            let sources = (pair.source == "auto" || pair.source == "*")
                ? Locale.preferredLanguages
                : [pair.source]
            for source in sources {
                let speechId = LocalTranslationLocales.speechLocaleIdentifier(for: source)
                guard !seen.contains(speechId) else { continue }
                seen.insert(speechId)
                speechLocales.append(Locale(identifier: speechId))
                if speechLocales.count >= maxLanes { break outer }
            }
        }

        let hasOnDeviceLane = speechLocales.contains { locale in
            SFSpeechRecognizer(locale: locale)?.supportsOnDeviceRecognition == true
        }

        // Aggregate LanguageAvailability for the first target against every
        // candidate source: installed if ANY pair is installed, else
        // supported if ANY is supported, else unsupported.
        var translationStatus = "unknown"
        if let targetWireTag = parsed.first?.target {
            let targetSpeechId = LocalTranslationLocales.speechLocaleIdentifier(for: targetWireTag)
            let targetLanguage = Locale.Language(identifier: targetSpeechId)
            let availability = LanguageAvailability()
            var anySupported = false
            for locale in speechLocales {
                switch await availability.status(from: locale.language, to: targetLanguage) {
                case .installed:
                    translationStatus = "installed"
                case .supported:
                    anySupported = true
                case .unsupported:
                    break
                @unknown default:
                    break
                }
                if translationStatus == "installed" { break }
            }
            if translationStatus != "installed", anySupported {
                translationStatus = "supported"
            } else if translationStatus == "unknown" {
                translationStatus = "unsupported"
            }
        }

        return LocalTranslationLocales.probeDecision(
            isIOS18OrNewer: true,
            speechAuthorized: speechAuthorized,
            hasOnDeviceLane: hasOnDeviceLane,
            translationStatus: translationStatus
        )
    }

    // MARK: - Transcribe-only mode (Contract A)

    /**
     * (Re)configure the pipeline for on-device transcription only — the same
     * SFSpeechRecognizer lanes, no Translation engine. `locales` are BCP-47
     * wire tags; "auto"/"*" expands to the device's preferred languages.
     * Recognized text is emitted as `local_transcription` Bridge events with
     * `provider: "apple-speech"`. No iOS-18 gate: speech recognition is all
     * this mode needs.
     */
    func configureTranscription(locales: [String]) {
        Bridge.log("LocalTranscription: configure locales=\(locales)")
        mode = .transcription

        teardownPipeline(reason: "configureTranscription")
        loggedFirstAudioBuffer = false
        audioWindowStart = 0
        audioWindowBuffers = 0
        audioWindowBytes = 0
        emittedSpeechUnavailable = false

        // Resolve candidate speech locales — same expansion and cap as the
        // translation configure so the two modes arbitrate identically.
        var speechLocales: [(wire: String, locale: Locale)] = []
        var seen = Set<String>()
        outer: for source in locales {
            let sources = (source == "auto" || source == "*")
                ? Locale.preferredLanguages
                : [source]
            for candidate in sources {
                let speechId = LocalTranslationLocales.speechLocaleIdentifier(for: candidate)
                guard !seen.contains(speechId) else { continue }
                seen.insert(speechId)
                speechLocales.append((wire: candidate, locale: Locale(identifier: speechId)))
                if speechLocales.count >= Self.maxLanes { break outer }
            }
        }

        // Keep only locales with an on-device recognizer — this hop is
        // on-device; there is no server-fallback lane.
        lanes = speechLocales.compactMap { candidate in
            guard let recognizer = SFSpeechRecognizer(locale: candidate.locale) else {
                Bridge.log("LocalTranscription: no recognizer for \(candidate.locale.identifier); lane dropped")
                return nil
            }
            guard recognizer.supportsOnDeviceRecognition else {
                Bridge.log("LocalTranscription: \(candidate.locale.identifier) lacks on-device recognition; lane dropped")
                return nil
            }
            return Lane(wireSource: candidate.wire, speechLocale: candidate.locale, recognizer: recognizer)
        }

        guard !lanes.isEmpty else {
            Bridge.log("LocalTranscription: no usable on-device speech recognizer lanes; pipeline inactive")
            return
        }

        let generation = configureGeneration
        requestAuthorizationIfNeeded { [weak self] granted in
            guard let self, self.configureGeneration == generation else { return }
            if granted {
                self.active = true
                self.startLanes()
            } else {
                Bridge.log("LocalTranscription: speech recognition authorization denied")
            }
        }
    }

    /**
     * Whether the transcribe-only hop can serve `locales` right now — speech
     * authorization plus an on-device recognizer lane. Mirrors
     * configureTranscription's locale resolution exactly so the verdict
     * cannot disagree with what configure would build. The policy itself
     * lives in LocalTranslationLocales.transcriptionProbeDecision so
     * `swift test` locks it.
     */
    static func probeTranscription(locales: [String]) async -> (available: Bool, reason: String) {
        var speechAuthorized = SFSpeechRecognizer.authorizationStatus() == .authorized
        if !speechAuthorized, SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            speechAuthorized = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status == .authorized)
                }
            }
        }

        var speechLocales: [Locale] = []
        var seen = Set<String>()
        outer: for source in locales {
            let sources = (source == "auto" || source == "*")
                ? Locale.preferredLanguages
                : [source]
            for candidate in sources {
                let speechId = LocalTranslationLocales.speechLocaleIdentifier(for: candidate)
                guard !seen.contains(speechId) else { continue }
                seen.insert(speechId)
                speechLocales.append(Locale(identifier: speechId))
                if speechLocales.count >= maxLanes { break outer }
            }
        }

        let hasOnDeviceLane = speechLocales.contains { locale in
            SFSpeechRecognizer(locale: locale)?.supportsOnDeviceRecognition == true
        }

        return LocalTranslationLocales.transcriptionProbeDecision(
            speechAuthorized: speechAuthorized,
            hasOnDeviceLane: hasOnDeviceLane
        )
    }

    /// Tears down lanes, recognition tasks, and the translation host without
    /// forgetting the speech-authorization grant.
    private func teardownPipeline(reason: String) {
        Bridge.log("LocalTranslation: teardownPipeline reason=\(reason) lanes=\(lanes.count)")
        configureGeneration += 1
        active = false
        promotionLoopTask?.cancel()
        promotionLoopTask = nil
        for lane in lanes {
            lane.retryTask?.cancel()
            lane.retryTask = nil
            lane.promotionTask?.cancel()
            lane.promotionTask = nil
            lane.awaitingPromotion = false
            // Same ordering as startLane: generation first so the
            // teardown-induced 1110 is dropped as stale.
            lane.generation += 1
            lane.request?.endAudio()
            lane.task?.cancel()
            lane.request = nil
            lane.task = nil
        }
        lanes = []
        if #available(iOS 18.0, *) {
            (engine as? LocalTranslationEngine)?.shutdown()
        }
        engine = nil
        targetWireTag = nil
        lastEmittedPartial = ""
        loggedSameLanguage = false
        preferredPartialLane = nil
    }

    // MARK: - Audio input

    func acceptAudio(pcm16le data: Data) {
        guard active else { return }
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16000,
            channels: 1,
            interleaved: true
        ) else { return }
        let frameCount = AVAudioFrameCount(data.count / 2)
        guard frameCount > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount)
        else { return }
        buffer.frameLength = frameCount
        data.withUnsafeBytes { raw in
            if let src = raw.baseAddress, let dst = buffer.int16ChannelData?[0] {
                memcpy(dst, src, data.count)
            }
        }
        if !loggedFirstAudioBuffer {
            loggedFirstAudioBuffer = true
            Bridge.log("LocalTranslation: first PCM buffer accepted bytes=\(data.count) frames=\(frameCount)")
        }
        for lane in lanes {
            guard let request = lane.request else { continue }
            let nativeFormat = request.nativeAudioFormat
            let outBuffer: AVAudioPCMBuffer?
            if format.matches(nativeFormat) {
                outBuffer = buffer
            } else {
                let inputSignature = AudioFormatSignature(format)
                if lane.converterInputSignature != inputSignature || lane.audioConverter == nil {
                    lane.audioConverter = AVAudioConverter(from: format, to: nativeFormat)
                    lane.converterInputSignature = inputSignature
                }
                guard let converter = lane.audioConverter else {
                    Bridge.log("LocalTranslation: lane \(lane.speechLocale.identifier) no converter to native format")
                    continue
                }
                outBuffer = Self.convertBuffer(buffer, using: converter, to: nativeFormat)
            }
            guard let outBuffer else { continue }
            request.append(outBuffer)
            lane.appendedBuffers += 1
        }
        // (or that it starved) without per-frame logging.
        let now = Date().timeIntervalSince1970
        if audioWindowStart == 0 { audioWindowStart = now }
        audioWindowBuffers += 1
        audioWindowBytes += data.count
        if now - audioWindowStart >= 5 {
            let perLane = lanes.map { "\($0.speechLocale.identifier)=\($0.appendedBuffers)" }.joined(separator: ",")
            Bridge.log("LocalTranslation: audio feed buffers=\(audioWindowBuffers) bytes=\(audioWindowBytes) laneAppends=[\(perLane)]")
            audioWindowStart = now
            audioWindowBuffers = 0
            audioWindowBytes = 0
        }
    }

    // MARK: - Speech lanes

    private func requestAuthorizationIfNeeded(completion: @escaping (Bool) -> Void) {
        if authorizationRequested {
            completion(SFSpeechRecognizer.authorizationStatus() == .authorized)
            return
        }
        authorizationRequested = true
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                completion(status == .authorized)
            }
        }
    }
    private func startLanes() {
        Bridge.log("LocalTranslation: experiment E2S_PROMOTE=\(Self.promotionEnabled ? 1 : 0) E2S_START_GAP_MS=\(Self.startGapMs)")
        for (index, lane) in lanes.enumerated() {
            if index == 0 || Self.startGapMs <= 0 {
                startLane(lane)
            } else {
                // Stagger lane starts so two fresh requests are not born in
                // the same tick (experiment: same-tick creation may be what
                // makes fresh requests die together).
                let generation = lane.generation
                lane.retryTask = Task { @MainActor [weak self, weak lane] in
                    try? await Task.sleep(nanoseconds: UInt64(Self.startGapMs) * 1_000_000)
                    guard let self, let lane, !Task.isCancelled else { return }
                    lane.retryTask = nil
                    guard self.active, lane.generation == generation else { return }
                    self.startLane(lane)
                }
            }
        }
        if Self.promotionEnabled {
            startPromotionLoop()
        }
    }

    /// Repeating promotion check: some locales (zh-TW among them) never
    /// emit isFinal, so consumers that commit only on finals stall
    /// forever. A partial stable for stablePartialPromoteMs is promoted
    /// by endAudio'ing the request so Apple emits a genuine final; an
    /// utterance older than maxUtteranceMs rolls over regardless.
    private func startPromotionLoop() {
        promotionLoopTask?.cancel()
        promotionLoopTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.promotionTickNanos)
                guard let self, !Task.isCancelled, self.active else { return }
                self.evaluatePromotions()
            }
        }
    }

    private func evaluatePromotions() {
        let now = Date()
        for lane in lanes where !lane.awaitingPromotion && !lane.failed {
            switch LocalTranslationLocales.partialPromotionDecision(
                now: now,
                lastChangeAt: lane.partialChangedAt,
                utteranceStartAt: lane.utteranceStartAt,
                textIsEmpty: lane.lastText.isEmpty,
                stableMs: Self.stablePartialPromoteMs,
                maxUtteranceMs: Self.maxUtteranceMs
            ) {
            case .none:
                break
            case .promote:
                promoteLane(lane, reason: "stable")
            case .rollover:
                promoteLane(lane, reason: "max")
            }
        }
    }

    /// Promote a stable partial to a final: endAudio the request so Apple
    /// emits a genuine isFinal, and arm the fallback that commits the
    /// last partial ourselves when no final arrives.
    private func promoteLane(_ lane: Lane, reason: String) {
        lane.awaitingPromotion = true
        lane.promotionTask?.cancel()
        Bridge.log("LocalTranslation: lane \(lane.speechLocale.identifier) promote reason=\(reason) chars=\(lane.lastText.count)")
        lane.request?.endAudio()
        let generation = lane.generation
        lane.promotionTask = Task { @MainActor [weak self, weak lane] in
            try? await Task.sleep(nanoseconds: UInt64(Self.promotionFallbackMs * 1_000_000_000))
            guard let self, let lane, !Task.isCancelled else { return }
            guard self.active, lane.awaitingPromotion, !lane.failed,
                  lane.generation == generation else { return }
            self.commitPromotedFinal(lane)
        }
    }

    /// No Apple final arrived after a promoted endAudio — commit the last
    /// partial as final so consumers always see one. Emits only when this
    /// lane still wins partial arbitration; otherwise the lane just
    /// restarts and the other lane's utterance continues.
    private func commitPromotedFinal(_ lane: Lane) {
        lane.awaitingPromotion = false
        lane.promotionTask = nil
        if bestLane(isFinal: false) === lane {
            Bridge.log("LocalTranslation: lane \(lane.speechLocale.identifier) promoted final outcome=partial-fallback chars=\(lane.lastText.count)")
            // A committed final wins the preference too — its lane keeps
            // partial arbitration until the next final says otherwise.
            preferredPartialLane = lane
            emit(lane: lane, text: lane.lastText, isFinal: true)
            resetLanes()
        } else {
            Bridge.log("LocalTranslation: lane \(lane.speechLocale.identifier) promoted final outcome=lost-arbitration; restarting")
            startLane(lane)
        }
    }

    private func startLane(_ lane: Lane) {
        lane.retryTask?.cancel()
        lane.retryTask = nil
        lane.promotionTask?.cancel()
        lane.promotionTask = nil
        lane.awaitingPromotion = false
        lane.partialChangedAt = .distantPast
        lane.utteranceStartAt = .distantPast
        // Bump generation BEFORE tearing down the old request: the 1110
        // "No speech detected" that endAudio() on a nearly-empty request
        // produces must arrive stamped with a stale generation and be
        // dropped by the callback guard — otherwise it maps to
        // restartImmediately and the lane storms forever.
        lane.generation += 1
        let hadRequest = lane.request != nil || lane.task != nil
        lane.request?.endAudio()
        lane.task?.cancel()
        lane.request = nil
        lane.task = nil
        let generation = lane.generation

        // E2S_START_GAP_MS>0: wait after tearing down the previous request
        // before creating the next one — fresh requests born inside the
        // teardown shadow die with instant 1110 on-device.
        if Self.startGapMs > 0, hadRequest {
            lane.retryTask = Task { @MainActor [weak self, weak lane] in
                try? await Task.sleep(nanoseconds: UInt64(Self.startGapMs) * 1_000_000)
                guard let self, let lane, !Task.isCancelled else { return }
                lane.retryTask = nil
                guard self.active, !lane.failed, lane.generation == generation else { return }
                self.createRequest(lane, generation: generation)
            }
            return
        }
        createRequest(lane, generation: generation)
    }

    private func createRequest(_ lane: Lane, generation: Int) {

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        lane.request = request
        lane.lastText = ""
        lane.lastConfidence = 0
        lane.appendedBuffers = 0
        // New request may carry a different nativeAudioFormat — drop the
        // converter so the next buffer rebuilds it (Easy2Say pattern).
        lane.audioConverter = nil
        lane.converterInputSignature = nil
        let nf = request.nativeAudioFormat
        Bridge.log("LocalTranslation: lane \(lane.speechLocale.identifier) request nativeAudioFormat commonFormat=\(nf.commonFormat.rawValue) sampleRate=\(nf.sampleRate) channels=\(nf.channelCount) interleaved=\(nf.isInterleaved)")

        lane.task = lane.recognizer.recognitionTask(with: request) { [weak self, weak lane] result, error in
            guard let self, let lane else { return }
            Task { @MainActor in
                // A callback from a superseded task — including the
                // cancellation error our own startLane/teardown triggered —
                // must not touch lane state or schedule another start.
                guard lane.generation == generation else { return }
                if let result {
                    // A real result clears the failure streak and proves the
                    // lane recovered — a previously reported all-lanes-down
                    // episode may re-report if it happens again. It also
                    // cancels a pending low-buffer-1110 retry: the task
                    // demonstrably survived, so restarting it would only
                    // drop the in-flight utterance.
                    lane.retryAttempt = 0
                    lane.retryTask?.cancel()
                    lane.retryTask = nil
                    lane.failed = false
                    self.emittedSpeechUnavailable = false
                    self.handleLaneResult(lane: lane, result: result)
                }
                if let error {
                    let nsError = error as NSError
                    let disposition = LocalTranslationLocales.laneErrorDisposition(
                        domain: nsError.domain,
                        code: nsError.code,
                        message: error.localizedDescription
                    )
                    Bridge.log("LocalTranslation: lane \(lane.speechLocale.identifier) error domain=\(nsError.domain) code=\(nsError.code) disposition=\(disposition): \(error.localizedDescription)")
                    guard self.active, !lane.failed else { return }
                    // An error during a promoted endAudio means no Apple
                    // final is coming — for restart dispositions, commit
                    // the last partial as final first so the utterance is
                    // not lost. stopAndSurface still fails the lane.
                    if lane.awaitingPromotion,
                       disposition == .restartImmediately || disposition == .retryWithBackoff {
                        self.commitPromotedFinal(lane)
                        return
                    }
                    switch disposition {
                    case .ignore:
                        break
                    case .restartImmediately:
                        // A 1110 on a request that saw almost no audio is
                        // ambiguous: it may be a teardown artifact on a task
                        // that keeps running, or a terminal error that leaves
                        // the lane silently dead (observed on-device: en-US
                        // 1110 166ms after request start, then zero results
                        // forever). Bounded retry covers both — a surviving
                        // task's next result cancels the pending restart, a
                        // dead one gets restarted, and a recognizer that
                        // keeps erroring exhausts into markLaneFailed where
                        // the failure surfaces instead of hiding.
                        if nsError.domain == "kAFAssistantErrorDomain", nsError.code == 1110,
                           lane.appendedBuffers < 10 {
                            Bridge.log("LocalTranslation: lane \(lane.speechLocale.identifier) 1110 with only \(lane.appendedBuffers) buffers appended; bounded retry")
                            self.scheduleLaneRetry(lane)
                            break
                        }
                        self.startLane(lane)
                    case .retryWithBackoff:
                        self.scheduleLaneRetry(lane)
                    case .stopAndSurface:
                        self.markLaneFailed(lane, reason: "stopAndSurface")
                    }
                }
            }
        }
    }

    /// Bounded exponential backoff for retryWithBackoff errors: 0.5s
    /// doubling, capped at 8s, at most maxLaneRetries attempts per failure
    /// streak. A real result or an utterance reset clears the streak.
    private func scheduleLaneRetry(_ lane: Lane) {
        guard lane.retryAttempt < Self.maxLaneRetries else {
            markLaneFailed(lane, reason: "backoff-exhausted")
            return
        }
        lane.retryAttempt += 1
        let attempt = lane.retryAttempt
        let delay = min(Self.retryBaseDelay * pow(2.0, Double(attempt - 1)), Self.retryMaxDelay)
        let generation = lane.generation
        Bridge.log("LocalTranslation: lane \(lane.speechLocale.identifier) retry \(attempt)/\(Self.maxLaneRetries) in \(delay)s")
        lane.retryTask = Task { @MainActor [weak self, weak lane] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, let lane, !Task.isCancelled else { return }
            lane.retryTask = nil
            // Stale-generation guard: our own endAudio/cancel or a newer
            // start must never let this fire a second restart.
            guard self.active, !lane.failed, lane.generation == generation else { return }
            self.startLane(lane)
        }
    }

    /// Lane is done for this utterance: stopAndSurface or backoff budget
    /// spent. When every lane is down the hop reports unavailable with a
    /// speech-specific reason — in local mode there is no cloud fallback,
    /// so the coordinator deactivates the hop and the miniapp can surface
    /// the failure instead of showing silence.
    private func markLaneFailed(_ lane: Lane, reason: String) {
        lane.failed = true
        lane.retryTask?.cancel()
        lane.retryTask = nil
        Bridge.log("LocalTranslation: lane \(lane.speechLocale.identifier) failed (\(reason))")
        guard !emittedSpeechUnavailable, lanes.allSatisfy({ $0.failed }) else { return }
        emittedSpeechUnavailable = true
        Bridge.log("LocalTranslation: all lanes failed; reporting speech-recognizer-failed")
        if mode == .transcription {
            Bridge.sendLocalTranscriptionUnavailable(reason: "speech-recognizer-failed")
        } else {
            Bridge.sendLocalTranslationUnavailable(reason: "speech-recognizer-failed")
        }
    }

    private func handleLaneResult(lane: Lane, result: SFSpeechRecognitionResult) {
        guard active else { return }
        let transcription = result.bestTranscription
        let newText = transcription.formattedString
        let now = Date()
        if newText != lane.lastText {
            // Text actually changed — reset the stability clock; a fresh
            // non-empty text also (re)starts the utterance-age clock.
            lane.partialChangedAt = now
            if lane.utteranceStartAt == .distantPast, !newText.isEmpty {
                lane.utteranceStartAt = now
            }
        }
        lane.lastText = newText
        let confidences = transcription.segments.map { $0.confidence }
        lane.lastConfidence = confidences.isEmpty ? 0 : confidences.reduce(0, +) / Float(confidences.count)
        lane.lastResultAt = now
        Bridge.log("LocalTranslation: lane \(lane.speechLocale.identifier) result final=\(result.isFinal) chars=\(lane.lastText.count) conf=\(lane.lastConfidence)")

        if result.isFinal {
            if lane.awaitingPromotion {
                lane.awaitingPromotion = false
                lane.promotionTask?.cancel()
                lane.promotionTask = nil
                Bridge.log("LocalTranslation: lane \(lane.speechLocale.identifier) promoted final outcome=apple-final")
            }
            guard let best = bestLane(isFinal: true) else {
                // A final below the confidence floor still terminates the
                // request — restart the lane or it goes silent forever.
                startLane(lane)
                return
            }
            // The final winner becomes the preferred partial lane: raw
            // partial length is script-biased (a wrong-script lane's
            // phonetic gibberish out-grows the real transcript), so once
            // a lane proves itself on a final its partials stay sticky.
            preferredPartialLane = best
            if best === lane {
                emit(lane: lane, text: lane.lastText, isFinal: true)
                resetLanes()
            } else {
                // A final from a non-best lane is dropped — but the final
                // also terminated this lane's request, so restart it or
                // the lane goes silent while the other lane talks.
                startLane(lane)
            }
            return
        }
        guard let best = bestLane(isFinal: false) else { return }
        if best === lane, lane.lastText != lastEmittedPartial {
            lastEmittedPartial = lane.lastText
            emit(lane: lane, text: lane.lastText, isFinal: false)
        }
    }

    /// Picks the lane whose text should be emitted. Apple only populates
    /// SFTranscriptionSegment.confidence on FINAL results — it is 0 on
    /// partials — so partials arbitrate on the longest transcript (the lane
    /// actually hearing the utterance accumulates text; the wrong-language
    /// lane stays short or empty), tie-broken by most recent result. Finals
    /// keep the confidence comparison where the value is real.
    private func bestLane(isFinal: Bool) -> Lane? {
        let candidates = lanes.filter { !$0.lastText.isEmpty }
        if isFinal {
            return candidates
                .filter { $0.lastConfidence >= Self.minLaneConfidence }
                .max { $0.lastConfidence < $1.lastConfidence }
        }
        let preferredIndex = preferredPartialLane.flatMap { preferred in
            candidates.firstIndex(where: { $0 === preferred })
        }
        guard let index = LocalTranslationLocales.bestPartialLaneIndex(
            candidates.map { (textCount: $0.lastText.count, resultAt: $0.lastResultAt) },
            preferredLaneIndex: preferredIndex
        ) else { return nil }
        return candidates[index]
    }

    private func resetLanes() {
        // A finalized request cannot accept more audio; restart every lane so
        // recognition continues seamlessly into the next utterance. A new
        // utterance is a fresh restart budget for a previously failing lane.
        lastEmittedPartial = ""
        for lane in lanes {
            lane.retryAttempt = 0
            lane.failed = false
            startLane(lane)
        }
    }

    // MARK: - Emission

    private func emit(lane: Lane, text: String, isFinal: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Transcribe-only mode (Contract A): emit the winning lane's text
        // directly as a local_transcription event — no translation engine,
        // no same-language passthrough rule.
        if mode == .transcription {
            let utteranceId = "at-\(utteranceCounter)"
            if isFinal { utteranceCounter += 1 }
            let now = Int(Date().timeIntervalSince1970 * 1000)
            Bridge.sendLocalTranscription(transcription: [
                "type": "local_transcription",
                "text": trimmed,
                "isFinal": isFinal,
                "transcribeLanguage": lane.speechLocale.identifier,
                "provider": "apple-speech",
                "utteranceId": utteranceId,
                "startTime": now - 1000,
                "endTime": now,
                "speakerId": 0,
            ])
            return
        }

        guard let targetWireTag else { return }
        let targetSpeechId = LocalTranslationLocales.speechLocaleIdentifier(for: targetWireTag)
        // Same-language pair: the miniapp's passthrough owns this path — do
        // not call Apple translate and do not emit.
        guard lane.speechLocale.identifier != targetSpeechId else {
            if !loggedSameLanguage {
                loggedSameLanguage = true
                Bridge.log("LocalTranslation: source \(lane.speechLocale.identifier) equals target \(targetSpeechId); passthrough owns it")
            }
            return
        }
        let sourceWireTag = (lane.wireSource == "auto" || lane.wireSource == "*")
            ? lane.speechLocale.identifier
            : lane.wireSource
        let utteranceId = "lt-\(utteranceCounter)"
        if isFinal { utteranceCounter += 1 }

        if #available(iOS 18.0, *) {
            (engine as? LocalTranslationEngine)?.submit(
                sourceText: trimmed,
                sourceWireTag: sourceWireTag,
                utteranceId: utteranceId,
                isFinal: isFinal
            )
        }
    }
}

/**
 * iOS-18-gated translation half of the pipeline: owns the view-anchored
 * TranslationSession (same mechanism Easy2Say's TranslationCoordinator uses)
 * and serializes translate calls.
 *
 * Like Easy2Say, the session configuration pins BOTH source and target —
 * source: nil auto-detect treats Chinese as one language and will not
 * reliably produce Traditional. The source follows the winning lane's
 * speech locale; when that locale id changes the configuration is replaced
 * and translation waits for the new session to arrive.
 */
@available(iOS 18.0, *)
@MainActor
private final class LocalTranslationEngine: ObservableObject {
    /// Partial results coalesce into one translate call per this window;
    /// finals flush immediately.
    private static let partialCoalesceNanos: UInt64 = 250_000_000
    /// Delay before re-trying host attachment when no root view controller
    /// was ready yet.
    private static let attachRetryNanos: UInt64 = 1_000_000_000
    /// A submitted job waiting for its TranslationSession gives up after
    /// this window and reports the hop unavailable. In local mode there is
    /// no cloud fallback: the coordinator deactivates the hop so the
    /// miniapp can surface the failure instead of showing silence.
    private static let sessionWaitNanos: UInt64 = 8_000_000_000

    @Published var configuration: TranslationSession.Configuration?
    var onEvent: ([String: Any]) -> Void = { _ in }

    private let targetWireTag: String
    private let targetSpeechId: String
    private let targetLanguage: Locale.Language
    /// Speech-locale id of the session's source; nil until the first submit.
    private var activeSourceSpeechId: String?
    private var session: TranslationSession?
    private var hostController: UIHostingController<TranslationHostView>?
    private var attachRetryTask: Task<Void, Never>?
    private var partialFlushTask: Task<Void, Never>?
    private var partialReady = false
    private var inFlight = false
    private var pending: (sourceText: String, sourceWireTag: String, utteranceId: String, isFinal: Bool)?
    private var loggedMissingHost = false
    private var loggedWaitingForSession = false
    /// The probeLocalTranslation reason that let this hop activate (e.g.
    /// "needs-download"); reported on local_translation_unavailable.
    private let probeReason: String?
    /// Bumped on every session swap/arrival so a stale prepare or wait
    /// cannot report unavailable for a superseded session.
    private var sessionGeneration = 0
    private var sessionWaitTask: Task<Void, Never>?
    /// Dedups local_translation_unavailable events: set when a late failure
    /// reports, cleared by a later successful prepare/translate so a new
    /// failure episode can report again. Does NOT gate translate attempts —
    /// in local mode there is no cloud fallback, so a transient failure must
    /// not silence the hop permanently.
    private var emittedUnavailable = false

    init(targetWireTag: String, probeReason: String? = nil) {
        self.targetWireTag = targetWireTag
        self.probeReason = probeReason
        self.targetSpeechId = LocalTranslationLocales.speechLocaleIdentifier(for: targetWireTag)
        self.targetLanguage = Locale.Language(identifier: targetSpeechId)
    }

    func attachHost() {
        guard hostController == nil else { return }
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let root = scene.windows.first?.rootViewController
        else {
            if !loggedMissingHost {
                loggedMissingHost = true
                Bridge.log("LocalTranslation: no root view controller for translation host; retrying")
            }
            scheduleAttachRetry()
            return
        }
        loggedMissingHost = false
        let host = UIHostingController(rootView: TranslationHostView(engine: self))
        host.view.frame = .zero
        host.view.alpha = 0.01
        host.view.isUserInteractionEnabled = false
        root.addChild(host)
        root.view.addSubview(host.view)
        host.didMove(toParent: root)
        hostController = host
    }

    private func scheduleAttachRetry() {
        guard attachRetryTask == nil else { return }
        attachRetryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.attachRetryNanos)
            guard let self, !Task.isCancelled else { return }
            self.attachRetryTask = nil
            self.attachHost()
        }
    }
    func sessionArrived(_ newSession: TranslationSession) {
        session = newSession
        sessionGeneration += 1
        sessionWaitTask?.cancel()
        sessionWaitTask = nil
        loggedWaitingForSession = false
        // Warm the models for this pair once per session. A thrown prepare
        // (e.g. a needs-download pair the system cannot fetch) is a late
        // failure: report unavailable once — in local mode the coordinator
        // deactivates the hop since no cloud fallback exists.
        let generation = sessionGeneration
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await newSession.prepareTranslation()
                guard self.sessionGeneration == generation else { return }
                // A successful prepare proves the hop recovered; allow a
                // later failure episode to report unavailable again.
                self.emittedUnavailable = false
            } catch {
                guard self.sessionGeneration == generation else { return }
                let nsError = error as NSError
                Bridge.log("LocalTranslation: prepareTranslation failed domain=\(nsError.domain) code=\(nsError.code): \(error.localizedDescription)")
                self.emitUnavailable()
            }
        }
        drain()
    }

    func submit(sourceText: String, sourceWireTag: String, utteranceId: String, isFinal: Bool) {
        // emittedUnavailable only dedups the unavailable event — it does
        // not gate jobs. In local mode there is no cloud fallback, so a
        // transient failure must not silence the hop permanently.
        let sourceSpeechId = LocalTranslationLocales.speechLocaleIdentifier(for: sourceWireTag)
        // Same-language pair: the miniapp's passthrough owns this path — do
        // not call Apple translate and do not emit.
        guard sourceSpeechId != targetSpeechId else { return }

        // The heard language follows the winning lane. Swap the session only
        // when the speech-locale id actually changes — no thrash.
        if sourceSpeechId != activeSourceSpeechId {
            activeSourceSpeechId = sourceSpeechId
            session = nil
            sessionGeneration += 1
            configuration = TranslationSession.Configuration(
                source: Locale.Language(identifier: sourceSpeechId),
                target: targetLanguage
            )
        }

        // If the host never attached (no root VC at configure time), nudge
        // it now that audio is flowing.
        if hostController == nil {
            attachHost()
        }

        pending = (sourceText: sourceText, sourceWireTag: sourceWireTag, utteranceId: utteranceId, isFinal: isFinal)
        if isFinal {
            partialFlushTask?.cancel()
            partialFlushTask = nil
            drain()
        } else {
            // A new partial starts its own coalesce window even if an
            // earlier flush already fired while a translate was in flight.
            partialReady = false
            schedulePartialFlush()
        }
    }

    private func schedulePartialFlush() {
        guard partialFlushTask == nil else { return }
        partialFlushTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.partialCoalesceNanos)
            guard let self, !Task.isCancelled else { return }
            self.partialFlushTask = nil
            self.partialReady = true
            self.drain()
        }
    }

    private func drain() {
        guard !inFlight, let job = pending else { return }
        // Partials wait for the coalesce window; finals flush immediately.
        guard job.isFinal || partialReady else { return }
        guard let session else {
            // Session not delivered yet (first use or a source-locale swap):
            // hold the latest job until sessionArrived — but only for the
            // wait window, then report the hop unavailable (in local mode
            // the coordinator deactivates the hop; there is no cloud path).
            if !loggedWaitingForSession {
                loggedWaitingForSession = true
                Bridge.log("LocalTranslation: waiting for TranslationSession; holding latest job")
            }
            scheduleSessionWait()
            return
        }
        inFlight = true
        pending = nil
        partialReady = false
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.inFlight = false
                self.drain()
            }
            // Never emit source text as a translation: a missing session, a
            // thrown translate, or an empty targetText emits nothing.
            guard let translated = await self.translate(job.sourceText, over: session) else { return }
            self.onEvent([
                "text": translated,
                "isFinal": job.isFinal,
                "sourceLanguage": job.sourceWireTag,
                "targetLanguage": self.targetWireTag,
                "originalText": job.sourceText,
                "utteranceId": job.utteranceId,
                "provider": "apple-speech-translation",
            ])
        }
    }

    private func translate(_ text: String, over session: TranslationSession) async -> String? {
        do {
            let response = try await session.translate(text)
            let out = response.targetText.trimmingCharacters(in: .whitespacesAndNewlines)
            if out.isEmpty {
                Bridge.log("LocalTranslation: translate outcome=empty sourceChars=\(text.count)")
                return nil
            }
            Bridge.log("LocalTranslation: translate outcome=ok chars=\(out.count)")
            // A successful translate proves the hop recovered; allow a
            // later failure episode to report unavailable again.
            emittedUnavailable = false
            return out
        } catch {
            let nsError = error as NSError
            Bridge.log("LocalTranslation: translate outcome=error domain=\(nsError.domain) code=\(nsError.code): \(error.localizedDescription)")
            // A thrown translate is a late failure: report unavailable once
            // per episode — in local mode the coordinator deactivates the
            // hop since no cloud fallback exists.
            emitUnavailable()
            return nil
        }
    }

    /// Arms the give-up window for a job waiting on its TranslationSession.
    /// Idempotent: the first waiter owns the timer; sessionArrived cancels it.
    private func scheduleSessionWait() {
        guard sessionWaitTask == nil else { return }
        let generation = sessionGeneration
        sessionWaitTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.sessionWaitNanos)
            guard let self, !Task.isCancelled else { return }
            self.sessionWaitTask = nil
            guard self.session == nil, self.sessionGeneration == generation else { return }
            Bridge.log("LocalTranslation: TranslationSession never arrived; reporting unavailable")
            self.emitUnavailable()
        }
    }

    /// Late-failure report, deduped per episode: JS marks the probe
    /// unavailable and reconciles — in local mode (cloudSpeech off) there
    /// is no cloud fallback, so the coordinator deactivates the hop and
    /// the miniapp can surface the failure. The latch does not stop
    /// translate attempts; a later successful prepare/translate clears it
    /// so a new episode can report again.
    private func emitUnavailable() {
        guard !emittedUnavailable else { return }
        emittedUnavailable = true
        Bridge.sendLocalTranslationUnavailable(reason: probeReason ?? "unknown")
    }

    func shutdown() {
        partialFlushTask?.cancel()
        partialFlushTask = nil
        attachRetryTask?.cancel()
        attachRetryTask = nil
        sessionWaitTask?.cancel()
        sessionWaitTask = nil
        configuration?.invalidate()
        configuration = nil
        session = nil
        sessionGeneration += 1
        pending = nil
        partialReady = false
        activeSourceSpeechId = nil
        if let host = hostController {
            host.willMove(toParent: nil)
            host.view.removeFromSuperview()
            host.removeFromParent()
            hostController = nil
        }
    }
}

/// Invisible SwiftUI anchor for `.translationTask` — the same mechanism
/// Easy2Say uses to obtain a TranslationSession.
@available(iOS 18.0, *)
private struct TranslationHostView: View {
    @ObservedObject var engine: LocalTranslationEngine

    var body: some View {
        Color.clear
            .frame(width: 1, height: 1)
            .translationTask(engine.configuration) { session in
                await MainActor.run {
                    engine.sessionArrived(session)
                }
            }
    }
}

/// Audio-format identity for converter reuse — mirrors Easy2Say's
/// AudioFormatSignature (sample rate, channels, common format, interleave).
private struct AudioFormatSignature: Equatable {
    let sampleRate: Double
    let channelCount: AVAudioChannelCount
    let commonFormat: AVAudioCommonFormat
    let isInterleaved: Bool

    init(_ format: AVAudioFormat) {
        sampleRate = format.sampleRate
        channelCount = format.channelCount
        commonFormat = format.commonFormat
        isInterleaved = format.isInterleaved
    }
}

private extension AVAudioFormat {
    func matches(_ other: AVAudioFormat) -> Bool {
        AudioFormatSignature(self) == AudioFormatSignature(other)
    }
}

private extension LocalTranslationPipeline {
    /// Single-shot AVAudioConverter pass — mirrors Easy2Say's convertBuffer:
    /// feed the whole input once, then report noDataNow.
    static func convertBuffer(
        _ inputBuffer: AVAudioPCMBuffer,
        using converter: AVAudioConverter,
        to outputFormat: AVAudioFormat
    ) -> AVAudioPCMBuffer? {
        let outputFrameCapacity = max(
            AVAudioFrameCount(ceil(Double(inputBuffer.frameLength) * outputFormat.sampleRate / inputBuffer.format.sampleRate)),
            1
        )
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: outputFrameCapacity) else {
            return nil
        }
        var didProvideInput = false
        var conversionError: NSError?
        let status = converter.convert(to: outputBuffer, error: &conversionError) { _, outStatus in
            if didProvideInput {
                outStatus.pointee = .noDataNow
                return nil
            }
            didProvideInput = true
            outStatus.pointee = .haveData
            return inputBuffer
        }
        if conversionError != nil { return nil }
        switch status {
        case .haveData, .inputRanDry, .endOfStream:
            return outputBuffer.frameLength > 0 ? outputBuffer : nil
        case .error:
            return nil
        @unknown default:
            return nil
        }
    }
}
#endif
