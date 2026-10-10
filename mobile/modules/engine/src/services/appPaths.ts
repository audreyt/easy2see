/**
 * appPaths — EASY2SEE-only relocation of app-internal storage out of the
 * Files-visible Documents directory into Library/Application Support.
 *
 * Why: Easy2See enables UIFileSharingEnabled so users can reach session
 * recordings in Files › On My iPhone › Easy2See. That flag exposes the WHOLE
 * Documents directory — including stt_models, tts_models and mentra_blobs —
 * to browsing AND deletion. A user deleting the Sherpa model would break
 * offline voice-follow with no network to re-download it, so internals move
 * to Application Support (same backup exclusion as Documents) for EASY2SEE
 * builds only. Stock Mentra paths are byte-identical.
 *
 * expo-file-system's `Paths` has no Application Support constant; on iOS it
 * is the sibling of Documents inside the app container, so we derive it from
 * `Paths.document.uri`. On Android there is no equivalent — the internal
 * files dir is already private — so the helper falls back to Documents.
 */

import {Directory, Paths} from "expo-file-system"

import {getConfigValues} from "../runtime/bootstrap"

/** Host-supplied flag (IslandConfigValues.useAppSupportStorage); false until configure(). */
function useAppSupport(): boolean {
  return getConfigValues().useAppSupportStorage === true
}

/** Library/Application Support as a Directory (iOS); Documents elsewhere. */
export function appSupportDir(): Directory {
  // Paths.document is a Directory in the real API; tests mock it as a string.
  const docUri = (typeof Paths.document === "string" ? Paths.document : Paths.document.uri).replace(/\/+$/, "")
  // iOS: file:///…/Containers/Data/Application/<uuid>/Documents
  if (docUri.endsWith("/Documents")) {
    return new Directory(`${docUri.slice(0, -"/Documents".length)}/Library/Application Support`)
  }
  return new Directory(docUri)
}

/**
 * The base directory for app-internal storage: Application Support on
 * EASY2SEE builds, Documents everywhere else.
 */
export function internalStorageDir(): Directory {
  return useAppSupport() ? appSupportDir() : new Directory(Paths.document)
}

/**
 * One-time move-on-launch migration: if `name` exists under Documents but not
 * under Application Support, move it (same volume → rename). Returns true
 * when the directory is present at the destination afterwards. Any failure
 * logs and returns false — callers fall through to their normal
 * re-download/re-extract path exactly like a fresh install.
 *
 * No-op on non-EASY2SEE builds (nothing was ever relocated there).
 */
export function migrateDocumentsDirToAppSupport(name: string): boolean {
  if (!useAppSupport()) return true
  try {
    const support = appSupportDir()
    const dest = new Directory(support, name)
    if (dest.exists) return true
    const src = new Directory(Paths.document, name)
    if (!src.exists) return true // nothing to migrate — fresh install path
    if (!support.exists) support.create({intermediates: true})
    src.move(dest)
    console.log(`appPaths: migrated Documents/${name} → Library/Application Support/${name}`)
    return true
  } catch (err) {
    console.log(`appPaths: migration of ${name} failed; subsystem will re-populate`, err)
    return false
  }
}

/**
 * Plain-path sibling of `internalStorageDir` for subsystems that use
 * @dr.pogodin/react-native-fs (STT/TTS model managers) or react-native-mmkv
 * instead of expo-file-system. `docBase` is the caller's Documents path
 * (RNFS.DocumentDirectoryPath) — same directory as Paths.document on device.
 */
export function internalStoragePath(docBase: string): string {
  if (!useAppSupport()) return docBase
  return appSupportPath(docBase)
}

/** Library/Application Support as a plain path derived from a Documents path. */
export function appSupportPath(docBase: string): string {
  const base = docBase.replace(/\/+$/, "")
  if (base.endsWith("/Documents")) {
    return `${base.slice(0, -"/Documents".length)}/Library/Application Support`
  }
  return base
}

/**
 * Root path for react-native-mmkv's documented `createMMKV({path})` option.
 * EASY2SEE: `<AppSupport>/mmkv` (call migrateDocumentsDirToAppSupport("mmkv")
 * first so existing stores move with it). Stock: undefined → MMKV default.
 */
export function mmkvRootPath(docBase: string): string | undefined {
  if (!useAppSupport()) return undefined
  return `${appSupportPath(docBase)}/mmkv`
}
