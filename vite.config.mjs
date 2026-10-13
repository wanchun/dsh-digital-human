import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Build the browser half.
 *
 * The Harness module loader hands the bundle a `require`, so the output must be
 * CommonJS with `react` and the shared component library left external — the
 * loader supplies both. `tools/wrap-client.mjs` then wraps that CommonJS file in
 * the `window.__ModuleLoader__.load({ id, factory })` envelope the loader reads.
 */
export default defineConfig({
  build: {
    outDir: 'build/client',
    emptyOutDir: true,
    minify: false,
    target: 'es2022',
    lib: {
      entry: resolve(here, 'src/client.tsx'),
      formats: ['cjs'],
      fileName: () => 'client.cjs',
    },
    rollupOptions: {
      external: [
        'react',
        'react/jsx-runtime',
        '@deepseek-ai/dsh-client-ui-primitives',
      ],
    },
  },
})
