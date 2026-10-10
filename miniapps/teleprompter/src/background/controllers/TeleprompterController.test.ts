import type {MiniappSession, RenderElement, RenderResult, TranscriptionData} from "@mentra/miniapp/background"
import type {TeleprompterSettings} from "../../shared/types"
import {afterEach, describe, expect, jest, test} from "bun:test"
import {ScriptEngine} from "../core/ScriptEngine"
import {serializeDisplayLines, TeleprompterController} from "./TeleprompterController"
import {processText} from "../../../../../mobile/modules/engine/src/utils/display/scene/text"
import {NIMO_PROFILE} from "../../../../../mobile/modules/engine/src/utils/display/profiles/nimo"

describe("Teleprompter host layout", () => {
  test("load_script reports unavailable lines when no display can provide layout", async () => {
    const controller = new TeleprompterController({storage: {set: async () => {}}} as never)
    Object.assign(controller, {
      engine: new ScriptEngine({numberOfLines: 2}),
      hasDisplay: false,
      ui: {send: () => {}},
    })
    expect(await controller.loadScript("one two three four", false)).toEqual({words: 4, lines: null, started: false})
  })
  test("load_script waits for host layout before returning its line count", async () => {
    let finishRender!: (result: RenderResult) => void
    const session = {
      capabilities: {display: {width: 80, height: 100}},
      display: {
        render: () =>
          new Promise<RenderResult>((resolve) => {
            finishRender = resolve
          }),
      },
      storage: {set: async () => {}},
    }
    const controller = new TeleprompterController(session as never)
    Object.assign(controller, {
      engine: new ScriptEngine({numberOfLines: 2}),
      hasDisplay: true,
      ui: {send: () => {}},
    })
    let returned = false
    const loading = controller.loadScript("one two three four five six", false).then((result) => {
      returned = true
      return result
    })
    await Promise.resolve()
    expect(returned).toBe(false)
    finishRender({
      status: "displayed",
      textLayout: {
        script: {
          lines: [
            {text: "one two", start: 0, end: 7},
            {text: "three four", start: 8, end: 18},
          ],
          lineStarts: [0, 8, 19],
          capacity: 2,
          truncated: true,
        },
      },
    })
    expect(await loading).toEqual({words: 6, lines: 3, started: false})
  })
  test.each([false, true])(
    "load_script follows a replacement render (newest resolves first: %s)",
    async (newestFirst) => {
      const pending: Array<(result: RenderResult) => void> = []
      const controller = new TeleprompterController({
        capabilities: {display: {width: 80, height: 100}},
        display: {render: () => new Promise<RenderResult>((resolve) => pending.push(resolve))},
        storage: {set: async () => {}},
      } as never)
      Object.assign(controller, {engine: new ScriptEngine({numberOfLines: 2}), hasDisplay: true, ui: {send: () => {}}})
      let returned = false
      const loading = controller.loadScript("one two three four", false).then((value) => {
        returned = true
        return value
      })
      const internal = controller as unknown as {render: () => Promise<number | null>; lastRenderedText: string}
      // Foreground/device events force a replacement even for unchanged content.
      internal.lastRenderedText = ""
      const replacement = internal.render()
      const layout: RenderResult = {
        status: "displayed",
        textLayout: {
          script: {
            lines: [
              {text: "one two", start: 0, end: 7},
              {text: "three four", start: 8, end: 18},
            ],
            lineStarts: [0, 8],
            capacity: 2,
            truncated: false,
          },
        },
      }
      if (newestFirst) pending[1](layout)
      pending[0]({status: "displayed"}) // obsolete feedback must not win
      await Promise.resolve()
      expect(returned).toBe(false)
      if (!newestFirst) pending[1](layout)
      expect(await loading).toEqual({words: 4, lines: 2, started: false})
      expect(await replacement).toBe(2)
      expect(await internal.render()).toBe(2) // deduped render shares the known result
    },
  )

  test("stopping cancels a pending layout without a promise cycle", async () => {
    let finish!: (result: RenderResult) => void
    const controller = new TeleprompterController({
      capabilities: {display: {width: 80, height: 100}},
      display: {
        render: () =>
          new Promise<RenderResult>((resolve) => {
            finish = resolve
          }),
      },
      storage: {set: async () => {}},
    } as never)
    Object.assign(controller, {engine: new ScriptEngine({numberOfLines: 2}), hasDisplay: true, ui: {send: () => {}}})
    const loading = controller.loadScript("one two", false)
    controller.stop()
    finish({status: "displayed"})
    expect((await loading).lines).toBeNull()
  })

  test("tracks source words and accepts line boundaries only from render results", () => {
    const engine = new ScriptEngine({numberOfLines: 2})
    engine.setScript("one two three four five six")
    engine.acceptLayout(0, {lines: [], lineStarts: [0, 8, 19], capacity: 2, truncated: true})
    expect(engine.totalWords).toBe(6)
    expect(engine.topLineForWord(2)).toBe(1)
    expect(engine.firstWordOfLine(1)).toBe(2)
    expect(engine.topLineForWord(5)).toBe(1) // final page remains full
    expect(engine.textFrom(engine.sourceStartForLine(1))).toBe("three four five six")
    expect(engine.matchSpoken(["three", "four"], 2)).toBe(4)
    engine.invalidateLayout()
    expect(engine.totalWords).toBe(6)
    engine.setScript("extraordinary words follow")
    engine.acceptLayout(0, {lines: [], lineStarts: [0, 5, 10, 14, 20], capacity: 2, truncated: true})
    expect(engine.firstWordOfLine(1)).toBe(0) // continuation of a hyphenated word
  })
  test("renders replacements, follows voice, steps lines, pins the last page", async () => {
    const sent: RenderElement[][] = []
    const pending: Array<() => void> = []
    const session = {
      capabilities: {display: {width: 80, height: 100}},
      display: {
        render: (elements: RenderElement[]) => {
          sent.push(elements)
          return new Promise<RenderResult>((resolve) =>
            pending.push(() => {
              const textLayout = Object.fromEntries(
                elements
                  .filter((e): e is Extract<RenderElement, {type: "text"}> => e.type === "text")
                  .map((e) => [e.id, processText(e.text, e.box, e.style ?? {}, NIMO_PROFILE).layout]),
              )
              resolve({status: "displayed", textLayout})
            }),
          )
        },
      },
    }
    const controller = new TeleprompterController(session as never) as unknown as {
      engine: ScriptEngine
      settings: TeleprompterSettings
      hasDisplay: boolean
      ui: {send: () => void}
      render: () => void
      currentVisible: string[]
      cursor: number
      nudge: (lines: number) => void
      seek: (percent: number) => void
    }
    controller.engine = new ScriptEngine({numberOfLines: 2})
    controller.engine.setScript("one two three four five six seven eight nine ten eleven twelve")
    controller.settings = {...controller.settings, numberOfLines: 2, lineWidth: 2, showTimecode: false}
    controller.hasDisplay = true
    controller.ui = {send: () => {}}
    controller.render()
    pending.shift()!()
    await Promise.resolve()
    expect(controller.currentVisible).toEqual(["one two", "three four"])
    controller.cursor = controller.engine.matchSpoken(["one", "two"], 0)
    controller.render()
    pending.shift()!()
    await Promise.resolve()
    expect((sent.at(-1)![0] as Extract<RenderElement, {type: "text"}>).text).toStartWith("three four")
    controller.nudge(-1)
    pending.shift()!()
    await Promise.resolve()
    expect((sent.at(-1)![0] as Extract<RenderElement, {type: "text"}>).text).toStartWith("one two")
    controller.seek(95)
    pending.shift()!()
    await Promise.resolve()
    expect(controller.currentVisible).toEqual(["ten eleven", "twelve"])
    controller.cursor = 0
    controller.render()
    controller.settings.lineWidth = 0
    controller.render()
    pending[1]()
    await Promise.resolve()
    const latest = [...controller.currentVisible]
    pending[0]()
    await Promise.resolve()
    expect(controller.currentVisible).toEqual(latest)
  })
})

describe("serializeDisplayLines", () => {
  test("preserves blank rows without consecutive newlines", () => {
    const text = serializeDisplayLines(["Welcome to your teleprompter.", "", "Paste your script here.", ""])

    expect(text).toBe("Welcome to your teleprompter.\n\u200B\nPaste your script here.\n\u200B")
    expect(text).not.toContain("\n\n")
    expect(text.split("\n")[1].trim()).toBe("\u200B")
  })

  test("does not alter visible text", () => {
    expect(serializeDisplayLines(["First line", "Second line"])).toBe("First line\nSecond line")
  })
})


// ── Mock session ────────────────────────────────────────────────────────────
// The controller talks to MiniappSession; we fake just the surface it touches.
// `transcription.on` records every call so tests can assert the subscribe
// options — this is where forceLocal must appear and includeCloud must not.

interface TranscriptCall {
  handler: (data: TranscriptionData) => void
  options: unknown
}

function mockSession(opts: {hasMic?: boolean; stored?: Record<string, string>} = {}) {
  const statuses: Array<Record<string, unknown>> = []
  const transcriptionCalls: TranscriptCall[] = []
  const forLanguageCalls: unknown[] = []
  const blobFiles = new Map<string, {opts: Record<string, unknown>; bytes: number[]; committed: Record<string, unknown> | null; aborted: boolean}>()
  const exportRequests: Array<Record<string, unknown>> = []
  let audioHandler: ((d: {data: string; sampleRate?: number; format?: string}) => void) | null = null
  let micVadCalls = 0
  let micChunkCalls = 0
  const session = {
    ready: true,
    capabilities: {
      modelName: "Even G1",
      hasDisplay: true,
      hasMicrophone: opts.hasMic ?? true,
      display: {width: 576, height: 288},
    },
    ui: {
      send: (channel: string, payload: unknown) => {
        if (channel === "tp:status") statuses.push(payload as Record<string, unknown>)
      },
      on: (_channel: string, _cb: (p: never) => void) => () => {},
      onOpen: (_cb: () => void) => () => {},
    },
    on: (_event: string, _cb: () => void) => () => {},
    onCapabilitiesChange: (_cb: () => void) => () => {},
    onBeforeDisconnect: (_cb: () => void) => () => {},
    onVisibilityChange: (_cb: (v: string) => void) => () => {},
    actions: {handle: (_id: string, _cb: unknown) => () => {}},
    storage: {
      get: async (key: string) => opts.stored?.[key] ?? null,
      set: async (_key: string, _value: string) => {},
    },
    display: {
      // Fake host: the whole script element is one laid-out line, so the
      // controller's render feedback path populates currentVisible.
      render: async (els: Array<{id?: string; text?: string}>) => {
        const text = els.find((e) => e.id === "script")?.text ?? ""
        return {
          status: "displayed",
          textLayout: {
            script: {lines: [{text, start: 0, end: text.length}], lineStarts: [0], capacity: 4, truncated: false},
          },
        }
      },
    },
    // The controller must only touch mic streams while a recording session is
    // active — audio_chunk forces device-wide PCM mode. These counters prove
    // no such subscription exists when the setting is off.
    mic: {
      hasPermission: true,
      onVoiceActivity: (_h: unknown) => {
        micVadCalls++
        return () => {}
      },
      onAudioChunk: (h: (d: {data: string; sampleRate?: number; format?: string}) => void) => {
        micChunkCalls++
        audioHandler = h
        return () => {
          audioHandler = null
        }
      },
    },
    blob: {
      createWriteStream: async (key: string, o: Record<string, unknown>) => {
        const f = {opts: o, bytes: [] as number[], committed: null as Record<string, unknown> | null, aborted: false}
        blobFiles.set(key, f)
        return {
          key,
          write: async (chunk: Uint8Array) => {
            for (const b of chunk) f.bytes.push(b)
          },
          writeAt: async (offset: number, chunk: Uint8Array) => {
            for (let i = 0; i < chunk.length; i++) f.bytes[offset + i] = chunk[i]
          },
          close: async (meta: Record<string, unknown>) => {
            f.committed = meta ?? {}
            return {key, uri: `file:///blobs/${key}`, bytes: f.bytes.length}
          },
          abort: async () => {
            f.aborted = true
          },
        }
      },
    },
    sendRequest: async (payload: Record<string, unknown>) => {
      exportRequests.push(payload)
      return {uri: `file:///Documents/${String(payload.folder)}/${String(payload.filename)}`}
    },
    transcription: {
      on: (handler: (data: TranscriptionData) => void, options?: unknown) => {
        transcriptionCalls.push({handler, options})
        return () => {}
      },
      forLanguage: (...args: unknown[]) => {
        forLanguageCalls.push(args)
        return () => {}
      },
      stop: () => {},
    },
  }
  return {
    session: session as unknown as MiniappSession,
    statuses,
    transcriptionCalls,
    forLanguageCalls,
    blobFiles,
    exportRequests,
    hasAudioSub: () => audioHandler !== null,
    feedAudio: (pcm: number[] | Uint8Array) => {
      let s = ""
      for (const b of pcm) s += String.fromCharCode(b)
      audioHandler?.({data: btoa(s), sampleRate: 16000, format: "pcm"})
    },
    blobText: (suffix: string) => {
      const f = [...blobFiles.values()].find((b) => String(b.opts.name).endsWith(suffix))
      return f ? new TextDecoder().decode(new Uint8Array(f.bytes)) : null
    },
    micCalls: () => micVadCalls + micChunkCalls,
  }
}

const lastStatus = (m: ReturnType<typeof mockSession>) => m.statuses[m.statuses.length - 1]

// Fake timers drive BOTH the watchdog setTimeout and the controller's
// wall-clock WPM math (Bun's advanceTimersByTime also advances Date.now —
// verified against this runtime), so no real waiting is needed.
afterEach(() => jest.useRealTimers())

describe("voice-follow on-device subscription", () => {
  test("subscribes with forceLocal and never requests cloud delivery", async () => {
    jest.useFakeTimers()
    const m = mockSession({stored: {voiceFollow: "true", wpm: "400"}})
    const c = new TeleprompterController(m.session, 60_000)
    await c.start()
    c.play()
    // Cycle drivers: pause → play again. Every subscription must carry
    // forceLocal and none may carry includeCloud.
    c.pause()
    c.play()
    expect(m.transcriptionCalls.length).toBeGreaterThanOrEqual(2)
    for (const call of m.transcriptionCalls) {
      expect(call.options).toEqual({forceLocal: true})
      expect(call.options).not.toHaveProperty("includeCloud")
    }
    expect(m.forLanguageCalls).toHaveLength(0)
    // No mic-side subscription either — audio_chunk/vad would alter
    // device-wide mic gating, and any audio-bearing stream risks arming the
    // cloud uplink the forceLocal transcription deliberately avoids.
    expect(m.micCalls()).toBe(0)
    c.stop()
  })

  test("does not subscribe at all when the device has no mic", async () => {
    jest.useFakeTimers()
    const m = mockSession({hasMic: false, stored: {voiceFollow: "true", wpm: "400"}})
    const c = new TeleprompterController(m.session, 60_000)
    await c.start()
    c.play()
    expect(m.transcriptionCalls).toHaveLength(0)
    expect(lastStatus(m)).toMatchObject({state: "playing", voiceMode: false, voiceFallback: "no-mic"})
    c.stop()
  })
})

describe("voice-stall watchdog", () => {
  test("falls back to the timed driver when no transcript arrives", async () => {
    jest.useFakeTimers()
    const m = mockSession({stored: {voiceFollow: "true", wpm: "400"}})
    const c = new TeleprompterController(m.session, 120)
    await c.start()
    c.play()
    expect(lastStatus(m)).toMatchObject({state: "playing", voiceMode: true})
    // Nothing arrives → watchdog fires → timed scroll takes over and the
    // status tells the UI why (voiceFallback "no-speech"). At 400 wpm the
    // timed driver must also have advanced the cursor.
    jest.advanceTimersByTime(120 + 2000)
    const s = lastStatus(m)
    expect(s).toMatchObject({state: "playing", voiceMode: false, voiceFallback: "no-speech"})
    expect(s.wordIndex as number).toBeGreaterThan(0)
    c.stop()
  })

  test("a usable transcript before the window keeps voice-follow live", async () => {
    jest.useFakeTimers()
    const m = mockSession({stored: {voiceFollow: "true", wpm: "400"}})
    const c = new TeleprompterController(m.session, 200)
    await c.start()
    c.play()
    jest.advanceTimersByTime(60)
    m.transcriptionCalls[0].handler({text: "welcome to your teleprompter", isFinal: true} as TranscriptionData)
    jest.advanceTimersByTime(2000)
    const s = lastStatus(m)
    expect(s).toMatchObject({state: "playing", voiceMode: true, voiceFallback: null})
    expect(s.wordIndex as number).toBeGreaterThan(0)
    c.stop()
  })

  test("pause cancels the watchdog — no fallback while paused", async () => {
    jest.useFakeTimers()
    const m = mockSession({stored: {voiceFollow: "true", wpm: "400"}})
    const c = new TeleprompterController(m.session, 120)
    await c.start()
    c.play()
    c.pause()
    jest.advanceTimersByTime(2000)
    const s = lastStatus(m)
    expect(s).toMatchObject({state: "paused", voiceFallback: null})
    expect(s.wordIndex).toBe(0)
    c.stop()
  })

  test("a late transcript restores voice-follow and re-anchors the cursor", async () => {
    jest.useFakeTimers()
    const m = mockSession({stored: {voiceFollow: "true", wpm: "400"}})
    const c = new TeleprompterController(m.session, 120)
    await c.start()
    c.play()
    // The presenter says nothing past the window: the watchdog trips and the
    // timed driver walks the script away from a reader still at the top.
    jest.advanceTimersByTime(120 + 2000)
    const stalled = lastStatus(m)
    expect(stalled).toMatchObject({state: "playing", voiceMode: false, voiceFallback: "no-speech"})
    const drifted = stalled.wordIndex as number
    expect(drifted).toBeGreaterThan(0)
    // The subscription stayed alive — when the presenter finally reads the
    // opening words, voice-follow resumes and the cursor snaps BACK to the
    // spoken position instead of keeping the timer's drift.
    m.transcriptionCalls[0].handler({text: "welcome to your teleprompter", isFinal: true} as TranscriptionData)
    const recovered = lastStatus(m)
    expect(recovered).toMatchObject({state: "playing", voiceMode: true, voiceFallback: null})
    expect(recovered.wordIndex as number).toBeLessThan(drifted)
    expect(recovered.wordIndex).toBe(4) // anchored just past the spoken run
    c.stop()
  })

  test("the watchdog re-arms after pause/resume", async () => {
    jest.useFakeTimers()
    const m = mockSession({stored: {voiceFollow: "true", wpm: "400"}})
    const c = new TeleprompterController(m.session, 120)
    await c.start()
    c.play()
    // First window expires with no speech → timed fallback.
    jest.advanceTimersByTime(120 + 500)
    expect(lastStatus(m)).toMatchObject({voiceMode: false, voiceFallback: "no-speech"})
    // Pause and resume: a fresh subscription gets a fresh stall window, and
    // continued silence trips it again — the watchdog is not one-shot.
    c.pause()
    c.play()
    expect(m.transcriptionCalls.length).toBe(2)
    expect(lastStatus(m)).toMatchObject({state: "playing", voiceMode: true, voiceFallback: null})
    jest.advanceTimersByTime(120 + 500)
    expect(lastStatus(m)).toMatchObject({state: "playing", voiceMode: false, voiceFallback: "no-speech"})
    c.stop()
  })
})

describe("Traditional script, Simplified speech", () => {
  test("voice-follow advances and the glasses still show Traditional", async () => {
    jest.useFakeTimers()
    const m = mockSession({
      stored: {voiceFollow: "true", script: "我們今天要討論三個主題"},
    })
    const c = new TeleprompterController(m.session, 60_000)
    await c.start()
    c.play()
    // Sherpa's zh model emits Simplified — the fold must still anchor it.
    m.transcriptionCalls[0].handler({text: "我们今天要讨论三个主题", isFinal: true} as TranscriptionData)
    // The host render round-trip resolves in a microtask; flush so the
    // status built from currentVisible is populated before asserting.
    for (let i = 0; i < 5; i++) await Promise.resolve()
    const s = lastStatus(m)
    expect(s.wordIndex as number).toBeGreaterThan(0)
    // Rendered lines are the user's original text, never the folded form.
    expect((s.visibleLines as string[]).join("")).toContain("討論")
    expect((s.visibleLines as string[]).join("")).not.toContain("讨论")
    c.stop()
  })
})

describe("session recording", () => {
  // Deterministic microtask drain — recorder begin/finish are pure promise
  // continuations (no timers), so N ticks settles them.
  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
  }

  test("setting off: play captures nothing — no audio sub, no blobs", async () => {
    const m = mockSession({stored: {wpm: "400"}})
    const c = new TeleprompterController(m.session, 60_000)
    await c.start()
    c.play()
    await flush()
    expect(m.hasAudioSub()).toBe(false)
    expect(m.blobFiles.size).toBe(0)
    expect(m.exportRequests).toHaveLength(0)
    c.stop()
  })

  test("setting on: audio subscribes on play and unsubscribes on stop", async () => {
    const m = mockSession({stored: {wpm: "400", saveRecording: "true"}})
    const c = new TeleprompterController(m.session, 60_000)
    await c.start()
    expect(m.hasAudioSub()).toBe(false) // idle — not yet playing
    c.play()
    await flush()
    expect(m.hasAudioSub()).toBe(true)
    c.stop()
    await flush()
    expect(m.hasAudioSub()).toBe(false)
  })

  test("finals land in the transcript; partials never do; script appended", async () => {
    const m = mockSession({stored: {wpm: "400", saveRecording: "true", voiceFollow: "true", script: "hello world"}})
    const c = new TeleprompterController(m.session, 60_000)
    await c.start()
    c.play()
    await flush()
    m.feedAudio(new Array(3200).fill(1))
    m.transcriptionCalls[0].handler({text: "hel", isFinal: false} as TranscriptionData)
    m.transcriptionCalls[0].handler({text: "hello", isFinal: true} as TranscriptionData)
    c.stop()
    await flush()
    const md = m.blobText(".md")
    expect(md).not.toBeNull()
    expect(md).toContain("hello")
    expect(md).not.toContain("hel\n")
    expect(md).toContain("## Script")
    expect(md).toContain("hello world")
    expect(m.blobText(".wav")).not.toBeNull()
    expect(m.exportRequests.length).toBe(2)
  })

  test("turning the setting off mid-read discards the capture", async () => {
    const m = mockSession({stored: {wpm: "400", saveRecording: "true"}})
    const c = new TeleprompterController(m.session, 60_000)
    await c.start()
    c.play()
    await flush()
    expect(m.hasAudioSub()).toBe(true)
    await (c as unknown as {setSaveRecording: (b: boolean) => Promise<void>}).setSaveRecording(false)
    expect(m.hasAudioSub()).toBe(false)
    for (const f of m.blobFiles.values()) expect(f.aborted).toBe(true)
    expect(m.exportRequests).toHaveLength(0)
    c.stop()
  })
})
