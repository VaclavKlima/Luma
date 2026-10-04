import { randomUUID } from 'node:crypto'
import { mkdir, rm, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { MergeProcess } from './process'
import type { MergeResult } from './engine'
import {
  exposure,
  mergeFailure,
  type MergeFailure,
  type MergeDiagnostics,
  validateMergeSettings,
  validateMergeSources,
  mergeUnavailable,
  type MergeMode,
  type MergeReview,
  type MergeSettings,
  type MergeSource,
  type MergePreview,
} from '../../shared/merge'

interface ReviewState {
  review: MergeReview
  paths: string[]
  directory: string
  abort: AbortController
  work?: Promise<MergeResult>
  result?: MergeResult
  output?: string
  nativeWork?: Promise<MergeResult>
  nativeResult?: MergeResult
  nativeOutput?: string
  failure?: MergeFailure
  accepted: boolean
  updating?: boolean
  closing?: boolean
}
export class MergeReviews {
  private state?: ReviewState
  private creating?: string[]
  readonly worker: MergeProcess
  constructor(
    private root: string,
    private source: (id: string) => Promise<{ source: MergeSource; path: string }>,
    workerPath?: string,
  ) {
    this.worker = new MergeProcess(workerPath)
  }
  leased(ids: string[]) {
    return ids.some(
      (id) =>
        this.creating?.includes(id) || this.state?.review.sources.some((s) => s.photo.id === id),
    )
  }
  active(): MergeReview | null {
    return this.state ? structuredClone(this.state.review) : null
  }
  diagnostics(id: string, revision: number): MergeDiagnostics {
    const s = this.get(id, revision)
    return structuredClone({
      reviewId: id,
      revision,
      status: s.failure ? 'failed' : s.result ? 'ready' : 'pending',
      sources: s.review.sources.map((source) => ({
        id: source.photo.id,
        filename: source.photo.filename,
        diagnostics: s.result?.recipe.sources.find((v) => v.id === source.photo.id)?.transform
          .diagnostics,
      })),
      error: s.failure,
      measurements: s.nativeResult?.recipe.measurements ?? s.result?.recipe.measurements,
    })
  }
  async create(ids: string[], mode: MergeMode): Promise<MergeReview> {
    if (this.state || this.creating) throw new Error('Close the current merge review first.')
    if (
      !Array.isArray(ids) ||
      ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) ||
      !['hdr', 'noise'].includes(mode)
    )
      throw new Error('Invalid merge sources.')
    const unavailable = mergeUnavailable(ids.length)
    if (unavailable) throw new Error(unavailable)
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate merge sources.')
    this.creating = [...ids]
    try {
      const inputs = []
      for (const id of ids) inputs.push(await this.source(id))
      const sources = inputs.map((i) => i.source)
      validateMergeSources(sources, mode)
      const sorted = [...sources].sort(
        mode === 'hdr'
          ? (a, b) => exposure(a.capture) - exposure(b.capture)
          : (a, b) =>
              (a.photo.capturedAt ?? a.photo.filename).localeCompare(
                b.photo.capturedAt ?? b.photo.filename,
              ),
      )
      const reference = sorted[Math.floor(sorted.length / 2)]
      for (const s of sources)
        s.relativeEv = Math.log2(exposure(s.capture) / exposure(reference.capture))
      const scratchBytes = Math.ceil(
        sources[0].photo.width * sources[0].photo.height * (sources.length * 20 + 112) +
          (sources.length * 32 + 256) * 1024 ** 2,
      )
      const disk = await statfs(this.root)
      if (disk.bavail * disk.bsize < scratchBytes)
        throw new Error(
          `Insufficient temporary disk space: ${Math.ceil(scratchBytes / 1024 ** 3)} GiB required.`,
        )
      const id = randomUUID(),
        directory = join(this.root, 'merge-reviews', id)
      await mkdir(directory, { recursive: true })
      const review: MergeReview = {
        id,
        revision: 0,
        sources,
        scratchBytes,
        settings: {
          mode,
          autoAlign: true,
          deghost: true,
          strength: 50,
          autoCrop: true,
          referenceId: reference.photo.id,
        },
      }
      this.state = {
        review,
        paths: inputs.map((i) => i.path),
        directory,
        abort: new AbortController(),
        accepted: false,
      }
      return structuredClone(review)
    } finally {
      this.creating = undefined
    }
  }
  private get(id: string, revision?: number, transition = false) {
    const s = this.state
    if (!s || s.review.id !== id) throw new Error('Merge review is unavailable.')
    if (!transition && (s.updating || s.closing))
      throw new Error('Merge review is updating or closing.')
    if (
      revision !== undefined &&
      (!Number.isSafeInteger(revision) || revision !== s.review.revision)
    )
      throw new Error('Stale merge review. Refresh the review before proceeding.')
    return s
  }
  async update(id: string, revision: number, settings: MergeSettings) {
    const s = this.get(id, revision)
    if (s.accepted) throw new Error('This merge was already accepted.')
    validateMergeSettings(
      settings,
      s.review.sources.map((s) => s.photo.id),
    )
    validateMergeSources(s.review.sources, settings.mode)
    const previousReference = s.review.settings.referenceId
    // Advance synchronously before awaiting cancellation so concurrent callers conflict.
    try {
      s.updating = true
      s.review = { ...s.review, revision: revision + 1, settings: structuredClone(settings) }
      s.abort.abort()
      await Promise.all([s.work?.catch(() => {}), s.nativeWork?.catch(() => {})])
      if (this.state !== s || s.closing) throw new Error('Merge review is unavailable.')
      await rm(join(s.directory, `revision-${revision}`), { recursive: true, force: true })
      await rm(join(s.directory, `native-${revision}`), { recursive: true, force: true })
      if (previousReference !== settings.referenceId)
        await rm(join(s.directory, 'prepared'), { recursive: true, force: true })
      s.work = undefined
      s.result = undefined
      s.failure = undefined
      s.output = undefined
      s.nativeWork = undefined
      s.nativeResult = undefined
      s.nativeOutput = undefined
      s.abort = new AbortController()
      s.updating = false
    } finally {
      s.updating = false
    }
    return structuredClone(s.review)
  }
  async preview(id: string, revision: number, detail = false): Promise<MergePreview> {
    if (typeof detail !== 'boolean') throw new Error('Invalid merge detail request.')
    const s = this.get(id, revision)
    if (s.accepted) throw new Error('This merge was already accepted.')
    if (!s.work) {
      const directory = join(s.directory, 'prepared'),
        output = join(s.directory, `revision-${revision}`)
      s.output = output
      s.work = (async () => {
        await mkdir(directory, { recursive: true })
        this.get(id, revision)
        return this.worker.run(
          {
            preview: true,
            directory,
            output,
            paths: s.paths,
            sources: s.review.sources,
            settings: s.review.settings,
          },
          s.abort.signal,
          () => {},
        )
      })()
    }
    try {
      s.result = await s.work
    } catch (error) {
      if (this.state === s && s.review.revision === revision) s.failure = mergeFailure(error)
      throw error
    }
    this.get(id, revision)
    const result = detail
      ? await this.native(s, s.abort.signal, () => {}, true)
      : (s.nativeResult ?? s.result)
    const url = `luma-photo://merge/${id}/${revision}`
    return {
      reviewId: id,
      revision,
      resultUrl: `${url}/${s.nativeResult ? 'final-' : ''}result`,
      referenceUrl: `${url}/${s.nativeResult ? 'final-' : ''}reference`,
      overlayUrl: `${url}/${s.nativeResult ? 'final-' : ''}overlay`,
      nativeResultUrl: `${url}/native-result`,
      nativeReferenceUrl: `${url}/native-reference`,
      nativeOverlayUrl: `${url}/native-overlay`,
      width: result.recipe.crop.width,
      height: result.recipe.crop.height,
      recipe: result.recipe,
    }
  }
  private async native(
    s: ReviewState,
    signal: AbortSignal,
    progress: (phase: string, completed: number, total: number) => void,
    comparisons = false,
  ): Promise<MergeResult> {
    signal.throwIfAborted()
    if (s.nativeResult) return s.nativeResult
    if (s.result?.recipe.resolution === 'native') {
      s.nativeOutput = s.output
      return s.result
    }
    const cancel = () => s.abort.abort()
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (!s.nativeWork) {
        s.nativeOutput = join(s.directory, `native-${s.review.revision}`)
        s.nativeWork = this.worker.run(
          {
            directory: join(s.directory, 'prepared'),
            output: s.nativeOutput,
            paths: s.paths,
            sources: s.review.sources,
            settings: s.review.settings,
            recipe: s.result!.recipe,
            comparisons,
          },
          s.abort.signal,
          progress,
        )
      }
      let result: MergeResult
      try {
        result = await s.nativeWork
      } catch (error) {
        if (this.state === s) s.failure = mergeFailure(error)
        throw error
      }
      this.get(s.review.id, s.review.revision)
      const initial = s.result!.measurements,
        sameResult = initial === result.measurements,
        final = structuredClone(result.measurements)
      result.measurements = final
      result.recipe.measurements = final
      if (!sameResult) {
        for (const stage of Object.keys(final.stages) as (keyof typeof final.stages)[])
          final.stages[stage] += initial.stages[stage]
        final.preparation = initial.preparation
        final.attempts = initial.attempts
        final.disk.readBytes += initial.disk.readBytes
        final.disk.writtenBytes += initial.disk.writtenBytes
        for (const key of Object.keys(final.peak) as (keyof typeof final.peak)[])
          final.peak[key] = Math.max(final.peak[key], initial.peak[key])
        final.runtimeMs += initial.runtimeMs
      }
      s.nativeResult = result
      return result
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }
  accept(id: string, revision: number) {
    const s = this.get(id, revision)
    if (s.accepted || !s.result || !s.output)
      throw new Error('Wait for the current merge preview before accepting.')
    s.accepted = true
    return {
      render: async (
        signal: AbortSignal,
        progress: (phase: string, completed: number, total: number) => void,
      ) => ({ result: await this.native(s, signal, progress), output: s.nativeOutput! }),
      review: structuredClone(s.review),
    }
  }
  async dispose(id: string, finished = false) {
    const s = this.get(id, undefined, true)
    if (s.accepted && !finished) throw new Error('Cancel the background merge task first.')
    s.closing = true
    s.abort.abort()
    await Promise.all([s.work?.catch(() => {}), s.nativeWork?.catch(() => {})])
    await rm(s.directory, { recursive: true, force: true })
    if (this.state === s) this.state = undefined
  }
  imagePath(parts: string[]) {
    const s = this.state
    if (
      parts.length !== 3 ||
      !s ||
      parts[0] !== s.review.id ||
      parts[1] !== String(s.review.revision) ||
      !s.result ||
      ![
        'result',
        'reference',
        'overlay',
        'native-result',
        'native-reference',
        'native-overlay',
        'final-result',
        'final-reference',
        'final-overlay',
      ].includes(parts[2])
    )
      return
    const directory =
      parts[2].startsWith('native-') || parts[2].startsWith('final-') ? s.nativeOutput : s.output
    if (!directory) return
    return join(directory, `${parts[2].replace(/^final-/, '')}.png`)
  }
  async close() {
    if (this.state) await this.dispose(this.state.review.id, true)
  }
}
