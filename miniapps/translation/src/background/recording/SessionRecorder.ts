/**
 * SessionRecorder — captures a session's microphone audio to a 16 kHz mono WAV
 * plus a timestamped Markdown transcript, then exports both into the
 * user-visible Files folder (On My iPhone › <App> › Recordings/<App>/).
 *
 * Mirrors the Recorder miniapp's proven pipeline (com.mentra.recorder-1.0.8,
 * background/index.js): `session.mic.onAudioChunk` delivers base64 PCM16LE
 * chunks which are buffered and flushed through `session.blob` chunked writes;
 * the blob starts with a 44-byte placeholder WAV header that is patched in
 * place (writeAt offset 0) after every flush, so even an abruptly-orphaned
 * upload commits as a playable file.
 *
 * Files export rides on the blob's `export` create option: a host that
 * implements it copies the committed file into Documents/<folder>/<filename>
 * and removes the blob (move semantics), reporting `exportedTo` / `exportError`
 * on the commit result. Hosts that predate the option silently ignore it —
 * detected as a commit result carrying neither field — so we fall back to the
 * explicit `miniapp_blob_export` request, and surface a real error when that
 * is unimplemented too. Nothing here pretends an export succeeded.
 *
 * The audio subscription exists ONLY between begin() and finish()/abort():
 * subscribing to `audio_chunk` forces device-wide PCM mic mode and pumps
 * ~100 base64 events/s over the bridge, so it must never outlive the session.
 */

import {
  base64ToBytes,
  type AudioChunkData,
  type BlobMeta,
  type BlobModule,
  type BlobSetOptions,
  type BlobWriter,
  type MiniappSession,
  type UnsubscribeFn,
} from "@mentra/miniapp/background"

const WAV_HEADER_BYTES = 44
const FLUSH_BYTES = 48 * 1024
const DEFAULT_SAMPLE_RATE = 16000

/**
 * Explicit export request type. `MiniappRequestType.BLOB_EXPORT` once the SDK
 * ships it; the literal keeps this file compiling against older SDK builds.
 */
const BLOB_EXPORT_REQUEST_TYPE = "miniapp_blob_export"

/** Destination hint carried on blob create / the explicit export request. */
export interface BlobExportHint {
  /** Path under the app's Documents directory, e.g. "Recordings/Translation". */
  folder: string
  /** Display filename, e.g. "2026-09-22 1403 Translation 3.wav". */
  filename: string
}

export interface RecordingFileNames {
  wav: string
  md: string
}

export interface RecordingResult {
  /** file:// URIs of the exported files (as reported by the host). */
  exported: string[]
  /** Human-readable failures — empty means everything saved + exported. */
  errors: string[]
}

/** `<YYYY-MM-DD HHmm>` local-time stamp used in recording filenames. */
export function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`
}

/** Milliseconds → `mm:ss` for transcript line timestamps. */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
}

export class SessionRecorder {
  private wavWriter: BlobWriter | null = null
  private mdWriter: BlobWriter | null = null
  private wavKey: string | null = null
  private mdKey: string | null = null
  private micUnsub: UnsubscribeFn | null = null
  private chunks: Uint8Array[] = []
  private bufBytes = 0
  private pcmBytes = 0
  private sampleRate = DEFAULT_SAMPLE_RATE
  private writeErrored = false
  private drainChain: Promise<void> = Promise.resolve()
  private finishing: Promise<RecordingResult> | null = null
  private names: RecordingFileNames | null = null

  constructor(
    private readonly session: MiniappSession,
    /** Folder under the app's Documents dir the host exports into. */
    private readonly exportFolder: string,
  ) {}

  /** True while a recording session is open (mic subscribed, writers live). */
  get active(): boolean {
    return this.wavWriter !== null
  }

  /** Milliseconds of audio captured so far — the [mm:ss] transcript clock. */
  elapsedMs(): number {
    if (this.sampleRate <= 0) return 0
    return Math.floor(((this.pcmBytes + this.bufBytes) / (this.sampleRate * 2)) * 1000)
  }

  /**
   * Open the WAV + transcript blobs, write the WAV placeholder header and the
   * transcript header, and subscribe to raw audio. Throws when the mic or blob
   * store is unavailable — callers surface that to the user.
   */
  async begin(names: RecordingFileNames, transcriptHeader: string): Promise<void> {
    if (this.finishing) await this.finishing
    if (this.active) return
    const mic = this.session.mic
    if (!mic?.hasPermission) {
      throw new Error("Microphone permission is required to record a session")
    }
    const blob = this.session.blob
    if (!blob) {
      throw new Error("On-device blob storage is unavailable on this host")
    }

    this.resetState()
    this.names = names
    try {
      this.wavWriter = await blob.createWriteStream(makeKey("wav"), {
        mimeType: "audio/wav",
        name: names.wav,
        meta: {title: names.wav},
        export: {folder: this.exportFolder, filename: names.wav},
      } as BlobSetOptions)
      this.wavKey = this.wavWriter.key
      this.mdWriter = await blob.createWriteStream(makeKey("md"), {
        mimeType: "text/markdown",
        name: names.md,
        meta: {title: names.md},
        export: {folder: this.exportFolder, filename: names.md},
      } as BlobSetOptions)
      this.mdKey = this.mdWriter.key
      await this.wavWriter.write(new Uint8Array(WAV_HEADER_BYTES))
      this.enqueueWrite(this.mdWriter, utf8Bytes(transcriptHeader))
    } catch (err) {
      const wav = this.wavWriter
      const md = this.mdWriter
      this.wavWriter = null
      this.mdWriter = null
      this.wavKey = null
      this.mdKey = null
      try {
        await wav?.abort()
      } catch {
        /* ignore */
      }
      try {
        await md?.abort()
      } catch {
        /* ignore */
      }
      throw err
    }
    this.micUnsub = mic.onAudioChunk((d) => this.onChunk(d))
  }

  /** mic.onAudioChunk handler — buffer PCM and flush in 48 KB batches. */
  onChunk(d: AudioChunkData): void {
    if (!this.active || this.writeErrored) return
    // Only PCM16LE can go into the WAV. The host's audio_chunk stream is PCM
    // whenever a raw subscriber exists; a format tag saying otherwise means
    // the bytes are not WAV-safe and must be dropped rather than corrupted in.
    const format = (d.format ?? "").toLowerCase()
    if (format && format !== "pcm" && format !== "pcm16" && format !== "s16le") return
    if (d.sampleRate && d.sampleRate > 0) this.sampleRate = d.sampleRate
    const bytes = base64ToBytes(d.data || "")
    if (bytes.length === 0) return
    this.chunks.push(bytes)
    this.bufBytes += bytes.length
    if (this.bufBytes >= FLUSH_BYTES) this.scheduleDrain()
  }

  /** Append one already-formatted transcript line (finals only — callers filter). */
  noteLine(text: string): void {
    const writer = this.mdWriter
    if (!writer || this.writeErrored) return
    this.enqueueWrite(writer, utf8Bytes(text.endsWith("\n") ? text : text + "\n"))
  }

  /**
   * Flush, patch the WAV header, close both blobs, and export them to Files.
   * Idempotent: a second call joins the in-flight finalize. Never rejects —
   * failures come back in `result.errors` so the caller can surface them.
   */
  finish(footer: string): Promise<RecordingResult> {
    if (this.finishing) return this.finishing
    if (!this.active) return Promise.resolve({exported: [], errors: []})
    const p = this.doFinish(footer).finally(() => {
      this.finishing = null
    })
    this.finishing = p
    return p
  }

  /** Discard the in-progress recording (setting switched off mid-session). */
  async abort(): Promise<void> {
    if (this.finishing) {
      try {
        await this.finishing
      } catch {
        /* ignore */
      }
    }
    try {
      this.micUnsub?.()
    } catch {
      /* ignore */
    }
    this.micUnsub = null
    const wav = this.wavWriter
    const md = this.mdWriter
    this.wavWriter = null
    this.mdWriter = null
    this.wavKey = null
    this.mdKey = null
    this.names = null
    try {
      await wav?.abort()
    } catch {
      /* ignore */
    }
    try {
      await md?.abort()
    } catch {
      /* ignore */
    }
    this.resetState()
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async doFinish(footer: string): Promise<RecordingResult> {
    const wavWriter = this.wavWriter!
    const mdWriter = this.mdWriter!
    const wavKey = this.wavKey!
    const mdKey = this.mdKey!
    const names = this.names!
    const sampleRate = this.sampleRate
    try {
      this.micUnsub?.()
    } catch {
      /* ignore */
    }
    this.micUnsub = null
    this.wavWriter = null
    this.mdWriter = null
    this.wavKey = null
    this.mdKey = null
    this.names = null

    const result: RecordingResult = {exported: [], errors: []}
    try {
      await this.drainChain
      await this.drainOnce(wavWriter)
      if (footer) {
        this.enqueueWrite(mdWriter, utf8Bytes(footer.endsWith("\n") ? footer : footer + "\n"))
        await this.drainChain
      }
      const wavMeta = await wavWriter.close({
        durationMs: this.sampleRate > 0 ? Math.floor((this.pcmBytes / (this.sampleRate * 2)) * 1000) : 0,
        sampleRate,
        channels: 1,
        bitsPerSample: 16,
        ...(this.writeErrored ? {truncated: true} : {}),
      })
      const mdMeta = await mdWriter.close({})
      for (const [key, meta, filename] of [
        [wavKey, wavMeta, names.wav],
        [mdKey, mdMeta, names.md],
      ] as const) {
        const outcome = await this.resolveExport(key, meta, {folder: this.exportFolder, filename})
        if (outcome.uri) result.exported.push(outcome.uri)
        if (outcome.error) result.errors.push(outcome.error)
      }
      if (this.writeErrored) {
        result.errors.push("Recording was truncated — a storage write failed mid-session")
      }
    } catch (err) {
      result.errors.push(`Recording could not be saved: ${errMessage(err)}`)
      try {
        await wavWriter.abort()
      } catch {
        /* ignore */
      }
      try {
        await mdWriter.abort()
      } catch {
        /* ignore */
      }
    }
    this.resetState()
    return result
  }

  /**
   * Export one committed blob to the Files-visible folder. Primary path: the
   * host honored the create-time `export` option and annotated the commit
   * result. Fallback: the explicit `miniapp_blob_export` request (or the SDK's
   * `blob.exportToFiles` once it exists). Anything else is a real error.
   */
  private async resolveExport(
    key: string,
    meta: BlobMeta,
    hint: BlobExportHint,
  ): Promise<{uri?: string; error?: string}> {
    const m = meta as BlobMeta & {exportedTo?: string; exportError?: string}
    if (typeof m.exportedTo === "string" && m.exportedTo) return {uri: m.exportedTo}
    if (typeof m.exportError === "string" && m.exportError) {
      return {error: `Could not export ${hint.filename} to Files: ${m.exportError}`}
    }
    try {
      const blob = this.session.blob as BlobModule & {
        exportToFiles?: (key: string, opts: BlobExportHint) => Promise<{uri: string}>
      }
      if (typeof blob.exportToFiles === "function") {
        const res = await blob.exportToFiles(key, hint)
        if (res?.uri) return {uri: res.uri}
        return {error: `Could not export ${hint.filename} to Files: the host returned no destination`}
      }
      const res = await this.session.sendRequest<{uri?: string}>({
        type: BLOB_EXPORT_REQUEST_TYPE,
        key,
        folder: hint.folder,
        filename: hint.filename,
      })
      if (res?.uri) return {uri: res.uri}
      return {error: `Could not export ${hint.filename} to Files: the host returned no destination`}
    } catch (err) {
      return {error: `Could not export ${hint.filename} to Files: ${errMessage(err)}`}
    }
  }

  private enqueueWrite(writer: BlobWriter, bytes: Uint8Array): void {
    this.drainChain = this.drainChain.then(async () => {
      if (this.writeErrored) return
      try {
        await writer.write(bytes)
      } catch (err) {
        console.log("SessionRecorder: blob write failed; stopping append", err)
        this.writeErrored = true
      }
    })
  }

  private scheduleDrain(): void {
    this.drainChain = this.drainChain.then(() => this.drainOnce(this.wavWriter)).catch(() => {})
  }

  private async drainOnce(writer: BlobWriter | null): Promise<void> {
    if (!writer || this.writeErrored) return
    while (this.chunks.length > 0) {
      const buf = this.takeBuffer()
      try {
        await writer.write(buf)
        this.pcmBytes += buf.length
      } catch (err) {
        console.log("SessionRecorder: audio write failed; stopping append", err)
        this.writeErrored = true
        return
      }
    }
    // Keep the on-disk header honest as we go: if the session dies abruptly
    // the host still commits a playable (if shorter) WAV.
    if (this.pcmBytes > 0) {
      try {
        await writer.writeAt(0, buildWavHeader(this.sampleRate, this.pcmBytes))
      } catch (err) {
        console.log("SessionRecorder: WAV header patch failed", err)
        this.writeErrored = true
      }
    }
  }

  private takeBuffer(): Uint8Array {
    if (this.chunks.length === 1) {
      const only = this.chunks[0]
      this.chunks = []
      this.bufBytes = 0
      return only
    }
    const out = new Uint8Array(this.bufBytes)
    let at = 0
    for (const c of this.chunks) {
      out.set(c, at)
      at += c.length
    }
    this.chunks = []
    this.bufBytes = 0
    return out
  }

  private resetState(): void {
    this.chunks = []
    this.bufBytes = 0
    this.pcmBytes = 0
    this.sampleRate = DEFAULT_SAMPLE_RATE
    this.writeErrored = false
    this.drainChain = Promise.resolve()
  }
}

// ── WAV + encoding helpers ─────────────────────────────────────────────────

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4)
  b[0] = n & 255
  b[1] = (n >>> 8) & 255
  b[2] = (n >>> 16) & 255
  b[3] = (n >>> 24) & 255
  return b
}

function u16le(n: number): Uint8Array {
  const b = new Uint8Array(2)
  b[0] = n & 255
  b[1] = (n >>> 8) & 255
  return b
}

/** Canonical 44-byte PCM WAV header (mono, 16-bit). Exported for tests. */
export function buildWavHeader(
  sampleRate: number,
  dataBytes: number,
  channels = 1,
  bitsPerSample = 16,
): Uint8Array {
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const h = new Uint8Array(WAV_HEADER_BYTES)
  const ascii = (s: string, at: number) => {
    for (let i = 0; i < s.length; i++) h[at + i] = s.charCodeAt(i)
  }
  const put = (bytes: Uint8Array, at: number) => h.set(bytes, at)
  ascii("RIFF", 0)
  put(u32le(36 + dataBytes), 4)
  ascii("WAVE", 8)
  ascii("fmt ", 12)
  put(u32le(16), 16)
  put(u16le(1), 20)
  put(u16le(channels), 22)
  put(u32le(sampleRate), 24)
  put(u32le(byteRate), 28)
  put(u16le(blockAlign), 32)
  put(u16le(bitsPerSample), 34)
  ascii("data", 36)
  put(u32le(dataBytes), 40)
  return h
}

function utf8Bytes(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i)
    if (cp >= 55296 && cp <= 56319 && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1)
      if (lo >= 56320 && lo <= 57343) {
        cp = 65536 + ((cp - 55296) << 10) + (lo - 56320)
        i++
      }
    }
    if (cp < 128) {
      out.push(cp)
    } else if (cp < 2048) {
      out.push(192 | (cp >> 6), 128 | (cp & 63))
    } else if (cp < 65536) {
      out.push(224 | (cp >> 12), 128 | ((cp >> 6) & 63), 128 | (cp & 63))
    } else {
      out.push(240 | (cp >> 18), 128 | ((cp >> 12) & 63), 128 | ((cp >> 6) & 63), 128 | (cp & 63))
    }
  }
  return new Uint8Array(out)
}

function makeKey(prefix: string): string {
  return `rec-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "object" && err !== null && "message" in err) return String((err as {message: unknown}).message)
  return String(err)
}
