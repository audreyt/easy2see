import en from "./en"
import {EASY2SEE_PRODUCT_NAME_KEYS, withEasy2SeeProductName} from "./easy2see"

function valueAt(root: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => (node as Record<string, unknown>)?.[segment], root)
}

describe("Easy2See product name overlay", () => {
  const renamed = withEasy2SeeProductName(en)

  it("names Easy2See wherever the stock string named the host app", () => {
    for (const key of EASY2SEE_PRODUCT_NAME_KEYS) {
      // An upstream rewording that drops Mentra would leave a dead entry here.
      expect(valueAt(en, key)).toMatch(/Mentra/)
      const text = valueAt(renamed, key) as string
      expect(text).toContain("Easy2See")
      expect(text.replace(/Mentra (?:Live|Mach1|Miniapp SDK)/g, "")).not.toMatch(/Mentra/)
    }
  })

  it("keeps names that belong to Mentra", () => {
    expect(valueAt(renamed, "miniappDevSettings.body")).toBe(
      "Miniapps run locally in Easy2See, connect to your glasses, and are built with the Mentra Miniapp SDK. To learn how to get started, check out the documentation.",
    )
    expect(valueAt(renamed, "settings.leaveAppMessage")).toBe(
      "This link will open in your browser, outside Easy2See. Continue?",
    )
    for (const key of [
      "pairing.liveScanSubtitle",
      "onboarding.osOpenLegacyPage",
      "workspace.mentraAccount",
      "settings.privacyPolicySubtitle",
      "miniApps.store",
    ]) {
      expect(valueAt(renamed, key)).toBe(valueAt(en, key))
    }
  })

  it("leaves the stock strings untouched", () => {
    expect(valueAt(en, "common.version")).toBe("MentraOS v{{number}}")
    expect(valueAt(renamed, "common.version")).toBe("Easy2See v{{number}}")
  })
})
