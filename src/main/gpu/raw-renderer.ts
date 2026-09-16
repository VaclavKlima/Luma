// AHD Lab conversion adapted from LibRaw 0.22.1 under CDDL-1.0. See third_party/libraw.
import { lensShader } from './lens-shader'
import type { CorrectionPlan } from '../processing/lens-correction'
import { ahdShader } from './ahd-shader'
import { displayCurve, type RawSource } from './raw-source'
import { frameByteLength } from '../../shared/preview-frame'

export const GPU_RENDER_ID = 'bayer-ahd-srgb-gpu-2'
export interface GpuFrame {
  data: Buffer
  width: number
  height: number
  adapter: string
  timings: Record<string, number>
}

/** Native Dawn only lives in the bundled Node worker, never Electron's address space. */
export class RawGpuRenderer {
  private gpu?: GPU
  private device?: GPUDevice
  private unavailable?: string
  private pipelines = new Map<string, GPUComputePipeline>()
  private linear?: GPUTexture
  private cameraSource?: RawSource
  private adapter = ''

  get failure(): string | undefined {
    return this.unavailable
  }

  private async initialize(): Promise<GPUDevice> {
    if (this.unavailable) throw new Error(this.unavailable)
    if (this.device) return this.device
    const { create, globals } = await import('webgpu')
    Object.assign(globalThis, globals)
    this.gpu = create([])
    const adapter = await this.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (
      !adapter ||
      adapter.info.isFallbackAdapter ||
      /llvmpipe|swiftshader|software/i.test(adapter.info.device)
    )
      throw new Error('No hardware GPU adapter is available.')
    this.adapter = `${adapter.info.vendor} ${adapter.info.device} (${adapter.info.description})`
    const device = await adapter.requestDevice({
      requiredLimits: { maxBufferSize: Math.min(1024 ** 3, adapter.limits.maxBufferSize) },
    })
    this.device = device
    void device.lost.then((info) => {
      if (this.device !== device) return
      this.unavailable = `GPU device lost: ${info.message}`
      this.close()
    })
    const module = device.createShaderModule({ code: ahdShader, label: 'Luma AHD' })
    const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')
    if (errors.length) throw new Error(errors.map((m) => `${m.lineNum}: ${m.message}`).join('\n'))
    for (const name of [
      'interpolateGreen',
      'interpolateColor',
      'buildHomogeneity',
      'combine',
      'display',
    ])
      this.pipelines.set(
        name,
        await device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: name },
          label: name,
        }),
      )
    const lensModule = device.createShaderModule({
      code: lensShader,
      label: 'Luma lens correction',
    })
    this.pipelines.set(
      'correct',
      await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: lensModule, entryPoint: 'correct' },
      }),
    )
    return device
  }

  releaseFrame(): void {
    this.linear?.destroy()
    this.linear = undefined
    this.cameraSource = undefined
  }
  close(): void {
    this.releaseFrame()
    const device = this.device
    this.device = undefined
    this.pipelines.clear()
    device?.destroy()
    this.gpu = undefined
  }

  async render(source: RawSource, correction?: CorrectionPlan): Promise<GpuFrame> {
    const start = performance.now()
    const device = await this.initialize().catch((error) => {
      this.unavailable = error instanceof Error ? error.message : String(error)
      this.close()
      throw error
    })
    const timings: Record<string, number> = { initializeMs: performance.now() - start }
    const { width, height } = source
    const bytes = frameByteLength(width, height)
    const rows = 256,
      stripePixels = width * (rows + 12)
    const estimatedBytes = Math.max(
      bytes * 6 + source.pixels.byteLength + stripePixels * 80,
      correction ? bytes * 9 + source.pixels.byteLength : 0,
    )
    if (
      estimatedBytes > 1024 ** 3 ||
      bytes * 4 > device.limits.maxBufferSize ||
      Math.max(width, height) > device.limits.maxTextureDimension2D ||
      Math.max(bytes, source.pixels.byteLength, stripePixels * 32) >
        device.limits.maxStorageBufferBindingSize
    )
      throw new Error('This photo exceeds the GPU processing memory limit.')
    const reuse = !!correction && this.cameraSource === source && !!this.linear
    if (!reuse) this.releaseFrame()
    const resources: GPUBuffer[] = []
    const makeBuffer = (size: number, usage: number, data?: ArrayBufferView<ArrayBuffer>) => {
      const buffer = device.createBuffer({ size: Math.ceil(size / 4) * 4, usage })
      resources.push(buffer)
      if (data) device.queue.writeBuffer(buffer, 0, data)
      return buffer
    }
    device.pushErrorScope('validation')
    device.pushErrorScope('out-of-memory')
    try {
      const upload = performance.now()
      const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      const uniform = makeBuffer(160, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
      const raw = makeBuffer(source.pixels.byteLength, storage, source.pixels)
      const green = makeBuffer(stripePixels * 8, storage)
      const rgb = makeBuffer(stripePixels * 32, storage)
      const lab = makeBuffer(stripePixels * 32, storage)
      const homo = makeBuffer(stripePixels * 8, storage)
      const histogram = makeBuffer(3 * 8192 * 4, storage | GPUBufferUsage.COPY_SRC)
      const output = makeBuffer(bytes, storage | GPUBufferUsage.COPY_SRC)
      const curve = makeBuffer(65536 * 4, storage)
      const cbrt = new Float32Array(65536)
      for (let i = 0; i < cbrt.length; i++) {
        const r = Math.fround(i / 65535)
        cbrt[i] =
          r > Math.fround(0.008856)
            ? Math.pow(r, Math.fround(1 / 3))
            : Math.fround(Math.fround(Math.fround(7.787) * r) + Math.fround(16 / 116))
      }
      const labCurve = makeBuffer(cbrt.byteLength, storage, cbrt)
      const linear =
        this.linear ??
        device.createTexture({
          size: [width, height],
          format: 'rgba32float',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        })
      this.linear = linear
      const bindings: GPUBindingResource[] = [uniform, raw, green, rgb, lab, homo].map(
        (buffer) => ({ buffer }),
      )
      bindings.push(
        linear.createView(),
        { buffer: histogram },
        { buffer: output },
        { buffer: curve },
        { buffer: labCurve },
        linear.createView(),
      )
      const names: [string, number[]][] = [
        ['interpolateGreen', [0, 1, 2]],
        ['interpolateColor', [0, 1, 2, 3, 4, 10]],
        ['buildHomogeneity', [0, 4, 5]],
        ['combine', [0, 1, 3, 5, 6, 7]],
        ['display', [0, 8, 9, 11]],
      ]
      const groups = new Map(
        names.map(([name, indices]) => [
          name,
          device.createBindGroup({
            layout: this.pipelines.get(name)!.getBindGroupLayout(0),
            entries: indices.map((binding) => ({ binding, resource: bindings[binding] })),
          }),
        ]),
      )
      const params = new ArrayBuffer(160)
      const ints = new Uint32Array(params),
        floats = new Float32Array(params)
      ints.set([width, height, source.rawWidth, source.flip, source.left, source.top, 0, rows])
      floats.set(source.black, 8)
      floats.set(source.scale, 12)
      floats.set(source.matrix, 16)
      const xyz = [
        0.412453, 0.35758, 0.180423, 0.212671, 0.71516, 0.072169, 0.019334, 0.119193, 0.950227,
      ]
      const d65 = [0.950456, 1, 1.088754]
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++) {
          let sum = 0
          for (let k = 0; k < 3; k++)
            sum = Math.fround(
              sum + Math.fround((xyz[r * 3 + k] * source.matrix[k * 4 + c]) / d65[r]),
            )
          floats[28 + r * 4 + c] = sum
        }
      floats[31] = correction ? 1 : 0
      const dispatch = (encoder: GPUCommandEncoder, name: string, dispatchRows: number) => {
        const pass = encoder.beginComputePass({ label: name })
        pass.setPipeline(this.pipelines.get(name)!)
        pass.setBindGroup(0, groups.get(name)!)
        pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(dispatchRows / 16))
        pass.end()
      }
      timings.uploadMs = performance.now() - upload
      const processing = performance.now()
      for (let top = 0; !reuse && top < height; top += rows) {
        const count = Math.min(rows, height - top)
        ints[6] = top
        ints[7] = count
        device.queue.writeBuffer(uniform, 0, params)
        const encoder = device.createCommandEncoder()
        for (const name of ['interpolateGreen', 'interpolateColor', 'buildHomogeneity'])
          dispatch(encoder, name, count + 12)
        dispatch(encoder, 'combine', count)
        device.queue.submit([encoder.finish()])
      }
      const readBuffer = async (buffer: GPUBuffer, length: number) => {
        const staging = makeBuffer(length, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ)
        const encoder = device.createCommandEncoder()
        encoder.copyBufferToBuffer(buffer, 0, staging, 0, length)
        device.queue.submit([encoder.finish()])
        await staging.mapAsync(GPUMapMode.READ)
        const copy = staging.getMappedRange().slice(0)
        staging.unmap()
        staging.destroy()
        return copy
      }
      let corrected: GPUTexture | undefined
      if (correction) {
        const correctionStart = performance.now()
        // Demosaic resources are no longer needed before allocating the second float texture.
        await device.queue.onSubmittedWorkDone()
        for (const resource of [raw, green, rgb, lab, homo, labCurve]) resource.destroy()
        this.cameraSource = source
        corrected = device.createTexture({
          size: [correction.width, correction.height],
          format: 'rgba32float',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        })
        const lensParams = new ArrayBuffer(80)
        new Uint32Array(lensParams).set([
          width,
          height,
          correction.width,
          correction.height,
          correction.left,
          correction.top,
          0,
          0,
        ])
        new Float32Array(lensParams).set(source.matrix, 8)
        const lensUniform = makeBuffer(
          80,
          GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          new Uint8Array(lensParams),
        )
        const lut = makeBuffer(correction.lut.byteLength, storage, correction.lut)
        device.queue.writeBuffer(histogram, 0, new Uint32Array(3 * 8192))
        const pipeline = this.pipelines.get('correct')!
        const group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: lensUniform } },
            { binding: 1, resource: linear.createView() },
            { binding: 2, resource: corrected.createView() },
            { binding: 3, resource: { buffer: lut } },
            { binding: 4, resource: { buffer: histogram } },
          ],
        })
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass()
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, group)
        pass.dispatchWorkgroups(Math.ceil(correction.width / 16), Math.ceil(correction.height / 16))
        pass.end()
        device.queue.submit([encoder.finish()])
        ints[0] = correction.width
        ints[1] = correction.height
        device.queue.writeBuffer(uniform, 0, params)
        groups.set(
          'display',
          device.createBindGroup({
            layout: this.pipelines.get('display')!.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 8, resource: { buffer: output } },
              { binding: 9, resource: { buffer: curve } },
              { binding: 11, resource: corrected.createView() },
            ],
          }),
        )
        await device.queue.onSubmittedWorkDone()
        timings.correctionMs = performance.now() - correctionStart
        timings.reusedLinear = Number(reuse)
      }
      const outWidth = correction?.width ?? width,
        outHeight = correction?.height ?? height
      const histogramData = new Uint32Array(await readBuffer(histogram, 3 * 8192 * 4))
      timings.processingMs = performance.now() - processing
      const display = performance.now()
      device.queue.writeBuffer(curve, 0, displayCurve(histogramData, outWidth * outHeight))
      const encoder = device.createCommandEncoder()
      dispatch(encoder, 'display', height)
      device.queue.submit([encoder.finish()])
      const data = Buffer.from(await readBuffer(output, outWidth * outHeight * 4))
      corrected?.destroy()
      timings.displayReadbackMs = performance.now() - display
      const oom = await device.popErrorScope(),
        validation = await device.popErrorScope()
      if (oom || validation) throw new Error((oom ?? validation)!.message)
      return {
        data,
        width: source.flip & 4 ? outHeight : outWidth,
        height: source.flip & 4 ? outWidth : outHeight,
        adapter: this.adapter,
        timings,
      }
    } catch (error) {
      this.releaseFrame()
      // A device error disables this worker's GPU path; the caller regenerates on CPU.
      this.unavailable = error instanceof Error ? error.message : String(error)
      this.close()
      throw error
    } finally {
      for (const resource of resources) resource.destroy()
    }
  }
}
