import { expect, test } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PhotoLibrary } from '../src/main/library'
import { PreviewEngine } from '../src/main/preview-engine'
import { processingMetadata } from '../src/main/processing/metadata'
import { noLensSettings } from '../src/shared/lens'
import { initialSettings } from '../src/shared/edits'

test('HDR migration preserves uninitialized photos and upgrades through one shared history entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luma-hdr-migration-'))
  const ids = ['a'.repeat(64), 'b'.repeat(64)]
  for (const id of ids) await mkdir(join(root, 'originals', id), { recursive: true })
  const db = new DatabaseSync(join(root, 'catalog.sqlite'))
  db.exec(
    'CREATE TABLE photos (id TEXT PRIMARY KEY, imported_at TEXT, photo TEXT); CREATE TABLE processing (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE edits (id TEXT PRIMARY KEY, data TEXT); PRAGMA user_version = 8',
  )
  for (const id of ids)
    db.prepare('INSERT INTO photos VALUES (?, ?, ?)').run(
      id,
      '2026',
      JSON.stringify({ id, filename: 'source.ARW' }),
    )
  const metadata = { ...processingMetadata({}, []), hdrEligible: true }
  db.prepare('INSERT INTO processing VALUES (?, ?)').run(
    ids[0],
    JSON.stringify({ metadata, settings: noLensSettings, revision: 0 }),
  )
  const settings = { ...initialSettings(noLensSettings), version: 5, exposureEv: 1.25 }
  delete (settings as { processing?: string }).processing
  const original = {
    photoId: ids[0],
    revision: 3,
    settings,
    snapshots: [{ settings, createdAt: '2026-01-01' }],
    cursor: 0,
    canUndo: false,
    canRedo: false,
  }
  db.prepare('INSERT INTO edits VALUES (?, ?)').run(ids[0], JSON.stringify(original))
  const inspector = { inspect: async () => metadata, close: async () => {} }
  let library = new PhotoLibrary(
    root,
    new PreviewEngine(),
    () => {},
    undefined,
    undefined,
    inspector,
    true,
  )
  try {
    db.exec(
      "CREATE TRIGGER fail_hdr BEFORE UPDATE ON edits BEGIN SELECT RAISE(ABORT, 'hdr migration fault'); END",
    )
    await expect(library.open()).rejects.toThrow('hdr migration fault')
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 8 })
    expect(
      db
        .prepare('PRAGMA table_info(photos)')
        .all()
        .some((column) => column.name === 'processing_identity'),
    ).toBe(false)
    await library.close()
    db.exec('DROP TRIGGER fail_hdr')
    library = new PhotoLibrary(
      root,
      new PreviewEngine(),
      () => {},
      undefined,
      undefined,
      inspector,
      true,
    )
    await library.open()
    expect((await library.getEdits(ids[1])).settings.processing).toBe('legacy-sdr-v1')
    const state = await library.getEditHistory(ids[0])
    expect(state.settings).toMatchObject({
      version: 6,
      processing: 'legacy-sdr-v1',
      exposureEv: 1.25,
    })
    expect(state.snapshots[0].settings).toEqual(state.settings)
    await library.upgradePhotoProcessing(ids[0], 3)
    const upgraded = await library.getEditHistory(ids[0])
    expect(upgraded.snapshots).toHaveLength(2)
    expect(upgraded.settings).toMatchObject({ processing: 'hdr-v1', exposureEv: 1.25 })
    expect((await library.undoEdit(ids[0], 4)).settings.processing).toBe('legacy-sdr-v1')
    expect((await library.redoEdit(ids[0], 5)).settings.processing).toBe('hdr-v1')
    const saved = await library.getEditHistory(ids[0])
    await library.close()
    library = new PhotoLibrary(
      root,
      new PreviewEngine(),
      () => {},
      undefined,
      undefined,
      inspector,
      true,
    )
    await library.open()
    expect(await library.getEditHistory(ids[0])).toEqual(saved)
    await expect(library.upgradePhotoProcessing(ids[0], 3)).rejects.toThrow('conflict')
  } finally {
    db.close()
    await library.close()
    await rm(root, { recursive: true, force: true })
  }
})
