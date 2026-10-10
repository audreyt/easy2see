import type {Translations} from "./en"

/**
 * English strings in which "Mentra", "MentraOS" or "the Mentra App" names the host
 * app. The Easy2See build renames exactly these. Everything else keeps Mentra's name
 * on purpose: Mentra glasses (Mentra Live, Mach1), Mentra accounts and workspaces,
 * the Mentra Miniapp SDK and Store, MentraOS Legacy, and Mentra's privacy policy all
 * still belong to Mentra.
 */
export const EASY2SEE_PRODUCT_NAME_KEYS = [
  "common.version",
  "home.title",
  "warning.betaBuild",
  "errorScreen.friendlySubtitle",
  "versionCheck.updateRequiredDescription",
  "versionCheck.updateRequiredButton",
  "versionCheck.updateAvailableDescription",
  "versionCheck.upToDateDescription",
  "versionCheck.managedUpdateDescription",
  "ota.updateInfoUnavailableMessage",
  "pairing.simulatedGlassesDescription",
  "onboarding.welcome",
  "onboarding.liveEndOnboardingMessage",
  "onboarding.osWelcomeTitle",
  "onboarding.osEndSubtitle",
  "onboarding.osMissingMiniappDescription",
  "onboarding.learnAboutOs",
  "onboarding.unpairEvenSubtitle",
  "permissions.phoneMicrophoneDeniedMessage",
  "permissions.backgroundLocationPermissionRequiredMessage",
  "settings.leaveAppTitle",
  "settings.leaveAppMessage",
  "settings.notificationsSubtitle",
  "settings.notificationsDescription",
  "settings.nativeNotificationsIosContent",
  "miniappDevSettings.body",
  "feedback.experienceRating",
  "feedback.rateApp",
  "feedback.rateAppMessage",
] as const

/** Mentra names that stay inside a renamed string: products Easy2See did not make. */
const KEPT_MENTRA_NAMES = /^ (?:Live|Mach1|Miniapp SDK|Display|AI|Call)\b/

export function renameHostApp(text: string): string {
  return text
    .replace(/\b[Tt]he Mentra App\b/g, "Easy2See")
    .replace(/\bMentra App\b/g, "Easy2See")
    .replace(/\bMentraOS\b/g, "Easy2See")
    .replace(/\bMentra\b/g, (match, offset: number, whole: string) =>
      KEPT_MENTRA_NAMES.test(whole.slice(offset + match.length)) ? match : "Easy2See",
    )
}

/** A copy of `en` with the host app named Easy2See. `en` is left untouched. */
export function withEasy2SeeProductName(en: Translations): Translations {
  const renamed = JSON.parse(JSON.stringify(en)) as Translations
  for (const key of EASY2SEE_PRODUCT_NAME_KEYS) {
    const path = key.split(".")
    const leaf = path.pop()!
    const parent = path.reduce<Record<string, unknown>>(
      (node, segment) => node[segment] as Record<string, unknown>,
      renamed as unknown as Record<string, unknown>,
    )
    parent[leaf] = renameHostApp(parent[leaf] as string)
  }
  return renamed
}
