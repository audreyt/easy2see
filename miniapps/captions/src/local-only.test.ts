import {describe, expect, test} from "bun:test"
import {readdirSync, readFileSync, statSync} from "node:fs"
import {join} from "node:path"

// Easy2See captions must run with the phone's radios off. This guard scans
// every source file that ships in the bundle and fails if a network API or a
// cloud transcription opt-in creeps back in.
const SRC = join(import.meta.dir)

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      yield* sourceFiles(p)
    } else if (/\.(ts|tsx|css)$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      yield p
    }
  }
}

const FORBIDDEN: Array<{pattern: RegExp; what: string}> = [
  {pattern: /\bfetch\s*\(/, what: "fetch()"},
  {pattern: /XMLHttpRequest/, what: "XMLHttpRequest"},
  {pattern: /new\s+WebSocket|WebSocket\s*\(/, what: "WebSocket"},
  {pattern: /new\s+EventSource|EventSource\s*\(/, what: "EventSource (SSE)"},
  {pattern: /includeCloud/, what: "includeCloud transcription opt-in"},
  {pattern: /https?:\/\/(?!www\.w3\.org\/)/, what: "remote URL (fonts, APIs, assets)"},
]

describe("local-only guarantee", () => {
  test("no shipped source file uses a network API or cloud opt-in", () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      // Strip comments first: several files document the cloud transport they
      // replaced ("replaces the cloud app's EventSource/SSE hook") — prose is
      // not a network call.
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
      for (const {pattern, what} of FORBIDDEN) {
        if (pattern.test(text)) {
          offenders.push(`${file.replace(`${SRC}/`, "")}: ${what}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
