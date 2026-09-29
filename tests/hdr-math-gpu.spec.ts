import { expect, test } from '@playwright/test'
import { hdrShader } from '../src/renderer/src/preview/hdr-shader'
import {
  adjustHdr,
  outputHdr,
  REC2020_TO_SRGB,
  REC2020_TO_P3,
  SDR_TARGET,
  type RGB,
} from '../src/shared/hdr'
import { neutralAdjustments } from '../src/shared/adjustments'
import { referenceAdjust, referenceOutput } from './hdr-reference'

let retainedGpu: GPU | undefined
test('HDR CPU and actual WGSL float math agree with independent Float64 reference', async () => {
  const { create, globals } = await import('webgpu')
  Object.assign(globalThis, globals)
  retainedGpu = create([])
  const adapter = await retainedGpu.requestAdapter()
  expect(adapter?.info.isFallbackAdapter).toBe(false)
  const device = await adapter!.requestDevice()
  const input: RGB[] = [0, 0.18, 1, 2, 4, 16, -0.1].map((v) => [v, v, v])
  for (let i = 0; i < 256; i++) input.push([i / 16, (255 - i) / 128, Math.sin(i) * 0.1])
  input.push([-2, 4, 1], [16, -0.1, 4], [0, 16, 0], [4, 0, 0])
  const buffer = device.createBuffer({
    size: input.length * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })
  const staging = device.createBuffer({
    size: buffer.size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const uniform = device.createBuffer({
    size: 176,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const texture = device.createTexture({
    size: [input.length, 1],
    format: 'rgba32float',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  })
  device.queue.writeTexture(
    { texture },
    new Float32Array(input.flatMap((v) => [...v, 1])),
    { bytesPerRow: input.length * 16 },
    [input.length, 1],
  )
  const code =
    hdrShader +
    `\n@group(0) @binding(2) var<storage,read_write> result:array<vec4f>;
  @compute @workgroup_size(1) fn check(@builtin(global_invocation_id) p:vec3u) {
    let rgb=adjusted(textureLoad(pixels,vec2i(p.xy),0).rgb);
    result[p.x]=vec4f(select(rgb,outputRgb(rgb),u.values[3].w>0.),1.);
  }`
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        texture: { sampleType: 'unfilterable-float' },
      },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  })
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: device.createShaderModule({ code }), entryPoint: 'check' },
  })
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: texture.createView() },
      { binding: 2, resource: { buffer } },
    ],
  })
  let maximumRatio = 0,
    worst: unknown
  try {
    for (const wb of [undefined, [1.1, 0.02, -0.01, -0.01, 0.9, 0.03, 0.02, -0.03, 1.2]])
      for (const extreme of [0, -100, 100])
        for (const space of ['srgb', 'display-p3'] as const)
          for (const peak of [1, 4, 23.47])
            for (const output of [0, 1]) {
              const params = {
                ...neutralAdjustments,
                exposureEv: extreme / 20,
                contrast: extreme,
                highlights: extreme,
                shadows: extreme,
                whites: extreme,
                blacks: extreme,
              }
              const values = new Float32Array(44)
              values.set(
                [params.exposureEv, extreme, extreme, extreme, extreme, extreme, peak, output],
                8,
              )
              if (wb) {
                values[19] = 1
                for (let r = 0; r < 3; r++) values.set(wb.slice(r * 3, r * 3 + 3), 20 + r * 4)
              }
              const matrix = space === 'srgb' ? REC2020_TO_SRGB : REC2020_TO_P3
              for (let row = 0; row < 3; row++)
                values.set(matrix.slice(row * 3, row * 3 + 3), 32 + row * 4)
              device.queue.writeBuffer(uniform, 0, values)
              const encoder = device.createCommandEncoder(),
                pass = encoder.beginComputePass()
              pass.setPipeline(pipeline)
              pass.setBindGroup(0, group)
              pass.dispatchWorkgroups(input.length)
              pass.end()
              encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size)
              device.queue.submit([encoder.finish()])
              await staging.mapAsync(GPUMapMode.READ)
              const actual = new Float32Array(staging.getMappedRange())
              for (let i = 0; i < input.length; i++) {
                const source = input[i].map(Math.fround) as RGB
                const balanced = wb
                  ? [0, 1, 2].map((r) => source.reduce((sum, v, c) => sum + v * wb[r * 3 + c], 0))
                  : source
                const adjusted = referenceAdjust(balanced, params)
                const reference = output ? referenceOutput(adjusted, peak, space) : adjusted
                const cpuAdjusted = adjustHdr(source, params, wb)
                const cpu = output
                  ? outputHdr(cpuAdjusted, { ...SDR_TARGET, peak, colorSpace: space }).rgb
                  : cpuAdjusted
                for (let c = 0; c < 3; c++)
                  for (const value of [actual[i * 4 + c], cpu[c]]) {
                    const ratio =
                      Math.abs(value - reference[c]) / (2e-6 + 2e-5 * Math.abs(reference[c]))
                    if (ratio > maximumRatio) {
                      maximumRatio = ratio
                      worst = {
                        source,
                        extreme,
                        space,
                        peak,
                        output,
                        c,
                        value,
                        reference: reference[c],
                        gpu: actual[i * 4 + c],
                      }
                    }
                  }
              }
              staging.unmap()
            }
    console.log({ maximumToleranceRatio: maximumRatio, worst })
    expect(maximumRatio).toBeLessThanOrEqual(1)
  } finally {
    texture.destroy()
    buffer.destroy()
    staging.destroy()
    uniform.destroy()
    device.destroy()
    retainedGpu = undefined
  }
})
