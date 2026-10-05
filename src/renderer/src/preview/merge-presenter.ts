import type { Size, View } from './geometry'
import { drawPixelGrid, pixelGridGlsl } from './pixel-grid'

const vertex = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0, 1); }`
const fragment = `#version 300 es
precision highp float;
uniform sampler2D pixels, mask;
uniform vec2 viewport, imageSize, pan;
uniform float scale, dpr;
uniform bool overlay;
out vec4 color;
vec4 sampleImage(sampler2D image, vec2 p) {
  if (scale >= 1.0) return texelFetch(image, clamp(ivec2(floor(p)), ivec2(0), ivec2(imageSize)-1), 0);
  return texture(image, p / imageSize);
}
void main() {
  vec2 css = vec2(gl_FragCoord.x / dpr, viewport.y - gl_FragCoord.y / dpr);
  vec2 source = (css - viewport * 0.5 - pan) / scale + imageSize * 0.5;
  if (any(lessThan(source, vec2(0))) || any(greaterThanEqual(source, imageSize))) { color = vec4(0); return; }
  color = sampleImage(pixels, source);
  if (overlay) {
    vec4 tint = sampleImage(mask, source);
    color = tint + color * (1.0 - tint.a);
  }
  color.rgb /= max(color.a, 0.000001);
  ${pixelGridGlsl}
}`

// Upload each native PNG once. Gestures change uniforms on a viewport-sized surface,
// including overlay composition and the grid, without scaling native-sized DOM layers.
export class MergePresenter {
  private gl: WebGL2RenderingContext | null = null
  private context: CanvasRenderingContext2D | null = null
  private program?: WebGLProgram
  private textures: WebGLTexture[] = []
  private uniforms = new Map<string, WebGLUniformLocation | null>()
  private disposed = false
  constructor(
    private canvas: HTMLCanvasElement,
    private images: HTMLImageElement[],
    fallback: boolean,
    private lost: () => void,
  ) {
    try {
      if (!fallback)
        this.gl = canvas.getContext('webgl2', {
          alpha: true,
          premultipliedAlpha: false,
          antialias: false,
          preserveDrawingBuffer: true,
        })
      const gl = this.gl
      if (gl) {
        const { naturalWidth: width, naturalHeight: height } = images[0]
        if (
          width > gl.getParameter(gl.MAX_TEXTURE_SIZE) ||
          height > gl.getParameter(gl.MAX_TEXTURE_SIZE) ||
          (width * height * images.length * 4 * 4) / 3 > 512 * 1024 ** 2
        )
          throw new Error('Merge textures exceed the GPU allocation budget.')
        this.program = gl.createProgram()!
        for (const [type, source] of [
          [gl.VERTEX_SHADER, vertex],
          [gl.FRAGMENT_SHADER, fragment],
        ] as const) {
          const shader = gl.createShader(type)!
          gl.shaderSource(shader, source)
          gl.compileShader(shader)
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const message = gl.getShaderInfoLog(shader)
            gl.deleteShader(shader)
            throw new Error(message ?? 'Merge shader failed.')
          }
          gl.attachShader(this.program, shader)
          gl.deleteShader(shader)
        }
        gl.linkProgram(this.program)
        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
          throw new Error('Merge program failed.')
        gl.useProgram(this.program)
        for (const name of [
          'viewport',
          'imageSize',
          'pan',
          'scale',
          'dpr',
          'overlay',
          'pixels',
          'mask',
        ])
          this.uniforms.set(name, gl.getUniformLocation(this.program, name))
        gl.uniform1i(this.location('pixels'), 0)
        gl.uniform1i(this.location('mask'), 1)
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
        // Premultiply before filtering so transparent overlay edges retain their tint.
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
        for (const image of images) {
          const texture = gl.createTexture()!
          this.textures.push(texture)
          gl.bindTexture(gl.TEXTURE_2D, texture)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image)
          gl.generateMipmap(gl.TEXTURE_2D)
          if (gl.getError() !== gl.NO_ERROR) throw new Error('Merge texture upload failed.')
        }
        canvas.addEventListener('webglcontextlost', this.contextLost)
        canvas.dataset.backend = 'webgl2'
      } else {
        this.context = canvas.getContext('2d', { colorSpace: 'srgb' })
        if (!this.context) throw new Error('Merge canvas unavailable.')
        canvas.dataset.backend = 'canvas2d'
      }
    } catch (error) {
      this.dispose()
      throw error
    }
  }
  private location(name: string) {
    return this.uniforms.get(name)!
  }
  private contextLost = (event: Event) => {
    event.preventDefault()
    this.lost()
  }
  draw(image: Size, viewport: Size, view: View, comparison: boolean, overlay: boolean) {
    if (this.disposed || !viewport.width || !viewport.height) return
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(viewport.width * dpr))
    const height = Math.max(1, Math.round(viewport.height * dpr))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    const gl = this.gl
    if (gl && this.program) {
      gl.viewport(0, 0, width, height)
      gl.useProgram(this.program)
      gl.uniform2f(this.location('viewport'), viewport.width, viewport.height)
      gl.uniform2f(this.location('imageSize'), image.width, image.height)
      gl.uniform2f(this.location('pan'), view.x, view.y)
      gl.uniform1f(this.location('scale'), view.scale)
      gl.uniform1f(this.location('dpr'), dpr)
      gl.uniform1i(this.location('overlay'), Number(overlay && !comparison))
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.textures[comparison ? 1 : 0])
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.textures[2])
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    } else if (this.context) {
      const context = this.context
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, viewport.width, viewport.height)
      context.imageSmoothingEnabled = view.scale < 1
      const left = (viewport.width - image.width * view.scale) / 2 + view.x
      const top = (viewport.height - image.height * view.scale) / 2 + view.y
      // Clip the source as well as the destination; magnified native images never
      // request enormous intermediate surfaces in the software fallback.
      const x = Math.max(0, -left / view.scale),
        y = Math.max(0, -top / view.scale)
      const sw = Math.min(image.width - x, (viewport.width - Math.max(0, left)) / view.scale)
      const sh = Math.min(image.height - y, (viewport.height - Math.max(0, top)) / view.scale)
      if (sw > 0 && sh > 0) {
        const draw = (source: HTMLImageElement) =>
          context.drawImage(
            source,
            x,
            y,
            sw,
            sh,
            Math.max(0, left),
            Math.max(0, top),
            sw * view.scale,
            sh * view.scale,
          )
        draw(this.images[comparison ? 1 : 0])
        if (overlay && !comparison) draw(this.images[2])
        drawPixelGrid(context, image, viewport, view)
      }
    }
    this.canvas.dataset.scale = String(view.scale)
    this.canvas.dataset.panX = String(view.x)
    this.canvas.dataset.panY = String(view.y)
    this.canvas.dataset.imageWidth = String(image.width)
    this.canvas.dataset.imageHeight = String(image.height)
    this.canvas.dataset.comparison = String(comparison)
    this.canvas.dataset.overlay = String(overlay && !comparison)
    this.canvas.dataset.grid = String(view.scale >= 8)
    this.canvas.dataset.frames = String(Number(this.canvas.dataset.frames ?? 0) + 1)
  }
  dispose() {
    this.disposed = true
    this.canvas.removeEventListener('webglcontextlost', this.contextLost)
    for (const texture of this.textures) this.gl?.deleteTexture(texture)
    if (this.program) this.gl?.deleteProgram(this.program)
    this.textures = []
    this.images = []
  }
}
