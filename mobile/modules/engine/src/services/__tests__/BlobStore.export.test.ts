import {afterEach, beforeEach, describe, expect, it, mock} from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// ── expo-file-system mock (mirrors BlobStore.share.test.ts) ──────────────────
let root: string
const Paths = {cache: "", document: ""}
const pathname = (parts: Array<string | {uri: string}>) =>
  path.join(...parts.map((p) => (typeof p === "string" ? p : p.uri)))
class Directory {
  uri: string
  constructor(...parts: Array<string | {uri: string}>) {
    this.uri = pathname(parts)
  }
  get exists() {
    return fs.existsSync(this.uri)
  }
  create() {
    fs.mkdirSync(this.uri, {recursive: true})
  }
  move(target: Directory) {
    fs.renameSync(this.uri, target.uri)
  }
}
class File {
  uri: string
  constructor(...parts: Array<string | {uri: string}>) {
    this.uri = pathname(parts)
  }
  get exists() {
    return fs.existsSync(this.uri)
  }
  get size() {
    return fs.statSync(this.uri).size
  }
  copy(target: File) {
    fs.copyFileSync(this.uri, target.uri)
  }
  rename(name: string) {
    fs.renameSync(this.uri, path.join(path.dirname(this.uri), name))
    this.uri = path.join(path.dirname(this.uri), name)
  }
  delete() {
    fs.rmSync(this.uri, {force: true})
  }
  create() {
    fs.mkdirSync(path.dirname(this.uri), {recursive: true})
    fs.writeFileSync(this.uri, "")
  }
  open() {
    const uri = this.uri
    return {
      offset: 0,
      writeBytes: (b: Uint8Array) => {
        const fd = fs.openSync(uri, "r+")
        fs.writeSync(fd, b, 0, b.length, this.offset ?? fs.statSync(uri).size)
        fs.closeSync(fd)
      },
      close: () => {},
    }
  }
}
const mmkv = new Map<string, unknown>()
mock.module("expo-file-system", () => ({Directory, File, Paths}))
mock.module("react-native-share", () => ({default: {open: mock(async () => {})}}))
mock.module("@mentra/miniapp", () => ({
  MiniappErrorCode: {
    BLOB_NOT_FOUND: "BLOB_NOT_FOUND",
    BLOB_WRITE_FAILED: "BLOB_WRITE_FAILED",
    BLOB_HANDLE_INVALID: "BLOB_HANDLE_INVALID",
    BLOB_QUOTA_EXCEEDED: "BLOB_QUOTA_EXCEEDED",
    INVALID_ARGUMENT: "INVALID_ARGUMENT",
  },
}))
mock.module("../../utils/storage/storage", () => ({
  storage: {
    load: (k: string) => (mmkv.has(k) ? {is_ok: () => true, value: mmkv.get(k)} : {is_ok: () => false}),
    save: (k: string, v: unknown) => void mmkv.set(k, v),
    remove: (k: string) => void mmkv.delete(k),
    getAllKeys: () => [...mmkv.keys()],
  },
}))
// EASY2SEE on: blobs relocate to <container>/Library/Application Support.
// appPaths.ts reads the flag from engine config — mock the bootstrap seam.
// Spread the REAL module and override only the one flag: bun keeps mock.module
// active for every later file in the same process, so a partial mock would
// strip isFeatureEnabled & co. from suites that run after this one.
// Snapshot the exports into a plain object FIRST: mock.module patches the live
// namespace in place, so reading it inside the factory would recurse.
const realBootstrap = {...(await import("../../runtime/bootstrap"))}
const realGetConfigValues = realBootstrap.getConfigValues
mock.module("../../runtime/bootstrap", () => ({
  ...realBootstrap,
  getConfigValues: () => ({...realGetConfigValues(), useAppSupportStorage: true}),
}))
// BlobStore (and its expo-file-system/storage imports) is evaluated.
const {BlobStore} = await import("../BlobStore")

let store: InstanceType<typeof BlobStore>
let results: ReturnType<typeof mock>
const calls = () => results.mock.calls as unknown as Array<[string, string | undefined, boolean, unknown, unknown]>
const lastCall = () => calls().at(-1)!
const docFile = (...p: string[]) => path.join(Paths.document, ...p)
const blobRoot = () => path.join(root, "Library", "Application Support", "mentra_blobs")

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "blob-export-test-"))
  // iOS container shape: <root>/Documents + <root>/Library/Application Support
  Paths.document = path.join(root, "Documents")
  Paths.cache = path.join(root, "cache")
  fs.mkdirSync(Paths.document, {recursive: true})
  fs.mkdirSync(Paths.cache, {recursive: true})
  mmkv.clear()
  results = mock(() => {})
  store = new BlobStore({sendResult: results, getUserId: () => "user"})
})
afterEach(() => fs.rmSync(root, {recursive: true, force: true}))

const commitBlob = (key: string, bytes: number[], exportHint?: {folder: string; filename: string}) => {
  store.handleCreate("app", {key, mimeType: "audio/wav", name: key, ...(exportHint ? {export: exportHint} : {})}, "c1")
  store.handleWrite("app", {key, base64: Buffer.from(bytes).toString("base64")}, "w1")
  store.handleCommit("app", {key}, "m1")
}

describe("blob export to Files", () => {
  it("copies a committed blob into Documents/<folder>/<filename> and removes the blob by default", () => {
    commitBlob("k1", [1, 2, 3])
    store.handleExport("app", {key: "k1", folder: "Recordings/Translation", filename: "take 1.wav"}, "e1")
    const [, , ok, res] = lastCall()
    expect(ok).toBe(true)
    const out = res as {uri: string; filename: string}
    expect(out.filename).toBe("take 1.wav")
    expect(fs.readFileSync(out.uri)).toEqual(Buffer.from([1, 2, 3]))
    expect(out.uri).toContain("Recordings/Translation")
    // Move semantics: blob meta + file are gone.
    expect([...mmkv.keys()].filter((k) => k.includes("k1"))).toHaveLength(0)
  })

  it("keepBlob retains the source blob", () => {
    commitBlob("k2", [9])
    store.handleExport("app", {key: "k2", folder: "Recordings", filename: "a.wav", keepBlob: true}, "e1")
    expect(lastCall()[2]).toBe(true)
    expect([...mmkv.keys()].filter((k) => k.includes("k2")).length).toBe(1)
  })

  it("dedupes on collision and never overwrites", () => {
    commitBlob("k3", [1])
    commitBlob("k4", [2])
    store.handleExport("app", {key: "k3", folder: "R", filename: "a.wav"}, "e1")
    store.handleExport("app", {key: "k4", folder: "R", filename: "a.wav"}, "e2")
    const second = lastCall()[3] as {uri: string; filename: string}
    expect(second.filename).toBe("a (2).wav")
    expect(fs.readFileSync(docFile("R", "a.wav"))).toEqual(Buffer.from([1]))
    expect(fs.readFileSync(docFile("R", "a (2).wav"))).toEqual(Buffer.from([2]))
  })

  it("sanitizes traversal out of folder and filename", () => {
    commitBlob("k5", [7])
    store.handleExport("app", {key: "k5", folder: "../../etc", filename: "../evil.wav"}, "e1")
    const out = lastCall()[3] as {uri: string}
    expect(out.uri.startsWith(Paths.document)).toBe(true)
    expect(fs.existsSync(path.join(root, "evil.wav"))).toBe(false)
  })

  it("rejects unknown keys with BLOB_NOT_FOUND", () => {
    store.handleExport("app", {key: "nope", folder: "R", filename: "a.wav"}, "e1")
    const [, , ok, , err] = lastCall()
    expect(ok).toBe(false)
    expect((err as {code: string}).code).toBe("BLOB_NOT_FOUND")
  })

  it("rejects missing arguments with INVALID_ARGUMENT", () => {
    store.handleExport("app", {key: "k", folder: "", filename: "a.wav"}, "e1")
    expect((lastCall()[4] as {code: string}).code).toBe("INVALID_ARGUMENT")
  })

  it("create-time export hint exports at commit and annotates the result", () => {
    commitBlob("k6", [5, 5], {folder: "Recordings/Translation", filename: "auto.wav"})
    const [, , ok, res] = lastCall()
    expect(ok).toBe(true)
    const meta = res as {exportedTo?: string}
    expect(meta.exportedTo).toContain("Recordings/Translation/auto.wav")
    expect(fs.existsSync(docFile("Recordings", "Translation", "auto.wav"))).toBe(true)
  })

  it("orphan-commit: app teardown commits + exports hinted uploads instead of discarding", () => {
    store.handleCreate(
      "app",
      {key: "k7", mimeType: "text/markdown", export: {folder: "Recordings/Translation", filename: "t.md"}},
      "c1",
    )
    store.handleWrite("app", {key: "k7", base64: Buffer.from("# hi").toString("base64")}, "w1")
    // No BLOB_COMMIT — the session dies here.
    store.onAppGone("app")
    expect(fs.readFileSync(docFile("Recordings", "Translation", "t.md")).toString()).toBe("# hi")
  })

  it("orphan without export hint is still discarded", () => {
    store.handleCreate("app", {key: "k8", mimeType: "text/plain"}, "c1")
    store.handleWrite("app", {key: "k8", base64: Buffer.from("x").toString("base64")}, "w1")
    store.onAppGone("app")
    expect([...mmkv.keys()]).toHaveLength(0)
  })
})

describe("EASY2SEE blob root relocation", () => {
  it("blobs live under Library/Application Support, not Documents", () => {
    commitBlob("k9", [1])
    expect(fs.existsSync(blobRoot())).toBe(true)
    expect(fs.existsSync(path.join(Paths.document, "mentra_blobs"))).toBe(false)
  })

  it("migrates a pre-existing Documents/mentra_blobs on first access", () => {
    const old = path.join(Paths.document, "mentra_blobs", "user", "app")
    fs.mkdirSync(old, {recursive: true})
    fs.writeFileSync(path.join(old, "f.wav"), "x")
    commitBlob("k10", [1]) // triggers dirFor → migration
    expect(fs.existsSync(path.join(blobRoot(), "user", "app", "f.wav"))).toBe(true)
    expect(fs.existsSync(path.join(Paths.document, "mentra_blobs"))).toBe(false)
  })
})
