import type { ElectronApplication, Page } from '@playwright/test'
import sharp from 'sharp'
import { test, expect } from './electron.fixture'
import { importPhotos } from './import.helpers'
import {
  MERGE_LIMITS,
  MERGE_VERSION,
  type MergeReview,
  type MergeRecipe,
} from '../src/shared/merge'

async function setup(
  app: ElectronApplication,
  page: Page,
  width = 1600,
  height = 1000,
  holdInitial = false,
  sourceCount = 2,
) {
  await importPhotos(app, page)
  const photos = (await page.evaluate(() => window.luma.listPhotos())).photos
  const native = await app.browserWindow(page)
  await native.evaluate((w) => {
    w.unmaximize()
    w.setContentSize(1100, 700)
  })
  await page.getByTestId('console-toggle').click()
  const assets = await Promise.all(
    [
      [width, height],
      [800, 600],
    ].map(async ([width, height]) => {
      const urls = await Promise.all(
        ['#646464', '#414141', '#b500a040'].map(
          async (background) =>
            `data:image/png;base64,${(
              await sharp({ create: { width, height, channels: 4, background } })
                .png()
                .toBuffer()
            ).toString('base64')}`,
        ),
      )
      return { width, height, urls }
    }),
  )
  const review: MergeReview = {
    id: 'fixture-review',
    revision: 0,
    scratchBytes: 1024,
    sources: Array.from({ length: sourceCount }, (_, i) => ({
      photo:
        i < photos.length
          ? photos[i]
          : { ...photos[i % photos.length], id: i.toString(16).padStart(64, '0') },
      relativeEv: 0,
      capture: { shutterSeconds: 1 / 125, iso: 400, aperture: 4, focalLength: 9.4 },
      metadata: {} as MergeReview['sources'][number]['metadata'],
    })),
    settings: {
      mode: 'hdr',
      autoAlign: true,
      deghost: true,
      strength: 50,
      autoCrop: true,
      referenceId: photos[1].id,
    },
  }
  const recipe: MergeRecipe = {
    resolution: 'native',
    version: MERGE_VERSION,
    constants: MERGE_LIMITS,
    settings: review.settings,
    sources: [],
    width,
    height,
    crop: { left: 0, top: 0, width, height },
    maskDimensions: { width, height },
    affectedPercent: 2,
    referenceClippedPercent: 0,
    maskSha256: '',
  }
  const control = await app.evaluateHandle(
    ({ ipcMain }, { review, recipe, assets, holdInitial }) => {
      let active = structuredClone(review),
        disposed = 0,
        creates = 0
      const holds = new Map<number, { wait: Promise<void>; release: () => void }>()
      const failures = new Set<number>(),
        mismatches = new Set<number>()
      const calls: { revision: number; arguments: number }[] = []
      function hold(revision: number) {
        let release!: () => void
        const wait = new Promise<void>((resolve) => {
          release = resolve
        })
        holds.set(revision, { wait, release })
      }
      if (holdInitial) hold(0)
      const handlers = {
        'merge:create': (_event: unknown, _ids: string[], mode: 'hdr' | 'noise') => {
          active = {
            ...structuredClone(review),
            id: `fixture-review-${++creates}`,
            settings: { ...review.settings, mode },
          }
          return { result: active }
        },
        'merge:active': () => ({ result: active }),
        'merge:update': (
          _event: unknown,
          id: string,
          revision: number,
          settings: MergeReview['settings'],
        ) => {
          if (id !== active.id || revision !== active.revision)
            throw new Error('Stale fixture revision')
          active = { ...active, revision: revision + 1, settings }
          return { result: active }
        },
        'merge:preview': async (...args: unknown[]) => {
          const revision = args[2] as number,
            snapshot = structuredClone(active)
          calls.push({ revision, arguments: args.length - 1 })
          await holds.get(revision)?.wait
          if (failures.has(revision))
            return {
              error: {
                code: 'processing',
                message: 'Injected native render failure.',
                filenames: [],
                diagnostics: [],
              },
            }
          const image = assets[snapshot.settings.autoCrop ? 0 : 1]
          return {
            result: {
              reviewId: snapshot.id,
              revision,
              width: image.width + Number(mismatches.has(revision)),
              height: image.height,
              resultUrl: image.urls[0],
              referenceUrl: image.urls[1],
              overlayUrl: image.urls[2],
              recipe: {
                ...recipe,
                settings: snapshot.settings,
                crop: { ...recipe.crop, width: image.width, height: image.height },
              },
            },
          }
        },
        'merge:dispose': () => {
          disposed++
          return { result: undefined }
        },
      }
      for (const [name, handler] of Object.entries(handlers)) {
        ipcMain.removeHandler(name)
        ipcMain.handle(name, handler)
      }
      return {
        hold,
        release: (revision: number) => holds.get(revision)?.release(),
        fail: (revision: number) => failures.add(revision),
        mismatch: (revision: number) => mismatches.add(revision),
        state: () => ({ calls, disposed, revision: active.revision }),
      }
    },
    { review, recipe, assets, holdInitial },
  )
  await page.getByTestId(`photo-card-${photos[0].id}`).click()
  await page.getByTestId(`photo-card-${photos[1].id}`).click({ modifiers: ['Shift'] })
  async function open(mode = 'Merge to HDR…') {
    await page.getByRole('button', { name: 'Actions', exact: true }).click()
    await page.getByRole('menuitem', { name: mode, exact: true }).click()
  }
  await open()
  const viewport = page.getByTestId('merge-viewport'),
    zoom = page.getByRole('combobox', { name: 'Merge preview zoom' })
  if (!holdInitial) await expect(viewport).toHaveAttribute('data-ready', 'true')
  const view = () =>
    viewport.evaluate((el) => ({
      scale: Number(el.dataset.scale),
      x: Number(el.dataset.panX),
      y: Number(el.dataset.panY),
      fit: el.dataset.fit === 'true',
    }))
  return { control, viewport, zoom, view, native, open }
}

test('native pixel scale, pointer anchoring, bounded drag and scoped zoom shortcuts', async ({
  luma,
}) => {
  const { page, app } = luma,
    { viewport, zoom, view } = await setup(app, page)
  const box = (await viewport.boundingBox())!
  expect((await view()).scale).toBeCloseTo(Math.min(1, box.width / 1600, box.height / 1000), 5)
  await zoom.selectOption('1')
  const image = page.getByAltText('Merged result', { exact: true })
  expect((await image.boundingBox())!.width).toBe(1600)
  expect((await image.boundingBox())!.height).toBe(1000)
  const pointer = { x: box.x + box.width / 2 + 70, y: box.y + box.height / 2 + 45 },
    before = await view()
  await page.mouse.move(pointer.x, pointer.y)
  await viewport.evaluate((el) =>
    el.addEventListener(
      'wheel',
      (event) => {
        const wheel = event as WheelEvent,
          box = el.getBoundingClientRect()
        el.dataset.anchorX = String(wheel.clientX - box.left - box.width / 2)
        el.dataset.anchorY = String(wheel.clientY - box.top - box.height / 2)
      },
      { once: true },
    ),
  )
  await page.mouse.wheel(0, -140)
  await expect.poll(async () => (await view()).scale).toBeGreaterThan(1)
  const after = await view()
  const anchor = await viewport.evaluate((el) => ({
    x: Number(el.dataset.anchorX),
    y: Number(el.dataset.anchorY),
  }))
  expect((anchor.x - before.x) / before.scale).toBeCloseTo((anchor.x - after.x) / after.scale, 5)
  expect((anchor.y - before.y) / before.scale).toBeCloseTo((anchor.y - after.y) / after.scale, 5)
  await zoom.selectOption('1')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect(viewport).toHaveAttribute('data-dragging', 'true')
  await page.mouse.move(box.x + box.width + 500, box.y + box.height + 300)
  await page.mouse.up()
  expect((await view()).x).toBeCloseTo((1600 - box.width) / 2, 4)
  expect((await view()).y).toBeCloseTo((1000 - box.height) / 2, 4)
  await expect(viewport).toHaveAttribute('data-dragging', 'false')
  await viewport.focus()
  await viewport.press('0')
  await expect(viewport).toHaveAttribute('data-fit', 'true')
  await viewport.press('1')
  await viewport.press('ArrowRight')
  expect((await view()).x).toBe(-40)
  await viewport.press('Shift+ArrowDown')
  expect((await view()).y).toBe(-120)
  await viewport.press('+')
  await expect(viewport).toHaveAttribute('data-scale', '2')
  await viewport.press('-')
  await expect(viewport).toHaveAttribute('data-scale', '1')
  await viewport.dblclick()
  await expect(viewport).toHaveAttribute('data-fit', 'true')
  await viewport.dblclick()
  await expect(viewport).toHaveAttribute('data-scale', '1')
  await zoom.selectOption('32')
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Zoom in', exact: true }),
  ).toBeDisabled()
  await viewport.dispatchEvent('wheel', { deltaY: -200, ctrlKey: true })
  await expect(viewport).toHaveAttribute('data-scale', '32')
  expect(
    await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((w) => w.getType() === 'window')
        .map((w) => w.getZoomFactor()),
    ),
  ).toEqual([1])
})

test('comparison, overlay and native revisions retain zoom and normalized framing', async ({
  luma,
}) => {
  const { page, app } = luma,
    { control, viewport, zoom, view } = await setup(app, page)
  await zoom.selectOption('1')
  await viewport.focus()
  await viewport.press('ArrowLeft')
  await viewport.press('ArrowUp')
  const before = await view()
  await page.getByRole('checkbox', { name: 'Show deghost overlay' }).check()
  expect(await page.getByAltText('Deghosted areas').boundingBox()).toEqual(
    await page.getByAltText('Merged result', { exact: true }).boundingBox(),
  )
  await page.getByRole('button', { name: 'Show prepared reference' }).click()
  expect(await view()).toEqual(before)
  await expect(page.getByAltText('Deghosted areas')).toHaveCount(0)
  await page.getByRole('button', { name: 'Show merged result' }).click()
  expect(await view()).toEqual(before)
  await control.evaluate((c) => c.hold(1))
  await page.getByRole('checkbox', { name: 'Auto Crop', exact: true }).uncheck()
  await expect(viewport).toHaveAttribute('data-ready', 'false')
  await expect(page.getByAltText('Merged result', { exact: true })).toHaveCount(0)
  await expect(zoom).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled()
  await viewport.dispatchEvent('wheel', { deltaY: -200 })
  expect(await view()).toEqual(before)
  await expect.poll(async () => (await control.evaluate((c) => c.state())).calls.length).toBe(2)
  await control.evaluate((c) => c.release(1))
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  const after = await view()
  expect(after.scale).toBe(before.scale)
  expect(after.x).toBe((before.x * 800) / 1600)
  expect(after.y).toBe((before.y * 600) / 1000)
  expect((await page.getByAltText('Merged result', { exact: true }).boundingBox())!.width).toBe(800)
  await page
    .getByRole('complementary', { name: 'Merge sources' })
    .getByRole('button')
    .first()
    .click()
  await expect.poll(async () => (await control.evaluate((c) => c.state())).revision).toBe(2)
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  expect(await view()).toEqual(after)
  await page.getByRole('combobox', { name: 'Mode', exact: true }).selectOption('noise')
  await expect.poll(async () => (await control.evaluate((c) => c.state())).revision).toBe(3)
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  expect(await view()).toEqual(after)
  await page.getByRole('button', { name: 'Fit merge preview' }).click()
  await page.getByRole('checkbox', { name: 'Auto Align', exact: true }).uncheck()
  await expect.poll(async () => (await control.evaluate((c) => c.state())).revision).toBe(4)
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  await expect(viewport).toHaveAttribute('data-fit', 'true')
  await viewport.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await control.evaluate((c) => c.state())).disposed).toBeGreaterThan(0)
})

test('stale native replies cannot enable Merge, and failed or invalid frames retry through a new revision', async ({
  luma,
}) => {
  const { page, app } = luma,
    { control, viewport, view, open } = await setup(app, page, 1600, 1000, true)
  await control.evaluate((c) => c.hold(1))
  await page.getByRole('checkbox', { name: 'Auto Crop', exact: true }).uncheck()
  await expect.poll(async () => (await control.evaluate((c) => c.state())).calls.length).toBe(2)
  await control.evaluate((c) => c.release(0))
  await expect(viewport).toHaveAttribute('data-ready', 'false')
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled()
  await control.evaluate((c) => c.release(1))
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  await viewport.focus()
  await viewport.press('1')
  const before = await view()
  await control.evaluate((c) => c.fail(2))
  await page.getByRole('checkbox', { name: 'Auto Align', exact: true }).uncheck()
  await expect(page.getByRole('alert')).toHaveText('Injected native render failure.')
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeDisabled()
  await control.evaluate((c) => c.mismatch(3))
  await page.getByRole('button', { name: 'Retry preview' }).click()
  await expect(page.getByRole('alert')).toContainText('dimensions do not match')
  await expect(page.getByAltText('Merged result', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Retry preview' }).click()
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  expect(await view()).toEqual(before)
  const state = await control.evaluate((c) => c.state())
  expect(state.calls.map((c) => c.revision)).toEqual([0, 1, 2, 3, 4])
  expect(state.calls.every((c) => c.arguments === 2)).toBe(true)
  await viewport.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('selection-count')).toHaveText('2 selected')
  await open('Stack for noise reduction…')
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  await expect(viewport).toHaveAttribute('data-fit', 'true')
})

test('pointer capture cleans up on cancellation, blur, loading and resize; fields and panels keep their controls', async ({
  luma,
}) => {
  const { page, app } = luma,
    { control, viewport, zoom, view, native } = await setup(app, page, 1600, 1000, false, 24)
  await zoom.selectOption('1')
  async function begin() {
    const box = (await viewport.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await expect(viewport).toHaveAttribute('data-dragging', 'true')
  }
  await begin()
  await viewport.dispatchEvent('pointercancel', { pointerId: 1 })
  await expect(viewport).toHaveAttribute('data-dragging', 'false')
  await page.mouse.up()
  await begin()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(viewport).toHaveAttribute('data-dragging', 'false')
  await page.mouse.up()
  await begin()
  await native.evaluate((w) => w.setContentSize(1200, 760))
  await expect(viewport).toHaveAttribute('data-dragging', 'false')
  await page.mouse.up()
  await native.evaluate((w) => w.setContentSize(1100, 700))
  await control.evaluate((c) => c.hold(1))
  await begin()
  await page
    .getByRole('checkbox', { name: 'Auto Align', exact: true })
    .evaluate((el) => (el as HTMLInputElement).click())
  await expect(viewport).toHaveAttribute('data-dragging', 'false')
  expect(await viewport.evaluate((el) => el.hasPointerCapture(1))).toBe(false)
  await page.mouse.up()
  await expect.poll(async () => (await control.evaluate((c) => c.state())).calls.length).toBe(2)
  await control.evaluate((c) => c.release(1))
  await expect(viewport).toHaveAttribute('data-ready', 'true')
  const before = await view(),
    strength = page.getByRole('spinbutton', { name: 'Deghost strength value' })
  await strength.fill('72')
  await strength.press('ArrowLeft')
  await strength.press('Escape')
  await expect(strength).toHaveValue('50')
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await view()).toEqual(before)
  const panel = page.getByRole('complementary', { name: 'Merge sources' })
  await panel.hover()
  await page.mouse.wheel(0, 400)
  await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  expect(await view()).toEqual(before)
  const bounds = (await page.getByRole('dialog').boundingBox())!
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1100)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(700)
  await viewport.focus()
  await viewport.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

for (const [width, height] of [
  [80, 48],
  [900, 1800],
]) {
  test(`Fit uses actual decoded ${width} × ${height} pixels without upscaling`, async ({
    luma,
  }) => {
    const { page, app } = luma,
      { viewport, view, native } = await setup(app, page, width, height)
    const box = (await viewport.boundingBox())!,
      fit = Math.min(1, box.width / width, box.height / height)
    expect((await view()).scale).toBeCloseTo(fit, 5)
    expect(
      (await page.getByAltText('Merged result', { exact: true }).boundingBox())!.width,
    ).toBeCloseTo(width * fit, 3)
    await native.evaluate((w) => w.setContentSize(1200, 760))
    const resized = (await viewport.boundingBox())!
    await expect
      .poll(async () => (await view()).scale)
      .toBeCloseTo(Math.min(1, resized.width / width, resized.height / height), 5)
  })
}
