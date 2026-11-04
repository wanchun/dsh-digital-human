import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * Every plugin row BASELINE_ROWS names must be resolvable by the Host that
 * runs the tests. A row whose package has no such export fails here first,
 * at upgrade time, instead of as "never started" on a live preset.
 *
 * The Host ships its plugin packages inside the dsh CLI's own node_modules,
 * which no test resolves through by default; a require rooted there reads
 * exactly what the running Host would load.
 */
const dshRoot = process.env.DSH_TEST_HOST
  ?? join(process.env.HOME ?? '', '.n/lib/node_modules/@deepseek-ai/dsh/node_modules')
const hostRequire = createRequire(join(dshRoot, '@deepseek-ai/_/index.js'))

/** Split a scoped name into package and subpath: the SECOND slash is the divider. */
function splitName(name: string): { pkgName: string; subpath?: string } {
  const first = name.indexOf('/')
  const second = name.indexOf('/', first + 1)
  if (second === -1) return { pkgName: name }
  return { pkgName: name.slice(0, second), subpath: '.' + name.slice(second) }
}

describe('BASELINE_ROWS name every plugin the Host still exports', () => {
  it('resolves every row name against the installed Host packages', async () => {
    const source = await readFile(fileURLToPath(new URL('../../src/lib/presets.ts', import.meta.url)), 'utf8')
    const names = [...source.matchAll(/name: '(@deepseek-ai\/[^']+)'/g)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(10)
    const failures: string[] = []
    for (const name of new Set(names)) {
      const { pkgName, subpath } = splitName(name)
      try {
        const pkgJson = hostRequire(pkgName + '/package.json')
        if (subpath === undefined) continue
        const exported = pkgJson.exports
        if (exported && !(subpath in exported)) failures.push(name + ': package exports no ' + subpath)
      } catch (error) {
        failures.push(name + ': ' + String(error).split('\n')[0])
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  })
})