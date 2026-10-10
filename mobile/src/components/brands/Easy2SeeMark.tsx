import Svg, {Path} from "react-native-svg"

import {useAppTheme} from "@/contexts/ThemeContext"

import {EASY2SEE_MARK_PATH, EASY2SEE_MARK_VIEWBOX, EASY2SEE_PEACH, EASY2SEE_PLUM} from "./easy2seeMarkGeometry"

interface Easy2SeeMarkProps {
  width?: number
  height?: number
  colorOverride?: string
}

/**
 * The Easy2See mark: glasses whose lenses carry caption lines. Fits inside
 * `width` × `height` keeping its aspect ratio. Plum on light surfaces, peach on
 * dark ones, as Easy2Say's controls do.
 */
export function Easy2SeeMark({width = 33, height = 16, colorOverride}: Easy2SeeMarkProps) {
  const {theme} = useAppTheme()
  const color = colorOverride || (theme.isDark ? EASY2SEE_PEACH : EASY2SEE_PLUM)
  return (
    <Svg width={width} height={height} viewBox={EASY2SEE_MARK_VIEWBOX} accessibilityLabel="Easy2See">
      <Path d={EASY2SEE_MARK_PATH} fill={color} fillRule="nonzero" />
    </Svg>
  )
}
