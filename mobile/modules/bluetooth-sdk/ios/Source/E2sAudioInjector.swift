import Foundation

/**
 * Easy2See dev-only audio injector (overnight device lab).
 *
 * Activated by launch argument `-E2S_INJECT_AUDIO <filename>`: reads a
 * 16 kHz mono Int16 PCM file (raw .pcm, or a WAV whose fmt chunk is
 * 16 kHz/mono/Int16 — the 44-byte header is stripped) from the app
 * container at `Documents/e2s-test/<filename>` and feeds it into
 * `DeviceManager.handlePcm` in real-time 20 ms chunks, looping until the
 * process ends. While active, `handlePcm` drops real mic/glasses audio so
 * the recognizer sees a clean single stream; glasses frame counting in
 * `handleGlassesMicData` still runs for feed diagnostics.
 *
 * Logs byte counts only — never audio content.
 */
final class E2sAudioInjector {
    static let shared = E2sAudioInjector()

    private(set) var isActive = false
    private var pcm = Data()
    private var offset = 0
    private var timer: DispatchSourceTimer?
    private var chunksFed = 0
    private var loops = 0

    /// 20 ms of 16 kHz mono Int16 = 320 samples = 640 bytes.
    private let chunkBytes = 640

    private init() {}

    func startIfRequested() {
        guard !isActive else { return }
        guard let name = UserDefaults.standard.string(forKey: "E2S_INJECT_AUDIO"), !name.isEmpty else { return }
        // Path traversal guard: filename only, no separators.
        guard !name.contains("/") && !name.contains("..") else {
            Bridge.log("E2S: inject rejected bad filename")
            return
        }
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("e2s-test", isDirectory: true)
        let url = dir.appendingPathComponent(name)
        guard var data = try? Data(contentsOf: url) else {
            Bridge.log("E2S: inject file missing: \(name)")
            return
        }
        if data.count >= 12 && data.prefix(4).elementsEqual([0x52, 0x49, 0x46, 0x46]) { // "RIFF"
            // Walk RIFF chunks to the 'data' chunk — afconvert writes a large
            // FLLR padding chunk, so a fixed 44-byte strip feeds zeros.
            var off = 12
            var stripped = false
            while off + 8 <= data.count {
                let cid = data.subdata(in: off..<(off + 4))
                let sz = Int(data.withUnsafeBytes { $0.load(fromByteOffset: off + 4, as: UInt32.self) }.littleEndian)
                if cid.elementsEqual([0x64, 0x61, 0x74, 0x61]) { // "data"
                    let start = off + 8
                    let end = min(start + sz, data.count)
                    data = data.subdata(in: start..<end)
                    stripped = true
                    break
                }
                off += 8 + sz + (sz & 1)
            }
            Bridge.log("E2S: inject WAV strip \(stripped ? "ok" : "no data chunk") pcmBytes=\(data.count)")
        }
        guard data.count >= chunkBytes else {
            Bridge.log("E2S: inject file too small bytes=\(data.count)")
            return
        }
        pcm = data
        isActive = true
        Bridge.log("E2S: inject active file=\(name) pcmBytes=\(pcm.count) chunkBytes=\(chunkBytes)")

        let t = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInitiated))
        t.schedule(deadline: .now() + 0.1, repeating: .milliseconds(20))
        t.setEventHandler { [weak self] in self?.tick() }
        timer = t
        t.resume()
    }

    private func tick() {
        if offset + chunkBytes > pcm.count {
            offset = 0
            loops += 1
            Bridge.log("E2S: inject loop=\(loops) chunksFed=\(chunksFed)")
        }
        let chunk = pcm.subdata(in: offset..<(offset + chunkBytes))
        offset += chunkBytes
        chunksFed += 1
        DispatchQueue.main.async {
            DeviceManager.shared.handlePcm(chunk, injected: true)
        }
    }
}
