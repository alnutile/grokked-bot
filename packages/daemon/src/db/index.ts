import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DB_PATH } from '../config.ts'
import { log } from '../log.ts'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

export type Db = DatabaseSync

export function openDb(path = DB_PATH): Db {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous  = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `)
  migrate(db)
  return db
}

/** Version tracked in PRAGMA user_version rather than a table, so migration 001
 *  can create every table without a bootstrap chicken-and-egg. */
export function migrate(db: Db): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)

  for (const file of files) {
    const version = Number(file.slice(0, 3))
    if (!Number.isFinite(version) || version === 0) throw new Error(`bad migration name: ${file}`)
    if (version <= current) continue

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.exec(`PRAGMA user_version = ${version}`)
      db.exec('COMMIT')
      log.info({ file, version }, 'migration applied')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err })
    }
  }
}

export function dbOk(db: Db): boolean {
  try {
    db.prepare('SELECT 1 AS ok').get()
    return true
  } catch {
    return false
  }
}
