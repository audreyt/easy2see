/**
 * ConversateController — the whole live loop, glued to the session.
 *
 *   speech finals ─► transcript list ─► CueScheduler ─► serialized LLM queue
 *        │                                        ─► RunningSummary (4 min)
 *        │                                                           │
 *        └─► GlassesDisplay (cues + live line) ◄── cues ◄── generate() ◄┘
 *        └─► session.ui channels (phone WebView)
 *
 * On End: map-reduce review → Markdown → session.blob + Files export →
 * local history. Every degradation is visible: AI unavailable banner,
 * speech-unavailable reason, export failure — nothing is faked and nothing
 * touches the network.
 */

import type {
  MiniappSession,
  TranscriptionData,
  TranslationData,
  UnsubscribeFn,
} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {
  AiStatus,
  ConversateSettings,
  ConversateSnapshot,
  Cue,
  SessionState,
  SpeechStatus,
  TranscriptFinal,
} from "../shared/types"
import {GlassesDisplay} from "./display/glasses"
import {CueScheduler, type CueTrigger} from "./cues/scheduler"
import {buildCuePrompt, decideCueLanguage, parseCues, TOKEN_BUDGET} from "./cues/prompt"
import {dedupeCues} from "./cues/dedupe"
import {clampPrepNote, extractKeywords, retrievePrepNote, PREP_NOTE_MAX_CHARS} from "./cues/prepnote"
import {RunningSummary} from "./summary/running"
import {generateReview, renderReviewMarkdown} from "./review/review"
import {HistoryStore} from "./history/store"
import {
  exportMarkdown,
  getLlm,
  importTextFile,
  llmErrorCode,
  llmErrorReason,
  onSpeechUnavailable,
  subscribeTranscription,
  subscribeTranslation,
  type SessionLlm,
} from "./host"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void
type On = <C extends keyof Channels & string>(channel: C, cb: (payload: Channels[C]) => void) => () => void

const DEFAULT_SETTINGS: ConversateSettings = {
  language: "en",
  translationEnabled: false,
  targetLanguage: "zh-TW",
  cuesEnabled: true,
  autoPopup: true,
  cueDurationSec: 8,
  liveTranscriptOnGlasses: false,
  cueLanguage: "auto",
  micSource: "auto",
}

const STORAGE_KEYS = {
  settings: "conversate.settings.v1",
  prepNote: "conversate.prepnote.v1",
} as const

/** LLM queue priorities — cues jump ahead of running-summary work. */
const PRIORITY_CUE = 10
const PRIORITY_SUMMARY = 1

export class ConversateController {
  private started = false
  private readonly unsubs: Array<() => void> = []

  private ui!: {send: Send; on: On; onOpen: (cb: () => void) => () => void; handle: (c: string, h: (p: never) => unknown) => () => void}

  private settings: ConversateSettings = {...DEFAULT_SETTINGS}
  private prepNote = ""
  private state: SessionState = "idle"
  private transcript: TranscriptFinal[] = []
  private cues: Cue[] = []
  private ai: AiStatus = {available: false}
  private speech: SpeechStatus = {ok: true}
  private reviewState: {ready: boolean; exported: boolean; exportMessage?: string} | null = null
  private guardrailSkips = 0
  private sessionStartedAt = 0
  private lastMarkdown: {id: string; markdown: string} | null = null

  private speechCleanup: UnsubscribeFn | null = null
  private micLease: {release(): Promise<void>} | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null

  private readonly llm: SessionLlm | null
  private llmSupportedLanguages: string[] | undefined
  private llmQueue: Array<{priority: number; seq: number; run: () => Promise<void>}> = []
  private llmQueueSeq = 0
  private llmBusy = false

  private readonly scheduler: CueScheduler
  private readonly runningSummary = new RunningSummary()
  private readonly glasses: GlassesDisplay
  private readonly history: HistoryStore

  constructor(private readonly session: MiniappSession) {
    this.llm = getLlm(session)
    this.history = new HistoryStore(session)
    this.scheduler = new CueScheduler((trigger) => this.onCueTrigger(trigger))
    const caps = session.capabilities?.display
    this.glasses = new GlassesDisplay((els) => void session.display.render(els), {
      width: caps?.width ?? 576,
      height: caps?.height ?? 288,
    })
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    this.ui = this.session.ui as unknown as typeof this.ui

    await this.loadState()
    this.applySettings()

    // Probe once — the call prewarms the model per Contract B. A stale
    // "unavailable" never blocks cue attempts; it only arms the banner,
    // which a successful generate clears.
    void this.probeLlm()

    this.registerUiHandlers()
    this.registerActions()
    this.subscribeSpeechStatus()
    this.subscribeTouch()

    this.unsubs.push(
      this.ui.onOpen(() => {
        void this.sendSnapshot()
      }),
    )
    try {
      this.unsubs.push(this.session.onBeforeDisconnect(() => this.stop()))
    } catch {
      /* hook unavailable on this runtime */
    }

    console.log(`Easy2Say: started (llm=${this.llm ? "present" : "absent"})`)
  }

  stop(): void {
    this.teardownSession()
    for (const u of this.unsubs) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    this.unsubs.length = 0
    this.started = false
  }

  // ───────────────────────────────────────────────────────────────────────
  // Session lifecycle
  // ───────────────────────────────────────────────────────────────────────

  private async startSession(): Promise<void> {
    if (this.state === "running") return
    this.transcript = []
    this.cues = []
    this.guardrailSkips = 0
    this.reviewState = null
    this.sessionStartedAt = Date.now()
    this.scheduler.reset()
    this.scheduler.setPrepKeywords(extractKeywords(this.prepNote))
    this.runningSummary.reset()
    this.speech = {ok: true}
    this.subscribeSpeech()
    this.scheduler.setEnabled(this.settings.cuesEnabled)
    this.setState("running")
    this.tickTimer = setInterval(() => this.scheduler.tick(), 1_000)
  }

  private pauseSession(): void {
    if (this.state !== "running") return
    this.releaseSpeech()
    this.scheduler.setEnabled(false)
    this.setState("paused")
  }

  private resumeSession(): void {
    if (this.state !== "paused") return
    this.subscribeSpeech()
    this.scheduler.setEnabled(this.settings.cuesEnabled)
    this.setState("running")
  }

  private async endSession(): Promise<void> {
    if (this.state === "idle" || this.state === "reviewing") return
    this.releaseSpeech()
    this.scheduler.setEnabled(false)
    this.glasses.clear()
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    this.setState("reviewing")
    this.reviewState = {ready: false, exported: false}
    this.broadcastReview()

    const unsummarized = this.runningSummary.flushBuffer()
    const result = await generateReview({
      summarySegments: [...this.runningSummary.segments],
      unsummarizedFinals: unsummarized,
      allFinals: this.transcript,
      cues: this.cues,
      startedAt: this.sessionStartedAt,
      llm: this.llm,
      run: (req) => this.enqueueLlm(() => this.llm!.generate(req), PRIORITY_SUMMARY),
    })

    const markdown = renderReviewMarkdown({
      title: result.summary.title,
      startedAt: this.sessionStartedAt,
      summary: result.summary,
      cues: this.cues,
      finals: this.transcript,
      aiGenerated: result.aiGenerated,
      note: result.note,
      label: result.label,
      guardrailSkips: this.guardrailSkips,
    })

    const d = new Date(this.sessionStartedAt)
    const pad = (n: number) => String(n).padStart(2, "0")
    const safeTitle = result.summary.title.replace(/[\\/:*?"<>|]/g, "").slice(0, 60).trim() || "session"
    const filename = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())} Easy2Say ${safeTitle}.md`

    const exportResult = await exportMarkdown(this.session, filename, markdown)
    const record = {
      id: `sess-${this.sessionStartedAt.toString(36)}`,
      startedAt: this.sessionStartedAt,
      title: result.summary.title,
      blobKey: exportResult.blobKey ?? "",
      cueCount: this.cues.length,
      finalCount: this.transcript.length,
      exported: Boolean(exportResult.uri),
    }
    if (record.blobKey) {
      await this.history.add(record)
      this.lastMarkdown = {id: record.id, markdown}
    }
    this.reviewState = {
      ready: true,
      exported: Boolean(exportResult.uri),
      exportMessage: exportResult.error,
    }
    this.broadcastReview()
    this.broadcastHistory()
    this.setState("idle")
  }

  private teardownSession(): void {
    this.releaseSpeech()
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    this.scheduler.setEnabled(false)
    this.llmQueue = []
  }

  private releaseSpeech(): void {
    if (this.speechCleanup) {
      try {
        this.speechCleanup()
      } catch {
        /* ignore */
      }
      this.speechCleanup = null
    }
    if (this.micLease) {
      void this.micLease.release().catch(() => {})
      this.micLease = null
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Speech
  // ───────────────────────────────────────────────────────────────────────

  private subscribeSpeech(): void {
    this.releaseSpeech()
    try {
      if (this.settings.micSource !== "auto") {
        this.session.mic
          .acquire({source: this.settings.micSource, useCase: "transcription"})
          .then((lease) => {
            this.micLease = lease
          })
          .catch(() => {})
      }
      if (this.settings.translationEnabled) {
        this.speechCleanup = subscribeTranslation(this.session, this.settings.targetLanguage, (d) =>
          this.onTranslation(d),
        )
      } else {
        this.speechCleanup = subscribeTranscription(this.session, this.settings.language, (d) =>
          this.onTranscription(d),
        )
      }
    } catch (err) {
      this.speech = {ok: false, reason: err instanceof Error ? err.message : String(err)}
      this.ui.send("conversate:speech-status", {...this.speech})
    }
  }

  private subscribeSpeechStatus(): void {
    try {
      this.unsubs.push(
        onSpeechUnavailable(this.session, (reason) => {
          this.speech = {ok: false, reason}
          this.ui.send("conversate:speech-status", {...this.speech})
        }),
      )
    } catch {
      /* stream not forwarded by this host */
    }
  }

  private onTranscription(d: TranscriptionData): void {
    if (!d.isFinal || this.state !== "running") return
    this.addFinal({t: Date.now(), text: d.text})
  }

  private onTranslation(d: TranslationData): void {
    if (!d.isFinal || this.state !== "running") return
    const original = d.originalText?.trim()
    this.addFinal({
      t: Date.now(),
      text: original && original.length > 0 ? original : d.text,
      translation: original && original.length > 0 ? d.text : undefined,
    })
  }

  private addFinal(f: TranscriptFinal): void {
    this.transcript.push(f)
    this.runningSummary.add(f)
    this.scheduler.onFinal(f.text)
    this.glasses.setLiveLine(f)
    this.ui.send("conversate:final", f)
    if (this.runningSummary.due()) this.enqueueSummary()
  }

  // ───────────────────────────────────────────────────────────────────────
  // Cue pipeline
  // ───────────────────────────────────────────────────────────────────────

  private onCueTrigger(trigger: CueTrigger): void {
    if (!this.llm) {
      this.setAi({available: false, reason: "unknown"})
      this.scheduler.requestSettled(this.scheduler.speechMark())
      return
    }
    const mark = this.scheduler.speechMark()
    void this.enqueueLlm(() => this.generateCue(trigger, mark), PRIORITY_CUE)
  }

  private async generateCue(trigger: CueTrigger, mark: number, transcriptBudget?: number): Promise<void> {
    const llm = this.llm!
    const requested =
      this.settings.cueLanguage === "auto" ? this.settings.language : this.settings.cueLanguage
    const lang = decideCueLanguage(requested, this.llmSupportedLanguages)
    const lastFinals = this.transcript.slice(-3)
    const prepExcerpt = retrievePrepNote(
      this.prepNote,
      lastFinals.map((f) => f.text).join("\n"),
      TOKEN_BUDGET.prepNote,
    )
    const prompt = buildCuePrompt({
      finals: this.transcript,
      runningSummary: this.runningSummary.promptText(),
      prepNoteExcerpt: prepExcerpt,
      recentCueTitles: this.cues.slice(-8).map((c) => c.title),
      cueLanguage: lang.tag,
      transcriptBudget,
    })

    try {
      const res = await llm.generate({
        instructions: prompt.instructions,
        prompt: prompt.prompt,
        schema: prompt.schema,
        maxTokens: prompt.maxTokens,
        requestId: `cue-${mark}`,
      })
      const {stale} = this.scheduler.requestSettled(mark)
      if (stale) return // speech moved on — drop, never show
      this.setAi({available: true, proven: true})
      const fresh = dedupeCues(parseCues(res, Date.now(), lang.languageNote), this.cues)
      for (const cue of fresh) this.addCue(cue)
    } catch (err) {
      this.scheduler.requestSettled(mark)
      const code = llmErrorCode(err)
      if (code === "LLM_GUARDRAIL") {
        // Silent skip, counted for the session summary footer (probe rule).
        this.guardrailSkips += 1
      } else if (code === "LLM_CONTEXT_EXCEEDED" && transcriptBudget === undefined) {
        // Halve the transcript window and retry once (design §4).
        const retryMark = this.scheduler.speechMark()
        await this.generateCue(trigger, retryMark, Math.floor(TOKEN_BUDGET.transcript / 2))
      } else if (code === "LLM_UNAVAILABLE") {
        // Report only when a fresh availability read agrees (stale-probe rule).
        const avail = await llm.availability().catch(() => null)
        if (!avail || !avail.available) {
          this.setAi({available: false, reason: llmErrorReason(err) ?? avail?.reason ?? "unknown"})
        }
      } else if (code === "LLM_UNSUPPORTED_LANGUAGE") {
        this.llmSupportedLanguages = (await llm.availability().catch(() => null))?.supportedLanguages ?? ["en"]
      }
      // LLM_CANCELLED and unknown errors: drop the cue, keep the session.
    }
  }

  private addCue(cue: Cue): void {
    this.cues.push(cue)
    this.glasses.addCue(cue)
    this.ui.send("conversate:cue", cue)
  }

  private enqueueSummary(): void {
    if (!this.llm) return
    const req = this.runningSummary.buildRequest()
    void this.enqueueLlm(async () => {
      try {
        const res = await this.llm!.generate({...req, requestId: `sum-${Date.now().toString(36)}`})
        const text = extractSummaryText(res)
        this.runningSummary.commit(text ?? "")
      } catch {
        // A failed summary pass must not lose the transcript: keep the
        // buffer by committing nothing — but bound it by committing the raw
        // tail so the window doesn't grow forever.
        this.runningSummary.commit("")
      }
    }, PRIORITY_SUMMARY)
  }

  // ───────────────────────────────────────────────────────────────────────
  // Serialized LLM queue (Contract B: one in-flight per miniapp)
  // ───────────────────────────────────────────────────────────────────────

  private enqueueLlm<T>(fn: () => Promise<T>, priority: number): Promise<T> {
    const {promise, resolve, reject} = Promise.withResolvers<T>()
    this.llmQueue.push({
      priority,
      seq: this.llmQueueSeq++,
      run: async () => {
        try {
          resolve(await fn())
        } catch (err) {
          reject(err)
        }
      },
    })
    // Higher priority first; FIFO within a priority.
    this.llmQueue.sort((a, b) => b.priority - a.priority || a.seq - b.seq)
    void this.pumpLlm()
    return promise
  }

  private async pumpLlm(): Promise<void> {
    if (this.llmBusy) return
    const job = this.llmQueue.shift()
    if (!job) return
    this.llmBusy = true
    try {
      await job.run()
    } finally {
      this.llmBusy = false
      if (this.llmQueue.length > 0) void this.pumpLlm()
    }
  }

  private async probeLlm(): Promise<void> {
    if (!this.llm) {
      this.setAi({available: false, reason: "unknown"})
      return
    }
    try {
      const avail = await this.llm.availability()
      this.llmSupportedLanguages = avail.supportedLanguages
      this.setAi({available: avail.available, reason: avail.reason})
    } catch {
      /* probe failed — first real generate decides */
    }
  }

  private setAi(ai: AiStatus): void {
    const changed = ai.available !== this.ai.available || ai.reason !== this.ai.reason
    this.ai = {...this.ai, ...ai}
    if (changed) this.ui.send("conversate:ai-status", {...this.ai})
  }

  // ───────────────────────────────────────────────────────────────────────
  // Glasses input
  // ───────────────────────────────────────────────────────────────────────

  private subscribeTouch(): void {
    try {
      this.unsubs.push(
        this.session.input.onTouch((d) => {
          if (this.state !== "running" && this.state !== "paused") return
          switch (d.kind) {
            case "single_tap":
              this.glasses.tap()
              break
            case "double_tap":
              void this.endSession()
              break
            case "swipe_up":
              this.glasses.pageBack()
              break
            case "swipe_down":
              this.glasses.pageForward()
              break
          }
        }),
      )
    } catch {
      /* input module unavailable */
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Settings + prep note
  // ───────────────────────────────────────────────────────────────────────

  private async loadState(): Promise<void> {
    try {
      const raw = await this.session.storage.get(STORAGE_KEYS.settings)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed === "object" && parsed !== null) {
          this.settings = {...DEFAULT_SETTINGS, ...(parsed as Partial<ConversateSettings>)}
        }
      }
    } catch {
      /* defaults */
    }
    try {
      this.prepNote = clampPrepNote((await this.session.storage.get(STORAGE_KEYS.prepNote)) ?? "")
    } catch {
      this.prepNote = ""
    }
  }

  private applySettings(): void {
    this.glasses.autoPopup = this.settings.autoPopup
    this.glasses.liveLine = this.settings.liveTranscriptOnGlasses
    this.glasses.cueDurationMs = this.settings.cueDurationSec * 1000
  }

  private async persistSettings(): Promise<void> {
    try {
      await this.session.storage.set(STORAGE_KEYS.settings, JSON.stringify(this.settings))
    } catch {
      /* ignore */
    }
    this.ui.send("conversate:settings", {...this.settings})
  }

  private async setPrepNote(text: string): Promise<void> {
    this.prepNote = clampPrepNote(text)
    this.scheduler.setPrepKeywords(extractKeywords(this.prepNote))
    try {
      await this.session.storage.set(STORAGE_KEYS.prepNote, this.prepNote)
    } catch {
      /* ignore */
    }
    this.ui.send("conversate:prep-note", {text: this.prepNote})
  }

  // ───────────────────────────────────────────────────────────────────────
  // UI bus
  // ───────────────────────────────────────────────────────────────────────

  private setState(state: SessionState): void {
    this.state = state
    this.ui.send("conversate:state", {state})
  }

  private broadcastReview(): void {
    if (this.reviewState) this.ui.send("conversate:review", {...this.reviewState})
  }

  private async broadcastHistory(): Promise<void> {
    this.ui.send("conversate:history", {history: await this.history.list()})
  }

  private async sendSnapshot(): Promise<void> {
    const snapshot: ConversateSnapshot = {
      state: this.state,
      settings: {...this.settings},
      prepNote: this.prepNote,
      cues: [...this.cues],
      transcript: this.transcript.slice(-200),
      ai: {...this.ai},
      speech: {...this.speech},
      review: this.reviewState ? {...this.reviewState} : null,
      history: await this.history.list(),
    }
    this.ui.send("conversate:snapshot", snapshot)
  }

  private registerUiHandlers(): void {
    const on = this.ui.on.bind(this.ui) as (c: string, cb: (p: never) => void) => () => void
    this.unsubs.push(
      on("conversate:start", () => void this.startSession()),
      on("conversate:pause", () => this.pauseSession()),
      on("conversate:resume", () => this.resumeSession()),
      on("conversate:end", () => void this.endSession()),
      on("conversate:request-snapshot", () => void this.sendSnapshot()),
      on("conversate:set-language", (p: {language: string}) => {
        this.settings.language = p.language
        void this.persistSettings()
        if (this.state === "running") this.subscribeSpeech()
      }),
      on("conversate:set-translation", (p: {enabled: boolean; targetLanguage?: string}) => {
        this.settings.translationEnabled = p.enabled
        if (p.targetLanguage) this.settings.targetLanguage = p.targetLanguage
        void this.persistSettings()
        if (this.state === "running") this.subscribeSpeech()
      }),
      on("conversate:set-cues-enabled", (p: {enabled: boolean}) => {
        this.settings.cuesEnabled = p.enabled
        this.scheduler.setEnabled(p.enabled && this.state === "running")
        void this.persistSettings()
      }),
      on("conversate:set-auto-popup", (p: {enabled: boolean}) => {
        this.settings.autoPopup = p.enabled
        this.glasses.autoPopup = p.enabled
        void this.persistSettings()
      }),
      on("conversate:set-cue-duration", (p: {seconds: number}) => {
        const s = Math.min(60, Math.max(2, Math.round(p.seconds)))
        this.settings.cueDurationSec = s
        this.glasses.cueDurationMs = s * 1000
        void this.persistSettings()
      }),
      on("conversate:set-live-transcript", (p: {enabled: boolean}) => {
        this.settings.liveTranscriptOnGlasses = p.enabled
        this.glasses.liveLine = p.enabled
        void this.persistSettings()
      }),
      on("conversate:set-cue-language", (p: {cueLanguage: ConversateSettings["cueLanguage"]}) => {
        this.settings.cueLanguage = p.cueLanguage
        void this.persistSettings()
      }),
      on("conversate:set-mic-source", (p: {micSource: ConversateSettings["micSource"]}) => {
        this.settings.micSource = p.micSource
        void this.persistSettings()
      }),
      on("conversate:set-prep-note", (p: {text: string}) => void this.setPrepNote(p.text)),
      on("conversate:delete-history", (p: {id: string}) => {
        void this.history.delete(p.id).then(() => this.broadcastHistory())
      }),
    )

    // RPC channels (request/response).
    const handle = this.ui.handle.bind(this.ui) as (c: string, h: (p: never) => unknown) => () => void
    this.unsubs.push(
      handle("conversate:import-prep-note", async () => {
        const res = await importTextFile(this.session)
        if (res.text !== null) await this.setPrepNote(res.text.slice(0, PREP_NOTE_MAX_CHARS))
        return {text: res.text !== null ? this.prepNote : null, error: res.error}
      }),
      handle("conversate:get-review", async (p: {id: string}) => {
        if (this.lastMarkdown && this.lastMarkdown.id === p.id) {
          return {markdown: this.lastMarkdown.markdown}
        }
        const md = await this.history.markdown(p.id)
        return {markdown: md, error: md === null ? "Review not found on this device" : undefined}
      }),
      handle("conversate:export-review", async (p: {id: string}) => {
        const md =
          this.lastMarkdown && this.lastMarkdown.id === p.id
            ? this.lastMarkdown.markdown
            : await this.history.markdown(p.id)
        if (md === null) return {error: "Review not found on this device"}
        const rec = (await this.history.list()).find((r) => r.id === p.id)
        const res = await exportMarkdown(this.session, rec ? `${rec.title}.md` : "conversate.md", md)
        if (res.uri) {
          await this.history.markExported(p.id)
          await this.broadcastHistory()
          return {uri: res.uri}
        }
        return {error: res.error ?? "Export failed"}
      }),
    )
  }

  // ───────────────────────────────────────────────────────────────────────
  // Actions
  // ───────────────────────────────────────────────────────────────────────

  private registerActions(): void {
    try {
      this.unsubs.push(
        this.session.actions.handle("start_conversate", (params) => this.startConversateAction(params)),
      )
    } catch (err) {
      console.log("Easy2Say: failed to register actions", err)
    }
  }

  private async startConversateAction(
    params: Record<string, unknown>,
  ): Promise<{language: string; targetLanguage: string; status: string}> {
    if (typeof params.language === "string" && params.language.trim()) {
      this.settings.language = params.language.trim()
    }
    if (typeof params.targetLanguage === "string" && params.targetLanguage.trim()) {
      this.settings.targetLanguage = params.targetLanguage.trim()
      this.settings.translationEnabled = true
    }
    await this.persistSettings()
    await this.startSession()
    return {
      language: this.settings.language,
      targetLanguage: this.settings.targetLanguage,
      status: this.state === "running" ? "running" : "failed",
    }
  }
}

/** Pull the summary string out of a guided-generation result. */
function extractSummaryText(res: {json?: unknown; text?: string}): string | null {
  let root: unknown = res.json
  if (root === undefined && typeof res.text === "string") {
    try {
      root = JSON.parse(res.text)
    } catch {
      return null
    }
  }
  if (typeof root !== "object" || root === null) return null
  const s = (root as {summary?: unknown}).summary
  return typeof s === "string" && s.trim() ? s.trim() : null
}
