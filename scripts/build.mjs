// Bundle the daemon into one file the desktop app ships as a resource and runs
// with its bundled Node. Node 24 strips TS types natively, but not inside
// node_modules, and a .app can't carry a pnpm workspace anyway.
import { cpSync, rmSync } from 'node:fs'
import { build } from 'esbuild'

const OUT = 'apps/desktop/src-tauri/resources/daemon'
rmSync(OUT, { recursive: true, force: true })

await build({
  entryPoints: ['packages/daemon/src/index.ts'],
  outfile: `${OUT}/grokked.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  // Some deps are CJS and call require() on node builtins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
})

// db/index.ts reads these from next to the module at runtime.
cpSync('packages/daemon/src/db/migrations', `${OUT}/migrations`, { recursive: true })
