import type { RawGpuRenderer } from '../gpu/raw-renderer'
import type { MergeTransform } from '../../shared/merge'
import { cropCoverage } from './math'
import { transformMatrix, warpedPoint } from './matrix'

const shader = /* wgsl */ `
struct Transform { matrix:array<vec4f,3>, info:vec4u }
@group(0) @binding(0) var<uniform> size:vec4u;
@group(0) @binding(1) var<storage,read> transforms:array<Transform>;
@group(0) @binding(2) var<storage,read> offsets:array<vec2f>;
@group(0) @binding(3) var<storage,read_write> mask:array<u32>;
@compute @workgroup_size(256) fn coverage(@builtin(global_invocation_id) id:vec3u) {
 let i=id.x+id.y*size.w; if(i>=size.x*size.y) {return;}
 let xy=vec3f(f32(i%size.x),f32(i/size.x),1.);var valid=true;var uncertain=false;
 for(var s=0u;s<size.z;s++) {
  let t=transforms[s];let denominator=dot(t.matrix[2].xyz,xy);
  var q=vec2f(dot(t.matrix[0].xyz,xy),dot(t.matrix[1].xyz,xy))/denominator;
  if(t.info.x>0u) {
   let grid=t.info.x; let p=clamp((xy.xy+.5)*f32(grid)/vec2f(size.xy)-.5,vec2f(0),vec2f(f32(grid-1u)));
   let base=vec2u(floor(p));let f=fract(p);
   for(var y=0u;y<2u;y++) {for(var x=0u;x<2u;x++) {
    let k=min(base+vec2u(x,y),vec2u(grid-1u));
    q+=offsets[t.info.y+k.y*grid+k.x]*select(1.-f.x,f.x,x==1u)*select(1.-f.y,f.y,y==1u);
   }}
  }
  let maximum=vec2f(size.xy)-1.;let margin=t.matrix[0].w;
  uncertain=uncertain || any(abs(q)<vec2f(margin)) || any(abs(q-maximum)<vec2f(margin));
  if(any(q<vec2f(0)) || any(q>maximum)) {valid=false;break;}
 }
 mask[i]=select(0u,1u,valid) | select(0u,2u,uncertain);
}`

/** GPU evaluates interior pixels; double-precision CPU geometry resolves every uncertain edge. */
export async function coverageGpu(
  gpu: RawGpuRenderer,
  width: number,
  height: number,
  transforms: MergeTransform[],
  checkpoint: () => Promise<void>,
) {
  const { device } = await gpu.mergeDevice(),
    resources: GPUBuffer[] = []
  const buffer = (bytes: number, usage: number) => {
    if (resources.reduce((n, b) => n + b.size, 0) + bytes > 1024 ** 3)
      throw new Error('Merge exceeds the 1 GiB GPU allocation limit.')
    const b = device.createBuffer({ size: bytes, usage })
    resources.push(b)
    return b
  }
  device.pushErrorScope('validation')
  device.pushErrorScope('out-of-memory')
  let scopes = true
  try {
    const packed = new ArrayBuffer(transforms.length * 64),
      values = new Float32Array(packed),
      ints = new Uint32Array(packed),
      offsets: number[] = []
    for (let s = 0; s < transforms.length; s++) {
      const t = transforms[s],
        m = transformMatrix(t, width, height),
        corners = [
          [0, 0],
          [width - 1, 0],
          [0, height - 1],
          [width - 1, height - 1],
        ],
        minimum = Math.min(...corners.map(([x, y]) => Math.abs(m[6] * x + m[7] * y + m[8]))),
        denominator = Math.abs(m[6]) * width + Math.abs(m[7]) * height + Math.abs(m[8]),
        numerator = Math.max(
          ...[0, 3].map(
            (r) => Math.abs(m[r]) * width + Math.abs(m[r + 1]) * height + Math.abs(m[r + 2]),
          ),
        ),
        margin =
          64 *
          2 ** -23 *
          (1 +
            numerator / minimum +
            (numerator * denominator) / minimum ** 2 +
            Math.max(0, ...(t.tiles?.offsets.map(Math.abs) ?? [])))
      if (!Number.isFinite(margin) || margin > 0.25)
        throw new Error('Coverage needs double-precision CPU geometry.')
      for (let r = 0; r < 3; r++) values.set(m.slice(r * 3, r * 3 + 3), s * 16 + r * 4)
      values[s * 16 + 3] = margin
      ints.set([t.tiles?.columns ?? 0, offsets.length / 2, 0, 0], s * 16 + 12)
      offsets.push(...(t.tiles?.offsets ?? []))
    }
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      uniform = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      matrices = buffer(packed.byteLength, storage),
      tiles = buffer(Math.max(8, offsets.length * 4), storage),
      output = buffer(width * height * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
      staging = buffer(output.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ),
      peakBytes = resources.reduce((n, b) => n + b.size, 0)
    const groups = Math.ceil((width * height) / 256),
      columns = Math.min(65535, groups)
    device.queue.writeBuffer(
      uniform,
      0,
      new Uint32Array([width, height, transforms.length, columns * 256]),
    )
    device.queue.writeBuffer(matrices, 0, packed)
    if (offsets.length) device.queue.writeBuffer(tiles, 0, Float32Array.from(offsets))
    const module = device.createShaderModule({ code: shader }),
      errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')
    if (errors.length) throw new Error(errors.map((m) => m.message).join('\n'))
    const pipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module, entryPoint: 'coverage' },
      }),
      group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [uniform, matrices, tiles, output].map((b, binding) => ({
          binding,
          resource: { buffer: b },
        })),
      }),
      encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.dispatchWorkgroups(columns, Math.ceil(groups / columns))
    pass.end()
    encoder.copyBufferToBuffer(output, 0, staging, 0, output.size)
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const data = new Uint32Array(staging.getMappedRange()),
      mask = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) {
      if (y % 256 === 0) await checkpoint()
      for (let x = 0; x < width; x++) {
        const i = y * width + x,
          value = data[i]
        mask[i] =
          value & 2
            ? Number(
                transforms.every((t) => {
                  const q = warpedPoint(t, width, height, x, y)
                  return q[0] >= 0 && q[1] >= 0 && q[0] <= width - 1 && q[1] <= height - 1
                }),
              )
            : value & 1
      }
    }
    staging.unmap()
    const oom = await device.popErrorScope(),
      validation = await device.popErrorScope()
    scopes = false
    if (oom || validation) throw new Error((oom ?? validation)!.message)
    return { ...cropCoverage(mask, width, height), peakBytes }
  } finally {
    if (scopes) await Promise.allSettled([device.popErrorScope(), device.popErrorScope()])
    for (const b of resources) b.destroy()
  }
}
