/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {CueScheduler, countCjk, countWords, isQuestion, type CueTrigger} from "./scheduler"

/** Manual clock + deferred queue — deterministic fake timers. */
function makeClock(start = 1_000_000) {
  let now = start
  const deferred: Array<{at: number; fn: () => void}> = []
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
      deferred.sort((a, b) => a.at - b.at)
      while (deferred.length > 0 && deferred[0].at <= now) {
        deferred.shift()!.fn()
        deferred.sort((a, b) => a.at - b.at)
      }
    },
    defer: (fn: () => void, ms: number) => {
      deferred.push({at: now + ms, fn})
    },
    pendingDeferred: () => deferred.length,
  }
}

function makeScheduler(opts: ConstructorParameters<typeof CueScheduler>[1] = {}) {
  const clock = makeClock()
  const fired: CueTrigger[] = []
  const scheduler = new CueScheduler((t) => fired.push(t), {
    now: clock.now,
    defer: clock.defer,
    ...opts,
  })
  scheduler.setEnabled(true)
  scheduler.reset()
  return {scheduler, fired, clock}
}

describe("trigger detection", () => {
  test("question finals: ?, ？, 嗎, 呢, interrogative leads", () => {
    expect(isQuestion("What time is the meeting?")).toBe(true)
    expect(isQuestion("會議是幾點？")).toBe(true)
    expect(isQuestion("你會來嗎")).toBe(true)
    expect(isQuestion("要不要一起呢")).toBe(true)
    expect(isQuestion("How does the bridge protocol work")).toBe(true)
    expect(isQuestion("The meeting is at three.")).toBe(false)
    expect(isQuestion("我們三點見")).toBe(false)
  })

  test("word and CJK counters", () => {
    expect(countWords("the quick brown fox jumps")).toBe(5)
    expect(countCjk("繁體中文測試")).toBe(6)
    expect(countCjk("hello 世界")).toBe(2)
  })

  test("a question final fires an answer trigger immediately", () => {
    const {scheduler, fired} = makeScheduler()
    scheduler.onFinal("What is the capital of France?")
    expect(fired).toHaveLength(1)
    expect(fired[0].kind).toBe("question")
  })

  test("word threshold fires a volume trigger", () => {
    const {scheduler, fired} = makeScheduler({wordThreshold: 10})
    scheduler.onFinal("one two three four five")
    expect(fired).toHaveLength(0)
    scheduler.onFinal("six seven eight nine ten eleven")
    expect(fired).toHaveLength(1)
    expect(fired[0].kind).toBe("volume")
  })

  test("CJK threshold fires a volume trigger", () => {
    const {scheduler, fired} = makeScheduler({cjkThreshold: 10})
    scheduler.onFinal("一二三四五六七八九十") // 10 CJK chars
    expect(fired).toHaveLength(1)
    expect(fired[0].kind).toBe("volume")
  })

  test("prep-note keyword in a final fires a prepnote trigger", () => {
    const {scheduler, fired} = makeScheduler({prepKeywords: ["meridian", "量子"]})
    scheduler.onFinal("let's talk about the meridian proposal")
    expect(fired).toHaveLength(1)
    expect(fired[0].kind).toBe("prepnote")
  })

  test("cadence: 20s since last cue with new speech fires on tick", () => {
    const {scheduler, fired, clock} = makeScheduler({cadenceMs: 20_000})
    scheduler.onFinal("a short statement")
    expect(fired).toHaveLength(0)
    clock.advance(19_000)
    scheduler.tick()
    expect(fired).toHaveLength(0)
    clock.advance(2_000)
    scheduler.tick()
    expect(fired).toHaveLength(1)
    expect(fired[0].kind).toBe("cadence")
  })
})

describe("spacing and one-in-flight", () => {
  test("never more than one in flight — second trigger queues", () => {
    const {scheduler, fired, clock} = makeScheduler()
    scheduler.onFinal("First question?")
    scheduler.onFinal("Second question?")
    expect(fired).toHaveLength(1)
    // Settle the first; the queued question dispatches after the 6s spacing.
    scheduler.requestSettled(1)
    expect(fired).toHaveLength(1)
    clock.advance(6_000)
    expect(fired).toHaveLength(2)
    expect(fired[1].kind).toBe("question")
  })

  test("never more often than every 6s — deferred retry honors spacing", () => {
    const {scheduler, fired, clock} = makeScheduler({minSpacingMs: 6_000})
    scheduler.onFinal("Question one?")
    scheduler.requestSettled(1)
    clock.advance(3_000)
    scheduler.onFinal("Question two?")
    expect(fired).toHaveLength(1) // inside the 6s window — deferred
    clock.advance(3_000) // deferred retry fires
    expect(fired).toHaveLength(2)
  })
  test("higher priority replaces a queued lower-priority trigger", () => {
    const {scheduler, fired} = makeScheduler({minSpacingMs: 60_000, wordThreshold: 10})
    scheduler.onFinal("Question one?")
    // Queue a volume trigger behind the in-flight question.
    scheduler.onFinal("filler words to trigger the volume threshold")
    scheduler.onFinal("more words here to push past ten total words now")
    // A question arrives while one is in flight — it wins the pending slot.
    scheduler.onFinal("An urgent question?")
    scheduler.requestSettled(1)
    expect(fired[fired.length - 1].kind).toBe("question")
  })
})

describe("stale drop", () => {
  test("a pending trigger is dropped once speech moved on by 2+ finals", () => {
    const {scheduler, fired} = makeScheduler({staleFinals: 2})
    scheduler.onFinal("Question one?")
    scheduler.onFinal("Question two?") // queued behind the in-flight request
    scheduler.onFinal("speech moved on one")
    scheduler.onFinal("speech moved on two")
    scheduler.requestSettled(1)
    // The queued trigger was marked before the two new finals — dropped.
    expect(fired).toHaveLength(1)
  })

  test("an in-flight result is dropped when speech moved on during generation", () => {
    const {scheduler, fired} = makeScheduler({staleFinals: 2})
    scheduler.onFinal("Question one?")
    const mark = scheduler.speechMark()
    scheduler.onFinal("new speech one")
    scheduler.onFinal("new speech two")
    const {stale} = scheduler.requestSettled(mark)
    expect(stale).toBe(true)
  })

  test("a pending trigger older than staleMs is dropped", () => {
    const {scheduler, fired, clock} = makeScheduler({staleMs: 10_000, minSpacingMs: 60_000})
    scheduler.onFinal("Question one?")
    scheduler.onFinal("Question two?") // queued behind in-flight + spacing
    clock.advance(11_000)
    scheduler.requestSettled(1)
    scheduler.tick()
    expect(fired).toHaveLength(1)
  })
})

describe("enable/disable", () => {
  test("disabled scheduler collects speech but fires nothing", () => {
    const {scheduler, fired} = makeScheduler()
    scheduler.setEnabled(false)
    scheduler.onFinal("A question?")
    expect(fired).toHaveLength(0)
    scheduler.setEnabled(true)
    scheduler.onFinal("Another question?")
    expect(fired).toHaveLength(1)
  })
})