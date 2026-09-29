import type { HdrAnalysisRequest, HdrPhotoStatistics } from '../shared/hdr-statistics'
import type { PhotoStatistics } from '../shared/statistics'
import { SDR_TARGET, type DisplayTarget, HDR_IMPORT_DEFAULT } from '../shared/hdr'
import {
  initialSettings,
  SETTINGS_VERSION,
  validatePatch,
  type EditState,
  type EditPatch,
  type EditHistory,
} from '../shared/edits'
import { photoExtensions } from './processing/formats'
import {
  automaticLensSettings,
  PROCESSING_METADATA_VERSION,
  correctionKinds,
  type CorrectionKind,
  type LensState,
  type ProcessingOptions,
} from '../shared/lens'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { cp, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { RemovalStore } from './removal-store'
import { copyOriginal } from './copy-original'
import { FullPreviews } from './full-previews'
import { PreviewProcess } from './preview-process'
import {
  PAGE_SIZE,
  type ImportCandidate,
  type ImportReview,
  type LibraryEvent,
  type Photo,
  type PhotoPage,
  type PhotoLocation,
  type PhotoReference,
  type BackgroundTask,
  type TaskErrorPage,
} from '../shared/contracts'
import type { PreviewProcessor, PreviewResult } from './preview-types'

const extensions = new Set(photoExtensions.map((extension) => `.${extension}`))
const hashPattern = /^[a-f0-9]{64}$/
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

interface Candidate extends ImportCandidate {
  path: string
  hash?: string
  preview?: PreviewResult
  cacheDir?: string
}

interface Session {
  id: string
  source: string
  phase: ImportReview['phase']
  candidates: Candidate[]
  skipped: number
  abort: AbortController
  task: Promise<void>
  firstImportedId?: string
}

export class PhotoLibrary {
  readonly fullPreviews: FullPreviews
  private db!: DatabaseSync
  private lensTail: Promise<unknown> = Promise.resolve()
  private metadataTail: Promise<unknown> = Promise.resolve()
  private removals!: RemovalStore
  private session?: Session
  private closed = false
  private replacingSession = false
  private notification?: ReturnType<typeof setTimeout>
  private tasks = new Map<
    string,
    {
      snapshot: BackgroundTask
      errors: TaskErrorPage['errors']
      abort?: AbortController
      work?: Promise<void>
    }
  >()

  constructor(
    readonly root: string,
    private processor: PreviewProcessor,
    private emit: (event: LibraryEvent) => void,
    private transfer: typeof copyOriginal = copyOriginal,
    private trash: (path: string) => Promise<void> = async () => {
      throw new Error('System Trash is unavailable.')
    },
    private metadataProcessor: Pick<PreviewProcess, 'inspect' | 'close'> = new PreviewProcess(),
    private hdrImports = HDR_IMPORT_DEFAULT,
  ) {
    this.fullPreviews = new FullPreviews(
      join(root, 'cache', 'previews'),
      (id) => {
        if (this.closed) return
        const photo = this.find(id)
        return photo
          ? join(root, 'originals', id, `original${extname(photo.filename).toLowerCase()}`)
          : undefined
      },
      new PreviewProcess(),
      undefined,
      (id, signal) => this.processingOptions(id, signal),
    )
  }

  async open(): Promise<void> {
    await mkdir(join(this.root, 'originals'), { recursive: true })
    this.db = new DatabaseSync(join(this.root, 'catalog.sqlite'))
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version.user_version > 9) throw new Error('This library requires a newer version of Luma.')
    this.db.exec(
      'BEGIN; CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, imported_at TEXT NOT NULL, photo TEXT NOT NULL); CREATE TABLE IF NOT EXISTS removals (id TEXT PRIMARY KEY, staged TEXT NOT NULL); CREATE TABLE IF NOT EXISTS processing (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TRIGGER IF NOT EXISTS remove_processing AFTER DELETE ON photos BEGIN DELETE FROM processing WHERE id = old.id; END; CREATE TABLE IF NOT EXISTS edits (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TRIGGER IF NOT EXISTS remove_edits AFTER DELETE ON photos BEGIN DELETE FROM edits WHERE id = old.id; END;',
    )
    try {
      if (version.user_version < 9)
        this.db.exec(
          "ALTER TABLE photos ADD COLUMN processing_identity TEXT NOT NULL DEFAULT 'legacy-sdr-v1'",
        )
      for (const row of this.db.prepare('SELECT id, data FROM edits').all() as {
        id: string
        data: string
      }[]) {
        const history = JSON.parse(row.data)
        let migrated = false
        for (const settings of [
          history.settings,
          ...history.snapshots.map(
            (snapshot: { settings: { version: number; contrast?: number } }) => snapshot.settings,
          ),
        ]) {
          if (settings.version === 1) {
            settings.version = 2
            settings.contrast = 0
            migrated = true
          }
          if (settings.version === 2) {
            settings.version = 3
            settings.highlights = 0
            migrated = true
          }
          if (settings.version === 3) {
            settings.version = 4
            settings.shadows = 0
            settings.whites = 0
            settings.blacks = 0
            migrated = true
          }
          if (settings.version === 4) {
            settings.version = 5
            settings.whiteBalance = { mode: 'as-shot' }
            migrated = true
          }
          if (settings.version === 5) {
            settings.version = SETTINGS_VERSION
            settings.processing = 'legacy-sdr-v1'
            migrated = true
          } else if (settings.version !== SETTINGS_VERSION) {
            throw new Error('These edits require a newer version of Luma.')
          }
        }
        if (migrated)
          this.db
            .prepare('UPDATE edits SET data = ? WHERE id = ?')
            .run(JSON.stringify(history), row.id)
      }
      for (const row of this.db.prepare('SELECT id, data FROM processing').all() as {
        id: string
        data: string
      }[]) {
        const data = JSON.parse(row.data) as ProcessingOptions
        this.ensureEdits(row.id, data)
      }
      this.db.exec('PRAGMA user_version = 9; COMMIT;')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.removals = new RemovalStore(this.root, this.db, this.trash)
    await this.removals.recover()
    // Only application-owned, unpublished files are recovered here.
    await rm(join(this.root, 'staging'), { recursive: true, force: true })
    await mkdir(join(this.root, 'staging'), { recursive: true })
    for (const entry of await readdir(join(this.root, 'originals'), { withFileTypes: true })) {
      if (entry.isDirectory() && hashPattern.test(entry.name) && !this.find(entry.name)) {
        await rm(join(this.root, 'originals', entry.name), { recursive: true, force: true })
      }
    }
    await this.fullPreviews.open()
  }

  private find(id: string): Photo | undefined {
    const row = this.db.prepare('SELECT photo FROM photos WHERE id = ?').get(id) as
      { photo: string } | undefined
    return row ? (JSON.parse(row.photo) as Photo) : undefined
  }

  private readProcessing(id: string): ProcessingOptions | undefined {
    const row = this.db.prepare('SELECT data FROM processing WHERE id = ?').get(id) as
      { data: string } | undefined
    if (!row) return undefined
    const data = JSON.parse(row.data) as ProcessingOptions
    const edits = this.ensureEdits(id, data)
    return {
      ...data,
      processing: edits.settings.processing,
      settings: edits.settings.lens,
      adjustments: {
        whiteBalance: edits.settings.whiteBalance,
        exposureEv: edits.settings.exposureEv,
        contrast: edits.settings.contrast,
        highlights: edits.settings.highlights,
        shadows: edits.settings.shadows,
        whites: edits.settings.whites,
        blacks: edits.settings.blacks,
      },
      revision: edits.revision,
    }
  }

  private async processingOptions(
    id: string,
    signal = new AbortController().signal,
  ): Promise<ProcessingOptions> {
    if (typeof id !== 'string' || !hashPattern.test(id) || this.closed || !this.find(id))
      throw new Error('This photo is unavailable.')
    const existing = this.readProcessing(id)
    if (existing?.metadata.version === PROCESSING_METADATA_VERSION) return existing
    const work = this.metadataTail.then(async () => {
      signal.throwIfAborted()
      const existing = this.readProcessing(id)
      if (existing?.metadata.version === PROCESSING_METADATA_VERSION) return existing
      const photo = this.find(id)
      if (!photo || this.closed) throw new Error('This photo is unavailable.')
      const path = join(
        this.root,
        'originals',
        id,
        `original${extname(photo.filename).toLowerCase()}`,
      )
      const metadata = await this.metadataProcessor.inspect(path, signal)
      signal.throwIfAborted()
      if (this.closed || !this.find(id)) throw new Error('This photo is unavailable.')
      const data: ProcessingOptions = {
        metadata,
        settings: existing?.settings ?? { ...automaticLensSettings },
        revision: existing?.revision ?? 0,
      }
      this.db
        .prepare('INSERT OR REPLACE INTO processing (id, data) VALUES (?, ?)')
        .run(id, JSON.stringify(data))
      return this.readProcessing(id)!
    })
    this.metadataTail = work.catch(() => undefined)
    return work
  }

  async getLensSettings(id: string): Promise<LensState> {
    const data = await this.processingOptions(id)
    return {
      photoId: id,
      revision: data.revision,
      settings: data.settings,
      profile: data.metadata.lensProfile,
    }
  }

  private ensureEdits(id: string, data: ProcessingOptions): EditHistory {
    const row = this.db.prepare('SELECT data FROM edits WHERE id = ?').get(id) as
      { data: string } | undefined
    if (row) {
      const history = JSON.parse(row.data) as EditHistory
      if (
        history.settings.version !== SETTINGS_VERSION ||
        history.snapshots.some((snapshot) => snapshot.settings.version !== SETTINGS_VERSION)
      )
        throw new Error('These edits require a newer version of Luma.')
      return history
    }
    const settings = initialSettings(data.settings)
    const seed = this.db.prepare('SELECT processing_identity FROM photos WHERE id = ?').get(id) as
      { processing_identity: 'legacy-sdr-v1' | 'hdr-v1' } | undefined
    settings.processing = seed?.processing_identity ?? 'legacy-sdr-v1'
    const history: EditHistory = {
      photoId: id,
      revision: data.revision,
      settings,
      canUndo: false,
      canRedo: false,
      cursor: 0,
      snapshots: [{ settings, createdAt: new Date().toISOString() }],
    }
    this.db.prepare('INSERT INTO edits (id, data) VALUES (?, ?)').run(id, JSON.stringify(history))
    return history
  }

  async getEditHistory(id: string): Promise<EditHistory> {
    const data = await this.processingOptions(id)
    if (this.closed || !this.find(id)) throw new Error('This photo is unavailable.')
    return this.ensureEdits(id, data)
  }

  displayTarget?: () => DisplayTarget
  getPhotoStatistics(id: string, expectedRevision: number): Promise<PhotoStatistics>
  getPhotoStatistics(
    id: string,
    expectedRevision: number,
    request: HdrAnalysisRequest,
  ): Promise<HdrPhotoStatistics>
  getPhotoStatistics(
    id: string,
    expectedRevision: number,
    request?: HdrAnalysisRequest,
  ): Promise<PhotoStatistics | HdrPhotoStatistics>
  async getPhotoStatistics(
    id: string,
    expectedRevision: number,
    request?: HdrAnalysisRequest,
  ): Promise<PhotoStatistics | HdrPhotoStatistics> {
    if (request === undefined) return this.fullPreviews.statistics(id, expectedRevision)
    if (
      !request ||
      !['working-hdr', 'output'].includes(request.domain) ||
      Object.keys(request).some((key) => !['domain', 'target', 'targetGeneration'].includes(key)) ||
      (request.target !== undefined && !['sdr', 'current'].includes(request.target))
    )
      throw new Error('Invalid HDR analysis request.')
    const current = request.domain === 'output' && request.target !== 'sdr'
    let target = current ? this.displayTarget?.() : SDR_TARGET
    if (!target || (current && request.targetGeneration !== target.generation))
      throw new Error('Display target generation conflict.')
    if (
      current &&
      target.presentation?.photoId === id &&
      target.presentation.stage === 'presented' &&
      target.presentation.backend === 'canvas2d-hdr-sdr'
    )
      target = { ...target, mode: 'sdr', colorSpace: 'srgb', peak: 1 }
    const result = await this.fullPreviews.hdrStatistics(
      id,
      expectedRevision,
      request.domain,
      target,
    )
    if (
      current &&
      (this.displayTarget?.().generation !== target.generation ||
        this.displayTarget?.().presentation?.backend !== target.presentation?.backend)
    )
      throw new Error('Display target generation conflict.')
    return result
  }

  async getEdits(id: string): Promise<EditState> {
    return this.editState(await this.getEditHistory(id))
  }

  private editState(history: EditHistory): EditState {
    const { photoId, revision, settings, canUndo, canRedo } = history
    return {
      photoId,
      revision,
      settings,
      canUndo,
      canRedo,
      hdrEligible: this.readProcessing(photoId)?.metadata.hdrEligible,
      whiteBalanceProfile: this.readProcessing(photoId)?.metadata.whiteBalance,
    }
  }

  private publishEdit(history: EditHistory, expectedRevision: number): EditState {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      history.revision !== expectedRevision
    )
      throw new Error('Edit conflict: reload the confirmed settings and try again.')
    const previous = this.ensureEdits(history.photoId, this.readProcessing(history.photoId)!)
    const lensChanged =
      previous.settings.processing !== history.settings.processing ||
      JSON.stringify(previous.settings.lens) !== JSON.stringify(history.settings.lens)
    history.revision++
    history.canUndo = history.cursor > 0
    history.canRedo = history.cursor < history.snapshots.length - 1
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('UPDATE edits SET data = ? WHERE id = ?')
        .run(JSON.stringify(history), history.photoId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.fullPreviews.settingsChanged(history.photoId)
    this.emit({
      editsChanged: { photoId: history.photoId, revision: history.revision },
      lensChanged: lensChanged
        ? { photoId: history.photoId, revision: history.revision }
        : undefined,
    })
    return this.editState(history)
  }

  async updateEdits(id: string, patch: EditPatch, expectedRevision: number): Promise<EditState> {
    validatePatch(patch)
    await this.processingOptions(id)
    if (this.closed || !this.find(id)) throw new Error('This photo is unavailable.')
    const data = this.readProcessing(id)!
    const history = this.ensureEdits(id, data)
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      history.revision !== expectedRevision
    )
      throw new Error('Edit conflict: reload the confirmed settings and try again.')
    for (const kind of correctionKinds)
      if (patch.lens?.[kind] !== undefined && !data.metadata.lensProfile[kind])
        throw new Error('This correction is unavailable.')
    if (patch.whiteBalance?.mode === 'custom' && !data.metadata.whiteBalance)
      throw new Error('White balance is unavailable for this camera.')
    const settings = {
      ...history.settings,
      ...patch,
      lens: { ...history.settings.lens, ...patch.lens },
    }
    if (JSON.stringify(settings) === JSON.stringify(history.settings)) {
      return this.editState(history)
    }
    history.settings = settings
    history.snapshots = history.snapshots.slice(0, history.cursor + 1)
    history.snapshots.push({ settings, createdAt: new Date().toISOString() })
    history.cursor++
    return this.publishEdit(history, expectedRevision)
  }

  async upgradePhotoProcessing(id: string, expectedRevision: number): Promise<EditState> {
    await this.processingOptions(id)
    if (this.closed || !this.find(id)) throw new Error('This photo is unavailable.')
    const data = this.readProcessing(id)!
    const history = this.ensureEdits(id, data)
    if (history.revision !== expectedRevision || !Number.isSafeInteger(expectedRevision))
      throw new Error('Edit conflict: reload the confirmed settings and try again.')
    if (!data.metadata.hdrEligible)
      throw new Error('HDR processing is unavailable for this RAW mode.')
    if (history.settings.processing === 'hdr-v1') return this.editState(history)
    history.settings = { ...history.settings, processing: 'hdr-v1' }
    history.snapshots = history.snapshots.slice(0, history.cursor + 1)
    history.snapshots.push({ settings: history.settings, createdAt: new Date().toISOString() })
    history.cursor++
    return this.publishEdit(history, expectedRevision)
  }

  async undoEdit(id: string, expectedRevision: number): Promise<EditState> {
    return this.moveEdit(id, expectedRevision, -1)
  }
  async redoEdit(id: string, expectedRevision: number): Promise<EditState> {
    return this.moveEdit(id, expectedRevision, 1)
  }
  private async moveEdit(
    id: string,
    expectedRevision: number,
    direction: -1 | 1,
  ): Promise<EditState> {
    await this.processingOptions(id)
    if (this.closed || !this.find(id)) throw new Error('This photo is unavailable.')
    const history = this.ensureEdits(id, this.readProcessing(id)!)
    const cursor = history.cursor + direction
    if (cursor < 0 || cursor >= history.snapshots.length)
      throw new Error('No edit history in that direction.')
    history.cursor = cursor
    history.settings = history.snapshots[cursor].settings
    return this.publishEdit(history, expectedRevision)
  }

  async updateLensSettings(id: string, kind: CorrectionKind, enabled: boolean): Promise<LensState> {
    if (!correctionKinds.includes(kind) || typeof enabled !== 'boolean')
      throw new Error('Invalid lens correction setting.')
    const work = this.lensTail.then(async () => {
      const state = await this.getEdits(id)
      await this.updateEdits(id, { lens: { [kind]: enabled } }, state.revision)
      return this.getLensSettings(id)
    })
    this.lensTail = work.catch(() => undefined)
    return work
  }

  list(offset = 0): PhotoPage {
    this.validateOffset(offset)
    const rows = this.db
      .prepare('SELECT photo FROM photos ORDER BY imported_at DESC, rowid DESC LIMIT ? OFFSET ?')
      .all(PAGE_SIZE, offset) as { photo: string }[]
    const count = this.db.prepare('SELECT COUNT(*) AS total FROM photos').get() as { total: number }
    return { photos: rows.map((row) => JSON.parse(row.photo) as Photo), total: count.total }
  }

  locate(id: string, direction: -1 | 0 | 1 = 0): PhotoLocation | null {
    if (typeof id !== 'string' || ![-1, 0, 1].includes(direction))
      throw new Error('Invalid photo navigation.')
    const row = this.db
      .prepare(
        'SELECT position FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY imported_at DESC, rowid DESC) - 1 AS position FROM photos) WHERE id = ?',
      )
      .get(id) as { position: number } | undefined
    if (!row) return null
    const index = row.position + direction
    if (index < 0) return null
    const offset = Math.floor(index / PAGE_SIZE) * PAGE_SIZE
    const page = this.list(offset)
    if (index >= page.total) return null
    return { ...page, offset, index }
  }

  listTasks(): BackgroundTask[] {
    return [...this.tasks.values()].map((task) => structuredClone(task.snapshot))
  }

  range(fromId: string, toId: string): PhotoReference[] {
    if (![fromId, toId].every((id) => typeof id === 'string' && hashPattern.test(id)))
      throw new Error('Invalid photo selection.')
    return this.db
      .prepare(
        `
      WITH ordered AS (
        SELECT id, photo, ROW_NUMBER() OVER (ORDER BY imported_at DESC, rowid DESC) AS position FROM photos
      ), bounds AS (
        SELECT COALESCE((SELECT position FROM ordered WHERE id = ?), (SELECT position FROM ordered WHERE id = ?)) AS start,
          (SELECT position FROM ordered WHERE id = ?) AS finish
      )
      SELECT id, json_extract(photo, '$.filename') AS filename FROM ordered, bounds
      WHERE position BETWEEN MIN(start, finish) AND MAX(start, finish) ORDER BY position
    `,
      )
      .all(fromId, toId, toId) as unknown as PhotoReference[]
  }

  deletePhotos(ids: string[]): string | null {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !hashPattern.test(id)))
      throw new Error('Invalid photo selection.')
    if (
      this.closed ||
      this.replacingSession ||
      this.hasActiveTask() ||
      this.session?.phase === 'scanning'
    )
      throw new Error('Finish or cancel the current library operation first.')
    this.assertRecovered()
    const photos = [...new Set(ids)]
      .map((id) => this.find(id))
      .filter((photo): photo is Photo => Boolean(photo))
    if (!photos.length) return null
    const id = randomUUID()
    const task = {
      snapshot: {
        id,
        kind: 'delete',
        title: 'Moving photos to Trash',
        status: 'running',
        progress: { completed: 0, total: photos.length, unit: 'items' },
        items: { completed: 0, total: photos.length, label: 'photos moved to Trash' },
        errorCount: 0,
      } as BackgroundTask,
      errors: [] as TaskErrorPage['errors'],
      abort: new AbortController(),
      work: Promise.resolve(),
    }
    this.tasks.set(id, task)
    this.changed()
    task.work = (async () => {
      try {
        if (this.session) await this.dispose(this.session.id)
        for (const photo of photos) {
          if (task.abort.signal.aborted) break
          task.snapshot.detail = photo.filename
          this.changed()
          try {
            const neighbor = this.locate(photo.id, 1) ?? this.locate(photo.id, -1)
            const replacementId = neighbor?.photos[neighbor.index - neighbor.offset]?.id
            await this.fullPreviews.beginRemoval(photo.id)
            try {
              await this.removals.remove(photo.id)
            } finally {
              await this.fullPreviews.endRemoval(photo.id, !this.find(photo.id))
            }
            task.snapshot.items!.completed++
            if (!this.closed)
              this.emit({ libraryChanged: true, deletedIds: [photo.id], replacementId })
          } catch (error) {
            task.errors.push({ filename: photo.filename, message: errorMessage(error) })
          }
          task.snapshot.progress!.completed++
          task.snapshot.errorCount = task.errors.length
          this.changed()
        }
      } catch (error) {
        task.errors.push({ filename: 'Library', message: errorMessage(error) })
      } finally {
        task.snapshot.status = task.abort.signal.aborted
          ? 'cancelled'
          : task.errors.length
            ? 'failed'
            : 'completed'
        task.snapshot.title = task.abort.signal.aborted
          ? 'Deletion cancelled'
          : task.errors.length
            ? 'Deletion finished with errors'
            : 'Moved to Trash'
        task.snapshot.errorCount = task.errors.length
        task.snapshot.detail = undefined
        task.snapshot.finishedAt = Date.now()
        this.changed(undefined, true)
      }
    })()
    return id
  }

  hasActiveTask(): boolean {
    return [...this.tasks.values()].some(({ snapshot }) =>
      ['running', 'cancelling'].includes(snapshot.status),
    )
  }

  taskErrors(id: string, offset = 0): TaskErrorPage {
    this.validateOffset(offset)
    const task = this.tasks.get(id)
    if (!task) throw new Error('This task has been dismissed.')
    return {
      errors: task.errors.slice(offset, offset + PAGE_SIZE).map((error) => ({ ...error })),
      total: task.errors.length,
    }
  }

  async cancelTask(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) throw new Error('This task has been dismissed.')
    if (!['running', 'cancelling'].includes(task.snapshot.status)) return
    task.snapshot.status = 'cancelling'
    task.snapshot.title =
      task.snapshot.kind === 'delete' ? 'Cancelling deletion…' : 'Cancelling import…'
    this.changed()
    if (task.abort) {
      task.abort.abort()
      await task.work
    } else await this.cancel(id)
  }

  dismissTask(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    if (['running', 'cancelling'].includes(task.snapshot.status))
      throw new Error('Cancel the task before dismissing it.')
    this.tasks.delete(id)
    if (!this.closed) this.emit({ tasksChanged: true })
  }

  private assertRecovered(): void {
    if (this.db.prepare('SELECT 1 FROM removals LIMIT 1').get())
      throw new Error(
        'An interrupted deletion needs recovery. Restart Luma before changing the library.',
      )
  }

  private validateOffset(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid page offset.')
  }

  private getSession(id: string): Session {
    if (!this.session || this.session.id !== id) throw new Error('This import session has expired.')
    return this.session
  }

  private changed(session?: Session, libraryChanged = false): void {
    if (this.closed) return
    if (libraryChanged)
      this.emit({
        sessionId: session?.id,
        libraryChanged: true,
        firstImportedId: session?.firstImportedId,
      })
    if (this.notification) return
    this.notification = setTimeout(() => {
      this.notification = undefined
      if (!this.closed) this.emit({ sessionId: this.session?.id, tasksChanged: true })
    }, 80)
  }

  async scan(paths: string[], recursive: boolean): Promise<string> {
    if (
      this.closed ||
      this.replacingSession ||
      this.hasActiveTask() ||
      this.session?.phase === 'importing' ||
      this.session?.phase === 'scanning'
    )
      throw new Error('Finish or cancel the current import before choosing another source.')
    this.assertRecovered()
    this.replacingSession = true
    try {
      if (this.session) await this.dispose(this.session.id)
      const session: Session = {
        id: randomUUID(),
        source: paths.length === 1 ? basename(paths[0]) : `${paths.length} selected files`,
        phase: 'scanning',
        candidates: [],
        skipped: 0,
        abort: new AbortController(),
        task: Promise.resolve(),
      }
      this.session = session
      session.task = this.scanFiles(session, paths, recursive)
        .catch((error) => {
          if (!session.abort.signal.aborted) this.addError(session, session.source, error)
        })
        .finally(() => {
          session.phase = session.abort.signal.aborted ? 'cancelled' : 'review'
          this.changed(session)
        })
      return session.id
    } finally {
      this.replacingSession = false
    }
  }

  private addError(session: Session, path: string, error: unknown): void {
    session.candidates.push({
      id: randomUUID(),
      path,
      filename: basename(path),
      relativePath: basename(path),
      bytes: 0,
      status: 'error',
      selected: false,
      message: errorMessage(error),
    })
    this.changed(session)
  }

  private async scanFiles(session: Session, paths: string[], recursive: boolean): Promise<void> {
    const seen = new Map<string, Candidate>()
    const visited = new Set<string>()
    const managedRoot = await realpath(this.root)
    const visit = async (path: string, base: string, explicit: boolean): Promise<void> => {
      if (session.abort.signal.aborted) return
      try {
        const canonical = await realpath(path)
        if (
          canonical === managedRoot ||
          canonical.startsWith(managedRoot + sep) ||
          visited.has(canonical)
        )
          return
        visited.add(canonical)
        const info = await stat(canonical)
        if (info.isDirectory()) {
          for (const entry of await readdir(canonical, { withFileTypes: true })) {
            if (session.abort.signal.aborted) break
            if (entry.isSymbolicLink()) {
              session.skipped++
              continue
            }
            if (entry.isDirectory() && !recursive) continue
            await visit(join(canonical, entry.name), base, false)
          }
          return
        }
        if (!info.isFile()) {
          session.skipped++
          return
        }
        if (!extensions.has(extname(canonical).toLowerCase())) {
          if (explicit)
            this.addError(session, path, 'Unsupported format. Choose JPEG, PNG, TIFF, or Sony ARW.')
          else session.skipped++
          return
        }
        const candidate: Candidate = {
          id: randomUUID(),
          filename: basename(path),
          relativePath: relative(base, path) || basename(path),
          path: canonical,
          bytes: info.size,
          status: 'processing',
          selected: false,
        }
        session.candidates.push(candidate)
        this.changed(session)
        try {
          const hash = await this.hashFile(canonical, session.abort.signal)
          candidate.hash = hash
          const existing = this.find(hash)
          const previous = seen.get(hash)
          if (existing || previous) {
            candidate.status = 'duplicate'
            candidate.message = existing
              ? 'Already imported'
              : `Duplicate of ${previous!.filename} in this selection`
            candidate.thumbnailUrl = existing?.thumbnailUrl ?? previous?.thumbnailUrl
          } else {
            candidate.cacheDir = join(this.root, 'staging', session.id, candidate.id)
            await mkdir(candidate.cacheDir, { recursive: true })
            candidate.preview = await this.processor.process(
              canonical,
              candidate.cacheDir,
              session.abort.signal,
            )
            const after = await stat(canonical)
            if (
              after.size !== info.size ||
              after.mtimeMs !== info.mtimeMs ||
              after.ctimeMs !== info.ctimeMs
            )
              throw new Error('The source changed while generating its preview. Choose it again.')
            candidate.thumbnailUrl = `luma-photo://review/${session.id}/${candidate.id}/thumb`
            candidate.status = 'ready'
            candidate.selected = true
            seen.set(hash, candidate)
          }
        } catch (error) {
          candidate.status = 'error'
          candidate.message = session.abort.signal.aborted ? 'Cancelled' : errorMessage(error)
        }
        this.changed(session)
      } catch (error) {
        if (!session.abort.signal.aborted) this.addError(session, path, error)
      }
    }
    for (const path of paths)
      await visit(
        resolve(path),
        (await stat(path).catch(() => undefined))?.isDirectory()
          ? resolve(path)
          : resolve(path, '..'),
        true,
      )
  }

  private async hashFile(path: string, signal: AbortSignal): Promise<string> {
    const hash = createHash('sha256')
    const stream = createReadStream(path, { signal })
    for await (const chunk of stream) hash.update(chunk as Buffer)
    return hash.digest('hex')
  }

  review(id: string, offset = 0): ImportReview {
    this.validateOffset(offset)
    const s = this.getSession(id)
    const selected = s.candidates.filter((c) => c.selected && c.status === 'ready')
    return {
      sessionId: id,
      source: s.source,
      phase: s.phase,
      candidates: s.candidates
        .slice(offset, offset + PAGE_SIZE)
        .map(({ id, filename, relativePath, bytes, status, selected, thumbnailUrl, message }) => ({
          id,
          filename,
          relativePath,
          bytes,
          status,
          selected,
          thumbnailUrl,
          message,
        })),
      total: s.candidates.length,
      selected: selected.length,
      selectedBytes: selected.reduce((sum, c) => sum + c.bytes, 0),
      ready: s.candidates.filter((c) => c.status === 'ready').length,
      duplicates: s.candidates.filter((c) => c.status === 'duplicate').length,
      errors: s.candidates.filter((c) => c.status === 'error').length,
      imported: s.candidates.filter((c) => c.status === 'imported').length,
      skipped: s.skipped,
      firstImportedId: s.firstImportedId,
    }
  }

  select(id: string, ids: string[] | null, selected: boolean): void {
    const s = this.getSession(id)
    if (s.phase !== 'review')
      throw new Error('Wait for scanning to finish before changing the selection.')
    if (
      typeof selected !== 'boolean' ||
      (ids !== null && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')))
    )
      throw new Error('Invalid photo selection.')
    const chosen = ids === null ? null : new Set(ids)
    for (const c of s.candidates)
      if (c.status === 'ready' && (!chosen || chosen.has(c.id))) c.selected = selected
    this.changed(s)
  }

  importSelected(id: string): void {
    if (this.closed || this.hasActiveTask())
      throw new Error('Finish or cancel the current library operation first.')
    this.assertRecovered()
    const s = this.getSession(id)
    if (s.phase !== 'review' || !s.candidates.some((c) => c.status === 'ready' && c.selected))
      throw new Error('Select at least one photo after scanning finishes.')
    const selected = s.candidates.filter(
      (candidate) => candidate.status === 'ready' && candidate.selected,
    )
    const task = {
      snapshot: {
        id,
        kind: 'import',
        title: 'Importing photos',
        status: 'running' as BackgroundTask['status'],
        progress: {
          completed: 0,
          total: selected.reduce((sum, candidate) => sum + candidate.bytes, 0),
          unit: 'bytes' as const,
        },
        items: { completed: 0, total: selected.length, label: 'photos imported' },
        errorCount: 0,
      } as BackgroundTask,
      errors: [] as TaskErrorPage['errors'],
    }
    this.tasks.set(id, task)
    s.phase = 'importing'
    this.changed(s)
    s.task = (async () => {
      try {
        await this.commit(s)
      } catch (error) {
        task.errors.push({ filename: s.source, message: errorMessage(error) })
      } finally {
        // Result summaries outlive preview staging and the review session.
        try {
          await rm(join(this.root, 'staging', id), { recursive: true, force: true })
        } catch (error) {
          task.errors.push({
            filename: s.source,
            message: `Could not clean temporary files: ${errorMessage(error)}`,
          })
        }
        s.phase = s.abort.signal.aborted ? 'cancelled' : 'complete'
        task.snapshot.status = s.abort.signal.aborted
          ? 'cancelled'
          : task.errors.length
            ? 'failed'
            : 'completed'
        task.snapshot.title = s.abort.signal.aborted
          ? 'Import cancelled'
          : task.errors.length
            ? 'Import finished with errors'
            : 'Import complete'
        task.snapshot.errorCount = task.errors.length
        task.snapshot.detail = undefined
        task.snapshot.finishedAt = Date.now()
        this.changed(s, true)
      }
    })()
  }

  private async commit(s: Session): Promise<void> {
    const task = this.tasks.get(s.id)!
    for (const c of s.candidates) {
      if (s.abort.signal.aborted) break
      if (c.status !== 'ready' || !c.selected || !c.hash || !c.preview || !c.cacheDir) continue
      const finalDir = join(this.root, 'originals', c.hash)
      const staging = join(this.root, 'staging', s.id, `copy-${c.id}`)
      let published = false
      let committed = false
      try {
        if (this.find(c.hash)) {
          c.status = 'duplicate'
          c.selected = false
          c.message = 'Already imported'
          continue
        }
        await mkdir(staging, { recursive: true })
        task.snapshot.detail = c.filename
        this.changed(s)
        const hash = await this.transfer(
          c.path,
          join(staging, `original${extname(c.path).toLowerCase()}`),
          s.abort.signal,
          (bytes) => {
            task.snapshot.progress!.completed += bytes
            this.changed(s)
          },
        )
        task.snapshot.detail = `Finalizing ${c.filename}…`
        this.changed(s)
        if (hash !== c.hash)
          throw new Error(
            'The source changed after review. Choose it again to review the updated photo.',
          )
        await cp(join(c.cacheDir, 'thumb.jpg'), join(staging, 'thumb.jpg'))
        await cp(join(c.cacheDir, 'preview.jpg'), join(staging, 'preview.jpg'))
        s.abort.signal.throwIfAborted()
        const photo: Photo = {
          ...c.preview.metadata,
          id: c.hash,
          filename: c.filename,
          format: extname(c.path).slice(1).toUpperCase(),
          bytes: c.bytes,
          importedAt: new Date().toISOString(),
          thumbnailUrl: `luma-photo://library/${c.hash}/thumb`,
          previewUrl: `luma-photo://library/${c.hash}/preview`,
          previewSource: c.preview.source,
        }
        await rename(staging, finalDir)
        published = true
        this.db.exec('BEGIN IMMEDIATE')
        try {
          this.db
            .prepare(
              'INSERT INTO photos (id, imported_at, photo, processing_identity) VALUES (?, ?, ?, ?)',
            )
            .run(
              photo.id,
              photo.importedAt,
              JSON.stringify(photo),
              this.hdrImports && c.preview.processing?.hdrEligible ? 'hdr-v1' : 'legacy-sdr-v1',
            )
          if (c.preview.processing)
            this.db.prepare('INSERT OR REPLACE INTO processing (id, data) VALUES (?, ?)').run(
              photo.id,
              JSON.stringify({
                metadata: c.preview.processing,
                settings: automaticLensSettings,
                revision: 0,
              }),
            )
          this.db.exec('COMMIT')
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
        committed = true
        task.snapshot.items!.completed++
        c.status = 'imported'
        c.selected = false
        c.thumbnailUrl = photo.thumbnailUrl
        s.firstImportedId ??= photo.id
        this.changed(s, true)
      } catch (error) {
        c.status = 'error'
        c.selected = false
        c.message = s.abort.signal.aborted
          ? 'Cancelled before this photo was imported'
          : errorMessage(error)
        if (!s.abort.signal.aborted) {
          task.errors.push({ filename: c.filename, message: c.message })
          task.snapshot.errorCount = task.errors.length
        }
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined)
        if (published && !committed)
          await rm(finalDir, { recursive: true, force: true }).catch(() => undefined)
        this.changed(s)
      }
    }
  }

  async cancel(id: string): Promise<void> {
    const s = this.getSession(id)
    const task = this.tasks.get(id)
    if (task && task.snapshot.status === 'running') {
      task.snapshot.status = 'cancelling'
      task.snapshot.title = 'Cancelling import…'
      this.changed(s)
    }
    s.abort.abort()
    await s.task
    s.phase = 'cancelled'
    this.changed(s)
  }

  async dispose(id: string): Promise<void> {
    await this.cancel(id)
    await rm(join(this.root, 'staging', id), { recursive: true, force: true })
    this.session = undefined
  }

  imagePath(url: string): string | undefined {
    if (this.closed) return
    const parsed = new URL(url)
    if (
      parsed.protocol !== 'luma-photo:' ||
      parsed.search ||
      parsed.hash ||
      parsed.port ||
      parsed.username ||
      parsed.password
    )
      return
    const parts = parsed.pathname.slice(1).split('/')
    if (parsed.hostname === 'library' && parts.length === 2) {
      const [id, kind] = parts
      if (hashPattern.test(id) && ['thumb', 'preview'].includes(kind) && this.find(id)) {
        const original = join(this.root, 'originals', id, `${kind}.jpg`)
        if (existsSync(original)) return original
        const staged = this.removals.stagedPath(id)
        return staged ? join(staged, `${kind}.jpg`) : original
      }
    }
    if (
      parsed.hostname === 'review' &&
      parts.length === 3 &&
      this.session?.id === parts[0] &&
      parts[2] === 'thumb'
    ) {
      const candidate = this.session.candidates.find((c) => c.id === parts[1])
      if (candidate?.cacheDir && candidate.preview) return join(candidate.cacheDir, 'thumb.jpg')
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.metadataProcessor.close()
    await this.metadataTail
    await this.fullPreviews.close()
    if (this.notification) clearTimeout(this.notification)
    try {
      for (const [id, task] of this.tasks) {
        if (task.snapshot.status === 'running' || task.snapshot.status === 'cancelling')
          await this.cancelTask(id)
      }
      if (this.session) await this.dispose(this.session.id)
    } finally {
      try {
        await this.processor.close()
      } finally {
        this.db?.close()
      }
    }
  }
}
