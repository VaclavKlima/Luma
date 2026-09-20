import type { ElectronApplication } from '@playwright/test'
export async function holdFullPreview(app: ElectronApplication) {
  return app.evaluateHandle(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get('preview:request')!
    let release!: () => void
    let failure = false
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    ipcMain.removeHandler('preview:request')
    ipcMain.handle('preview:request', async (...args) => {
      await pending
      return failure ? { error: 'Preview generation timed out.' } : original(...args)
    })
    return {
      release: () => release(),
      fail: () => {
        failure = true
      },
      succeed: () => {
        failure = false
      },
    }
  })
}
