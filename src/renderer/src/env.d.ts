/// <reference types="vite/client" />

import type { LumaApi } from '../../shared/contracts'

declare global {
  interface Window {
    luma: LumaApi
  }
}
