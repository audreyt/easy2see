import {ConfigPlugin, withXcodeProject} from "expo/config-plugins"

/**
 * Easy2See-only manual signing, scoped to the application target.
 *
 * The release is archived locally on a Mac that has no Apple Development
 * certificate for team P8PJ468WJ2 and no Xcode Apple ID session, so
 * automatic signing and -allowProvisioningUpdates are unavailable. The app
 * target must sign with "Apple Distribution: Audrey Tang (P8PJ468WJ2)" and
 * the "Easy2See App Store" profile.
 *
 * These settings CANNOT be passed as xcodebuild command-line build settings:
 * command-line values apply to every target in the workspace, including the
 * Swift Package targets (MapboxNavigation_MapboxNavigationCore,
 * MapboxMaps_MapboxMaps), which then fail with "does not support
 * provisioning profiles". Writing them into the Easy2See target's Release
 * build configuration keeps SPM/Pod targets untouched.
 *
 * Registered from app.config.ts only when EASY2SEE=1 so the settings survive
 * `expo prebuild` regeneration of ios/.
 */
const withEasy2SeeSigning: ConfigPlugin = (config) => {
  return withXcodeProject(config, (config) => {
    const project = config.modResults
    const section = project.pbxXCBuildConfigurationSection()
    for (const key of Object.keys(section)) {
      const cfg = section[key]
      if (!cfg || cfg.isa !== "XCBuildConfiguration") continue
      const buildSettings = cfg.buildSettings || {}
      const bundleId = String(buildSettings.PRODUCT_BUNDLE_IDENTIFIER ?? "").replace(/"/g, "")
      if (cfg.name === "Release" && bundleId === "org.audreyt.easy2see") {
        // Values containing spaces must arrive pre-quoted: the xcode pbxproj
        // writer does not quote them itself, and an unquoted
        // `CODE_SIGN_IDENTITY = Apple Distribution;` makes the project file
        // unparseable ("not a valid property list").
        buildSettings.CODE_SIGN_STYLE = "Manual"
        buildSettings.CODE_SIGN_IDENTITY = '"Apple Distribution"'
        buildSettings.PROVISIONING_PROFILE_SPECIFIER = '"Easy2See App Store"'
      }
    }
    return config
  })
}

export default withEasy2SeeSigning
