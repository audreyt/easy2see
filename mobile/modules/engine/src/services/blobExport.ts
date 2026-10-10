/**
 * blobExport — copy a committed blob into a user-visible folder under the
 * app's Documents directory (Files app › On My iPhone › <App>).
 *
 * Kept out of BlobStore so the shared-file diff stays wiring-only. Pure
 * filesystem logic over expo-file-system's synchronous API; the only RN
 * surface is `Paths.document` and `Directory`/`File`.
 *
 * Contract (mirrors session.blob.exportToFiles + the create-time `export`
 * option):
 *   - `folder` is a path UNDER Documents — segments are sanitized, traversal
 *     is impossible, and the result never escapes Documents.
 *   - `filename` is a display name — separators/illegal chars are stripped,
 *     spaces preserved for readability.
 *   - Intermediate directories are created; on a name collision a numeric
 *     suffix is appended ("name (2).ext"); existing files are NEVER
 *     overwritten.
 */

import {Directory, File, Paths} from "expo-file-system"

/** One safe path segment for an export folder: no separators, no traversal. */
function sanitizeFolderSegment(s: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = (s || "").replace(/[/\\<>:"|?*\x00-\x1f]/g, "_").trim()
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "_"
  return cleaned.slice(0, 80)
}

/**
 * Resolve `folder` (e.g. "Recordings/Translation") to a Directory strictly
 * under Documents, creating intermediates. Every segment is sanitized, so
 * ".." and absolute paths collapse to harmless literal names.
 */
export function exportDirFor(folder: string): Directory {
  const segments = (folder || "")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(sanitizeFolderSegment)
  const dir = new Directory(Paths.document, ...segments)
  if (!dir.exists) dir.create({intermediates: true})
  return dir
}

/** Display filename for an export: readable, filesystem-safe, never empty. */
export function sanitizeExportFilename(name: string, fallback = "export"): string {
  // eslint-disable-next-line no-control-regex
  let safe = (name || "").replace(/[/\\<>:"|?*\x00-\x1f]/g, "_").trim()
  if (!safe || safe === "." || safe === "..") safe = fallback
  // Bound total length like shareFileName (filesystems reject >~255 bytes).
  const dot = safe.lastIndexOf(".")
  const hasExt = dot > 0 && dot < safe.length - 1
  const MAX_LEN = 160
  if (safe.length > MAX_LEN) {
    const ext = hasExt ? safe.slice(dot) : ""
    safe = safe.slice(0, MAX_LEN - ext.length) + ext
  }
  return safe
}

/**
 * First non-colliding name in `dir`: `name`, then `name (2)`, `name (3)`, …
 * The extension stays at the end ("a (2).wav"). Never overwrites.
 */
export function dedupeName(dir: Directory, filename: string): string {
  const dot = filename.lastIndexOf(".")
  const hasExt = dot > 0 && dot < filename.length - 1
  const base = hasExt ? filename.slice(0, dot) : filename
  const ext = hasExt ? filename.slice(dot) : ""
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? filename : `${base} (${i})${ext}`
    if (!new File(dir, candidate).exists) return candidate
  }
  // Pathological: fall back to a timestamped name rather than overwrite.
  return `${base} ${Date.now()}${ext}`
}

/**
 * Copy `src` into `dir` under a deduped `filename`. Returns the destination
 * file's URI and the name actually written. Throws on filesystem failure —
 * the caller maps that to BLOB_WRITE_FAILED / exportError.
 */
export function copyIntoDir(src: File, dir: Directory, filename: string): {uri: string; filename: string} {
  const name = dedupeName(dir, filename)
  const dest = new File(dir, name)
  src.copy(dest)
  return {uri: dest.uri, filename: name}
}
