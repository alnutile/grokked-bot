/** read_file and edit_file: what the bot uses to read and change code. */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = mkdtempSync(join(tmpdir(), 'grokked-work-'))
const files = await import('../src/files.js')
const s = { read_file: files.readFileLines, edit_file: (a) => files.editFile({ ...a, workDir: work }) }
const fails = async (p, code) => { await assert.rejects(p, (e) => e.code === code); }

const file = join(work, 'calc.js')
writeFileSync(file, 'function add(a, b) {\n  return a - b\n}\n\nfunction sub(a, b) {\n  return a - b\n}\n')

let r = await s.read_file({ path: file })
assert.equal(r.total_lines, 7)
assert.match(r.content, /^1  function add/)
r = await s.read_file({ path: file, start_line: 2, end_line: 3 })
assert.equal(r.content, '2    return a - b\n3  }')
console.log('  ok  reads numbered lines, whole or a range')

writeFileSync(join(work, 'bin'), Buffer.from([0, 1, 2, 3]))
await fails(s.read_file({ path: join(work, 'bin') }), 'binary')
console.log('  ok  refuses binary files')

await fails(s.edit_file({ path: file, old_text: '  return a - b', new_text: '  return a + b' }), 'ambiguous')
await fails(s.edit_file({ path: file, old_text: 'return a * b', new_text: 'x' }), 'not_found')
r = await s.edit_file({ path: file, old_text: 'function add(a, b) {\n  return a - b', new_text: 'function add(a, b) {\n  return a + b' })
assert.equal(r.replaced, 1)
assert.match(readFileSync(file, 'utf8'), /return a \+ b\n\}\n\nfunction sub\(a, b\) \{\n  return a - b/)
console.log('  ok  edits one exact, unique piece of text')

r = await s.edit_file({ path: file, old_text: 'a, b', new_text: 'x, y', replace_all: true })
assert.equal(r.replaced, 2)
await fails(s.edit_file({ path: join(work, '..', 'etc-passwd'), old_text: 'a', new_text: 'b' }), 'path_not_allowed')
await fails(s.edit_file({ path: `${work}/../x`, old_text: 'a', new_text: 'b' }), 'path_not_allowed')
console.log('  ok  replace_all, and never outside the work dir')
console.log('\nall passed')
