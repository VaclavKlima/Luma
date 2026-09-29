/// <reference types="vite/client" />

import type { LumaApi } from '../../shared/contracts'

declare global {
  interface HdrScreen extends Screen, EventTarget {
    hdrHeadroom?: number
    label?: string
    left?: number
    top?: number
    devicePixelRatio?: number
  }
  interface ScreenDetails extends EventTarget {
    currentScreen: HdrScreen
    screens: HdrScreen[]
  }
  interface Window {
    luma: LumaApi
    getScreenDetails?: () => Promise<ScreenDetails>
    hdrDiagnostic: { onResume: (callback: () => void) => () => void }
  }
}
