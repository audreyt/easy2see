import {ConfigPlugin, withEntitlementsPlist} from "expo/config-plugins"

/**
 * Easy2See-only entitlement stripper. expo-notifications' autolinked
 * app.plugin.js unconditionally writes `aps-environment` into the generated
 * .entitlements file; the org.audreyt.easy2see App ID under team P8PJ468WJ2
 * has no Push capability, so any provisioning profile would fail with
 * "profile doesn't include the aps-environment entitlement". Autolinked
 * package plugins run before the user `plugins` array, so registering this
 * last removes the key after expo-notifications writes it.
 *
 * Registered from app.config.ts only when EASY2SEE=1.
 */
const withEasy2SeeEntitlements: ConfigPlugin = (config) => {
  return withEntitlementsPlist(config, (config) => {
    delete config.modResults["aps-environment"]
    return config
  })
}

export default withEasy2SeeEntitlements
