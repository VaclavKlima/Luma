import { cameraProfile } from './cameras'
import {
  WHITE_BALANCE_MODEL,
  estimateWhiteBalance,
  validateWhiteBalanceProfile,
  type WhiteBalanceProfile,
} from '../../shared/white-balance'
import type { RawMetadata, WhiteBalanceProvider } from './contracts'
export const sonyWhiteBalance: WhiteBalanceProvider = {
  id: 'sony-zv1-white-balance',
  version: '1',
  resolve(metadata) {
    const camera = cameraProfile(metadata.make, metadata.model)
    if (camera?.whiteBalance !== this.id || !metadata.color) return null
    const profile: WhiteBalanceProfile = {
      provider: this.id,
      version: this.version,
      identity: `${this.id}-${this.version}-${camera.id}-${camera.version}`,
      model: WHITE_BALANCE_MODEL,
      ...metadata.color,
      ranges: { kelvin: [2000, 25000], tint: [-100, 100] },
      estimate: { kelvin: 6500, tint: 0 },
    }
    try {
      validateWhiteBalanceProfile(profile)
      profile.estimate = estimateWhiteBalance(profile)
      return profile
    } catch {
      return null
    }
  },
}
export const whiteBalanceProviders: readonly WhiteBalanceProvider[] = [sonyWhiteBalance]
export function resolveWhiteBalance(metadata: RawMetadata, providers = whiteBalanceProviders) {
  return (
    providers.map((provider) => provider.resolve(metadata)).find((value) => value !== null) ??
    undefined
  )
}
