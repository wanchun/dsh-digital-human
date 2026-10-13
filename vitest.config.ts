import { existsSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Resolve a source module's `./x.js` specifier to `./x.ts`.
 *
 * The host half is compiled with `module: NodeNext`, which does not rewrite import
 * specifiers — so its imports name the emitted file, and that is correct for the
 * runtime. Unit tests import the source instead, where the same module is `x.ts`,
 * and only a specifier that resolves to a real `.ts` file is rewritten, so a
 * dependency inside `node_modules` keeps its own resolution.
 */
const jsSpecifierToTs = {
  name: 'digital-human:js-specifier-to-ts',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null
    const from = resolve(dirname(importer), source)
    if (!from.includes(`${sep}src${sep}`)) return null
    const asTs = from.replace(/\.js$/, '.ts')
    return existsSync(asTs) ? asTs : null
  },
}

export default defineConfig({
  plugins: [jsSpecifierToTs],
  resolve: {
    alias: {
      // Supplied by the Harness module loader at runtime, so it is not a dependency
      // here and Vite cannot resolve it. The stub forwards the props the page passes.
      '@deepseek-ai/dsh-client-ui-primitives': resolve(here, 'test/unit/stubs/primitives.tsx'),
    },
  },
  test: {
    include: ['test/unit/**/*.test.{ts,tsx}'],
    environment: 'node',
    // The client half is a browser module: its test file opts into a DOM with a
    // `@vitest-environment jsdom` docblock, and the rest stay on plain node.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        // Seeded business personas are data, not logic: every line is a string
        // literal, so covering them would only measure the fixture's length.
        'src/lib/seed.ts',
        // Declarations only — there is no runtime statement to cover.
        'src/lib/types.ts',
      ],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
})
