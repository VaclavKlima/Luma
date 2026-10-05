import type { Size, View } from './geometry'

// Shared by SDR photo and merge presentation; coordinates stay in native image pixels.
export const pixelGridGlsl = `
  float grid = clamp((scale - 4.0) / 12.0, 0.0, 1.0) * 0.22;
  vec2 edge = min(fract(source), 1.0-fract(source)) * scale;
  float coverage = clamp((0.5 + 0.5 / dpr - min(edge.x, edge.y)) * dpr, 0.0, 1.0);
  if (scale >= 8.0) color.rgb = mix(color.rgb, vec3(0.5), grid * coverage);
`

export function drawPixelGrid(
  context: CanvasRenderingContext2D,
  image: Size,
  viewport: Size,
  view: View,
) {
  if (view.scale < 8) return
  const left = (viewport.width - image.width * view.scale) / 2 + view.x
  const top = (viewport.height - image.height * view.scale) / 2 + view.y
  context.save()
  context.beginPath()
  context.rect(left, top, image.width * view.scale, image.height * view.scale)
  context.clip()
  context.strokeStyle = `rgba(128,128,128,${Math.min(1, (view.scale - 4) / 12) * 0.22})`
  context.lineWidth = 1
  context.beginPath()
  for (
    let x = left + Math.max(0, Math.ceil(-left / view.scale)) * view.scale;
    x <= Math.min(viewport.width, left + image.width * view.scale);
    x += view.scale
  ) {
    context.moveTo(x, 0)
    context.lineTo(x, viewport.height)
  }
  for (
    let y = top + Math.max(0, Math.ceil(-top / view.scale)) * view.scale;
    y <= Math.min(viewport.height, top + image.height * view.scale);
    y += view.scale
  ) {
    context.moveTo(0, y)
    context.lineTo(viewport.width, y)
  }
  context.stroke()
  context.restore()
}
