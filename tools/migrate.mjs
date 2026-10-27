#!/usr/bin/env node
/**
 * Migrate a legacy combined registry (`humans.json`) into one directory per
 * digital human.
 *
 * The logic lives in the store; this file only parses arguments and refuses to run
 * against a live host, because the running process holds the old state in memory and
 * would write it back over the migration.
 *
 * Run `pnpm build:host` first: the script imports the compiled store.
 *
 *   node tools/migrate.mjs --dry-run
 *   node tools/migrate.mjs
 *   node tools/migrate.mjs --home /path/to/digital-human --port 3080
 */
import { createConnection } from 'node:net'

import { HumanStore, defaultHome } from '../build/host/lib/store.js'

const args = process.argv.slice(2)
const valueOf = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback
}
const dryRun = args.includes('--dry-run')
const home = valueOf('--home', defaultHome())
const port = Number(valueOf('--port', '3080'))

/** A host listening on the port means its in-memory registry would undo the run. */
const listening = await new Promise((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port })
  const done = (result) => { socket.destroy(); resolve(result) }
  socket.once('connect', () => done(true))
  socket.once('error', () => done(false))
  socket.setTimeout(1000, () => done(false))
})

if (listening) {
  console.error(`refusing to migrate: something is listening on 127.0.0.1:${port}. Stop the host first, or pass --port when it runs elsewhere.`)
  process.exit(1)
}

const store = new HumanStore(home)
try {
  const result = await store.migrateLegacy({ dryRun })
  if (result.reason !== undefined) {
    console.log(`nothing to migrate under ${home}: ${result.reason}`)
    process.exit(0)
  }
  console.log(`${dryRun ? 'would migrate' : 'migrated'} ${result.records.length} record(s) under ${home}`)
  for (const entry of result.records) console.log(`  ${entry.id} -> ${entry.dir}`)
  if (result.backup !== undefined) console.log(`backup: ${result.backup}`)
  if (result.removed !== undefined) console.log(`removed: ${result.removed}`)
  if (dryRun) console.log('dry run: nothing was written. Re-run without --dry-run to apply.')
} catch (error) {
  console.error(`migration failed: ${error.message}`)
  process.exit(1)
}
