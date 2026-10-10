// @ts-nocheck
import type {MMKV} from "react-native-mmkv"
import {result as Res, Result} from "typesafe-ts"

/**
 * Thrown by load() when the key has no stored value. Callers that treat a
 * missing key as an expected state (e.g. first run) should branch on
 * `instanceof StorageValueNotFoundError` rather than matching the message.
 */
export class StorageValueNotFoundError extends Error {
  constructor(key: string) {
    super(`No value found for ${key}`)
    this.name = "StorageValueNotFoundError"
  }
}

/* ------------------------------------------------------------------------ *
 * Durable snapshot — crash-atomic backup of the whole MMKV store.
 *
 * react-native-mmkv 4 compacts via fullWriteBack: ftruncate, then rewrite
 * through mmap. A SIGKILL in that window leaves a truncated file and the
 * next launch loads an EMPTY store — observed on-device wiping the G2
 * pairing identity and easy2see.localUserId (which orphans every miniapp
 * namespace). MMKV itself cannot be made atomic, so every mutation is also
 * mirrored into a two-slot JSON snapshot and restored from it on the next
 * launch when the MMKV marker proves data was lost.
 *
 *   storage-snapshot-a.json / storage-snapshot-b.json
 *   {gen: number, crc32: string, payload: {key: rawString}}
 *
 * Each flush writes the OLDER slot, so a torn write can only damage the
 * slot being written, never the last good one. On load the highest-gen
 * slot whose checksum verifies wins. Flush order: snapshot slot first,
 * then the `__durable_gen` marker inside MMKV — the marker is the commit
 * point that tells restore whether MMKV is ahead of, equal to, or behind
 * the snapshot.
 *
 * Location: Library/Application Support/durable-storage — resolved
 * statically from Paths.document at first store access, BEFORE
 * engine.configure() (the 344 blank-screen trap: no config-gated lookup).
 * Not Documents (Files-visible + user-deletable under EASY2SEE) and not
 * Caches (purgeable). On Android there is no Application Support sibling;
 * the internal files dir is already private, so it falls back to
 * <files>/durable-storage.
 * ------------------------------------------------------------------------ */

const DURABLE_MARKER_KEY = "__durable_gen"
const SNAPSHOT_DIR_NAME = "durable-storage"
const SNAPSHOT_SLOT_A = "storage-snapshot-a.json"
const SNAPSHOT_SLOT_B = "storage-snapshot-b.json"
const FLUSH_DEBOUNCE_MS = 250

/** Minimal MMKV surface this wrapper needs (injectable for tests). */
export interface MMKVLike {
  getString(key: string): string | undefined
  set(key: string, value: string): void
  getAllKeys(): string[]
  remove(key: string): boolean
  clearAll(): void
}

/** Minimal file surface for one snapshot slot (injectable for tests). */
export interface SnapshotFileLike {
  readonly exists: boolean
  textSync(): string
  write(content: string): void
}

export interface StorageDeps {
  mmkv: MMKVLike
  /** Snapshot directory; created if missing. */
  snapshotDir: {exists: boolean; create(options?: {intermediates?: boolean}): void; uri: string}
  snapshotFile(name: string): SnapshotFileLike
  schedule?: (fn: () => void, ms: number) => unknown
  cancelScheduled?: (handle: unknown) => void
  /** Called once at first store access so the host can hook AppState. */
  onBackground?: (fn: () => void) => void
}

interface ParsedSnapshot {
  gen: number
  payload: Record<string, string>
}

/* CRC32 (IEEE) — table-driven, over UTF-8 bytes of the canonical payload. */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let crc = 0xffffffff
  for (const b of bytes) crc = CRC32_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0")
}

/** Deterministic serialization: keys sorted so identical stores checksum identically. */
function canonicalPayload(payload: Record<string, string>): string {
  const sorted: Record<string, string> = {}
  for (const k of Object.keys(payload).sort()) sorted[k] = payload[k]
  return JSON.stringify(sorted)
}

function parseSnapshot(raw: string): ParsedSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as {gen?: unknown; crc32?: unknown; payload?: unknown}
    if (typeof parsed.gen !== "number" || !Number.isFinite(parsed.gen)) return null
    if (typeof parsed.crc32 !== "string" || typeof parsed.payload !== "object" || parsed.payload === null) {
      return null
    }
    const payload = parsed.payload as Record<string, unknown>
    const strings: Record<string, string> = {}
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v !== "string") return null
      strings[k] = v
    }
    if (crc32(canonicalPayload(strings)) !== parsed.crc32) return null
    return {gen: parsed.gen, payload: strings}
  } catch {
    return null
  }
}

/**
 * Library/Application Support as a plain URI, derived statically from the
 * Documents URI. No engine config — safe at module load / first access.
 */
function appSupportUri(documentUri: string): string {
  const base = documentUri.replace(/\/+$/, "")
  if (base.endsWith("/Documents")) {
    return `${base.slice(0, -"/Documents".length)}/Library/Application Support`
  }
  return base
}

/** Real-device dependencies, resolved lazily so module load stays side-effect free. */
function defaultDeps(): StorageDeps {
  // Lazy requires: react-native / react-native-mmkv / expo-file-system are
  // native modules that cannot load under bun tests; deferring to first
  // store access keeps this file importable everywhere.
  const {createMMKV} = require("react-native-mmkv") as typeof import("react-native-mmkv")
  const {AppState} = require("react-native") as typeof import("react-native")
  const {Directory, File, Paths} = require("expo-file-system") as typeof import("expo-file-system")

  const docUri = typeof Paths.document === "string" ? Paths.document : Paths.document.uri
  const dir = new Directory(`${appSupportUri(docUri)}/${SNAPSHOT_DIR_NAME}`)
  return {
    mmkv: createMMKV() as unknown as MMKVLike,
    snapshotDir: dir,
    snapshotFile: (name) => new File(dir, name),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancelScheduled: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    onBackground: (fn) => {
      AppState.addEventListener("change", (state) => {
        if (state === "background" || state === "inactive") fn()
      })
    },
  }
}

export class MMKVStorage {
  private _deps?: StorageDeps
  private _store?: MMKVLike
  private _restored = false
  private _currentGen = 0
  private _dirty = false
  private _flushTimer: unknown = null
  private readonly _depsFactory: () => StorageDeps

  constructor(deps?: StorageDeps | (() => StorageDeps)) {
    this._depsFactory = typeof deps === "function" ? deps : () => deps ?? defaultDeps()
  }

  private get deps(): StorageDeps {
    if (!this._deps) this._deps = this._depsFactory()
    return this._deps
  }

  private get store(): MMKVLike {
    if (!this._store) {
      this._store = this.deps.mmkv
      this.restoreIfNeeded()
      try {
        this.deps.onBackground?.(() => this.flushSnapshot())
      } catch (err) {
        console.log("STORAGE: background-flush hook failed", err)
      }
    }
    return this._store
  }

  /* ------------------------- durable snapshot ------------------------- */

  private readSlot(name: string): ParsedSnapshot | null {
    try {
      const file = this.deps.snapshotFile(name)
      if (!file.exists) return null
      return parseSnapshot(file.textSync())
    } catch (err) {
      console.log(`STORAGE: snapshot slot ${name} unreadable`, err)
      return null
    }
  }

  /** Highest-gen slot whose checksum verifies; null when none does. */
  private readBestSnapshot(): ParsedSnapshot | null {
    const a = this.readSlot(SNAPSHOT_SLOT_A)
    const b = this.readSlot(SNAPSHOT_SLOT_B)
    if (a && b) return a.gen >= b.gen ? a : b
    return a ?? b
  }

  /** The slot a flush should write: the older (or empty) one. */
  private pickWriteSlot(a: ParsedSnapshot | null, b: ParsedSnapshot | null): string {
    if (a && b) return a.gen <= b.gen ? SNAPSHOT_SLOT_A : SNAPSHOT_SLOT_B
    return a ? SNAPSHOT_SLOT_B : SNAPSHOT_SLOT_A
  }

  private markerGen(): number {
    try {
      const raw = this._store?.getString(DURABLE_MARKER_KEY)
      const n = raw === undefined ? NaN : Number(raw)
      return Number.isFinite(n) ? n : 0
    } catch {
      return 0
    }
  }

  private collectPayload(): Record<string, string> {
    const payload: Record<string, string> = {}
    for (const key of this._store?.getAllKeys() ?? []) {
      if (key === DURABLE_MARKER_KEY) continue
      const value = this._store!.getString(key)
      if (typeof value === "string") payload[key] = value
    }
    return payload
  }

  /**
   * Restore MMKV from the best valid snapshot when the marker proves data
   * was lost (wipe → marker missing; rollback → marker < snapshot gen).
   * Never throws: a corrupt/absent snapshot just leaves MMKV as-is.
   */
  private restoreIfNeeded(): void {
    if (this._restored) return
    this._restored = true
    try {
      const best = this.readBestSnapshot()
      const marker = this.markerGen()
      this._currentGen = Math.max(marker, best?.gen ?? 0)
      if (!best) return // fresh install or first launch with this code
      if (marker >= best.gen) return // MMKV is at least as new as the snapshot
      const store = this._store!
      store.clearAll()
      for (const [key, value] of Object.entries(best.payload)) {
        store.set(key, value)
      }
      store.set(DURABLE_MARKER_KEY, String(best.gen))
      console.log(
        `STORAGE: restored ${Object.keys(best.payload).length} keys from durable snapshot gen ${best.gen} (marker was ${marker})`,
      )
    } catch (err) {
      console.log("STORAGE: durable snapshot restore failed; continuing with MMKV as-is", err)
    }
  }

  private markDirty(): void {
    this._dirty = true
    if (this._flushTimer !== null) return
    const schedule = this.deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    this._flushTimer = schedule(() => {
      this._flushTimer = null
      this.flushSnapshot()
    }, FLUSH_DEBOUNCE_MS)
  }

  /**
   * Write the current store into the older snapshot slot, then advance the
   * MMKV marker — the marker is the commit point. Never throws into callers.
   * `overridePayload` is used by clearAll to persist an EMPTY snapshot.
   */
  public flushSnapshot(overridePayload?: Record<string, string>): void {
    if (!this._store) return
    try {
      const payload = overridePayload ?? this.collectPayload()
      const gen = this._currentGen + 1
      const a = this.readSlot(SNAPSHOT_SLOT_A)
      const b = this.readSlot(SNAPSHOT_SLOT_B)
      const slot = this.pickWriteSlot(a, b)
      const dir = this.deps.snapshotDir
      if (!dir.exists) dir.create({intermediates: true})
      this.deps.snapshotFile(slot).write(
        JSON.stringify({gen, crc32: crc32(canonicalPayload(payload)), payload}),
      )
      this._store.set(DURABLE_MARKER_KEY, String(gen))
      this._currentGen = gen
      this._dirty = false
    } catch (err) {
      console.log("STORAGE: durable snapshot flush failed", err)
    }
  }

  /* ------------------------------ public API ------------------------------ */

  public save(key: string, value: unknown): Result<void, Error> {
    return this.saveString(key, JSON.stringify(value))
  }

  public load<T>(key: string): Result<T, Error> {
    return Res.try(() => {
      const loadedString = this.store.getString(key) ?? ""
      if (loadedString === "") {
        throw new StorageValueNotFoundError(key)
      }
      const value = JSON.parse(loadedString) as T
      return value
    })
  }

  private saveString(key: string, value: string): Result<void, Error> {
    this.store.set(key, value)
    this.markDirty()
    return Res.ok(undefined)
  }

  public getAllKeys(): string[] {
    // The durable-snapshot marker is wrapper-internal (collectPayload already
    // excludes it) — callers list user keys only.
    return this.store.getAllKeys().filter((key) => key !== DURABLE_MARKER_KEY)
  }

  public removeMultiple(keys: string[]): Result<void, Error> {
    let success = true
    for (const key of keys) {
      const res = this.store.remove(key)
      if (!res) {
        success = false
      }
    }
    this.markDirty()
    if (!success) {
      console.error("Failed to remove one or more keys")
      return Res.error(new Error("Failed to remove one or more keys"))
    }
    return Res.ok(undefined)
  }

  public loadSubKeys(key: string): Result<Record<string, unknown>, Error> {
    return Res.try(() => {
      // return the key value pair of any keys that start with the given key and contain a colon:
      const keys = this.store.getAllKeys()

      const subKeys = keys.filter((k) => k.startsWith(key) && k.includes(":"))

      if (subKeys.length === 0) {
        throw new Error(`No subkeys found for ${key}`)
      }

      let subKeysObject: Record<string, unknown> = {}

      for (const subKey of subKeys) {
        const res = this.load(subKey)
        if (res.is_ok()) {
          subKeysObject[subKey] = res.value
        }
      }

      return subKeysObject
    })
  }

  public remove(key: string): Result<void, Error> {
    this.store.remove(key)
    this.markDirty()
    return Res.ok(undefined)
  }

  // burn it all — synchronously persists an EMPTY snapshot with a new gen so
  // a logout can never be resurrected by the restore path.
  public clearAll(): Result<void, Error> {
    this.store.clearAll()
    this.flushSnapshot({})
    return Res.ok(undefined)
  }
}

export const storage = new MMKVStorage()
