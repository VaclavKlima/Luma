import type { PhotoStatistics } from '../shared/statistics'
import { ADJUSTMENT_VERSION, neutralAdjustments } from '../shared/adjustments'
import type { ProcessingOptions } from '../shared/lens'
import { CROP_POLICY, LENS_RENDER_VERSION } from './processing/lens-correction'
import { rawDecoderDefinitions } from './processing/formats'
import { cameraProfiles } from './processing/cameras'
import { frameByteLength } from '../shared/preview-frame'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FullPreview } from '../shared/contracts'
import type { FullPreviewProcessor, FullPreviewResult } from './preview-types'

// Bump whenever decoding, color, or output policy changes.
export const PREVIEW_VERSION = 'v6'
const hashPattern = /^[a-f0-9]{64}$/
const tokenPattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
interface Entry extends FullPreviewResult {
  variant: string
  sourceKey?: string
  id: string
  revision: string
  path: string
  bytes: number
  usedAt: number
  pins: number
  invalid: boolean
}
interface Request {
  id: string
  token: string
  abort: AbortController
  entry?: Entry
  linearEntry?: Entry
  work?: Promise<FullPreview | null>
}

/** One foreground consumer, with serialized disk changes and independent stream leases. */
export class FullPreviews {
  private entries = new Map<string, Entry>()
  private background = new Set<Request>()
  private active?: Request
  private running?: Request
  private blocked = new Set<string>()
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private retainedPhoto?: string
  private directory: string

  constructor(
    private root: string,
    private original: (id: string) => string | undefined,
    private processor: FullPreviewProcessor,
    private budget = 2 * 1024 ** 3,
    private options?: (id: string, signal: AbortSignal) => Promise<ProcessingOptions>,
  ) {
    this.directory = join(root, PREVIEW_VERSION)
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => undefined)
    return result
  }

  async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^v\d+$/.test(entry.name) && entry.name !== PREVIEW_VERSION)
        await rm(join(this.root, entry.name), { recursive: true, force: true })
    }
    for (const folder of await readdir(this.directory, { withFileTypes: true })) {
      const path = join(this.directory, folder.name)
      if (!folder.isDirectory()) continue
      const id = folder.name.slice(0, 64)
      const revision = folder.name.slice(65)
      try {
        if (!hashPattern.test(id) || !tokenPattern.test(revision) || !this.original(id))
          throw new Error('Disposable preview')
        const metadata = JSON.parse(await readFile(join(path, 'entry.json'), 'utf8'))
        const file = await stat(join(path, 'full.rgba'))
        const placeholder = await stat(join(path, 'placeholder.png'))
        if (
          !file.isFile() ||
          file.size !== frameByteLength(metadata.width, metadata.height) ||
          file.size !== metadata.byteLength ||
          metadata.format !== 'rgba8-srgb' ||
          !hashPattern.test(metadata.sha256) ||
          typeof metadata.renderId !== 'string' ||
          !placeholder.isFile() ||
          placeholder.size !== metadata.placeholderBytes ||
          placeholder.size > 128 * 1024 ||
          metadata.bytes !== file.size + placeholder.size + (metadata.linear?.byteLength ?? 0)
        )
          throw new Error('Incomplete preview')
        if (metadata.linear) {
          const linear = await stat(join(path, 'linear.f32'))
          if (
            linear.size !== file.size * 4 ||
            linear.size !== metadata.linear.byteLength ||
            linear.size > 512 * 1024 ** 2 ||
            !hashPattern.test(metadata.linear.sha256)
          )
            throw new Error('Incomplete linear preview')
        }
        this.entries.set(folder.name, {
          statistics: metadata.statistics,
          sourceKey: metadata.sourceKey,
          linear: metadata.linear,
          adjustments: metadata.adjustments,
          variant: metadata.variant ?? 'uncorrected',
          settingsRevision: metadata.settingsRevision,
          appliedCorrections: metadata.appliedCorrections,
          id,
          revision,
          path,
          width: metadata.width,
          height: metadata.height,
          byteLength: metadata.byteLength,
          format: metadata.format,
          sha256: metadata.sha256,
          renderId: metadata.renderId,
          placeholderBytes: metadata.placeholderBytes,
          bytes: file.size + placeholder.size + (metadata.linear?.byteLength ?? 0),
          usedAt: file.mtimeMs,
          pins: 0,
          invalid: false,
        })
      } catch {
        await rm(path, { recursive: true, force: true })
      }
    }
    await this.prune()
  }

  request(id: string, token: string, regenerate = false): Promise<FullPreview> {
    return this.prepare(id, token, regenerate, false).then((preview) => {
      if (!preview) throw new Error('The full preview was not generated.')
      return preview
    })
  }

  requestEditing(id: string, token: string): Promise<FullPreview> {
    return this.prepare(id, token, false, false, true).then((preview) => {
      if (!preview?.linear) throw new Error('A floating-point preview is unavailable.')
      return preview
    })
  }

  requestCached(id: string, token: string): Promise<FullPreview | null> {
    return this.prepare(id, token, false, true)
  }

  private prepare(
    id: string,
    token: string,
    regenerate: boolean,
    cachedOnly: boolean,
    prepareLinear = false,
    background = false,
  ): Promise<FullPreview | null> {
    if (
      this.closed ||
      typeof id !== 'string' ||
      !hashPattern.test(id) ||
      typeof token !== 'string' ||
      !tokenPattern.test(token) ||
      typeof regenerate !== 'boolean'
    )
      return Promise.reject(new Error('Invalid preview request.'))
    if (this.blocked.has(id) || !this.original(id))
      return Promise.reject(new Error('This photo is unavailable.'))
    if (!background) {
      if (this.retainedPhoto && this.retainedPhoto !== id) this.processor.releaseFrame?.()
      this.retainedPhoto = id
    }
    if (!background) {
      for (const job of this.background)
        job.abort.abort(new Error('Statistics interrupted by active preview.'))
      this.detach(false)
    }
    const request: Request = { id, token, abort: new AbortController() }
    if (background) this.background.add(request)
    else this.active = request
    const work = this.enqueue(async () => {
      this.running = request
      try {
        const check = () => {
          request.abort.signal.throwIfAborted()
          if (this.closed || this.blocked.has(id) || !this.original(id))
            throw new Error('This photo is unavailable.')
        }
        check()
        const options = await this.options?.(id, request.abort.signal)
        if (options) options.prepareLinear = prepareLinear
        check()
        const sourceKey = options
          ? createHash('sha256')
              .update(
                JSON.stringify([
                  id,
                  LENS_RENDER_VERSION,
                  CROP_POLICY,
                  rawDecoderDefinitions,
                  cameraProfiles,
                  options.metadata.lensProfile.identity,
                  options.metadata.whiteBalance?.identity,
                  options.settings,
                ]),
              )
              .digest('hex')
          : undefined
        let linearEntry =
          sourceKey && !regenerate
            ? [...this.entries.values()].find(
                (entry) =>
                  entry.id === id &&
                  entry.sourceKey === sourceKey &&
                  entry.linear &&
                  !entry.invalid,
              )
            : undefined
        if (linearEntry && options) {
          linearEntry.pins++
          request.linearEntry = linearEntry
          options.workingAsset = {
            path: join(linearEntry.path, 'linear.f32'),
            width: linearEntry.width,
            height: linearEntry.height,
            ...linearEntry.linear!,
          }
          options.prepareLinear = false
        }
        const variant = options
          ? createHash('sha256')
              .update(
                JSON.stringify([
                  id,
                  LENS_RENDER_VERSION,
                  CROP_POLICY,
                  rawDecoderDefinitions,
                  cameraProfiles,
                  options.metadata.lensProfile.identity,
                  options.metadata.whiteBalance?.identity,
                  options.settings,
                  options.adjustments ?? neutralAdjustments,
                  ADJUSTMENT_VERSION,
                ]),
              )
              .digest('hex')
          : 'uncorrected'
        if (regenerate) {
          for (const entry of this.entries.values())
            if (entry.id === id && entry.variant === variant) entry.invalid = true
        }
        let entry: Entry | undefined = [...this.entries.values()]
          .filter((entry) => entry.id === id && entry.variant === variant && !entry.invalid)
          .sort((a, b) => b.usedAt - a.usedAt)[0]
        if (entry) {
          try {
            const file = await stat(join(entry.path, 'full.rgba'))
            const placeholder = await stat(join(entry.path, 'placeholder.png'))
            if (file.size !== entry.byteLength || placeholder.size !== entry.placeholderBytes)
              throw new Error('Incomplete preview')
          } catch {
            entry.invalid = true
            entry = undefined
          }
        }
        if (!entry && cachedOnly) return null
        if (!entry) {
          const revision = randomUUID()
          const temporary = join(this.directory, `.tmp-${revision}`)
          const path = join(this.directory, `${id}-${revision}`)
          let published = false
          try {
            await mkdir(temporary)
            check()
            const dimensions = await this.processor.renderFull(
              this.original(id)!,
              temporary,
              request.abort.signal,
              options,
            )
            check()
            const file = await stat(join(temporary, 'full.rgba'))
            const placeholder = await stat(join(temporary, 'placeholder.png'))
            if (
              file.size !== frameByteLength(dimensions.width, dimensions.height) ||
              file.size !== dimensions.byteLength ||
              dimensions.format !== 'rgba8-srgb' ||
              !hashPattern.test(dimensions.sha256) ||
              placeholder.size !== dimensions.placeholderBytes ||
              placeholder.size > 128 * 1024
            )
              throw new Error('The decoder produced an invalid preview.')
            await writeFile(
              join(temporary, 'entry.json'),
              JSON.stringify({
                ...dimensions,
                sourceKey,
                variant,
                bytes: file.size + placeholder.size + (dimensions.linear?.byteLength ?? 0),
              }),
            )
            check()
            await rename(temporary, path)
            check()
            entry = {
              ...dimensions,
              sourceKey,
              variant,
              id,
              revision,
              path,
              bytes: file.size + placeholder.size + (dimensions.linear?.byteLength ?? 0),
              usedAt: Date.now(),
              pins: 0,
              invalid: false,
            }
            this.entries.set(`${id}-${revision}`, entry)
            published = true
          } finally {
            await rm(temporary, { recursive: true, force: true })
            if (!published) await rm(path, { recursive: true, force: true })
          }
        }
        if (prepareLinear && !entry.linear && !linearEntry) {
          const temporary = join(this.directory, `.tmp-${randomUUID()}`)
          entry.pins++
          try {
            await this.prune(entry.byteLength * 5 + entry.placeholderBytes)
            await mkdir(temporary)
            const prepared = await this.processor.renderFull(
              this.original(id)!,
              temporary,
              request.abort.signal,
              options,
            )
            check()
            if (
              !prepared.linear ||
              prepared.width !== entry.width ||
              prepared.height !== entry.height ||
              prepared.linear.byteLength !== entry.byteLength * 4 ||
              prepared.linear.byteLength > 512 * 1024 ** 2 ||
              !hashPattern.test(prepared.linear.sha256)
            )
              throw new Error('Invalid linear preview.')
            const linear = await stat(join(temporary, 'linear.f32'))
            if (linear.size !== prepared.linear.byteLength)
              throw new Error('Incomplete linear preview.')
            await rename(join(temporary, 'linear.f32'), join(entry.path, 'linear.f32'))
            entry.linear = prepared.linear
            entry.bytes += prepared.linear.byteLength
            await writeFile(join(entry.path, 'entry.json'), JSON.stringify(entry))
          } finally {
            entry.pins--
            await rm(temporary, { recursive: true, force: true })
          }
        }
        linearEntry ??= entry.linear ? entry : undefined
        check()
        entry.usedAt = Date.now()
        await utimes(join(entry.path, 'full.rgba'), new Date(), new Date(entry.usedAt))
        check()
        entry.pins++
        request.entry = entry
        await this.prune()
        check()
        return {
          adjustments: entry.adjustments,
          linear: linearEntry?.linear
            ? {
                ...linearEntry.linear,
                url: `luma-photo://library/${id}/linear/${PREVIEW_VERSION}/${linearEntry.revision}`,
              }
            : undefined,
          settingsRevision: options?.revision ?? 0,
          appliedCorrections: entry.appliedCorrections,
          photoId: id,
          requestId: token,
          format: entry.format,
          byteLength: entry.byteLength,
          sha256: entry.sha256,
          renderId: entry.renderId,
          placeholderUrl: `luma-photo://library/${id}/placeholder/${PREVIEW_VERSION}/${entry.revision}`,
          width: entry.width,
          height: entry.height,
          url: `luma-photo://library/${id}/full/${PREVIEW_VERSION}/${entry.revision}`,
        }
      } catch (error) {
        if (this.active === request) this.detach(false)
        throw error
      } finally {
        if (background) {
          if (request.entry) request.entry.pins--
          if (request.linearEntry) request.linearEntry.pins--
          this.background.delete(request)
        }
        if (this.running === request) this.running = undefined
      }
    })
    request.work = work
    return work
  }

  async statistics(id: string, expectedRevision: number): Promise<PhotoStatistics> {
    const check = async () => {
      const options = await this.options?.(id, new AbortController().signal)
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        options?.revision !== expectedRevision ||
        this.blocked.has(id) ||
        !this.original(id)
      )
        throw new Error('Statistics revision conflict or photo unavailable.')
    }
    await check()
    const preview = await this.prepare(id, randomUUID(), false, false, false, true)
    if (!preview) throw new Error('Statistics frame unavailable.')
    const lease = this.acquire(new URL(preview.url))
    if (!lease) throw new Error('Statistics frame unavailable.')
    try {
      return await this.enqueue(async () => {
        await check()
        const entry = [...this.entries.values()].find(
          (entry) => entry.path + '/full.rgba' === lease.path,
        )!
        if (!entry.statistics) {
          if (!this.processor.statistics) throw new Error('Statistics processor unavailable.')
          entry.statistics = await this.processor.statistics(
            lease.path,
            preview,
            new AbortController().signal,
          )
          await writeFile(join(entry.path, 'entry.json'), JSON.stringify(entry))
        }
        await check()
        return {
          ...entry.statistics,
          photoId: id,
          revision: expectedRevision,
          renderingIdentity: preview.renderId,
        }
      })
    } finally {
      lease.release()
    }
  }

  settingsChanged(id: string): void {
    for (const job of this.background)
      if (job.id === id) job.abort.abort(new Error('Statistics revision conflict.'))
    if (this.active?.id === id) this.detach(false)
  }

  private detach(releaseFrame = true): void {
    if (!this.active) return
    this.active.abort.abort(new Error('Preview request cancelled.'))
    if (this.active.entry) this.active.entry.pins--
    if (this.active.linearEntry) this.active.linearEntry.pins--
    this.active = undefined
    if (releaseFrame) this.processor.releaseFrame?.()
  }

  async release(token?: string): Promise<void> {
    if (token !== undefined && this.active?.token !== token) return
    this.detach(token === undefined)
    await this.enqueue(() => this.prune())
  }

  /** Acquire synchronously before opening the stream, so eviction cannot remove its file. */
  acquire(
    url: URL,
  ): { path: string; contentType: string; byteLength: number; release: () => void } | undefined {
    if (
      this.closed ||
      url.protocol !== 'luma-photo:' ||
      url.hostname !== 'library' ||
      url.search ||
      url.hash ||
      url.port ||
      url.username ||
      url.password
    )
      return
    const [id, kind, version, revision, extra] = url.pathname.slice(1).split('/')
    if (
      extra !== undefined ||
      (kind !== 'full' && kind !== 'placeholder' && kind !== 'linear') ||
      version !== PREVIEW_VERSION ||
      !hashPattern.test(id) ||
      !tokenPattern.test(revision) ||
      this.blocked.has(id) ||
      !this.original(id)
    )
      return
    const entry = this.entries.get(`${id}-${revision}`)
    if (!entry || entry.invalid || (kind === 'linear' && !entry.linear)) return
    entry.pins++
    let released = false
    return {
      path: join(
        entry.path,
        kind === 'linear' ? 'linear.f32' : kind === 'full' ? 'full.rgba' : 'placeholder.png',
      ),
      contentType: kind === 'placeholder' ? 'image/png' : 'application/octet-stream',
      byteLength:
        kind === 'linear'
          ? entry.linear!.byteLength
          : kind === 'full'
            ? entry.byteLength
            : entry.placeholderBytes,
      release: () => {
        if (released) return
        released = true
        entry.pins--
        void this.enqueue(() => this.prune()).catch(() => undefined)
      },
    }
  }

  async beginRemoval(id: string): Promise<void> {
    this.blocked.add(id)
    for (const job of this.background)
      if (job.id === id) job.abort.abort(new Error('Photo removed.'))
    if (this.active?.id === id) this.detach()
    // A superseded worker may still be stopping while the next photo is queued.
    const running = this.running
    if (running?.id === id) {
      running.abort.abort(new Error('Preview request cancelled.'))
      await running.work?.catch(() => undefined)
    }
  }

  endRemoval(id: string, removed: boolean): void {
    if (removed)
      for (const entry of this.entries.values()) if (entry.id === id) entry.invalid = true
    this.blocked.delete(id)
    // Invalidate immediately, but do not hold up Trash for an unrelated photo's decode.
    void this.enqueue(() => this.prune()).catch(() => undefined)
  }

  private async prune(reservedBytes = 0): Promise<void> {
    let bytes =
      reservedBytes + [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    const entries = [...this.entries.entries()].sort(
      ([, a], [, b]) => Number(b.invalid) - Number(a.invalid) || a.usedAt - b.usedAt,
    )
    for (const [key, entry] of entries) {
      if (entry.pins || (!entry.invalid && bytes <= this.budget)) continue
      // Cache cleanup must never turn a successful Trash operation into a reported failure.
      // Remove from lookup before awaiting unlink: a protocol request can arrive during disk I/O.
      this.entries.delete(key)
      try {
        await rm(entry.path, { recursive: true, force: true })
        bytes -= entry.bytes
      } catch {
        entry.invalid = true
        this.entries.set(key, entry)
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const job of this.background) job.abort.abort(new Error('Preview closed.'))
    this.detach()
    await this.tail
    await this.processor.close()
    await this.prune()
  }
}
