import {describe, expect, test} from "bun:test"

import {MMKVStorage, type MMKVLike, type SnapshotFileLike, type StorageDeps} from "../storage/storage"

/* In-memory MMKV. */
function fakeMmkv(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial))
  const mmkv: MMKVLike = {
    getString: (k) => map.get(k),
    set: (k, v) => void map.set(k, v),
    getAllKeys: () => [...map.keys()],
    remove: (k) => map.delete(k),
    clearAll: () => map.clear(),
  }
  return {mmkv, map}
}

/* In-memory snapshot dir + files. */
function fakeFs() {
  const files = new Map<string, string>()
  let dirExists = false
  const deps = {
    snapshotDir: {
      get exists() {
        return dirExists
      },
      create: () => {
        dirExists = true
      },
      uri: "file:///app/Library/Application Support/durable-storage",
    },
    snapshotFile: (name: string): SnapshotFileLike => ({
      get exists() {
        return files.has(name)
      },
      textSync: () => files.get(name)!,
      write: (content: string) => void files.set(name, content),
    }),
  }
  return {files, deps, isDirCreated: () => dirExists}
}

function makeStorage(mmkv: MMKVLike, deps: StorageDeps) {
  return new MMKVStorage({mmkv, ...deps})
}

const SLOT_A = "storage-snapshot-a.json"
const SLOT_B = "storage-snapshot-b.json"
const MARKER = "__durable_gen"

function snapshotJson(gen: number, payload: Record<string, string>): string {
  const sorted: Record<string, string> = {}
  for (const k of Object.keys(payload).sort()) sorted[k] = payload[k]
  const canonical = JSON.stringify(sorted)
  // Mirror the impl's crc32 so test fixtures are real, not hand-waved.
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of new TextEncoder().encode(canonical)) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  const crcHex = ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0")
  return JSON.stringify({gen, crc32: crcHex, payload})
}

describe("durable snapshot restore", () => {
  test("wipe: MMKV emptied → all keys restored incl. pairing identity + localUserId", () => {
    const {mmkv, map} = fakeMmkv() // wiped: empty store, no marker
    const {files, deps} = fakeFs()
    files.set(SLOT_A, snapshotJson(7, {default_wearable: '"G2-AB:CD"', "easy2see.localUserId": '"u-123"'}))

    const s = makeStorage(mmkv, deps)
    expect(s.load<string>("default_wearable").is_ok()).toBe(true)
    expect(s.load<string>("easy2see.localUserId").is_ok()).toBe(true)
    expect(map.get("default_wearable")).toBe('"G2-AB:CD"')
    expect(map.get("easy2see.localUserId")).toBe('"u-123"')
    expect(map.get(MARKER)).toBe("7")
  })

  test("rollback: marker < snapshot gen → restore", () => {
    const {mmkv, map} = fakeMmkv({[MARKER]: "3", stale: '"old"'})
    const {files, deps} = fakeFs()
    files.set(SLOT_B, snapshotJson(9, {fresh: '"new"'}))

    const s = makeStorage(mmkv, deps)
    s.getAllKeys() // first store access triggers restore
    expect(map.get("fresh")).toBe('"new"')
    expect(map.has("stale")).toBe(false) // clearAll wiped the stale key
    expect(map.get(MARKER)).toBe("9")
    expect(s.load<string>("fresh").is_ok()).toBe(true)
  })

  test("marker ≥ gen → MMKV untouched", () => {
    const {mmkv, map} = fakeMmkv({[MARKER]: "9", keep: '"me"'})
    const {files, deps} = fakeFs()
    files.set(SLOT_A, snapshotJson(9, {other: '"x"'}))

    makeStorage(mmkv, deps).getAllKeys()
    expect(map.get("keep")).toBe('"me"')
    expect(map.has("other")).toBe(false)
    expect(map.get(MARKER)).toBe("9")
  })

  test("no snapshot at all → no-op (fresh install)", () => {
    const {mmkv, map} = fakeMmkv({existing: '"v"'})
    const {deps} = fakeFs()
    makeStorage(mmkv, deps).getAllKeys()
    expect(map.get("existing")).toBe('"v"')
    expect(map.has(MARKER)).toBe(false)
  })

  test("corrupt newest slot → falls back to older valid slot", () => {
    const {mmkv, map} = fakeMmkv() // wiped
    const {files, deps} = fakeFs()
    files.set(SLOT_A, snapshotJson(5, {a: '"1"'}))
    files.set(SLOT_B, '{"gen":9,"crc32":"deadbeef","payload":{"b":"2"}}') // torn write

    makeStorage(mmkv, deps).getAllKeys()
    expect(map.get("a")).toBe('"1"')
    expect(map.has("b")).toBe(false)
    expect(map.get(MARKER)).toBe("5")
  })

  test("both slots corrupt → no restore, no throw", () => {
    const {mmkv, map} = fakeMmkv({survivor: '"s"'})
    const {files, deps} = fakeFs()
    files.set(SLOT_A, "not json {{{")
    files.set(SLOT_B, '{"gen":2,"crc32":"bad","payload":{}}')

    expect(() => makeStorage(mmkv, deps).getAllKeys()).not.toThrow()
    expect(map.get("survivor")).toBe('"s"')
  })
})

describe("durable snapshot flush", () => {
  test("save → debounced flush writes a slot; second flush writes the OTHER slot", async () => {
    const {mmkv, map} = fakeMmkv()
    const {files, deps} = fakeFs()
    const s = makeStorage(mmkv, deps)
    s.save("k1", "v1")
    await new Promise((r) => setTimeout(r, 300)) // debounce window
    expect(files.size).toBe(1)
    const first = JSON.parse([...files.values()][0])
    expect(first.gen).toBe(1)
    expect(first.payload.k1).toBe('"v1"')
    expect(map.get(MARKER)).toBe("1")

    s.save("k2", "v2")
    await new Promise((r) => setTimeout(r, 300))
    expect(files.size).toBe(2)
    const second = JSON.parse(files.get(SLOT_B)!)
    expect(second.gen).toBe(2)
    expect(second.payload.k2).toBe('"v2"')
    expect(map.get(MARKER)).toBe("2")
  })

  test("flush alternates slots (older slot always overwritten)", async () => {
    const {mmkv} = fakeMmkv()
    const {files, deps} = fakeFs()
    const s = makeStorage(mmkv, deps)
    s.save("x", 1)
    s.flushSnapshot() // gen1 → A
    s.save("x", 2)
    s.flushSnapshot() // gen2 → B
    s.save("x", 3)
    s.flushSnapshot() // gen3 → A again (older)
    expect(JSON.parse(files.get(SLOT_A)!).gen).toBe(3)
    expect(JSON.parse(files.get(SLOT_B)!).gen).toBe(2)
  })

  test("clearAll writes an EMPTY snapshot synchronously — next load does not resurrect", () => {
    const {mmkv, map} = fakeMmkv({secret: '"s"'})
    const {files, deps} = fakeFs()
    const s = makeStorage(mmkv, deps)
    s.save("secret", "s")
    s.clearAll()
    expect(map.size).toBe(1) // only the marker
    const written = JSON.parse(files.get(SLOT_A)!)
    expect(written.payload).toEqual({})
    expect(map.get(MARKER)).toBe(String(written.gen))

    // Simulate relaunch with a wiped MMKV: restore must yield EMPTY, not the old keys.
    const {mmkv: mmkv2, map: map2} = fakeMmkv()
    makeStorage(mmkv2, deps).getAllKeys()
    expect(map2.has("secret")).toBe(false)
    expect(map2.get(MARKER)).toBe(String(written.gen))
  })

  test("flush failure never throws into callers", () => {
    const {mmkv} = fakeMmkv()
    const {deps} = fakeFs()
    const bad = {
      ...deps,
      snapshotFile: (name: string): SnapshotFileLike => ({
        get exists() {
          return false
        },
        textSync: () => "",
        write: () => {
          throw new Error("disk full")
        },
      }),
    }
    const s = makeStorage(mmkv, bad)
    expect(() => {
      s.save("k", "v")
      s.flushSnapshot()
    }).not.toThrow()
  })

  test("snapshot dir is created on first flush", () => {
    const {mmkv} = fakeMmkv()
    const {deps, isDirCreated} = fakeFs()
    const s = makeStorage(mmkv, deps)
    expect(isDirCreated()).toBe(false)
    s.save("k", "v")
    s.flushSnapshot()
    expect(isDirCreated()).toBe(true)
  })
})
