import { createHash } from 'node:crypto'
import { frameByteLength } from '../shared/preview-frame'
import { RawGpuRenderer, GPU_RENDER_ID } from './gpu/raw-renderer'
import type { RawSource } from './gpu/raw-source'
import { rawDecoder } from './processing/decoders'
import { processingMetadata } from './processing/metadata'
import type { LinearFrame } from './processing/contracts'
import { correctionPlan, correctCpu, LENS_RENDER_VERSION } from './processing/lens-correction'
import type { ProcessingMetadata, ProcessingOptions } from '../shared/lens'
import { appliedCorrections } from '../shared/lens'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { ExifTool, type Tags } from 'exiftool-vendored'
import type { PhotoMetadata } from '../shared/contracts'
import type { FullPreviewResult, PreviewResult, PreviewStage } from './preview-types'

type ExtractEmbedded = (tool: ExifTool, path: string, output: string) => Promise<void>
const extractEmbedded: ExtractEmbedded = async (tool, path, output) => {
  for (const extract of [tool.extractJpgFromRaw.bind(tool), tool.extractPreview.bind(tool)]) {
    try {
      await extract(path, output)
      // Metadata alone can succeed for a truncated JPEG. Decode to validate it.
      await sharp(output).resize(1, 1).toBuffer()
      return
    } catch {
      await rm(output, { force: true })
    }
  }
  throw new Error('No usable embedded preview')
}

export class PreviewEngine {
  private tool = new ExifTool({ maxProcs: 1, taskTimeoutMillis: 20_000 })

  private retained?: { path: string; source?: RawSource; linear?: LinearFrame }

  async inspect(path: string): Promise<ProcessingMetadata> {
    if (this.tool.ended) this.tool = new ExifTool({ maxProcs: 1, taskTimeoutMillis: 20_000 })
    try {
      return processingMetadata(
        { ...(await this.tool.read(path, ['-G1', '-n']).catch(() => ({}))) },
        rawDecoder(path) ? undefined : [],
      )
    } finally {
      await this.tool.end()
    }
  }

  constructor(
    private extract: ExtractEmbedded = extractEmbedded,
    private backend = process.env.LUMA_PREVIEW_BACKEND ?? 'auto',
    private gpu: Pick<RawGpuRenderer, 'render' | 'close' | 'releaseFrame'> = new RawGpuRenderer(),
  ) {
    sharp.concurrency(1)
    sharp.cache({ memory: 32, files: 0, items: 20 })
  }

  async process(path: string, output: string): Promise<PreviewResult> {
    if (this.tool.ended) this.tool = new ExifTool({ maxProcs: 1, taskTimeoutMillis: 20_000 })
    const tags: Tags = await this.tool.read(path).catch(() => ({}))
    const processing = processingMetadata(
      {
        ...(await this.tool.read(path, ['-G1', '-n']).catch(() => ({}))),
      },
      rawDecoder(path) ? undefined : [],
    )
    let input = sharp(path)
    let source: PreviewResult['source'] = 'image'
    let rawDimensions: { width: number; height: number } | undefined
    const embedded = join(output, 'embedded.jpg')
    try {
      if (rawDecoder(path)) {
        try {
          await this.extract(this.tool, path, embedded)
          input = sharp(embedded)
          const details = await input.metadata()
          // An extracted JPEG may omit the source's orientation metadata.
          if (!details.orientation && typeof tags.Orientation === 'number') {
            input = sharp(await input.withMetadata({ orientation: tags.Orientation }).toBuffer())
          }
          source = 'embedded'
        } catch {
          // Finish ExifTool before synchronous RAW work, so forced decoder
          // cancellation cannot leave its subprocess behind.
          await this.tool.end()
          const session = await rawDecoder(path)!.open(path)
          try {
            const { width, height, flip } = session.dimensions
            rawDimensions = flip & 4 ? { width: height, height: width } : { width, height }
            const decoded = session.display(true)
            input = sharp(decoded.data, {
              raw: { width: decoded.width, height: decoded.height, channels: 3 },
            })
            source = 'decoded'
          } finally {
            session.close()
          }
        }
      }
      await this.tool.end()
      const details = await input.metadata()
      const rotated = details.orientation !== undefined && details.orientation >= 5
      const width = rawDimensions?.width ?? Number(tags.ImageWidth ?? details.width)
      const height = rawDimensions?.height ?? Number(tags.ImageHeight ?? details.height)
      const metadata: PhotoMetadata = {
        width: source !== 'decoded' && rotated ? height : width,
        height: source !== 'decoded' && rotated ? width : height,
        camera: text(tags.Model),
        lens: text(tags.LensModel ?? tags.LensID),
        capturedAt: tags.DateTimeOriginal?.toString(),
        aperture: tags.FNumber ? `f/${tags.FNumber}` : undefined,
        shutter: tags.ExposureTime ? `${tags.ExposureTime} s` : undefined,
        iso: text(tags.ISO),
        focalLength: text(tags.FocalLength),
      }
      const normalized = input.autoOrient().toColourspace('srgb')
      await normalized
        .clone()
        .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toFile(join(output, 'preview.jpg'))
      await normalized
        .clone()
        .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toFile(join(output, 'thumb.jpg'))
      return { metadata, source, processing }
    } finally {
      await this.tool.end()
      await rm(embedded, { force: true })
    }
  }

  async renderFull(
    path: string,
    output: string,
    onStage?: (stage: PreviewStage) => void,
    options?: ProcessingOptions,
  ): Promise<FullPreviewResult> {
    const started = performance.now()
    const timings: Record<string, number> = {}
    let input = sharp(path).autoOrient()
    let frame: { data: Buffer; width: number; height: number } | undefined
    let backend: 'cpu' | 'gpu' = 'cpu'
    let adapter: string | undefined
    let fallback: string | undefined
    if (rawDecoder(path)) {
      onStage?.('unpack')
      const applied = options && appliedCorrections(options.metadata.lensProfile, options.settings)
      const corrected = applied && Object.values(applied).some(Boolean)
      if (this.retained?.path !== path) this.releaseFrame()
      const retained = corrected ? this.retained : undefined
      const session = retained ? undefined : await rawDecoder(path)!.open(path)
      try {
        session?.unpack()
        timings.unpackMs = performance.now() - started
        const source =
          retained?.source ?? (this.backend !== 'cpu' ? session?.gpuSource() : undefined)
        if (this.backend !== 'cpu' && source) {
          try {
            onStage?.('gpu')
            const plan = corrected
              ? correctionPlan(
                  source.width,
                  source.height,
                  options!.metadata.lensProfile,
                  options!.settings,
                )
              : undefined
            const rendered = await this.gpu.render(source, plan)
            frame = rendered
            backend = 'gpu'
            adapter = rendered.adapter
            Object.assign(timings, rendered.timings)
            if (corrected) this.retained = { path, source }
          } catch (error) {
            fallback = error instanceof Error ? error.message : String(error)
          }
        } else if (this.backend !== 'cpu')
          fallback = 'This camera RAW layout has not been verified for GPU processing.'
        if (!frame) {
          onStage?.('cpu')
          const processing = performance.now()
          const fallbackSession =
            !session && !retained?.linear ? await rawDecoder(path)!.open(path) : undefined
          try {
            if (corrected) {
              const linear = retained?.linear ?? (session ?? fallbackSession)!.linear()
              this.retained = { path, linear }
              this.gpu.releaseFrame()
              const plan = correctionPlan(
                linear.width,
                linear.height,
                options!.metadata.lensProfile,
                options!.settings,
              )
              const correctionStart = performance.now()
              frame = correctCpu(linear, plan)
              timings.correctionMs = performance.now() - correctionStart
              timings.reusedLinear = Number(!!retained?.linear)
            } else {
              const decoded = session!.display()
              input = sharp(decoded.data, {
                raw: { width: decoded.width, height: decoded.height, channels: 3 },
              })
            }
          } finally {
            fallbackSession?.close()
          }
          timings.processingMs = performance.now() - processing
        }
      } finally {
        session?.close()
      }
    }

    if (!frame) {
      const dimensions = await input.metadata()
      frameByteLength(dimensions.width, dimensions.height)
      const { data, info } = await input
        .withIccProfile('srgb')
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      frame = { data, width: info.width, height: info.height }
    }
    const byteLength = frameByteLength(frame.width, frame.height)
    if (frame.data.byteLength !== byteLength)
      throw new Error('The decoder returned an incomplete pixel buffer.')
    const cacheStarted = performance.now()
    onStage?.('cache')
    const sha256 = createHash('sha256').update(frame.data).digest('hex')
    await writeFile(join(output, 'full.rgba'), frame.data)
    const placeholder = await sharp(frame.data, {
      raw: { width: frame.width, height: frame.height, channels: 4 },
    })
      .resize({ width: 96, height: 96, fit: 'inside', withoutEnlargement: true })
      .withIccProfile('srgb')
      .png()
      .toBuffer()
    await writeFile(join(output, 'placeholder.png'), placeholder)
    timings.cacheMs = performance.now() - cacheStarted
    timings.totalMs = performance.now() - started
    return {
      width: frame.width,
      height: frame.height,
      format: 'rgba8-srgb',
      byteLength,
      sha256,
      renderId:
        (backend === 'gpu' ? GPU_RENDER_ID : 'libraw-ahd-srgb-cpu-1') +
        (options &&
        Object.values(appliedCorrections(options.metadata.lensProfile, options.settings)).some(
          Boolean,
        )
          ? `-${LENS_RENDER_VERSION}`
          : ''),
      settingsRevision: options?.revision ?? 0,
      appliedCorrections: options
        ? appliedCorrections(options.metadata.lensProfile, options.settings)
        : undefined,
      placeholderBytes: placeholder.byteLength,
      diagnostics: { backend, adapter, fallback, timings },
    }
  }

  releaseFrame(): void {
    this.retained = undefined
    this.gpu.releaseFrame()
  }

  async close(): Promise<void> {
    this.retained = undefined
    this.gpu.close()
    await this.tool.end()
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}
