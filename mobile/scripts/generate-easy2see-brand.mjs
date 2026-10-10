#!/usr/bin/env node
// Generates every Easy2See brand asset from one geometry:
//   assets/easy2see/easy2see-mark.svg          mark source (peach)
//   assets/easy2see/icon.png                   1024 app icon, opaque (App Store rejects alpha)
//   assets/easy2see/adaptive-foreground.png    Android adaptive foreground, mark in the 66% safe zone
//   assets/easy2see/splash-light.png           native splash mark for light appearance (plum)
//   assets/easy2see/splash-dark.png            native splash mark for dark appearance (peach)
//   src/components/brands/easy2seeMarkGeometry.ts  the same path for the in-app SVG mark
//
// The mark is Easy2Say's sibling: Easy2Say's speech bubble carries two columns of
// caption slots; Easy2See's two lenses carry them instead. Same plum ground, same
// peach. It is a single path: lenses, hinges and bridge wind clockwise and union
// under the nonzero rule; caption slots wind counter-clockwise and cut through, so
// the mark tints cleanly on any background.
//
// Requires rsvg-convert and ImageMagick (`brew install librsvg imagemagick`).
// Run from mobile/: node scripts/generate-easy2see-brand.mjs

import {execFileSync} from "node:child_process"
import {mkdirSync, writeFileSync} from "node:fs"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const assetDir = join(mobileRoot, "assets/easy2see")
const geometryFile = join(mobileRoot, "src/components/brands/easy2seeMarkGeometry.ts")

// Easy2Say brand palette (easy2say Sources/V2SApp/UI/Shared/QuickSettingsControls.swift, EasyBrand).
const PLUM = "#4d2a33"
const PEACH = "#f4a499"

// Design units.
const LENS = {width: 352, height: 300, radius: 116}
const GAP = 100 // between the lenses; the bridge spans it
const HINGE = {x: -44, y: 34, width: 96, height: 58}
const BRIDGE = {inset: 50, y: 120, rise: 104, thickness: 58}
const SLOT = {height: 72, rowPitch: 118, inset: 62, shortRowTrim: 64}

const rightLensX = LENS.width + GAP
const VIEWBOX = {x: HINGE.x, y: 0, width: 2 * LENS.width + GAP - 2 * HINGE.x, height: LENS.height}

const n = (value) => Number(value.toFixed(2)).toString()

/** Rounded rectangle, clockwise on screen (y down) — or counter-clockwise to cut a hole. */
function roundedRect(x, y, w, h, r, {clockwise = true} = {}) {
  const sweep = clockwise ? 1 : 0
  const arc = (ex, ey) => `A${n(r)} ${n(r)} 0 0 ${sweep} ${n(ex)} ${n(ey)}`
  if (clockwise) {
    return [
      `M${n(x + r)} ${n(y)}`,
      `H${n(x + w - r)}`,
      arc(x + w, y + r),
      `V${n(y + h - r)}`,
      arc(x + w - r, y + h),
      `H${n(x + r)}`,
      arc(x, y + h - r),
      `V${n(y + r)}`,
      arc(x + r, y),
      "Z",
    ].join("")
  }
  return [
    `M${n(x + r)} ${n(y)}`,
    arc(x, y + r),
    `V${n(y + h - r)}`,
    arc(x + r, y + h),
    `H${n(x + w - r)}`,
    arc(x + w, y + h - r),
    `V${n(y + r)}`,
    arc(x + w - r, y),
    "Z",
  ].join("")
}

function markPath() {
  const parts = []
  // Temple hinges, tucked under the lenses' upper outer corners.
  parts.push(roundedRect(HINGE.x, HINGE.y, HINGE.width, HINGE.height, HINGE.height / 2))
  parts.push(
    roundedRect(
      rightLensX + LENS.width - (HINGE.width + HINGE.x),
      HINGE.y,
      HINGE.width,
      HINGE.height,
      HINGE.height / 2,
    ),
  )
  // Lenses.
  parts.push(roundedRect(0, 0, LENS.width, LENS.height, LENS.radius))
  parts.push(roundedRect(rightLensX, 0, LENS.width, LENS.height, LENS.radius))
  // Bridge: an arched band whose ends sit inside the lens frames, clear of the slots.
  const x0 = LENS.width - BRIDGE.inset
  const x1 = rightLensX + BRIDGE.inset
  const mid = (x0 + x1) / 2
  const half = BRIDGE.thickness / 2
  const peak = BRIDGE.y - BRIDGE.rise
  parts.push(
    `M${n(x0)} ${n(BRIDGE.y - half)}Q${n(mid)} ${n(peak - half)} ${n(x1)} ${n(BRIDGE.y - half)}` +
      `L${n(x1)} ${n(BRIDGE.y + half)}Q${n(mid)} ${n(peak + half)} ${n(x0)} ${n(BRIDGE.y + half)}Z`,
  )
  // Caption slots: two lines per lens. Inner ends stay pinned toward the bridge; the
  // lower line is shorter on its outer end, like the last line of a caption.
  const width = LENS.width - 2 * SLOT.inset
  const top = (LENS.height - (SLOT.rowPitch + SLOT.height)) / 2
  for (let row = 0; row < 2; row++) {
    const y = top + row * SLOT.rowPitch
    const trim = row === 1 ? SLOT.shortRowTrim : 0
    const hole = {clockwise: false}
    parts.push(roundedRect(SLOT.inset + trim, y, width - trim, SLOT.height, SLOT.height / 2, hole))
    parts.push(roundedRect(rightLensX + SLOT.inset, y, width - trim, SLOT.height, SLOT.height / 2, hole))
  }
  return parts.join("")
}

const PATH = markPath()
const viewBox = `${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.width} ${VIEWBOX.height}`

/** SVG of `size`, optional solid background, mark `widthFraction` of the canvas wide. */
function canvasSvg({width, height, background, color, widthFraction, lift = 0}) {
  const scale = (width * widthFraction) / VIEWBOX.width
  const ox = (width - VIEWBOX.width * scale) / 2 - VIEWBOX.x * scale
  const oy = (height - VIEWBOX.height * scale) / 2 - VIEWBOX.y * scale - height * lift
  const ground = background ? `<rect width="${width}" height="${height}" fill="${background}"/>` : ""
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    ground +
    `<path transform="translate(${n(ox)} ${n(oy)}) scale(${scale.toFixed(
      6,
    )})" fill="${color}" fill-rule="nonzero" d="${PATH}"/>` +
    `</svg>`
  )
}

function render(svg, output, {opaque = false} = {}) {
  const svgFile = `${output}.svg`
  writeFileSync(svgFile, svg)
  execFileSync("rsvg-convert", [svgFile, "-o", output])
  execFileSync("rm", [svgFile])
  if (opaque) {
    execFileSync("magick", [output, "-background", PLUM, "-alpha", "remove", "-alpha", "off", `PNG24:${output}`])
  }
}

mkdirSync(assetDir, {recursive: true})

writeFileSync(
  join(assetDir, "easy2see-mark.svg"),
  `<!-- Generated by mobile/scripts/generate-easy2see-brand.mjs. Edit the script, not this file. -->\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><path fill="${PEACH}" fill-rule="nonzero" d="${PATH}"/></svg>\n`,
)
render(
  canvasSvg({width: 1024, height: 1024, background: PLUM, color: PEACH, widthFraction: 0.84, lift: 0.02}),
  join(assetDir, "icon.png"),
  {opaque: true},
)
render(
  canvasSvg({width: 1024, height: 1024, color: PEACH, widthFraction: 0.6}),
  join(assetDir, "adaptive-foreground.png"),
)
const splash = {width: 600, height: Math.ceil((600 * VIEWBOX.height) / VIEWBOX.width), widthFraction: 1}
render(canvasSvg({...splash, color: PLUM}), join(assetDir, "splash-light.png"))
render(canvasSvg({...splash, color: PEACH}), join(assetDir, "splash-dark.png"))

writeFileSync(
  geometryFile,
  `// Generated by mobile/scripts/generate-easy2see-brand.mjs. Edit the script, not this file.

/** Easy2Say brand palette: plum ground, peach mark. */
export const EASY2SEE_PLUM = "${PLUM}"
export const EASY2SEE_PEACH = "${PEACH}"

export const EASY2SEE_MARK_VIEWBOX = "${viewBox}"
export const EASY2SEE_MARK_ASPECT_RATIO = ${n(VIEWBOX.width / VIEWBOX.height)}

/** Glasses whose two lenses carry caption lines. Fill with the nonzero rule. */
export const EASY2SEE_MARK_PATH =
  "${PATH}"
`,
)

console.log(`wrote ${assetDir} and ${geometryFile}`)
