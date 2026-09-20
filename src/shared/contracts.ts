import type { PhotoStatistics } from './statistics'
import type { AdjustmentParameters } from './adjustments'
import type { DisplayTransform } from './adjustments'
import type { EditState, EditPatch, EditHistory } from './edits'
import type { CorrectionKind, LensSettings, LensState } from './lens'
export interface AppInfo {
  version: string
  platform: 'linux' | 'darwin' | 'win32'
}

export interface LumaApi {
  onFlushEdits(listener: () => Promise<void>): () => void
  getPhotoStatistics(photoId: string, expectedRevision: number): Promise<PhotoStatistics>
  getEdits(photoId: string): Promise<EditState>
  updateEdits(photoId: string, patch: EditPatch, expectedRevision: number): Promise<EditState>
  getEditHistory(photoId: string): Promise<EditHistory>
  undoEdit(photoId: string, expectedRevision: number): Promise<EditState>
  redoEdit(photoId: string, expectedRevision: number): Promise<EditState>
  getLensSettings(photoId: string): Promise<LensState>
  updateLensSettings(photoId: string, kind: CorrectionKind, enabled: boolean): Promise<LensState>
  getAppInfo(): Promise<AppInfo>
  listPhotos(offset?: number): Promise<PhotoPage>
  locatePhoto(id: string, direction?: -1 | 0 | 1): Promise<PhotoLocation | null>
  getPhotoRange(fromId: string, toId: string): Promise<PhotoReference[]>
  requestEditingPreview(photoId: string, requestId: string): Promise<FullPreview>
  requestFullPreview(photoId: string, requestId: string, regenerate?: boolean): Promise<FullPreview>
  requestCachedFullPreview(photoId: string, requestId: string): Promise<FullPreview | null>
  releaseFullPreview(requestId: string): Promise<void>
  deletePhotos(ids: string[]): Promise<string | null>
  listTasks(): Promise<BackgroundTask[]>
  cancelTask(id: string): Promise<void>
  dismissTask(id: string): Promise<void>
  getTaskErrors(id: string, offset?: number): Promise<TaskErrorPage>
  chooseSource(kind: 'files' | 'folder', recursive: boolean): Promise<string | null>
  getReview(sessionId: string, offset?: number): Promise<ImportReview>
  selectCandidates(sessionId: string, ids: string[] | null, selected: boolean): Promise<void>
  importSelected(sessionId: string): Promise<void>
  cancelImport(sessionId: string): Promise<void>
  disposeImport(sessionId: string): Promise<void>
  onLibraryEvent(listener: (event: LibraryEvent) => void): () => void
}

export interface PhotoMetadata {
  width: number
  height: number
  camera?: string
  lens?: string
  capturedAt?: string
  aperture?: string
  shutter?: string
  iso?: string
  focalLength?: string
}

export interface Photo extends PhotoMetadata {
  id: string
  filename: string
  format: string
  bytes: number
  importedAt: string
  thumbnailUrl: string
  previewUrl: string
  previewSource: 'image' | 'embedded' | 'decoded'
}

export interface LinearAsset {
  url?: string
  byteLength: number
  sha256: string
  transform: DisplayTransform
}
export interface FullPreview {
  adjustments?: AdjustmentParameters
  linear?: LinearAsset
  settingsRevision?: number
  appliedCorrections?: LensSettings
  photoId: string
  requestId: string
  url: string
  width: number
  height: number
  format: 'rgba8-srgb'
  byteLength: number
  sha256: string
  renderId: string
  placeholderUrl?: string
}

export type PhotoReference = Pick<Photo, 'id' | 'filename'>

export interface PhotoPage {
  photos: Photo[]
  total: number
}

export interface PhotoLocation extends PhotoPage {
  offset: number
  index: number
}

export interface BackgroundTask {
  kind: 'import' | 'delete'
  id: string
  title: string
  status: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'
  detail?: string
  progress?: { completed: number; total: number; unit: 'bytes' | 'items' }
  items?: { completed: number; total: number; label: string }
  errorCount: number
  finishedAt?: number
}

export interface TaskErrorPage {
  errors: { filename: string; message: string }[]
  total: number
}

export type CandidateStatus = 'processing' | 'ready' | 'duplicate' | 'error' | 'imported'
export interface ImportCandidate {
  id: string
  filename: string
  relativePath: string
  bytes: number
  status: CandidateStatus
  selected: boolean
  thumbnailUrl?: string
  message?: string
}

export interface ImportReview {
  sessionId: string
  source: string
  phase: 'scanning' | 'review' | 'importing' | 'complete' | 'cancelled'
  candidates: ImportCandidate[]
  total: number
  selected: number
  selectedBytes: number
  ready: number
  duplicates: number
  errors: number
  imported: number
  skipped: number
  firstImportedId?: string
}

export interface LibraryEvent {
  editsChanged?: { photoId: string; revision: number }
  lensChanged?: { photoId: string; revision: number }
  sessionId?: string
  libraryChanged?: boolean
  tasksChanged?: boolean
  firstImportedId?: string
  deletedIds?: string[]
  replacementId?: string
}

export const PAGE_SIZE = 60
