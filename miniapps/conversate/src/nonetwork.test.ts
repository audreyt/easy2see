/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

/**
 * The whole point of this miniapp is that nothing leaves the phone. Scan
 * every source file for network APIs and remote URLs — a single fetch()
 * anywhere is a build failure, not a code review note.
 */
describe("no network access anywhere in src/", () => {
  const FORBIDDEN = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /\bEventSource\b/,
    /\bsendBeacon\b/,
    /https?:\/\//,
  ]

  test("no fetch/XHR/WebSocket/remote URL in any source file", async () => {
    const glob = new Bun.Glob("**/*.{ts,tsx,css,html}")
    const offenders: string[] = []
    for await (const path of glob.scan({cwd: import.meta.dir})) {
      if (path === "nonetwork.test.ts") continue
      const text = await Bun.file(`${import.meta.dir}/${path}`).text()
      for (const re of FORBIDDEN) {
        if (re.test(text)) {
          offenders.push(`${path}: ${re}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})