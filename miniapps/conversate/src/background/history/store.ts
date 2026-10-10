/**
 * store.ts — local session history (design §4: "store the session locally
 * (blob) for the in-app history; searchable offline").
 *
 * The index lives in session.storage as one JSON array (small: metadata
 * only). Each session's rendered Markdown review is a session.blob entry —
 * binary storage scoped to this miniapp, readable offline, deletable.
 */

import type {MiniappSession} from "@mentra/miniapp/background"
import type {SessionRecordMeta} from "../../shared/types"

const INDEX_KEY = "conversate.history.v1"
const MAX_RECORDS = 100

export class HistoryStore {
  private index: SessionRecordMeta[] | null = null

  constructor(private readonly session: MiniappSession) {}

  async list(): Promise<SessionRecordMeta[]> {
    if (this.index) return this.index
    try {
      const raw = await this.session.storage.get(INDEX_KEY)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      this.index = Array.isArray(parsed)
        ? parsed.filter(
            (r): r is SessionRecordMeta =>
              typeof r === "object" && r !== null && typeof (r as SessionRecordMeta).id === "string",
          )
        : []
    } catch {
      this.index = []
    }
    return this.index
  }

  /** Add a record (newest first), persist the index, cap at MAX_RECORDS. */
  async add(record: SessionRecordMeta): Promise<void> {
    const list = await this.list()
    list.unshift(record)
    if (list.length > MAX_RECORDS) {
      const dropped = list.splice(MAX_RECORDS)
      for (const d of dropped) {
        try {
          await this.session.blob.delete(d.blobKey)
        } catch {
          /* ignore */
        }
      }
    }
    await this.persist()
  }

  /** Read a record's Markdown from its blob. */
  async markdown(id: string): Promise<string | null> {
    const rec = (await this.list()).find((r) => r.id === id)
    if (!rec) return null
    try {
      const bytes = await this.session.blob.bytes(rec.blobKey)
      return bytes ? new TextDecoder().decode(bytes) : null
    } catch {
      return null
    }
  }

  /** Delete a record and its blob. */
  async delete(id: string): Promise<void> {
    const list = await this.list()
    const idx = list.findIndex((r) => r.id === id)
    if (idx < 0) return
    const [rec] = list.splice(idx, 1)
    try {
      await this.session.blob.delete(rec.blobKey)
    } catch {
      /* ignore */
    }
    await this.persist()
  }

  /** Offline search over titles (the UI filters; this is the same predicate). */
  async search(query: string): Promise<SessionRecordMeta[]> {
    const q = query.trim().toLowerCase()
    const list = await this.list()
    if (!q) return list
    return list.filter((r) => r.title.toLowerCase().includes(q))
  }

  /** Mark a record's Files-export state (re-export succeeded). */
  async markExported(id: string): Promise<void> {
    const rec = (await this.list()).find((r) => r.id === id)
    if (rec && !rec.exported) {
      rec.exported = true
      await this.persist()
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.session.storage.set(INDEX_KEY, JSON.stringify(this.index ?? []))
    } catch {
      /* storage write failed — history stays in memory this run */
    }
  }
}
