import { test, expect } from '@playwright/test'
import { BitmapCache } from '../src/renderer/src/preview/frame-cache'
import type { FullPreview } from '../src/shared/contracts'

function descriptor(id: string, width = 32): FullPreview {
  return {
    photoId: id,
    requestId: id,
    url: id,
    width,
    height: 32,
    format: 'rgba8-srgb',
    byteLength: width * 32 * 4,
    sha256: id,
    renderId: 'test',
  }
}

test('bitmap LRU bounds memory, protects active frames, and closes each evicted resource once', () => {
  const cache = new BitmapCache(8192),
    closed: string[] = []
  const bitmap = (id: string) =>
    ({
      width: 32,
      height: 32,
      close: () => {
        closed.push(id)
      },
    }) as ImageBitmap
  const a = descriptor('a'),
    b = descriptor('b'),
    c = descriptor('c'),
    huge = descriptor('huge', 128)
  cache.insert(a, bitmap('a')).release()
  cache.insert(b, bitmap('b')).release()
  const active = cache.acquire(a)!
  cache.insert(c, bitmap('c')).release()
  expect(closed).toEqual(['b'])
  expect(cache.acquire(b)).toBeNull()
  const oversized = cache.insert(huge, bitmap('huge'))
  expect(closed).toEqual(['b', 'c'])
  active.release()
  active.release()
  expect(closed).toEqual(['b', 'c', 'a'])
  oversized.release()
  expect(closed).toEqual(['b', 'c', 'a', 'huge'])
})

test('bitmap reuse requires the exact frame identity and validates dimensions before lookup', () => {
  const cache = new BitmapCache(),
    first = descriptor('photo'),
    closed: string[] = []
  const bitmap = (id: string) =>
    ({
      width: 32,
      height: 32,
      close: () => {
        closed.push(id)
      },
    }) as ImageBitmap
  const original = cache.insert(first, bitmap('first'))
  const duplicate = cache.insert(first, bitmap('duplicate'))
  expect(duplicate.bitmap).toBe(original.bitmap)
  expect(closed).toEqual(['duplicate'])
  expect(cache.acquire({ ...first, renderId: 'new-engine' })).toBeNull()
  expect(cache.acquire({ ...first, sha256: 'new-pixels' })).toBeNull()
  expect(() => cache.acquire({ ...first, width: Infinity })).toThrow('dimensions')
  original.release()
  duplicate.release()
})
