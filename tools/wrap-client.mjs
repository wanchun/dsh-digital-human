import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Wrap the Vite CommonJS bundle in the module-loader envelope.
 *
 * The Harness browser half loads a plugin through
 * `window.__ModuleLoader__.load({ id, factory })`, where `factory(require)`
 * returns the plugin module. Vite emits a CommonJS file instead, so this step
 * evaluates that file inside a factory and forwards the loader's own `require`,
 * which is what resolves `react` and the shared component library.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const bundlePath = resolve(root, 'build/client/client.cjs')
const outPath = resolve(root, 'client.js')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

const bundle = await readFile(bundlePath, 'utf8')

const banner = `/**
 * GENERATED FILE — do not edit.
 *
 * Source: src/client.tsx
 * Build:  npm run build   (Vite, then tools/wrap-client.mjs)
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    ;(function (module, exports, require) {
`

const footer = `
    }).call(module.exports, module, module.exports, require)
    return module.exports
  },
})
`

await writeFile(outPath, banner + bundle + footer, 'utf8')
console.log(`wrapped ${bundlePath} -> ${outPath}`)
