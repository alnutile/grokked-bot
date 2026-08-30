/**
 * Turns the live DOM into a compact outline of interactive elements, each with a
 * stable ref the model can name.
 *
 * This is the whole reason the project can run on an arbitrary OpenRouter model.
 * Asking a general VLM for the pixel coordinates of a button is a regression task
 * it was never tuned for and misses by enough to hit the neighbouring element.
 * Picking "s7e42" out of a list is a selection task, which every instruction-tuned
 * model is good at.
 *
 * Refs are generation-scoped (s<gen>e<n>). Acting on a ref from an older snapshot
 * is a hard stale_ref error rather than a click on whatever now occupies that slot.
 */

// Runs inside the page. Must be self-contained.
function collect([gen, maxNodes]) {
  const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'OPTION'])
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'textbox', 'combobox', 'listbox',
    'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch',
    'searchbox', 'slider', 'spinbutton', 'treeitem',
  ])
  const LANDMARK = new Set(['MAIN', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'TABLE', 'DIALOG'])

  const out = []
  let n = 0
  let truncated = false

  const visible = (el) => {
    if (el.getAttribute('aria-hidden') === 'true') return false
    if (el.hasAttribute('hidden')) return false
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    // Zero-size and far-offscreen elements are both noise and a classic hiding
    // place for injected instructions.
    if (r.width < 1 || r.height < 1) return false
    if (r.bottom < -2000 || r.top > (document.documentElement.scrollHeight || 0) + 2000) return false
    return true
  }

  const name = (el) => {
    const pick = (v) => (v && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, 160) : '')
    let v = pick(el.getAttribute('aria-label'))
    if (v) return v
    const lb = el.getAttribute('aria-labelledby')
    if (lb) {
      const parts = lb.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean)
      v = pick(parts.map((p) => p.textContent).join(' '))
      if (v) return v
    }
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (lab) { v = pick(lab.textContent); if (v) return v }
    }
    const closestLabel = el.closest('label')
    if (closestLabel) { v = pick(closestLabel.textContent); if (v) return v }
    v = pick(el.getAttribute('placeholder')) || pick(el.getAttribute('title')) || pick(el.getAttribute('alt'))
    if (v) return v
    if (el.tagName === 'INPUT') { v = pick(el.getAttribute('value')); if (v) return v }
    return pick(el.innerText || el.textContent)
  }

  const roleOf = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit.toLowerCase()
    switch (el.tagName) {
      case 'A': return el.hasAttribute('href') ? 'link' : 'generic'
      case 'BUTTON': return 'button'
      case 'SELECT': return el.multiple ? 'listbox' : 'combobox'
      case 'TEXTAREA': return 'textbox'
      case 'SUMMARY': return 'button'
      case 'TABLE': return 'table'
      case 'FORM': return 'form'
      case 'MAIN': return 'main'
      case 'NAV': return 'navigation'
      case 'HEADER': return 'banner'
      case 'FOOTER': return 'contentinfo'
      case 'DIALOG': return 'dialog'
      case 'INPUT': {
        const t = (el.getAttribute('type') || 'text').toLowerCase()
        if (t === 'checkbox') return 'checkbox'
        if (t === 'radio') return 'radio'
        if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button'
        if (t === 'search') return 'searchbox'
        if (t === 'range') return 'slider'
        if (t === 'number') return 'spinbutton'
        if (t === 'file') return 'file'
        return 'textbox'
      }
      default:
        if (/^H[1-6]$/.test(el.tagName)) return 'heading'
        return 'generic'
    }
  }

  const isInteresting = (el, role) =>
    INTERACTIVE.has(el.tagName) ||
    INTERACTIVE_ROLES.has(role) ||
    LANDMARK.has(el.tagName) ||
    role === 'heading' ||
    el.isContentEditable ||
    el.hasAttribute('onclick')

  const walk = (el, depth) => {
    if (n >= maxNodes) { truncated = true; return }
    if (!(el instanceof Element)) return
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') return
    if (!visible(el)) return

    const role = roleOf(el)
    let nextDepth = depth
    if (isInteresting(el, role)) {
      const ref = `s${gen}e${++n}`
      el.setAttribute('data-gref', ref)
      const item = { ref, role, name: name(el), depth }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        if (el.type === 'checkbox' || el.type === 'radio') item.checked = !!el.checked
        else item.value = String(el.value ?? '').slice(0, 120)
      }
      if (el.disabled) item.disabled = true
      if (el.getAttribute('aria-expanded')) item.expanded = el.getAttribute('aria-expanded')
      if (el.tagName === 'A' && el.href) item.href = String(el.href).slice(0, 200)
      out.push(item)
      nextDepth = depth + 1
    }

    // A large canvas means the accessibility tree is blind here; the caller uses
    // this to auto-escalate to a screenshot + the pixel escape hatch.
    if (el.tagName === 'CANVAS') {
      const r = el.getBoundingClientRect()
      const frac = (r.width * r.height) / Math.max(1, innerWidth * innerHeight)
      if (frac > 0.25) out.push({ ref: null, role: 'canvas', name: `canvas covering ${Math.round(frac * 100)}% of viewport`, depth })
    }

    for (const child of el.children) walk(child, nextDepth)
    if (el.shadowRoot) for (const child of el.shadowRoot.children) walk(child, nextDepth)
  }

  for (const el of document.body ? document.body.children : []) walk(el, 0)
  return { nodes: out, truncated, total: n }
}

/** Serialise to an indented outline. ~40% cheaper than JSON and models parse it fine. */
export function render(result, meta) {
  const lines = [`# snapshot s${meta.gen} | ${meta.url} | ${JSON.stringify(meta.title)}`]
  for (const nd of result.nodes) {
    const pad = '  '.repeat(Math.min(nd.depth, 8))
    let line = `${pad}- ${nd.role}`
    if (nd.name) line += ` ${JSON.stringify(nd.name)}`
    if (nd.ref) line += ` [ref=${nd.ref}]`
    if (nd.value !== undefined && nd.value !== '') line += ` value=${JSON.stringify(nd.value)}`
    if (nd.checked !== undefined) line += ` checked=${nd.checked}`
    if (nd.expanded) line += ` expanded=${nd.expanded}`
    if (nd.disabled) line += ' disabled'
    lines.push(line)
  }
  if (result.truncated) {
    lines.push(`  ... truncated at ${result.total} nodes (use find to locate an element by text)`)
  }
  return lines.join('\n')
}

export const collectSource = collect
