import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { randomBytes } from 'node:crypto'

export default defineConfig(({ command }) => {
  const nonce = command === 'serve' ? randomBytes(18).toString('base64') : undefined

  return {
    main: {
      build: {
        rollupOptions: {
          external: ['webgpu'],
          input: {
            index: 'src/main/index.ts',
            'preview-worker': 'src/main/preview-worker.ts',
            'hdr-diagnostic': 'src/main/hdr-diagnostic.ts',
          },
        },
      },
    },
    preload: {
      build: {
        rollupOptions: {
          input: {
            index: 'src/preload/index.ts',
            'hdr-diagnostic': 'src/preload/hdr-diagnostic.ts',
          },
          output: { format: 'cjs', entryFileNames: '[name].cjs' },
        },
      },
    },
    renderer: {
      build: {
        rollupOptions: {
          input: {
            index: 'src/renderer/index.html',
            'hdr-diagnostic': 'src/renderer/hdr-diagnostic.html',
          },
        },
      },
      html: { cspNonce: nonce },
      plugins: [
        react(),
        {
          name: 'luma-development-csp',
          apply: 'serve',
          transformIndexHtml: {
            order: 'pre',
            handler: (html) =>
              html.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`),
          },
        },
      ],
      server: {
        host: '127.0.0.1',
        port: Number(process.env.LUMA_DEV_PORT ?? 5173),
        strictPort: true,
      },
    },
  }
})
