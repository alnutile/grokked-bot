/**
 * Turns the live page into an outline of what's on it, each actionable element
 * with a ref the model can name.
 *
 * This is the whole reason the project can run on an arbitrary OpenRouter model.
 * Asking a general VLM for the pixel coordinates of a button is a regression task
 * it was never tuned for and misses by enough to hit the neighbouring element.
 * Picking "s7e42" out of a list is a selection task, which every instruction-tuned
 * model is good at.
 *
 * The outline is Playwright's AI snapshot, which computes roles and accessible
 * names the way the browser does -- through shadow DOM, slots and iframes. A
 * hand-rolled DOM walk used to do this and was blind to web-component sites
 * (an ADP "Apply" button: a <button> in a shadow root, labelled by slotted text,
 * inside a display:contents host).
 *
 * Refs: Playwright's e121 is shown as s7e121 (s7f1e3 inside an iframe), the s7
 * naming the snapshot it came from. Playwright keeps an element's ref stable
 * across snapshots, so a ref stays usable for as long as its element is on the
 * page; once the element is gone, using it is a hard stale_ref error rather
 * than a click on something else.
 *
 * Big pages (a job board's results list) don't fit. Rather than silently cut
 * off whatever comes last -- which is how a bot spent 25 steps failing to find
 * Indeed's "Apply now" -- a cut snapshot ends with a map of the sections that
 * didn't fit, each with a ref to snapshot on its own; and find() always
 * searches the whole page.
 */

/** s<gen> then Playwright's ref: e<n>, or f<n>e<n> for an element in an iframe. */
export const refPattern = /^s(\d+)((?:f\d+)?e\d+)$/

/** What one snapshot may show. ~10k tokens; the rest is reachable by ref or find. */
const MAX_CHARS = 40000

/** Drop what costs tokens and tells the model nothing. */
function compact(text) {
  return text
    .replace(/ \[cursor=pointer\]/g, '')
    .replace(/^(\s*- \/url: )(.{100}).+$/gm, '$1$2…')
}

const depthOf = (line) => line.length - line.trimStart().length

/** The full page: Playwright's AI snapshot, refs tagged with the generation. */
export async function fullSnapshot(page, gen) {
  const raw = await page.ariaSnapshot({ mode: 'ai', timeout: 15000 })
  let refs = 0
  const text = compact(raw.replace(/\[ref=((?:f\d+)?e\d+)\]/g, (_, r) => { refs++; return `[ref=s${gen}${r}]` }))
  return { text, refs }
}

/** One element's subtree, cut out of a full snapshot so other refs stay live. */
export function subtree(text, ref) {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.includes(`[ref=${ref}]`))
  if (at < 0) return null
  const d = depthOf(lines[at])
  let end = at + 1
  while (end < lines.length && depthOf(lines[end]) > d) end++
  return lines.slice(at, end).map((l) => l.slice(d)).join('\n')
}

/** Fit a snapshot to MAX_CHARS, ending with a map of what was left out. */
export function fit(body) {
  if (body.length <= MAX_CHARS) return { body, truncated: false }
  const cut = body.lastIndexOf('\n', MAX_CHARS - 4000)
  const shown = body.slice(0, cut)
  const rest = body.slice(cut + 1).split('\n')
  // What a reader would use to navigate the rest: the containers the cut falls
  // inside (they hold the remainder of that list), then headings and regions.
  const before = shown.split('\n')
  const open = []
  let depth = depthOf(before[before.length - 1] ?? '')
  for (let i = before.length - 1; i >= 0 && depth > 0; i--) {
    const d = depthOf(before[i])
    if (d < depth && before[i].includes('[ref=')) { open.unshift(`(continues) ${before[i].trim()}`); depth = d }
  }
  const SECTION = /^- (heading|main|region|complementary|dialog|form|navigation|contentinfo|article|tabpanel|list)\b/
  const after = rest.filter((l) => l.includes('[ref=') && SECTION.test(l.trim()))
  const map = [...open.slice(-3), ...after].slice(0, 40).map((l) => l.trim().slice(0, 140))
  return {
    body: `${shown}\n\n... the page continues (${rest.length} more lines). Not shown above — call browser_snapshot ` +
      `with one of these refs to see that part, or browser_find for a specific element:\n` +
      map.map((l) => `  ${l}`).join('\n'),
    truncated: true,
  }
}

export async function aiSnapshot(page, gen, scopeRef) {
  const { text, refs } = await fullSnapshot(page, gen)
  let body = text
  let scope = null
  if (scopeRef) {
    const part = subtree(text, scopeRef)
    if (part === null) return { missingScope: true }
    body = part
    scope = scopeRef
  }
  const fitted = fit(body)
  const url = page.url()
  const title = await page.title().catch(() => '')
  return {
    text: `# snapshot s${gen}${scope ? ` of ${scope}` : ''} | ${url} | ${JSON.stringify(title)}\n${fitted.body}`,
    full: text,
    refs,
    truncated: fitted.truncated,
    // A page that's mostly canvas is blind to the accessibility tree.
    canvasHeavy: /^\s*- (?:img|canvas)\b/m.test(text) && refs < 10,
    url,
    title,
  }
}
