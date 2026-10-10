import {describe, expect, mock, test} from "bun:test"

import {TranslationController} from "./TranslationController"

/** Mock session that captures translation handlers and glasses render text. */
function makeDisplayController(arg?: string | {stored?: Record<string, string>}) {
  let translationHandler: ((data: unknown) => void) | undefined
  let transcriptionHandler: ((data: unknown) => void) | undefined
  let audioHandler: ((d: {data: string; sampleRate?: number; format?: string}) => void) | null = null
  const renders: string[] = []
  const uiSends: Array<{channel: string; payload: Record<string, unknown>}> = []
  const storage = new Map<string, string>(
    Object.entries(typeof arg === "string" ? {targetLanguage: arg} : (arg?.stored ?? {})),
  )
  const targets: string[] = []
  const lifecycle = new Map<string, () => void>()
  const blobFiles = new Map<string, {opts: Record<string, unknown>; bytes: number[]; committed: Record<string, unknown> | null; aborted: boolean}>()
  const exportRequests: Array<Record<string, unknown>> = []
  const noop = () => () => {}
  const b64 = (bytes: number[] | Uint8Array) => {
    let s = ""
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s)
  }
  const session = {
    translation: {
      to: (target: string, h: (data: unknown) => void) => {
        targets.push(target)
        translationHandler = h
        return () => {}
      },
    },
    transcription: {
      on: (h: (data: unknown) => void) => {
        transcriptionHandler = h
        return () => {}
      },
    },
    display: {
      render: (els: Array<{text?: string}>) => {
        if (els.length > 0 && typeof els[0].text === "string") renders.push(els[0].text)
        return Promise.resolve({status: "displayed"})
      },
    },
    storage: {
      get: (k: string) => Promise.resolve(storage.get(k) ?? null),
      set: (k: string, v: string) => (storage.set(k, v), Promise.resolve()),
    },
    mic: {
      hasPermission: true,
      onAudioChunk: (h: (d: {data: string; sampleRate?: number; format?: string}) => void) => {
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
    ui: {
      send: (channel: string, payload: Record<string, unknown>) => uiSends.push({channel, payload}),
      on: noop,
      onOpen: noop,
    },
    actions: {handle: noop},
    capabilities: {modelName: null as string | null, display: {width: 576, height: 288}},
    on: (event: string, callback: () => void) => {
      lifecycle.set(event, callback)
      return () => lifecycle.delete(event)
    },
    onCapabilitiesChange: noop,
    cloud: {onStatusChanged: noop},
  }
  const controller = new TranslationController(session as never) as unknown as {
    start: () => Promise<void>
    stop: () => void
    setTargetLanguage: (target: string) => Promise<void>
    setGlassesDisplayMode: (m: string) => Promise<void>
  }
  return {
    controller,
    renders,
    uiSends,
    session,
    targets,
    ready: () => lifecycle.get("ready")?.(),
    blobFiles,
    exportRequests,
    feed: (d: unknown) => translationHandler?.(d),
    feedTranscription: (d: unknown) => transcriptionHandler?.(d),
    feedAudio: (pcm: number[] | Uint8Array) => audioHandler?.({data: b64(pcm), sampleRate: 16000, format: "pcm"}),
    hasAudioSub: () => audioHandler !== null,
    blobText: (suffix: string) => {
      const f = [...blobFiles.values()].find((b) => String(b.opts.name).endsWith(suffix))
      return f ? new TextDecoder().decode(new Uint8Array(f.bytes)) : null
    },
  }
}

function makeController() {
  const events: string[] = []
  const cleanups: Array<ReturnType<typeof mock>> = []
  const to = mock((target: string) => {
    events.push(`subscribe:${target}`)
    const cleanup = mock(() => events.push(`cleanup:${target}`))
    cleanups.push(cleanup)
    return cleanup
  })
  const controller = new TranslationController({translation: {to}} as never) as unknown as {
    settings: {targetLanguage: string}
    subscribeTranslation: () => void
  }
  return {controller, events, to, cleanups}
}

describe("TranslationController subscription replacement", () => {
  test("does not churn an unchanged target subscription", () => {
    const {controller, to, cleanups} = makeController()
    controller.subscribeTranslation()
    controller.subscribeTranslation()

    expect(to).toHaveBeenCalledTimes(1)
    expect(cleanups[0]).not.toHaveBeenCalled()
  })

  test("subscribes to the new target before releasing the old one", () => {
    const {controller, events} = makeController()
    controller.subscribeTranslation()
    controller.settings.targetLanguage = "es"
    controller.subscribeTranslation()

    expect(events).toEqual(["subscribe:en", "subscribe:es", "cleanup:en"])
  })
})

describe("TranslationController target defaults", () => {
  test.each([undefined, ""])("uses English when the saved target is %p", async (savedTarget) => {
    const {controller, targets} = makeDisplayController(savedTarget)
    await controller.start()
    expect(targets).toEqual(["en"])
    controller.stop()
  })

  test.each(["es", "de", "ja"])("preserves the saved %s target", async (savedTarget) => {
    const {controller, targets} = makeDisplayController(savedTarget)
    await controller.start()
    expect(targets).toEqual([savedTarget])
    controller.stop()
  })

  test("falls back to English if settings cannot be loaded", async () => {
    const {controller, targets, session} = makeDisplayController()
    session.storage.get = () => Promise.reject(new Error("storage unavailable"))
    await controller.start()
    expect(targets).toEqual(["en"])
    controller.stop()
  })

  test("persists a selected target and reuses it after restart", async () => {
    const {controller, targets, session} = makeDisplayController()
    await controller.start()
    await controller.setTargetLanguage("fr")
    expect(await session.storage.get("targetLanguage")).toBe("fr")
    controller.stop()
    await controller.start()
    expect(targets).toEqual(["en", "fr", "fr"])
    controller.stop()
  })

  test("a zh-TW target reaches session.translation.to verbatim (no zh/zh-CN collapse)", () => {
    const {controller, events, to} = makeController()
    controller.settings.targetLanguage = "zh-TW"
    controller.subscribeTranslation()

    expect(to).toHaveBeenCalledWith("zh-TW", expect.any(Function), {forceLocal: true})
    expect(events).toEqual(["subscribe:zh-TW"])
  })

  test("every subscription opts into the on-device hop (forceLocal)", () => {
    const {controller, to} = makeController()
    controller.subscribeTranslation()

    expect(to).toHaveBeenCalledWith(expect.any(String), expect.any(Function), {forceLocal: true})
  })
})

describe("TranslationController glasses display mode", () => {
  test("accepts initial capabilities on ready without device-specific formatting", async () => {
    const {controller, renders, feed, session, ready} = makeDisplayController()
    await controller.start()
    session.capabilities = {modelName: "Nimo-7188", display: {width: 500, height: 220}}
    ready()
    feed({text: "W".repeat(40), originalText: "source", isFinal: true, utteranceId: "nimo-1"})
    expect(renders.at(-1)).toContain("W".repeat(40))
    expect(renders.at(-1)).not.toContain("\n")
  })

  test("switching to 'both' re-renders the current line with the original text (not a no-op)", async () => {
    const {controller, renders, feed} = makeDisplayController()
    await controller.start()

    feed({text: "Hola mundo", originalText: "Hello world", isFinal: true, utteranceId: "u1", speakerId: "1"})
    const beforeToggle = renders.at(-1) ?? ""
    expect(beforeToggle).toContain("Hola mundo")
    expect(beforeToggle).not.toContain("Hello world") // default mode: translation only

    const renderCountBefore = renders.length
    await controller.setGlassesDisplayMode("both")

    // The toggle itself must produce a fresh render that now includes the
    // original transcription — the fix for the reported no-op.
    expect(renders.length).toBeGreaterThan(renderCountBefore)
    expect(renders.at(-1)).toContain("Hello world")
    expect(renders.at(-1)).toContain("Hola mundo")
  })

  test("switching back to 'translation' drops the original text from the current line", async () => {
    const {controller, renders, feed} = makeDisplayController()
    await controller.start()
    await controller.setGlassesDisplayMode("both")
    feed({text: "Bonjour", originalText: "Hello", isFinal: true, utteranceId: "u1", speakerId: "1"})
    expect(renders.at(-1)).toContain("Hello")

    await controller.setGlassesDisplayMode("translation")
    expect(renders.at(-1)).toContain("Bonjour")
    expect(renders.at(-1)).not.toContain("Hello")
  })
})

describe("TranslationController same-language passthrough (cloud events)", () => {
  // The cloud translation stream now emits speech ALREADY in the target
  // language as a transcription event whose source == target (single-detector
  // design; no second transcription subscription).
  test("same-language event shows in the UI history", async () => {
    const {controller, uiSends, feed} = makeDisplayController("es")
    await controller.start()

    feed({
      text: "Hola mundo",
      isFinal: true,
      sourceLanguage: "es",
      targetLanguage: "es-ES",
      utteranceId: "u1",
      speakerId: "1",
    })

    const card = uiSends.find((s) => s.channel === "translation:live-translation" && s.payload.text === "Hola mundo")
    expect(card).toBeDefined()
  })

  test("same-language reaches the glasses only in 'both' mode", async () => {
    const {controller, renders, feed} = makeDisplayController("es")
    await controller.start()

    feed({text: "Hola", isFinal: true, sourceLanguage: "es", targetLanguage: "es-ES", utteranceId: "u2"})
    expect(renders.some((r) => r.includes("Hola"))).toBe(false) // translation-only: not on glasses

    await controller.setGlassesDisplayMode("both")
    feed({text: "Adios", isFinal: true, sourceLanguage: "es-ES", targetLanguage: "es-ES", utteranceId: "u3"})
    expect(renders.some((r) => r.includes("Adios"))).toBe(true) // both: on glasses
  })

  test("cross-language events reach the glasses in every mode", async () => {
    const {controller, renders, feed} = makeDisplayController("es")
    await controller.start()

    feed({
      text: "Hola mundo",
      originalText: "Hello world",
      isFinal: true,
      sourceLanguage: "en",
      targetLanguage: "es-ES",
      utteranceId: "u4",
    })
    expect(renders.some((r) => r.includes("Hola mundo"))).toBe(true)
  })

  test("passthrough interims with an unidentified source do not leak onto the glasses", async () => {
    // Regression: early interims of a same-language utterance arrive before
    // Soniox has identified the language (source = "auto"/absent, and no
    // originalText since nothing is being translated). A source-vs-target
    // compare says "different" and rendered them in Translation-only mode.
    const {controller, renders, feed} = makeDisplayController("es")
    await controller.start()

    feed({text: "Hola", isFinal: false, sourceLanguage: "auto", targetLanguage: "es-ES", utteranceId: "u5"})
    feed({text: "Hola mun", isFinal: false, sourceLanguage: undefined, targetLanguage: "es-ES", utteranceId: "u5"})
    feed({text: "Hola mundo", isFinal: true, sourceLanguage: "es", targetLanguage: "es-ES", utteranceId: "u5"})

    expect(renders.some((r) => r.includes("Hola"))).toBe(false)

    // Cross-language interims (originalText present, source still unknown)
    // must STILL display in translation-only mode.
    feed({
      text: "Adios",
      originalText: "Goodbye",
      isFinal: false,
      sourceLanguage: "auto",
      targetLanguage: "es-ES",
      utteranceId: "u6",
    })
    expect(renders.some((r) => r.includes("Adios"))).toBe(true)
  })

  test("zh-CN speech into a zh-TW target is a real translation, not a passthrough", async () => {
    // Regression: primary-subtag compare equates zh-CN with zh-TW, so
    // Simplified speech rendered as a same-language passthrough and was
    // suppressed in translation-only mode.
    const {controller, renders, feed} = makeDisplayController()
    await controller.start() // target es, translation-only mode

    feed({text: "繁體中文", originalText: "简体中文", isFinal: true, sourceLanguage: "zh-CN", targetLanguage: "zh-TW", utteranceId: "u7"})
    expect(renders.some((r) => r.includes("繁體中文"))).toBe(true)

    // Same written form on both sides IS a passthrough — still suppressed.
    feed({text: "繁體中文", isFinal: true, sourceLanguage: "zh-Hant", targetLanguage: "zh-TW", utteranceId: "u8"})
    expect(renders.filter((r) => r.includes("繁體中文"))).toHaveLength(1)
  })
})

describe("TranslationController session recording", () => {
  // Deterministic microtask drain — the recorder's begin/finish chains are
  // pure promise continuations (no timers), so N ticks settles them.
  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
  }

  test("setting off: no audio subscription, no blobs, no export", async () => {
    const {controller, hasAudioSub, blobFiles, exportRequests, feed} = makeDisplayController()
    await controller.start() // subscribes translation; saveRecording defaults off
    await flush()
    feed({text: "Hola", isFinal: true, sourceLanguage: "en", targetLanguage: "es-ES", utteranceId: "r1"})
    await flush()
    expect(hasAudioSub()).toBe(false)
    expect(blobFiles.size).toBe(0)
    expect(exportRequests).toHaveLength(0)
  })

  test("setting on: audio subscribes with the session and unsubscribes on stop", async () => {
    const {controller, hasAudioSub} = makeDisplayController({stored: {saveRecording: "true"}})
    await controller.start()
    await flush()
    expect(hasAudioSub()).toBe(true)
    controller.stop()
    await flush()
    expect(hasAudioSub()).toBe(false)
  })

  test("finals land in the transcript as heard+translation pairs; interims never do", async () => {
    const {controller, feed, feedAudio, blobText} = makeDisplayController({stored: {saveRecording: "true"}})
    await controller.start()
    await flush()
    feedAudio(new Array(3200).fill(1)) // 0.1s of PCM
    feed({text: "Hol", originalText: "Hel", isFinal: false, sourceLanguage: "en", targetLanguage: "es-ES", utteranceId: "r2"})
    feed({text: "Hola mundo", originalText: "Hello world", isFinal: true, sourceLanguage: "en", targetLanguage: "es-ES", utteranceId: "r2"})
    controller.stop()
    await flush()
    const md = blobText(".md")
    expect(md).not.toBeNull()
    expect(md).toContain("heard (en): Hello world")
    expect(md).toContain("translation (es-ES): Hola mundo")
    expect(md).not.toContain("Hel\n")
    expect(blobText(".wav")).not.toBeNull()
  })

  test("turning the setting off mid-session discards the capture", async () => {
    const {controller, hasAudioSub, blobFiles, exportRequests} = makeDisplayController({stored: {saveRecording: "true"}})
    await controller.start()
    await flush()
    expect(hasAudioSub()).toBe(true)
    await (controller as unknown as {setSaveRecording: (b: boolean) => Promise<void>}).setSaveRecording(false)
    expect(hasAudioSub()).toBe(false)
    for (const f of blobFiles.values()) expect(f.aborted).toBe(true)
    expect(exportRequests).toHaveLength(0)
  })
})
