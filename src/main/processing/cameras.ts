import type { CameraProfile } from './contracts'
import { sonyZv1 } from './cameras/sony-zv1'

export const cameraProfiles: readonly CameraProfile[] = [sonyZv1]
export function cameraProfile(make: string, model: string, profiles = cameraProfiles) {
  return profiles.find(
    (profile) =>
      profile.make.toLowerCase() === make.toLowerCase() && profile.aliases.includes(model),
  )
}
