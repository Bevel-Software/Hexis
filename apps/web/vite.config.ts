import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

const envDir = path.resolve(__dirname, '../..')

export default defineConfig(({ mode }) => {
  // The shared branch registry (`@bevel-software/platform-shared` → git/protected.ts) reads these
  // off `process.env` so the SAME module works on the backend (Node runtime) and
  // in the browser (statically replaced here at build time). Load with an empty
  // prefix so both `.env` file entries and real build-time env vars are visible,
  // then inject just the keys the registry consumes — `process.env` itself
  // is otherwise undefined in the browser bundle.
  const env = loadEnv(mode, envDir, '')
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.DEFAULT_BRANCH': JSON.stringify(env.DEFAULT_BRANCH ?? ''),
      'process.env.PROTECTED_BRANCHES': JSON.stringify(env.PROTECTED_BRANCHES ?? ''),
      // Per-tenant demo expiry. Unset → the demo banner never renders.
      'process.env.DEMO_EXPIRY': JSON.stringify(env.DEMO_EXPIRY ?? ''),
    },
    resolve: {
      // One copy of react/router even though core-frontend is consumed as a
      // raw-source workspace package (its own node_modules carries dev copies).
      dedupe: ['react', 'react-dom', 'react-router-dom'],
    },
    envDir,
    server: {
      // `core-frontend` is consumed through a workspace SYMLINK in
      // node_modules, and that is the path Tailwind's `@source` scans (see
      // `src/index.css`). The scanner reads through it fine on a cold start,
      // but the file watcher does not follow symlinks by default — so a
      // utility class written mid-session is never compiled, and the class
      // lands in the DOM matching no rule at all. That failure is silent and
      // looks like a design bug: `not-sr-only` vanished a name, and an
      // entrance animation "just appeared" through three rounds of debugging
      // because its hold never existed. Following the link costs a little
      // watch overhead and buys back every one of those afternoons.
      watch: { followSymlinks: true },
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true,
          timeout: 300_000,
        },
      },
    },
  }
})
