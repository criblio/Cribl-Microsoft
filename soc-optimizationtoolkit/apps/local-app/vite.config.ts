import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'

// The app version shown in the always-visible sidebar footer, read from this
// app's package.json and injected as a build-time constant.
const APP_VERSION: string = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
).version

// Web build for the local shell.
//
// Dev:   `npm run dev` serves src/web with HMR and proxies /api to the
//        running local host (`npm run start` in another terminal; 4600 is
//        the port in config/local-config.example.json - if you changed
//        "port" in your local-config.json, adjust the proxy target too).
// Build: `npm run build` bundles into dist/web, which the host serves
//        statically at "/" (see src/host/static.mjs).
export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4600',
    },
  },
  build: {
    outDir: 'dist/web',
    assetsDir: 'assets',
  },
})
