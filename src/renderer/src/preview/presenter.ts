import { reservePresentationBitmaps, retainPresentationBitmap } from './frame-cache'
import { whiteBalanceMatrix, identityMatrix } from '../../../shared/white-balance'
type ComparisonMode = 'after' | 'before' | 'split'
import {
  exposureModule,
  contrastModule,
  highlightsModule,
  shadowsModule,
  whitesModule,
  blacksModule,
  neutralAdjustments,
  sameAdjustments,
  type AdjustmentParameters,
  type WorkingFrame,
} from '../../../shared/adjustments'
import type { Size, View } from './geometry'
import { drawPixelGrid, pixelGridGlsl } from './pixel-grid'

const vertex = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0, 1); }`
const fragment = `#version 300 es
precision highp float;
${exposureModule.glsl}
${contrastModule.glsl}
${highlightsModule.glsl}
${shadowsModule.glsl}
${whitesModule.glsl}
${blacksModule.glsl}
uniform sampler2D pixels;
uniform vec2 viewport, imageSize, pan;
uniform float scale, dpr, exposureEv, contrast, highlights, shadows, whites, blacks;
uniform bool working, quantize, customWb;
uniform mat3 whiteBalance;
uniform int comparison;
uniform float split;
uniform vec3 transform;
out vec4 color;
vec4 sampleImage(vec2 p) {
  if (scale >= 1.0) return texelFetch(pixels, clamp(ivec2(floor(p)), ivec2(0), ivec2(imageSize)-1), 0);
  return texture(pixels, p / imageSize);
}
void main() {
  vec2 css = vec2(gl_FragCoord.x / dpr, viewport.y - gl_FragCoord.y / dpr);
  vec2 source = (css - viewport * 0.5 - pan) / scale + imageSize * 0.5;
  if (any(lessThan(source, vec2(0))) || any(greaterThanEqual(source, imageSize))) { color = vec4(0); return; }
  color = sampleImage(source);
  if (working) {
    bool before = comparison == 1 || (comparison == 2 && css.x < viewport.x * split);
    vec3 inputRgb = (!before && customWb) ? whiteBalance * color.rgb : color.rgb;
    vec3 rgb = before ? max(vec3(0), color.rgb) : max(vec3(0), applyHighlights(applyContrast(applyExposure(inputRgb, exposureEv), contrast, transform.x), highlights, transform.x));
    if (!before) {
      rgb = applyShadows(rgb, shadows, transform.x);
      rgb = applyWhites(rgb, whites, transform.x);
      rgb = applyBlacks(rgb, blacks, transform.x);
    }
    if (quantize) rgb = floor(rgb * 65535.0) / 65535.0;
    rgb = clamp(rgb / transform.x, vec3(0), vec3(1));
    rgb = mix(pow(rgb, vec3(1.0/2.4)) * (1.0+transform.z) - transform.z, rgb * 12.92, lessThan(rgb, vec3(transform.y)));
    color.rgb = quantize ? min(vec3(255), floor(rgb * 65536.0 / 256.0)) / 255.0 : floor(rgb * 255.0 + 0.5) / 255.0;
  }
  ${pixelGridGlsl}
}`

export class PreviewPresenter {
  private gl: WebGL2RenderingContext | null = null
  private context: CanvasRenderingContext2D | null = null
  private program?: WebGLProgram
  private texture?: WebGLTexture
  private bitmap?: ImageBitmap
  private beforeBitmap?: ImageBitmap
  private releaseBitmapBudget?: () => void
  private releaseBorrowedBitmap?: () => void
  private comparison: { mode: ComparisonMode; split: number } = { mode: 'after', split: 0.5 }
  private working?: WorkingFrame
  private fallback?: Worker
  private fallbackBusy = false
  private fallbackParameters?: AdjustmentParameters
  private requestedParameters: AdjustmentParameters = neutralAdjustments
  private view?: { image: Size; viewport: Size; view: View; parameters: AdjustmentParameters }
  private disposed = false
  constructor(
    private canvas: HTMLCanvasElement,
    forceFallback: boolean,
    private lost: () => void,
  ) {
    if (!forceFallback)
      this.gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: false,
        antialias: false,
        preserveDrawingBuffer: true,
      })
    const gl = this.gl
    if (gl) {
      if (
        !gl.getExtension('OES_texture_float_linear') ||
        !gl.getExtension('EXT_color_buffer_float')
      ) {
        this.dispose()
        throw new Error('Floating-point filtering unavailable.')
      }
      const program = gl.createProgram()!
      for (const [type, source] of [
        [gl.VERTEX_SHADER, vertex],
        [gl.FRAGMENT_SHADER, fragment],
      ] as const) {
        const shader = gl.createShader(type)!
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) ?? 'Preview shader failed.')
        gl.attachShader(program, shader)
        gl.deleteShader(shader)
      }
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error('Preview program failed.')
      this.program = program
      this.texture = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, this.texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      canvas.addEventListener('webglcontextlost', this.contextLost)
      canvas.dataset.backend = 'webgl2'
    } else {
      this.context = canvas.getContext('2d', { colorSpace: 'srgb' })
      if (!this.context) throw new Error('Preview canvas unavailable.')
      canvas.dataset.backend = 'canvas2d'
    }
  }
  private contextLost = (event: Event) => {
    event.preventDefault()
    this.lost()
  }
  setBitmap(bitmap: ImageBitmap) {
    if (this.working && (this.gl || this.fallbackParameters !== undefined)) return
    if (this.bitmap !== bitmap) {
      const release = retainPresentationBitmap(bitmap)
      this.releaseBorrowedBitmap?.()
      this.releaseBorrowedBitmap = release
    }
    this.bitmap = bitmap
    const gl = this.gl
    if (gl) {
      this.checkSize(bitmap.width, bitmap.height, (4 * 4) / 3)
      gl.bindTexture(gl.TEXTURE_2D, this.texture!)
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
      gl.generateMipmap(gl.TEXTURE_2D)
    }
  }
  private checkSize(width: number, height: number, bytes: number) {
    const gl = this.gl!
    if (
      width > gl.getParameter(gl.MAX_TEXTURE_SIZE) ||
      height > gl.getParameter(gl.MAX_TEXTURE_SIZE) ||
      width * height * bytes + this.canvas.width * this.canvas.height * 8 > 512 * 1024 ** 2
    )
      throw new Error('Preview exceeds GPU allocation budget.')
  }
  setWorking(frame: WorkingFrame) {
    if (this.working === frame) return
    this.working = frame
    const gl = this.gl
    if (gl) {
      this.checkSize(frame.width, frame.height, (16 * 4) / 3)
      gl.bindTexture(gl.TEXTURE_2D, this.texture!)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        frame.width,
        frame.height,
        0,
        gl.RGBA,
        gl.FLOAT,
        frame.data,
      )
      gl.generateMipmap(gl.TEXTURE_2D)
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Preview texture upload failed.')
    } else {
      this.releaseBitmapBudget = reservePresentationBitmaps(frame.width * frame.height * 8)
      this.fallback = new Worker(new URL('./presentation-worker.ts', import.meta.url), {
        type: 'module',
      })
      this.fallback.postMessage({ frame })
      this.fallback.onmessage = (event) => {
        if (this.disposed) return
        this.fallbackBusy = false
        const { parameters, bitmap, before } = event.data as {
          before?: ImageBitmap
          parameters: AdjustmentParameters
          bitmap: ImageBitmap
        }
        if (before) {
          this.beforeBitmap?.close()
          this.beforeBitmap = before
        }
        if (sameAdjustments(parameters, this.requestedParameters)) {
          if (this.fallbackParameters !== undefined) this.bitmap?.close()
          this.releaseBorrowedBitmap?.()
          this.releaseBorrowedBitmap = undefined
          this.bitmap = bitmap
          this.fallbackParameters = parameters
          if (this.view) this.draw(this.view.image, this.view.viewport, this.view.view, parameters)
        } else bitmap.close()
        this.requestFallback()
      }
    }
    this.canvas.dataset.editing = 'ready'
  }
  private requestFallback() {
    if (
      !this.fallback ||
      this.fallbackBusy ||
      sameAdjustments(this.fallbackParameters, this.requestedParameters)
    )
      return
    this.fallbackBusy = true
    this.fallback.postMessage({ parameters: this.requestedParameters })
  }
  setComparison(mode: ComparisonMode, split: number) {
    this.comparison = { mode, split }
  }
  draw(image: Size, viewport: Size, view: View, parameters: AdjustmentParameters) {
    if (this.disposed || !viewport.width || !viewport.height) return
    this.view = { image, viewport, view, parameters }
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(viewport.width * dpr)),
      height = Math.max(1, Math.round(viewport.height * dpr))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    const gl = this.gl
    if (gl && this.program) {
      gl.viewport(0, 0, width, height)
      gl.useProgram(this.program)
      const location = (name: string) => gl.getUniformLocation(this.program!, name)
      gl.uniform2f(location('viewport'), viewport.width, viewport.height)
      gl.uniform2f(location('imageSize'), image.width, image.height)
      gl.uniform2f(location('pan'), view.x, view.y)
      gl.uniform1f(location('scale'), view.scale)
      gl.uniform1f(location('dpr'), dpr)
      gl.uniform1f(location('exposureEv'), parameters.exposureEv)
      gl.uniform1f(location('contrast'), parameters.contrast)
      gl.uniform1f(location('highlights'), parameters.highlights)
      gl.uniform1f(location('shadows'), parameters.shadows)
      gl.uniform1f(location('whites'), parameters.whites)
      gl.uniform1f(location('blacks'), parameters.blacks)
      const wb = whiteBalanceMatrix(parameters.whiteBalance, this.working?.transform.whiteBalance)
      const matrix = wb ?? identityMatrix
      gl.uniformMatrix3fv(
        location('whiteBalance'),
        false,
        [0, 3, 6, 1, 4, 7, 2, 5, 8].map((i) => matrix[i]),
      )
      gl.uniform1i(location('customWb'), Number(!!wb))
      gl.uniform1i(
        location('comparison'),
        this.comparison.mode === 'before' ? 1 : this.comparison.mode === 'split' ? 2 : 0,
      )
      gl.uniform1f(location('split'), this.comparison.split)

      gl.uniform1i(location('working'), Number(!!this.working))
      if (this.working) {
        const t = this.working.transform
        gl.uniform3f(location('transform'), t.white, t.threshold, t.offset)
        gl.uniform1i(location('quantize'), Number(t.quantize))
      }
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MAG_FILTER,
        view.scale < 1 ? gl.LINEAR : gl.NEAREST,
      )
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    } else if (this.context && this.bitmap) {
      this.requestedParameters = { ...parameters }
      this.requestFallback()
      const context = this.context
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, viewport.width, viewport.height)
      context.imageSmoothingEnabled = view.scale < 1
      const left = (viewport.width - image.width * view.scale) / 2 + view.x
      const top = (viewport.height - image.height * view.scale) / 2 + view.y
      if (this.comparison.mode !== 'after' && !this.beforeBitmap) return
      context.drawImage(
        this.comparison.mode === 'before' && this.beforeBitmap ? this.beforeBitmap : this.bitmap,
        left,
        top,
        image.width * view.scale,
        image.height * view.scale,
      )
      if (this.comparison.mode === 'split' && this.beforeBitmap) {
        context.save()
        context.beginPath()
        context.rect(0, 0, viewport.width * this.comparison.split, viewport.height)
        context.clip()
        context.clearRect(0, 0, viewport.width, viewport.height)
        context.drawImage(
          this.beforeBitmap,
          left,
          top,
          image.width * view.scale,
          image.height * view.scale,
        )
        context.restore()
      }
      drawPixelGrid(context, image, viewport, view)
    }
    this.canvas.dataset.whiteBalance = JSON.stringify(
      parameters.whiteBalance ?? { mode: 'as-shot' },
    )
    this.canvas.dataset.comparison = this.comparison.mode
    this.canvas.dataset.highlights = String(parameters.highlights)
    this.canvas.dataset.shadows = String(parameters.shadows)
    this.canvas.dataset.whites = String(parameters.whites)
    this.canvas.dataset.blacks = String(parameters.blacks)

    this.canvas.dataset.contrast = String(parameters.contrast)
    this.canvas.dataset.exposure = String(parameters.exposureEv)
  }
  dispose() {
    this.disposed = true
    this.canvas.removeEventListener('webglcontextlost', this.contextLost)
    this.fallback?.terminate()
    this.beforeBitmap?.close()
    this.releaseBitmapBudget?.()
    this.releaseBorrowedBitmap?.()
    if (this.fallbackParameters !== undefined) this.bitmap?.close()
    if (this.texture) this.gl?.deleteTexture(this.texture)
    if (this.program) this.gl?.deleteProgram(this.program)
    this.working = undefined
  }
}
