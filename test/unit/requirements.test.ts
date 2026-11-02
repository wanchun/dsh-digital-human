import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readRequirementDirs } from '../../src/lib/requirements'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dh-reqs-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Write one requirement directory's meta.json (or any text) under `reqs/`. */
async function meta(dir: string, body: string) {
  const at = join(root, 'reqs', dir)
  await mkdir(at, { recursive: true })
  await writeFile(join(at, 'meta.json'), body)
}

describe('requirement directory metadata', () => {
  it('maps a thread to its directory and Chinese name', async () => {
    await meta('组织基线验证-20261102', JSON.stringify({ thread: 'qs-org-baseline-verify-20261102', name: '组织基线验证' }))
    expect(readRequirementDirs(root)).toEqual(new Map([
      ['qs-org-baseline-verify-20261102', { dir: '组织基线验证-20261102', name: '组织基线验证' }],
    ]))
  })

  it('skips a directory without a usable meta.json', async () => {
    await meta('missing', '')
    const at = join(root, 'reqs', 'no-meta')
    await mkdir(at, { recursive: true })
    await meta('half', JSON.stringify({ thread: 't-only' }))
    await meta('blank', JSON.stringify({ thread: '  ', name: '名字' }))
    // A plain file under reqs/ is not a requirement directory.
    await writeFile(join(root, 'reqs', 'stray.md'), 'x')
    expect(readRequirementDirs(root).size).toBe(0)
  })

  it('answers an empty map without a requirement root', () => {
    expect(readRequirementDirs(undefined).size).toBe(0)
    expect(readRequirementDirs(join(root, 'absent')).size).toBe(0)
  })
})
