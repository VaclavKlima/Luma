import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Keeps filesystem moves recoverable across failed Trash calls and interrupted database writes. */
export class RemovalStore {
  constructor(
    private root: string,
    private db: DatabaseSync,
    private trash: (path: string) => Promise<void>,
    private repairMemberships: (id: string) => void = () => {},
  ) {}

  private paths(id: string, staged: string) {
    if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}-[a-f0-9-]{36}$/.test(staged))
      throw new Error('Invalid removal journal entry.')
    return {
      original: join(this.root, 'originals', id),
      removed: join(this.root, 'removed', staged),
    }
  }

  private finish(id: string) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM photos WHERE id = ?').run(id)
      this.repairMemberships(id)
      this.db.prepare('DELETE FROM removals WHERE id = ?').run(id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  async recover(): Promise<void> {
    await mkdir(join(this.root, 'removed'), { recursive: true })
    const pending = this.db.prepare('SELECT id, staged FROM removals').all() as {
      id: string
      staged: string
    }[]
    for (const { id, staged } of pending) {
      const paths = this.paths(id, staged)
      if (await exists(paths.removed)) {
        if (await exists(paths.original))
          throw new Error(
            'Both original and removal staging exist. Recovery requires checking the library files.',
          )
        await rename(paths.removed, paths.original)
        this.db.prepare('DELETE FROM removals WHERE id = ?').run(id)
      } else if (await exists(paths.original)) {
        this.db.prepare('DELETE FROM removals WHERE id = ?').run(id)
      } else this.finish(id)
    }
    // Unjournaled directories may have been restored from OS Trash. Never erase them.
  }

  async remove(id: string): Promise<void> {
    const staged = `${id}-${randomUUID()}`
    const paths = this.paths(id, staged)
    this.db.prepare('INSERT INTO removals (id, staged) VALUES (?, ?)').run(id, staged)
    try {
      await rename(paths.original, paths.removed)
      await this.trash(paths.removed)
    } catch (error) {
      try {
        if (await exists(paths.removed)) await rename(paths.removed, paths.original)
        if (await exists(paths.original))
          this.db.prepare('DELETE FROM removals WHERE id = ?').run(id)
      } catch (restoreError) {
        throw new Error(
          `Trash failed and the photo needs recovery on restart: ${String(error)}; ${String(restoreError)}`,
          { cause: restoreError },
        )
      }
      throw error
    }
    this.finish(id)
  }

  stagedPath(id: string): string | undefined {
    const row = this.db.prepare('SELECT staged FROM removals WHERE id = ?').get(id) as
      { staged: string } | undefined
    return row ? this.paths(id, row.staged).removed : undefined
  }
}
