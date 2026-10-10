import {getLocalUserId} from "./localIdentity"
import {storage} from "@/utils/storage"

describe("getLocalUserId", () => {
  it("generates a stable local- id and persists it", () => {
    const first = getLocalUserId()
    expect(first).toMatch(/^local-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // Second call reads the persisted value rather than minting a new one —
    // miniapp storage namespaces must survive restarts.
    expect(getLocalUserId()).toBe(first)
    expect(storage.load<string>("easy2see.localUserId").is_ok()).toBe(true)
  })
})
