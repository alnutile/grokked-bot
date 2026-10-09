import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Fail } from './fail.js'

/* Reading and changing text files: how the agent works on code. Kept apart from
   session.js so it is testable without a browser. */

/**
 * A file's lines, numbered, so the agent can quote and edit exact lines.
 * start_line/end_line are 1-based and inclusive; the default is the whole file.
 * Binary files are refused rather than dumped.
 */
export async function readFileLines({ path, start_line = 1, end_line, max_bytes = 2_000_000 }) {
  const buf = await readFile(path).catch((e) => { throw new Fail('read_failed', e.message, 'list_files or run_bash ls to find it') })
  if (buf.length > max_bytes) {
    throw new Fail('too_big', `${path} is ${buf.length} bytes; read a range with start_line/end_line, or grep it`)
  }
  if (buf.subarray(0, 8000).includes(0)) throw new Fail('binary', `${path} looks binary; inspect it with run_bash (file, xxd, unzip -l)`)
  const lines = buf.toString('utf8').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const from = Math.max(1, Math.floor(start_line))
  const to = Math.min(lines.length, Math.floor(end_line ?? lines.length))
  const width = String(to).length
  const content = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(width)}  ${l}`).join('\n')
  return { ok: true, path, total_lines: lines.length, start_line: from, end_line: to, content }
}

/**
 * Replace one exact piece of text in a file under the work dir. The text must
 * appear exactly once (or pass replace_all), so an edit never lands somewhere
 * the agent didn't mean.
 */
export async function editFile({ path, old_text, new_text, replace_all = false, workDir }) {
  const abs = resolve(path)
  if (!abs.startsWith(workDir + '/')) throw new Fail('path_not_allowed', `edits must be under ${workDir}`)
  if (typeof old_text !== 'string' || !old_text) throw new Fail('bad_args', 'old_text must be the exact text to replace')
  const before = await readFile(abs, 'utf8').catch((e) => { throw new Fail('read_failed', e.message) })
  const count = before.split(old_text).length - 1
  if (count === 0) {
    throw new Fail('not_found', `old_text is not in ${path}; read_file the lines again and copy them exactly, whitespace included`)
  }
  if (count > 1 && !replace_all) {
    throw new Fail('ambiguous', `old_text appears ${count} times in ${path}; include more surrounding lines so it is unique, or pass replace_all`)
  }
  const after = replace_all ? before.split(old_text).join(String(new_text ?? '')) : before.replace(old_text, () => String(new_text ?? ''))
  await writeFile(abs, after).catch((e) => { throw new Fail('write_failed', e.message) })
  return { ok: true, path, replaced: replace_all ? count : 1 }
}
