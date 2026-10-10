import {Easy2SeeMark} from "@/components/brands/Easy2SeeMark"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {isEasy2SeeBuild} from "@/services/deployment/officialManifest"

interface AppMarkProps {
  width?: number
  height?: number
  colorOverride?: string
}

/**
 * The host app's own mark, for app chrome (splash, screen headers). The Easy2See
 * build shows its mark; every other build shows Mentra's. Surfaces that refer to
 * Mentra itself (MentraOS Legacy, Mentra glasses) use MentraLogoStandalone or
 * MentraLogo directly.
 */
export function AppMark(props: AppMarkProps) {
  return isEasy2SeeBuild() ? <Easy2SeeMark {...props} /> : <MentraLogoStandalone {...props} />
}
