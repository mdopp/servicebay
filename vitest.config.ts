import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    env: {
      DATA_DIR: '/tmp/servicebay-test',
    },
    alias: [
      // Phase 3.2 (#763) — the moved FE dirs win over the bare `@/`
      // mapping. Resolution checks longest-prefix first so `@/components`
      // routes into packages/frontend before the catch-all `@/*` mapping
      // into src/.
      { find: /^@\/components\//, replacement: path.resolve(__dirname, './packages/frontend/src/components/') + '/' },
      { find: /^@\/config\//, replacement: path.resolve(__dirname, './packages/frontend/src/config/') + '/' },
      { find: /^@\/hooks\//, replacement: path.resolve(__dirname, './packages/frontend/src/hooks/') + '/' },
      { find: /^@\/dashboards\//, replacement: path.resolve(__dirname, './packages/frontend/src/dashboards/') + '/' },
      { find: /^@\/providers\//, replacement: path.resolve(__dirname, './packages/frontend/src/providers/') + '/' },
      { find: /^@\/lib\//, replacement: path.resolve(__dirname, './packages/backend/src/lib/') + '/' },
      { find: '@servicebay/api-client', replacement: path.resolve(__dirname, './packages/api-client/src/index.ts') },
      { find: /^@\//, replacement: path.resolve(__dirname, './src/') + '/' },
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
  },
})
