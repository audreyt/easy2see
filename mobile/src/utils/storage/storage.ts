// Thin re-export: the app and the engine share ONE default MMKV instance and
// one implementation. The engine's MMKVStorage adds the crash-atomic durable
// snapshot (two-slot gen/checksum files under Library/Application Support)
// that restores the store after an MMKV fullWriteBack wipe — see
// modules/engine/src/utils/storage/storage.ts.
export {storage, StorageValueNotFoundError, MMKVStorage} from "../../../modules/engine/src/utils/storage/storage"
export type {MMKVLike, SnapshotFileLike, StorageDeps} from "../../../modules/engine/src/utils/storage/storage"
