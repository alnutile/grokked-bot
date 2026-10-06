/** The parts of page reading that decide what the bot can see on a big page. */
import { strict as assert } from 'node:assert'
import { fit, subtree } from '../src/snapshot.js'

const card = (i) => `    - listitem [ref=s1e${i}]:\n      - button "full details of Job ${i}" [ref=s1e${i + 1}]: Job ${i}\n      - generic: Easily apply`
const page = [
  '- main [ref=s1e1]:',
  '  - list [ref=s1e2]:',
  ...Array.from({ length: 600 }, (_, i) => card(10 + i * 3)),
  '  - region "Job details" [ref=s1e5000]:',
  '    - heading "Senior Laravel Developer" [level=2] [ref=s1e5001]',
  '    - link "Apply now" [ref=s1e5002]:',
].join('\n')

const { body, truncated } = fit(page)
assert.equal(truncated, true)
assert.ok(body.length < 41000, `fits: ${body.length}`)
assert.ok(!body.slice(0, body.indexOf('... the page continues')).includes('Apply now'), 'the details pane is past the cut')
assert.match(body, /region "Job details" \[ref=s1e5000\]/, 'but the map names its region')
assert.match(body, /\(continues\) - list \[ref=s1e2\]/, 'and the list the cut fell inside')
console.log('  ok  a cut page ends with a map of what it left out')

const part = subtree(page, 's1e5000')
assert.match(part, /^- region "Job details"/)
assert.match(part, /link "Apply now" \[ref=s1e5002\]/)
assert.ok(!part.includes('Job 10'))
assert.equal(subtree(page, 's1e999999'), null)
console.log('  ok  a scoped snapshot returns just that element and what is inside it')

assert.deepEqual(fit('- button "x" [ref=s1e1]'), { body: '- button "x" [ref=s1e1]', truncated: false })
console.log('  ok  a small page passes through untouched')
console.log('\nall passed')
