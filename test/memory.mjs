/**
 * Standalone checks for durable memory. No Harness runtime is involved.
 *
 *   node test/memory.mjs
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HumanStore } from '../build/host/lib/store.js'
import { SEED_HUMANS } from '../build/host/lib/seed.js'
import {
  COMPACTION_THRESHOLD_BYTES,
  buildSnapshot,
  compactMemory,
  ensureMemory,
  memoryPaths,
  renderMemoryContext,
} from '../build/host/lib/memory.js'

const home = await mkdtemp(join(tmpdir(), 'dh-mem-'))
const store = new HumanStore(home)
let pass = 0
let fail = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    pass += 1
    console.log(`  ok   ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL ${label} ${extra}`)
  }
}

await store.list(SEED_HUMANS)
const paths = memoryPaths(store, 'dev-assistant')

console.log('1) first touch')
check('paths live under the human directory', paths.file.startsWith(store.dir('dev-assistant')), paths.file)
check('archive dir is beside the file', paths.archiveDir.startsWith(store.dir('dev-assistant')))
check('no file yet', buildSnapshot(paths).exists === false)
check('snapshot without a file is still complete', buildSnapshot(paths).headers.length === 0)
const cold = renderMemoryContext(paths)
check('context teaches the rules before any file exists', cold.includes('## Memory'))
check('context says there is no file yet', cold.includes('no memory file yet'))
check('ensureMemory creates it', ensureMemory(paths.file) === true)
check('ensureMemory is idempotent', ensureMemory(paths.file) === false)

console.log('2) skeleton shape')
const fresh = buildSnapshot(paths)
check('has a # now section', fresh.nowSection?.startsWith('# now'))
check('has a # History section', fresh.headers.some((entry) => entry.heading === 'History'))
check('small file is injected whole', fresh.fullContent !== null)
check('compaction not needed', fresh.needsCompaction === false)

console.log('3) grown file')
const lines = [
  '# now',
  '',
  '## State | reviewing 3 requirements',
  '- reviewed: 3',
  '',
  '## Patterns',
  '- dpms ids are numeric',
]
// Pad past the whole-file injection threshold so both branches are exercised.
for (let index = 0; index < 25; index += 1) lines.push(`- note ${index}`)
lines.push('', '# History', '', '## 2026-10-12-1930 | first pass', 'Reviewed three requirements and reported them.')
await writeFile(paths.file, lines.join('\n'), 'utf8')
const grown = buildSnapshot(paths)
check('nowSection stops before History', grown.nowSection.includes('reviewed: 3') && !grown.nowSection.includes('# History'))
check('nowSection keeps Patterns', grown.nowSection.includes('dpms ids are numeric'))
check('history body counted', grown.historyLines === 2, String(grown.historyLines))
check('headings carry line numbers', grown.headers.every((entry) => entry.line >= 1))
check('too big for whole-file injection', grown.fullContent === null, `totalLines=${grown.totalLines}`)
const context = renderMemoryContext(paths)
check('context pre-loads # now', context.includes('reviewing 3 requirements'))
check('context omits History body', !context.includes('Reviewed three requirements'))
check('context carries the memory map', context.includes('### Memory map') && context.includes(paths.file))
check('context teaches memory_status', context.includes('memory_status'))
check('context teaches memory_compact', context.includes('memory_compact'))
// The registered tool is `edit`, lowercase: naming `Edit` would send the model after
// a tool that does not exist.
check('context teaches the edit-not-rewrite rule', context.includes('Use edit for routine updates'))
check('the rule names the real tool', !/\b(Edit|Write)\(/.test(context))

console.log('4) compaction')
const big = `# now\n\n## State | big\n\n${'x'.repeat(COMPACTION_THRESHOLD_BYTES + 1024)}\n`
await writeFile(paths.file, big, 'utf8')
check('oversized file flags compaction', buildSnapshot(paths).needsCompaction === true)
const archived = compactMemory(paths)
check('compact returns the archive path', typeof archived === 'string' && archived.startsWith(paths.archiveDir + '/'), String(archived))
check('archive kept the old content', (await readFile(archived, 'utf8')) === big)
const after = buildSnapshot(paths)
check('compact reset the file', after.nowSection.includes('runs_completed: 0'))
check('reset file is small again', after.needsCompaction === false)
check('compact with nothing to archive', compactMemory(memoryPaths(store, 'no-such-human')) === null)
await writeFile(paths.file, big, 'utf8')
const second = compactMemory(paths)
check('a second archive in the same minute does not collide', second !== archived, String(second))

await rm(home, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
