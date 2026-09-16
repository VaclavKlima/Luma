import { create, globals } from 'webgpu'

const { GPUBufferUsage, GPUMapMode } = globals
let gpu = create([])
let device
try {
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter || adapter.info.isFallbackAdapter) throw new Error('No hardware GPU adapter')
  device = await adapter.requestDevice()
  const input = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })
  const readback = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  })
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: device.createShaderModule({
        code: `
      @group(0) @binding(0) var<storage, read_write> result: array<u32>;
      @compute @workgroup_size(4) fn main(@builtin(global_invocation_id) p: vec3u) {
        result[p.x] = (p.x + 1u) * 7u;
      }`,
      }),
      entryPoint: 'main',
    },
  })
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: input } }],
    }),
  )
  pass.dispatchWorkgroups(1)
  pass.end()
  encoder.copyBufferToBuffer(input, 0, readback, 0, 16)
  device.queue.submit([encoder.finish()])
  await readback.mapAsync(GPUMapMode.READ)
  const values = [...new Uint32Array(readback.getMappedRange())]
  if (values.join() !== '7,14,21,28') throw new Error('GPU computation returned incorrect pixels')
  console.log(
    JSON.stringify({
      adapter: adapter.info.description,
      device: adapter.info.device,
      vendor: adapter.info.vendor,
      values,
    }),
  )
  readback.unmap()
  input.destroy()
  readback.destroy()
} finally {
  device?.destroy()
  // Releasing Dawn's root object allows Node to exit.
  // eslint-disable-next-line no-useless-assignment
  gpu = undefined
}
