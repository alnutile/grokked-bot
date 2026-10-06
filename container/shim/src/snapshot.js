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
 * Refs are generation-scoped: Playwright's e121 becomes s7e121 (s7f1e3 inside an
 * iframe). Acting on a ref from an older snapshot is a hard stale_ref error
 * rather than a click on whatever now occupies that slot.
 */

/** s<gen> then Playwright's ref: e<n>, or f<n>e<n> for an element in an iframe. */
export const refPattern = /^s(\d+)((?:f\d+)?e\d+)$/

/** Long pages get cut here; find() and read_text() reach the rest. */
const MAX_CHARS = 30000

export async function aiSnapshot(page, gen) {
  const raw = await page.ariaSnapshot({ mode: 'ai', timeout: 15000 })
  let refs = 0
  let body = raw.replace(/\[ref=((?:f\d+)?e\d+)\]/g, (_, r) => { refs++; return `[ref=s${gen}${r}]` })
  const truncated = body.length > MAX_CHARS
  if (truncated) {
    body = body.slice(0, body.lastIndexOf('\n', MAX_CHARS)) +
      `\n... truncated at ${MAX_CHARS} chars (use find to locate an element by text, or scroll)`
  }
  const url = page.url()
  const title = await page.title().catch(() => '')
  return {
    text: `# snapshot s${gen} | ${url} | ${JSON.stringify(title)}\n${body}`,
    refs,
    // A page that's mostly canvas is blind to the accessibility tree.
    canvasHeavy: /^\s*- (?:img|canvas)\b/m.test(body) && refs < 10,
    url,
    title,
  }
}
