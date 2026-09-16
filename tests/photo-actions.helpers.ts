import type { ElectronApplication } from '@playwright/test'

export async function isolateTrash(
  app: ElectronApplication,
  options: { delay?: number; failId?: string } = {},
) {
  return app.evaluate(({ app, shell }, options) => {
    const fs = process.getBuiltinModule('fs')
    const path = process.getBuiltinModule('path')
    const destination = path.join(app.getPath('userData'), 'test-trash')
    fs.mkdirSync(destination, { recursive: true })
    shell.trashItem = async (source) => {
      if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay))
      if (options.failId && path.basename(source).startsWith(options.failId))
        throw new Error('System Trash is unavailable')
      await fs.promises.rename(source, path.join(destination, path.basename(source)))
    }
    return destination
  }, options)
}
