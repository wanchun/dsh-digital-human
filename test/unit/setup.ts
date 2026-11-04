/**
 * Keep the global skill root out of the tests.
 *
 * The catalog and a new record's default skill list read `$DSH_AGENTS_HOME/skills`.
 * Point that at an empty temporary root, so no test depends on the skills installed
 * on the machine running it. A test that needs a catalog passes its own root.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_AGENTS_HOME = mkdtempSync(join(tmpdir(), 'dh-agents-'))
