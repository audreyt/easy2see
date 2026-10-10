import {describe, expect, test} from "bun:test"

import {buildWavHeader, fileStamp, mmss, SessionRecorder} from "./SessionRecorder"

// ── Mock host ────────────────────────────────────────────────────────────────
// Replays the SDK's wire protocol: BLOB_CREATE → BLOB_WRITE (append/seek) →
// BLOB_COMMIT. Bytes are accumulated per key so tests can inspect the exact
// file the host would have committed.

interface MockBlob {
  key: string
  opts: Record<string, unknown>
  bytes: number[] // flat byte list (append order; writeAt patches in place)
  committed: Record<string, unknown> | null
  aborted: boolean
}

function makeSession(opts: {exportResult?: {uri?: string}; exportThrows?: unknown; micPermission?: boolean} = {}) {
  const blobs = new Map<string, MockBlob>()
  const requests: Array<{type: string; payload: Record<string, unknown>}> = []
  let audioHandler: ((d: {data: string; sampleRate?: number; format?: string}) => void) | null = null
  let audioUnsubbed = false
  let createCounter = 0

  const b64decode = (b64: string): number[] => Array.from(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
  const b64encode = (bytes: number[] | Uint8Array): string => {
    let s = ""
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  }

  const session = {
    mic: {
      hasPermission: opts.micPermission ?? true,
      onAudioChunk: (h: (d: {data: string; sampleRate?: number; format?: string}) => void) => {
        audioHandler = h
        return () => {
          audioUnsubbed = true
          audioHandler = null
        }
      },
    },
    blob: {
      createWriteStream: async (key: string, o: Record<string, unknown>) => {
        const blob: MockBlob = {key, opts: o, bytes: [], committed: null, aborted: false}
        blobs.set(key, blob)
        createCounter += 1
        return {
          key,
          write: async (chunk: Uint8Array) => {
            for (const b of chunk) blob.bytes.push(b)
          },
          writeBase64: async (b64: string) => {
            blob.bytes.push(...b64decode(b64))
          },
          writeAt: async (offset: number, chunk: Uint8Array) => {
            for (let i = 0; i < chunk.length; i++) blob.bytes[offset + i] = chunk[i]
          },
          close: async (meta: Record<string, unknown>) => {
            blob.committed = meta ?? {}
            return {key, uri: `file:///blobs/${key}`, bytes: blob.bytes.length, meta: meta ?? {}}
          },
          abort: async () => {
            blob.aborted = true
          },
        }
      },
    },
    sendRequest: async <T>(payload: Record<string, unknown>): Promise<T> => {
      requests.push({type: String(payload.type), payload})
      if (payload.type === "miniapp_blob_export") {
        if (opts.exportThrows) throw opts.exportThrows
        return (opts.exportResult ?? {uri: `file:///Documents/${payload.folder}/${payload.filename}`}) as T
      }
      throw new Error(`unexpected request ${String(payload.type)}`)
    },
  }

  return {
    session,
    blobs,
    requests,
    feedAudio: (pcm: number[] | Uint8Array, extra?: {sampleRate?: number; format?: string}) =>
      audioHandler?.({data: b64encode(pcm), ...extra}),
    hasAudioSub: () => audioHandler !== null,
    audioUnsubbed: () => audioUnsubbed,
    blobBytes: (key: string) => new Uint8Array(blobs.get(key)?.bytes ?? []),
    createCount: () => createCounter,
  }
}

const NAMES = {wav: "2026-09-22 1403 Translation 1.wav", md: "2026-09-22 1403 Translation 1.md"}

// ── WAV header ───────────────────────────────────────────────────────────────

describe("buildWavHeader", () => {
  test("writes a canonical 44-byte PCM header for a known sample count", () => {
    // 8000 samples of 16-bit mono @16kHz = 16000 data bytes = 0.5s.
    const h = buildWavHeader(16000, 16000)
    expect(h.length).toBe(44)
    const ascii = (off: number, len: number) => String.fromCharCode(...h.slice(off, off + len))
    expect(ascii(0, 4)).toBe("RIFF")
    expect(ascii(8, 4)).toBe("WAVE")
    expect(ascii(12, 4)).toBe("fmt ")
    expect(ascii(36, 4)).toBe("data")
    const u32 = (off: number) => h[off] | (h[off + 1] << 8) | (h[off + 2] << 16) | (h[off + 3] << 24)
    const u16 = (off: number) => h[off] | (h[off + 1] << 8)
    expect(u32(4)).toBe(36 + 16000) // RIFF chunk size = file size - 8
    expect(u32(16)).toBe(16) // fmt chunk size
    expect(u16(20)).toBe(1) // PCM
    expect(u16(22)).toBe(1) // mono
    expect(u32(24)).toBe(16000) // sample rate
    expect(u32(28)).toBe(32000) // byte rate = rate * channels * bits/8
    expect(u16(32)).toBe(2) // block align
    expect(u16(34)).toBe(16) // bits per sample
    expect(u32(40)).toBe(16000) // data size
  })

  test("zero-length recording still produces a valid empty WAV", () => {
    const h = buildWavHeader(16000, 0)
    const u32 = (off: number) => h[off] | (h[off + 1] << 8) | (h[off + 2] << 16) | (h[off + 3] << 24)
    expect(u32(4)).toBe(36)
    expect(u32(40)).toBe(0)
  })
})

describe("fileStamp / mmss", () => {
  test("fileStamp formats <YYYY-MM-DD HHmm>", () => {
    expect(fileStamp(new Date(2026, 8, 22, 14, 3))).toBe("2026-09-22 1403")
    expect(fileStamp(new Date(2026, 0, 5, 9, 7))).toBe("2026-01-05 0907")
  })
  test("mmss formats transcript timestamps", () => {
    expect(mmss(0)).toBe("00:00")
    expect(mmss(65_000)).toBe("01:05")
    expect(mmss(3_599_999)).toBe("59:59")
  })
})

// ── Session lifecycle ────────────────────────────────────────────────────────

describe("SessionRecorder", () => {
  test("audio subscription exists only between begin() and finish()", async () => {
    const {session, hasAudioSub, audioUnsubbed} = makeSession()
    const rec = new SessionRecorder(session as never, "Recordings/Translation")
    expect(hasAudioSub()).toBe(false)
    await rec.begin(NAMES, "# header\n")
    expect(hasAudioSub()).toBe(true)
    await rec.finish("## footer\n")
    expect(hasAudioSub()).toBe(false)
    expect(audioUnsubbed()).toBe(true)
  })

  test("abort() drops the mic subscription and aborts both blobs", async () => {
    const {session, hasAudioSub, blobs} = makeSession()
    const rec = new SessionRecorder(session as never, "Recordings/Translation")
    await rec.begin(NAMES, "# header\n")
    await rec.abort()
    expect(hasAudioSub()).toBe(false)
    for (const b of blobs.values()) expect(b.aborted).toBe(true)
    expect(rec.active).toBe(false)
  })

  test("committed WAV is header + PCM with the header patched to the real size", async () => {
    const {session, blobs, feedAudio, blobBytes} = makeSession()
    const rec = new SessionRecorder(session as never, "Recordings/Translation")
    await rec.begin(NAMES, "# header\n")
    // 1600 samples of 16-bit mono @16kHz = 3200 bytes = 0.1s.
    feedAudio(new Array(3200).fill(7), {sampleRate: 16000, format: "pcm"})
    await rec.finish("")
    const wav = [...blobs.values()].find((b) => String(b.opts.name).endsWith(".wav"))!
    const bytes = blobBytes(wav.key)
    expect(bytes.length).toBe(44 + 3200)
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF")
    const dataSize = bytes[40] | (bytes[41] << 8) | (bytes[42] << 16) | (bytes[43] << 24)
    expect(dataSize).toBe(3200)
    expect(bytes[44]).toBe(7)
  })

  test("non-PCM chunks are dropped, not corrupted into the WAV", async () => {
    const {session, blobs, feedAudio, blobBytes} = makeSession()
    const rec = new SessionRecorder(session as never, "Recordings/Translation")
    await rec.begin(NAMES, "# header\n")
    feedAudio(new Array(100).fill(1), {format: "lc3"})
    feedAudio(new Array(200).fill(2), {format: "pcm"})
    await rec.finish("")
    const wav = [...blobs.values()].find((b) => String(b.opts.name).endsWith(".wav"))!
    expect(blobBytes(wav.key).length).toBe(44 + 200)
  })

  test("transcript blob carries header, noteLine lines, and footer", async () => {
    const {session, blobs, blobBytes} = makeSession()
    const rec = new SessionRecorder(session as never, "Recordings/Translation")
    await rec.begin(NAMES, "# Translation session\n\n## Transcript\n\n")
    rec.noteLine("[00:01] heard (en): hello")
    rec.noteLine("[00:01] translation (zh-TW): 你好\n")
    await rec.finish("\n## Session\n\n- Ended: x\n")
    const md = [...blobs.values()].find((b) => String(b.opts.name).endsWith(".md"))!
    const text = new TextDecoder().decode(blobBytes(md.key))
    expect(text).toBe(
      "# Translation session\n\n## Transcript\n\n[00:01] heard (en): hello\n[00:01] translation (zh-TW): 你好\n\n## Session\n\n- Ended: x\n",
    )
  })

  test("finish exports both blobs through the explicit export request", async () => {
    const {session, requests} = makeSession()
    const rec = new SessionRecorder(session as never, "Recordings/Translation")
    await rec.begin(NAMES, "# h\n")
    const result = await rec.finish("")
    const exports = requests.filter((r) => r.type === "miniapp_blob_export")
    expect(exports.length).toBe(2)
    expect(exports.map((e) => e.payload.filename).sort()).toEqual([NAMES.md, NAMES.wav].sort())
    expect(exports.every((e) => e.payload.folder === "Recordings/Translation")).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.exported.length).toBe(2)
  })

  test("export failure is reported, never faked", async () => {
    const {session} = makeSession({exportThrows: new Error("unsupported request type")})
    const rec = new SessionRecorder(session as never, "Recordings/Translation")
    await rec.begin(NAMES, "# h\n")
    const result = await rec.finish("")
    expect(result.exported).toEqual([])
    expect(result.errors.length).toBe(2)
    expect(result.errors[0]).toContain("Could not export")
    expect(result.errors[0]).toContain("unsupported request type")
  })

  test("begin throws without microphone permission — no blobs, no subscription", async () => {
    const {session, hasAudioSub, createCount} = makeSession({micPermission: false})
    const rec = new SessionRecorder(session as never, "Recordings/Translation")
    await expect(rec.begin(NAMES, "# h\n")).rejects.toThrow("Microphone permission")
    expect(hasAudioSub()).toBe(false)
    expect(createCount()).toBe(0)
  })

  test("elapsedMs tracks captured audio on the 16kHz PCM clock", async () => {
    const {session, feedAudio} = makeSession()
    const rec = new SessionRecorder(session as never, "Recordings/Translation")
    await rec.begin(NAMES, "# h\n")
    feedAudio(new Array(32000).fill(0), {sampleRate: 16000, format: "pcm"}) // 1s
    expect(rec.elapsedMs()).toBe(1000)
    await rec.finish("")
  })
})
