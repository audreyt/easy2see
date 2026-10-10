import {storage} from "@/utils/storage"

/**
 * Device-local identity for `auth.mode === "local"` deployments (Easy2See).
 *
 * Generated once, persisted in the app's default MMKV store, and used wherever
 * a Mentra user id would namespace on-device data (local miniapp storage,
 * AuthContext's session user). The "local-" prefix keeps it visually distinct
 * from Core-issued ids. It is never sent anywhere: local deployments have no
 * Core/Runtime endpoints and the cloud client is never constructed.
 */
const LOCAL_USER_ID_KEY = "easy2see.localUserId"

function randomUuid(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"))
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
    .slice(8, 10)
    .join("")}-${hex.slice(10, 16).join("")}`
}

export function getLocalUserId(): string {
  const existing = storage.load<string>(LOCAL_USER_ID_KEY)
  if (existing.is_ok() && typeof existing.value === "string" && existing.value.trim()) {
    return existing.value
  }
  const id = `local-${randomUuid()}`
  const saved = storage.save(LOCAL_USER_ID_KEY, id)
  if (saved.is_error()) throw saved.error
  return id
}
