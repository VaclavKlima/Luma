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
export const PREVIEW_VERSION = 'v3'
const hashPattern = /^[a-f0-9]{64}$/
const tokenPattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
interface Entry extends FullPreviewResult {
  variant: string
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
  work?: Promise<FullPreview | null>
}

/** One foreground consumer, with serialized disk changes and independent stream leases. */
export class FullPreviews {
  private entries = new Map<string, Entry>()
  private active?: Request
  private running?: Request
  private blocked = new Set<string>()
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
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
          metadata.bytes !== file.size + placeholder.size
        )
          throw new Error('Incomplete preview')
        this.entries.set(folder.name, {
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
          bytes: file.size + placeholder.size,
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

  requestCached(id: string, token: string): Promise<FullPreview | null> {
    return this.prepare(id, token, false, true)
  }

  private prepare(
    id: string,
    token: string,
    regenerate: boolean,
    cachedOnly: boolean,
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
    this.detach(this.active?.id !== id)
    const request: Request = { id, token, abort: new AbortController() }
    this.active = request
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
        check()
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
                  options.settings,
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
              JSON.stringify({ ...dimensions, variant, bytes: file.size + placeholder.size }),
            )
            check()
            await rename(temporary, path)
            check()
            entry = {
              ...dimensions,
              variant,
              id,
              revision,
              path,
              bytes: file.size + placeholder.size,
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
        check()
        entry.usedAt = Date.now()
        await utimes(join(entry.path, 'full.rgba'), new Date(), new Date(entry.usedAt))
        check()
        entry.pins++
        request.entry = entry
        await this.prune()
        check()
        return {
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
      } finally {
        if (this.running === request) this.running = undefined
      }
    })
    request.work = work
    return work
  }

  settingsChanged(id: string): void {
    if (this.active?.id === id) this.detach(false)
  }

  private detach(releaseFrame = true): void {
    if (!this.active) return
    this.active.abort.abort(new Error('Preview request cancelled.'))
    if (this.active.entry) this.active.entry.pins--
    this.active = undefined
    if (releaseFrame) this.processor.releaseFrame?.()
  }

  async release(token?: string): Promise<void> {
    if (token !== undefined && this.active?.token !== token) return
    this.detach()
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
      (kind !== 'full' && kind !== 'placeholder') ||
      version !== PREVIEW_VERSION ||
      !hashPattern.test(id) ||
      !tokenPattern.test(revision) ||
      this.blocked.has(id) ||
      !this.original(id)
    )
      return
    const entry = this.entries.get(`${id}-${revision}`)
    if (!entry || entry.invalid) return
    entry.pins++
    let released = false
    return {
      path: join(entry.path, kind === 'full' ? 'full.rgba' : 'placeholder.png'),
      contentType: kind === 'full' ? 'application/octet-stream' : 'image/png',
      byteLength: kind === 'full' ? entry.byteLength : entry.placeholderBytes,
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

  private async prune(): Promise<void> {
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
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
    this.detach()
    await this.tail
    await this.processor.close()
    await this.prune()
  }
}
