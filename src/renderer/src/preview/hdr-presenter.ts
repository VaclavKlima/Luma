import { hdrPresentationMemory, HDR_PRESENTATION_BUDGET } from './hdr-memory'
import { reservePresentationBitmaps } from './frame-cache'
import {
  REC2020_TO_P3,
  REC2020_TO_SRGB,
  hdrAdjustmentMatrix,
  validateTarget,
  type DisplayTarget,
} from '../../../shared/hdr'
import { identityMatrix } from '../../../shared/white-balance'
import type { AdjustmentParameters, WorkingFrame } from '../../../shared/adjustments'
import type { Size, View } from './geometry'
import { hdrDevice } from './hdr-device'
import { uploadHdr } from './hdr-upload'
import { hdrShader, hdrMipShader } from './hdr-shader'

export class HdrPresenter {
  private abort = new AbortController()
  private device?: GPUDevice
  private context?: GPUCanvasContext
  private texture?: GPUTexture
  private uniform?: GPUBuffer
  private pipeline?: GPURenderPipeline
  private group?: GPUBindGroup
  private frame?: WorkingFrame
  private mode = 'after'
  private split = 0.5
  private levels = 1
  private ready = false
  private releaseBitmaps?: () => void
  private view?: { image: Size; viewport: Size; view: View; parameters: AdjustmentParameters }
  constructor(
    private canvas: HTMLCanvasElement,
    private target: DisplayTarget,
    private lost: (reason: string) => void,
    private loaded: () => void,
  ) {
    canvas.dataset.backend = 'webgpu-hdr'
  }
  setBitmap(bitmap: ImageBitmap) {
    void bitmap /* The SDR proof stays on the previous surface until replacement. */
  }
  setComparison(mode: string, split: number) {
    this.mode = mode
    this.split = split
  }
  setTarget(target: DisplayTarget) {
    validateTarget(target)
    if (target.generation === this.target.generation) return
    this.canvas.style.visibility = 'hidden'
    this.target = target
    try {
      if (this.ready && this.device && this.context) this.configure()
    } catch (error) {
      this.ready = false
      this.lost(`Canvas configuration failed: ${String(error)}`)
      return
    }
    if (this.view)
      this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
  }
  private configure() {
    this.context!.configure({
      device: this.device!,
      format: 'rgba16float',
      colorSpace: this.target.colorSpace,
      alphaMode: 'opaque',
      toneMapping: { mode: this.target.mode === 'hdr' ? 'extended' : 'standard' },
    })
    const config = this.context!.getConfiguration()
    if (
      config?.format !== 'rgba16float' ||
      config.colorSpace !== this.target.colorSpace ||
      config.toneMapping?.mode !== (this.target.mode === 'hdr' ? 'extended' : 'standard')
    )
      throw new Error('HDR canvas configuration unavailable.')
  }
  setWorking(frame: WorkingFrame) {
    if (!frame.hdr || this.frame === frame) return
    this.frame = frame
    this.ready = false
    this.canvas.style.visibility = 'hidden'
    void this.load(frame).catch((error) => {
      console.warn('HDR presentation initialization:', error)
      if (!this.abort.signal.aborted) this.lost(String(error))
    })
  }
  private async load(frame: WorkingFrame) {
    const started = performance.now()
    const device = await hdrDevice()
    if (this.abort.signal.aborted) return
    this.releaseBitmaps = reservePresentationBitmaps(256 * 1024 ** 2)
    this.device = device
    this.context = this.canvas.getContext('webgpu') ?? undefined
    if (!this.context) throw new Error('HDR canvas unavailable.')
    this.levels = Math.floor(Math.log2(Math.max(frame.width, frame.height))) + 1
    if (hdrPresentationMemory(frame.width, frame.height).total > HDR_PRESENTATION_BUDGET)
      throw new Error('This HDR frame exceeds the renderer memory limit.')
    if (
      frame.width > device.limits.maxTextureDimension2D ||
      frame.height > device.limits.maxTextureDimension2D
    )
      throw new Error('This HDR frame exceeds the adapter texture dimension limit.')
    device.addEventListener(
      'uncapturederror',
      (event) => {
        console.warn('HDR GPU validation:', event.error.message)
        if (!this.abort.signal.aborted)
          this.lost(`${event.error.constructor.name}: ${event.error.message}`)
      },
      { signal: this.abort.signal },
    )
    {
      // The previous surface may be large. Allocate it only after upload strips are released.
      this.context.unconfigure()
      this.texture = device.createTexture({
        size: [frame.width, frame.height],
        format: 'rgba32float',
        mipLevelCount: this.levels,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.STORAGE_BINDING,
      })
      const loading = performance.now()
      const timings: Record<string, number> = {
        readMs: 0,
        hashMs: 0,
        validateMs: 0,
        writeTextureMs: 0,
      }
      let submitted = 0
      for await (const strip of uploadHdr(frame.hdr!, this.abort.signal)) {
        for (const [key, value] of Object.entries(strip.timings)) timings[key] += value
        const writing = performance.now()
        device.queue.writeTexture(
          { texture: this.texture, origin: [0, strip.row] },
          strip.data,
          { bytesPerRow: frame.width * 16 },
          [frame.width, strip.data.length / (frame.width * 4)],
        )
        timings.writeTextureMs += performance.now() - writing
        if (++submitted % 3 === 0) await device.queue.onSubmittedWorkDone()
      }
      timings.streamMs = performance.now() - loading
      const pipelines = performance.now()
      const mipLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            texture: { sampleType: 'unfilterable-float' },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.COMPUTE,
            storageTexture: { access: 'write-only', format: 'rgba32float' },
          },
        ],
      })
      const mip = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [mipLayout] }),
        compute: { module: device.createShaderModule({ code: hdrMipShader }), entryPoint: 'down' },
      })
      if (this.abort.signal.aborted) return
      const encoder = device.createCommandEncoder()
      for (let level = 1; level < this.levels; level++) {
        const group = device.createBindGroup({
          layout: mipLayout,
          entries: [
            {
              binding: 0,
              resource: this.texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
            },
            {
              binding: 1,
              resource: this.texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
            },
          ],
        })
        const pass = encoder.beginComputePass()
        pass.setPipeline(mip)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(
          Math.ceil(Math.max(1, frame.width >> level) / 8),
          Math.ceil(Math.max(1, frame.height >> level) / 8),
        )
        pass.end()
      }
      device.queue.submit([encoder.finish()])
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: 'unfilterable-float' },
          },
        ],
      })
      const module = device.createShaderModule({ code: hdrShader })
      this.pipeline = await device.createRenderPipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      })
      if (this.abort.signal.aborted) return
      this.uniform = device.createBuffer({
        size: 176,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      this.group = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: this.texture.createView() },
        ],
      })
      await device.queue.onSubmittedWorkDone()
      timings.pipelinesMs = performance.now() - pipelines
      this.canvas.dataset.loadTimings = JSON.stringify(timings)
    }
    if (this.abort.signal.aborted) return
    this.configure()
    this.canvas.dataset.uploadMs = String(performance.now() - started)
    this.ready = true
    this.loaded()
    void device.lost.then(() => {
      if (!this.abort.signal.aborted) {
        this.canvas.style.visibility = 'hidden'
        this.lost('Presentation device lost.')
      }
    })
    if (this.view)
      this.draw(this.view.image, this.view.viewport, this.view.view, this.view.parameters)
  }
  draw(image: Size, viewport: Size, view: View, parameters: AdjustmentParameters) {
    this.view = { image, viewport, view, parameters }
    if (
      !this.ready ||
      !this.device ||
      !this.context ||
      !this.frame ||
      !viewport.width ||
      !viewport.height
    )
      return
    const dpr = window.devicePixelRatio || 1,
      width = Math.max(1, Math.round(viewport.width * dpr)),
      height = Math.max(1, Math.round(viewport.height * dpr))
    const memory = hdrPresentationMemory(this.frame.width, this.frame.height, width, height)
    this.canvas.dataset.allocatedBytes = String(memory.total)
    if (memory.total > HDR_PRESENTATION_BUDGET) {
      this.canvas.style.visibility = 'hidden'
      this.lost('Presentation memory limit exceeded by the source texture and canvas allocations.')
      return
    }
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    const p = new Float32Array(44)
    p.set([
      viewport.width,
      viewport.height,
      image.width,
      image.height,
      view.x,
      view.y,
      view.scale,
      dpr,
      parameters.exposureEv,
      parameters.contrast,
      parameters.highlights,
      parameters.shadows,
      parameters.whites,
      parameters.blacks,
      this.target.peak,
      0,
      this.mode === 'before' ? 1 : this.mode === 'split' ? 2 : 0,
      this.split,
      this.levels,
      0,
    ])
    const wb = hdrAdjustmentMatrix(parameters, this.frame.hdr?.whiteBalance)
    p[19] = Number(!!wb)
    const matrix = this.target.colorSpace === 'display-p3' ? REC2020_TO_P3 : REC2020_TO_SRGB
    for (let row = 0; row < 3; row++) {
      p.set((wb ?? identityMatrix).slice(row * 3, row * 3 + 3), 20 + row * 4)
      p.set(matrix.slice(row * 3, row * 3 + 3), 32 + row * 4)
    }
    try {
      this.device.queue.writeBuffer(this.uniform!, 0, p)
      const encoder = this.device.createCommandEncoder(),
        pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: this.context.getCurrentTexture().createView(),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: [0, 0, 0, 1],
            },
          ],
        })
      pass.setPipeline(this.pipeline!)
      pass.setBindGroup(0, this.group!)
      pass.draw(3)
      pass.end()
      this.device.queue.submit([encoder.finish()])
    } catch (error) {
      this.ready = false
      this.canvas.style.visibility = 'hidden'
      this.lost(`GPU presentation failed: ${String(error)}`)
      return
    }
    this.canvas.style.visibility = 'visible'
    Object.assign(this.canvas.dataset, {
      editing: 'ready',
      exposure: String(parameters.exposureEv),
      contrast: String(parameters.contrast),
      highlights: String(parameters.highlights),
      shadows: String(parameters.shadows),
      whites: String(parameters.whites),
      blacks: String(parameters.blacks),
      whiteBalance: JSON.stringify(parameters.whiteBalance),
      comparison: this.mode,
    })
  }
  dispose() {
    this.abort.abort()
    this.releaseBitmaps?.()
    this.ready = false
    this.texture?.destroy()
    this.uniform?.destroy()
    this.context?.unconfigure()
  }
}
