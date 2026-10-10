import {afterEach, describe, expect, mock, test, vi} from "bun:test"

import {DEFAULT_CAPTION_TIMEOUT_SECONDS} from "../../shared/types"
import {CaptionsController, isSupportedCaptionTimeoutSeconds} from "./CaptionsController"

describe("CaptionsController caption position", () => {
  test("sends source text and line preferences, leaving fitting to the host", async () => {
    const render = mock(() =>
      Promise.resolve({
        status: "displayed",
        textLayout: {
          caption: {
            lines: [{text: "newest words", start: 12, end: 24}],
            lineStarts: [0, 12],
            capacity: 3,
            truncated: true,
          },
        },
      }),
    )
    const controller = new CaptionsController({
      capabilities: {display: {width: 500, height: 220, canPosition: true}},
      display: {render},
    } as never) as unknown as {
      settings: {captionPosition: string; displayWidth: number; displayLines: number}
      ui: {send: ReturnType<typeof mock>}
      showOnGlasses: (text: string, final: boolean) => void
      lastDisplayPreview: {text: string; isFinal: boolean}
    }
    controller.settings.captionPosition = "bottom"
    controller.settings.displayWidth = 2
    controller.ui = {send: mock(() => {})}
    controller.showOnGlasses("older words newest words", false)
    await Promise.resolve()
    expect(render).toHaveBeenCalledWith(
      [
        {
          type: "text",
          id: "caption",
          box: {x: 0, y: 0, w: 500, h: 220},
          text: "older words newest words",
          style: {maxLines: 3, textWindow: "end", breakMode: "word", verticalAlign: "bottom"},
        },
      ],
      {includeTextLayout: true},
    )
    expect(controller.lastDisplayPreview).toMatchObject({text: "newest words", isFinal: false})
  })

  test("position changes preserve interim source and ignore stale render feedback", async () => {
    const resolve: Array<(value: unknown) => void> = []
    const render = mock(() => new Promise((done) => resolve.push(done)))
    const controller = new CaptionsController({
      capabilities: {display: {width: 576, height: 288, canPosition: true}},
      display: {render},
      storage: {set: mock(() => Promise.resolve())},
    } as never) as unknown as {
      ui: {send: ReturnType<typeof mock>}
      showOnGlasses: (text: string, final: boolean) => void
      setCaptionPosition: (position: "bottom") => Promise<void>
      lastDisplayPreview: {text: string}
    }
    controller.ui = {send: mock(() => {})}
    controller.showOnGlasses("interim words", false)
    await controller.setCaptionPosition("bottom")
    const feedback = (text: string) => ({textLayout: {caption: {lines: [{text}]}}})
    resolve[1](feedback("latest"))
    await Promise.resolve()
    resolve[0](feedback("stale"))
    await Promise.resolve()
    expect(controller.lastDisplayPreview.text).toBe("latest")
    expect(render.mock.calls[1][0][0].text).toBe("interim words")
    expect(render.mock.calls[1][0][0].style.verticalAlign).toBe("bottom")
  })

  test("restores bottom and defaults unknown stored values to top", async () => {
    const bottomController = new CaptionsController({
      storage: {get: mock((key: string) => Promise.resolve(key === "captionPosition" ? "bottom" : null))},
    } as never) as unknown as {
      settings: {captionPosition: string}
      loadSettings: () => Promise<void>
    }
    await bottomController.loadSettings()
    expect(bottomController.settings.captionPosition).toBe("bottom")

    const invalidController = new CaptionsController({
      storage: {get: mock((key: string) => Promise.resolve(key === "captionPosition" ? "middle" : null))},
    } as never) as unknown as {
      settings: {captionPosition: string}
      loadSettings: () => Promise<void>
    }
    await invalidController.loadSettings()
    expect(invalidController.settings.captionPosition).toBe("top")
  })
})

describe("CaptionsController caption timeout", () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  })

  test("supports each timeout preset and rejects arbitrary values", () => {
    expect([3, 5, 10, 30, 40].every(isSupportedCaptionTimeoutSeconds)).toBe(true)
    expect(isSupportedCaptionTimeoutSeconds(0)).toBe(false)
    expect(isSupportedCaptionTimeoutSeconds(4)).toBe(false)
    expect(isSupportedCaptionTimeoutSeconds(60)).toBe(false)
  })

  test("uses the configured timeout before clearing the glasses", () => {
    let scheduledCallback: (() => void) | undefined
    let scheduledDelay: number | undefined
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      scheduledCallback = callback
      scheduledDelay = delay
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout
    globalThis.clearTimeout = mock(() => {}) as unknown as typeof clearTimeout

    const clearFormatter = mock(() => {})
    const render = mock(() => Promise.resolve({status: "displayed" as const}))
    const controller = new CaptionsController({display: {render}} as never) as unknown as {
      settings: {captionTimeoutSeconds: number}
      formatter: {clear: () => void}
      lastSpeakerId: string | undefined
      resetInactivityTimer: () => void
    }
    controller.settings.captionTimeoutSeconds = 5
    controller.formatter = {clear: clearFormatter}
    controller.lastSpeakerId = "1"

    controller.resetInactivityTimer()

    expect(scheduledDelay).toBe(5000)
    expect(clearFormatter).not.toHaveBeenCalled()
    expect(render).not.toHaveBeenCalled()

    scheduledCallback?.()

    expect(clearFormatter).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledWith([])
    expect(controller.lastSpeakerId).toBeUndefined()
  })

  test("preserves the existing 40-second default", () => {
    expect(DEFAULT_CAPTION_TIMEOUT_SECONDS).toBe(40)
  })
})

describe("CaptionsController local speech to text", () => {
  test("every subscription is forceLocal with engine auto and never requests cloud", async () => {
    const on = mock((_handler: (data: unknown) => void, _options?: unknown) => mock(() => {}))
    const forLanguage = mock(
      (_language: string, _handler: (data: unknown) => void, _options?: unknown) => mock(() => {}),
    )
    const send = mock(() => undefined)
    const controller = new CaptionsController({
      storage: {set: mock(() => Promise.resolve())},
      transcription: {
        configure: mock(() => Promise.resolve()),
        on,
        forLanguage,
      },
      ui: {send, on: mock(() => () => undefined), onOpen: mock(() => () => undefined)},
    } as never) as unknown as {
      settings: {language: string; languageHints: string[]}
      subscribeTranscription: () => void
      setLanguage: (language: string) => Promise<void>
      ui: {send: typeof send}
    }
    controller.ui = {send} // start() normally binds session.ui

    // auto → transcription.on
    controller.settings.language = "auto"
    controller.subscribeTranscription()
    expect(on).toHaveBeenCalledTimes(1)
    expect(on.mock.calls[0]?.[1]).toEqual({forceLocal: true, engine: "auto"})
    expect(on.mock.calls[0]?.[1]).not.toHaveProperty("includeCloud")

    // pinned language → forLanguage with the same local-only options
    await controller.setLanguage("fr-FR")
    expect(forLanguage).toHaveBeenCalledTimes(1)
    expect(forLanguage.mock.calls[0]?.[0]).toBe("fr-FR")
    expect(forLanguage.mock.calls[0]?.[2]).toEqual({forceLocal: true, engine: "auto"})
    expect(forLanguage.mock.calls[0]?.[2]).not.toHaveProperty("includeCloud")

    // re-subscribing (language change) keeps the same options
    await controller.setLanguage("zh-TW")
    expect(forLanguage).toHaveBeenCalledTimes(2)
    expect(forLanguage.mock.calls[1]?.[0]).toBe("zh-TW")
    expect(forLanguage.mock.calls[1]?.[2]).toEqual({forceLocal: true, engine: "auto"})
  })

  test("stored cloud-only languages and hints are sanitized to local tags", async () => {
    const get = mock((key: string) =>
      Promise.resolve(
        key === "language" ? "Chinese (Pinyin)" : key === "languageHints" ? '["fr","sw","zh-Hant"]' : null,
      ),
    )
    const controller = new CaptionsController({
      storage: {get},
    } as never) as unknown as {
      settings: {language: string; languageHints: string[]}
      loadSettings: () => Promise<void>
    }

    await controller.loadSettings()

    // "Chinese (Pinyin)" has no local route → auto; sw (Swahili) is dropped,
    // fr and zh-Hant normalize to registry tags.
    expect(controller.settings.language).toBe("auto")
    expect(controller.settings.languageHints).toEqual(["fr-FR", "zh-TW"])
  })

  test("no speaker label is fabricated for on-device transcripts", async () => {
    const send = mock(() => undefined)
    const controller = new CaptionsController({
      ui: {send},
      display: {render: mock(() => Promise.resolve({status: "rendered"}))},
    } as never) as unknown as {
      handleTranscription: (data: {text: string; isFinal: boolean}) => Promise<void>
      ui: {send: typeof send}
    }
    controller.ui = {send} // start() normally binds session.ui

    await controller.handleTranscription({text: "hello", isFinal: true})

    const frame = send.mock.calls.find((c) => c[0] === "captions:live-transcript")?.[1] as
      | {speaker: string}
      | undefined
    expect(frame?.speaker).toBe("")
  })
})

describe("CaptionsController no-transcript watchdog", () => {
  // The watchdog is a real setTimeout; fake timers drive it deterministically.
  function makeWatchdogController(language: string, stallMs = 30) {
    const send = mock(() => undefined)
    const render = mock(() => Promise.resolve({status: "rendered" as const}))
    let handler: ((data: {text: string; isFinal: boolean}) => void) | undefined
    const session = {
      transcription: {
        configure: mock(() => Promise.resolve()),
        on: mock((h: typeof handler) => {
          handler = h
          return () => {}
        }),
        forLanguage: mock((_l: string, h: typeof handler) => {
          handler = h
          return () => {}
        }),
      },
      ui: {send},
      display: {render},
      capabilities: {display: {width: 576, height: 288, canPosition: true, maxTextLines: 8}},
    }
    const controller = new CaptionsController(session as never, stallMs) as unknown as {
      settings: {language: string; languageHints: string[]}
      subscribeTranscription: () => void
      speechStatus: {hint: string} | null
      ui: {send: typeof send}
    }
    controller.ui = {send} // start() normally binds session.ui; tests skip start()
    controller.settings.language = language
    controller.settings.languageHints = []
    return {controller, send, render, getHandler: () => handler}
  }

  test("fires a visible hint on phone and glasses, then clears on first transcript", () => {
    vi.useFakeTimers()
    try {
      const {controller, send, render, getHandler} = makeWatchdogController("en-US")
      controller.subscribeTranscription()

      // Nothing arrives within the window → Sherpa hint on both surfaces.
      vi.advanceTimersByTime(31)
      expect(controller.speechStatus?.hint).toBe("No speech model — Settings › Speech")
      expect(send).toHaveBeenCalledWith("captions:speech-status", {hint: "No speech model — Settings › Speech"})
      expect(render).toHaveBeenCalledWith(
        [expect.objectContaining({type: "text", text: "No speech model — Settings › Speech"})],
        expect.objectContaining({includeTextLayout: true}),
      )

      // First transcript clears the status and the hint is retracted on the bus.
      getHandler()?.({text: "it works", isFinal: true})
      expect(controller.speechStatus).toBeNull()
      expect(send).toHaveBeenCalledWith("captions:speech-status", null)
    } finally {
      vi.useRealTimers()
    }
  })

  test("an Apple-routed language gets the on-device hint instead", () => {
    vi.useFakeTimers()
    try {
      const {controller} = makeWatchdogController("zh-TW")
      controller.subscribeTranscription()
      vi.advanceTimersByTime(31)
      expect(controller.speechStatus?.hint).toBe(
        "On-device speech unavailable — check Settings › Speech Recognition",
      )
    } finally {
      vi.useRealTimers()
    }
  })

  test("a transcript inside the window never fires the hint", () => {
    vi.useFakeTimers()
    try {
      const {controller, send, getHandler} = makeWatchdogController("auto")
      controller.subscribeTranscription()
      getHandler()?.({text: "speech arrived", isFinal: false})
      vi.advanceTimersByTime(60)
      expect(controller.speechStatus).toBeNull()
      expect(send).not.toHaveBeenCalledWith("captions:speech-status", expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })
})
