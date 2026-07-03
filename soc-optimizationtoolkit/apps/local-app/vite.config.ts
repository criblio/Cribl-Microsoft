import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
