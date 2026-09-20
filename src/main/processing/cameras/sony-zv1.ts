import type { CameraProfile } from '../contracts'

export const sonyZv1: CameraProfile = {
  id: 'sony-zv1-family',
  version: '1',
  make: 'Sony',
  aliases: ['ZV-1', 'ZV-1A'],
  gpu: { algorithm: 'bayer-ahd', cfa: [0, 1, 3, 2], colors: 3, pixelAspect: 1 },
  whiteBalance: 'sony-zv1-white-balance',
  coordinates: 'active-sensor',
  orientation: 'decoder-flip-once',
}
