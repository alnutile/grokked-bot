import { chromium } from 'playwright-core'
import { execFile, spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { collectSource, render } from './snapshot.js'

const exec = promisify(execFile)
const CDP = `http://127.0.0.1:${process.env.CDP_PORT || 9222}`
const WORK_DIR = process.env.WORK_DIR || '/data/work'
const MAX_NODES = 120

export class Fail extends Error {
  constructor(code, message, recovery) {
    super(message)
    this.code = code
    this.recovery = recovery
  }
}

export class Session {
  #browser = null
  #context = null
  #page = null
  gen = 0
  allowedDomains = []

  async connect() {
    let lastErr
    for (let i = 0; i < 30; i++) {
      try {
        this.#browser = await chromium.connectOverCDP(CDP)
        this.#context = this.#browser.contexts()[0]
        this.#page = this.#context.pages()[0] ?? (await this.#context.newPage())
        await this.#page.setViewportSize?.({
          width: Number(process.env.SCREEN_WIDTH || 1280),
          height: Number(process.env.SCREEN_HEIGHT || 800),
        }).catch(() => {})
        // Never let a native Save-As dialog appear; downloads land where the
        // agent can read them and emit progress events we can surface.
        const cdp = await this.#context.newCDPSession(this.#page)
        await cdp.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: `${WORK_DIR}/downloads`,
          eventsEnabled: true,
        }).catch(() => {})
        return
      } catch (err) {
        lastErr = err
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    throw new Fail('cdp_unavailable', `could not attach to Chrome at ${CDP}: ${lastErr?.message}`)
  }

  page() {
    // Follow the frontmost page: clicking a target="_blank" link opens a new one.
    const pages = this.#context?.pages() ?? []
    if (pages.length && !pages.includes(this.#page)) this.#page = pages[pages.length - 1]
    if (!this.#page) throw new Fail('no_page', 'no open page')
    return this.#page
  }

  /** Enforced here, not in the prompt: a hostile page can talk the model into
   *  anything, but it cannot change what this function does. */
  assertAllowed(url) {
    if (this.allowedDomains.length === 0) return
    let host
    try { host = new URL(url).hostname } catch { throw new Fail('bad_url', `not a URL: ${url}`) }
    const ok = this.allowedDomains.some((pattern) => {
      const p = pattern.toLowerCase().replace(/^\*\./, '')
      return host === p || host.endsWith(`.${p}`)
    })
    if (!ok) {
      throw new Fail(
        'domain_not_allowed',
        `navigation to ${host} is outside this task's allowed domains (${this.allowedDomains.join(', ')})`,
        'ask_human',
      )
    }
  }

  async locate(ref) {
    if (!/^s\d+e\d+$/.test(String(ref ?? ''))) throw new Fail('bad_ref', `not a ref: ${ref}`)
    const gen = Number(String(ref).slice(1).split('e')[0])
    if (gen !== this.gen) {
      throw new Fail(
        'stale_ref',
        `ref ${ref} is from snapshot s${gen}; current is s${this.gen}`,
        'snapshot',
      )
    }
    const loc = this.page().locator(`[data-gref="${ref}"]`)
    if ((await loc.count()) === 0) {
      throw new Fail('stale_ref', `ref ${ref} no longer exists on the page`, 'snapshot')
    }
    return loc.first()
  }

  async snapshot() {
    const page = this.page()
    this.gen += 1
    // A click that triggers navigation tears down the execution context out from
    // under us. That is a race, not a failure: settle and try once more.
    let result
    try {
      result = await page.evaluate(collectSource, [this.gen, MAX_NODES])
    } catch (e) {
      if (!/Execution context was destroyed|Target closed|frame was detached/i.test(String(e?.message))) {
        throw new Fail('snapshot_failed', e.message, 'screenshot')
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {})
      await page.waitForTimeout(400)
      result = await page.evaluate(collectSource, [this.gen, MAX_NODES])
        .catch((e2) => { throw new Fail('snapshot_failed', e2.message, 'screenshot') })
    }
    const meta = { gen: this.gen, url: page.url(), title: await page.title().catch(() => '') }
    const interactive = result.nodes.filter((n) => n.ref).length
    const canvasHeavy = result.nodes.some((n) => n.role === 'canvas')
    return {
      text: render(result, meta),
      interactive,
      // When the AX tree is barren the model cannot work from refs, so the caller
      // attaches a screenshot and unlocks the pixel escape hatch instead.
      needs_vision: interactive < 5 || canvasHeavy,
      url: meta.url,
      title: meta.title,
    }
  }

  async envelope(extra = {}) {
    const page = this.page()
    return { ok: true, url: page.url(), title: await page.title().catch(() => ''), ...extra }
  }

  // ---------------------------------------------------------------- actions

  async navigate({ url }) {
    this.assertAllowed(url)
    const page = this.page()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
    return this.envelope({ snapshot: (await this.snapshot()).text })
  }

  async click({ ref, button = 'left', click_count = 1, modifiers = [] }) {
    const loc = await this.locate(ref)
    await loc.click({ button, clickCount: click_count, modifiers, timeout: 15000 })
    await this.page().waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
    return this.envelope({ snapshot: (await this.snapshot()).text })
  }

  /**
   * Deliberately does NOT re-snapshot unless it submitted. Typing rarely
   * restructures the page, and bumping the generation would invalidate every
   * other ref in the form you are in the middle of filling -- turning a 3-field
   * form into 3 extra snapshot round-trips.
   */
  async type({ ref, text, clear = true, submit = false }) {
    const loc = await this.locate(ref)
    if (clear) await loc.fill('', { timeout: 10000 }).catch(() => {})
    await loc.fill(String(text ?? ''), { timeout: 15000 })
    if (submit) {
      await loc.press('Enter')
      await this.page().waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
      return this.envelope({ snapshot: (await this.snapshot()).text })
    }
    const value_now = await loc.inputValue({ timeout: 5000 }).catch(() => undefined)
    return this.envelope({ value_now, note: 'refs still valid; snapshot not regenerated' })
  }

  async select({ ref, values }) {
    const loc = await this.locate(ref)
    await loc.selectOption(values.map((label) => ({ label })), { timeout: 15000 })
      .catch(async () => { await loc.selectOption(values, { timeout: 15000 }) })
    return this.envelope({ snapshot: (await this.snapshot()).text })
  }

  async find({ query, role }) {
    const page = this.page()
    // find() matches against elements tagged by a snapshot, so calling it before
    // any snapshot exists would always return not_found. Take one implicitly
    // rather than making the model discover that by wasting a step.
    if (this.gen === 0) await this.snapshot()
    const matches = await page.evaluate(
      ([q, r]) => {
        const needle = q.toLowerCase()
        const out = []
        for (const el of document.querySelectorAll('[data-gref]')) {
          const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim()
          const elRole = (el.getAttribute('role') || el.tagName).toLowerCase()
          if (!text.toLowerCase().includes(needle)) continue
          if (r && !elRole.includes(r.toLowerCase())) continue
          out.push({ ref: el.getAttribute('data-gref'), role: elRole, name: text.replace(/\s+/g, ' ').slice(0, 120) })
          if (out.length >= 25) break
        }
        return out
      },
      [query, role ?? ''],
    )
    if (matches.length === 0) {
      // Widen to the untagged DOM before giving up: the snapshot caps at 120
      // nodes, so the element may be real but simply not in it. Tag the hits so
      // they are immediately actionable.
      const widened = await page.evaluate(
        ([q, r, gen]) => {
          const needle = q.toLowerCase()
          const out = []
          let n = 100000
          for (const el of document.querySelectorAll('a,button,input,select,textarea,[role],th,td,li,span,label')) {
            const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim()
            if (!text || text.length > 200) continue
            const elRole = (el.getAttribute('role') || el.tagName).toLowerCase()
            if (!text.toLowerCase().includes(needle)) continue
            if (r && !elRole.includes(r.toLowerCase())) continue
            const rect = el.getBoundingClientRect()
            if (rect.width < 1 || rect.height < 1) continue
            const ref = `s${gen}e${++n}`
            el.setAttribute('data-gref', ref)
            out.push({ ref, role: elRole, name: text.replace(/\s+/g, ' ').slice(0, 120) })
            if (out.length >= 20) break
          }
          return out
        },
        [query, role ?? '', this.gen],
      )
      if (widened.length === 0) {
        throw new Fail('not_found', `nothing matching ${JSON.stringify(query)} on this page`, 'read_text')
      }
      return this.envelope({ matches: widened, note: 'found outside the snapshot; refs are usable' })
    }
    return this.envelope({ matches })
  }

  async read_text({ ref, max_chars = 6000 }) {
    const loc = ref ? await this.locate(ref) : this.page().locator('body')
    const raw = await loc.innerText({ timeout: 15000 }).catch(() => '')
    const text = raw.replace(/\n{3,}/g, '\n\n').trim()
    return this.envelope({
      text: text.slice(0, max_chars),
      truncated: text.length > max_chars,
      total_chars: text.length,
    })
  }

  async scroll({ direction, ref, amount }) {
    const page = this.page()
    const px = amount ?? 700
    if (ref) {
      const loc = await this.locate(ref)
      await loc.evaluate((el, [d, n]) => {
        if (d === 'top') el.scrollTop = 0
        else if (d === 'bottom') el.scrollTop = el.scrollHeight
        else el.scrollBy(0, d === 'up' ? -n : n)
      }, [direction, px])
    } else {
      await page.evaluate(([d, n]) => {
        if (d === 'top') scrollTo(0, 0)
        else if (d === 'bottom') scrollTo(0, document.body.scrollHeight)
        else scrollBy(0, d === 'up' ? -n : n)
      }, [direction, px])
    }
    await page.waitForTimeout(250)
    return this.envelope({ snapshot: (await this.snapshot()).text })
  }

  /**
   * The single biggest cost lever in the system. The naive alternative is
   * screenshot -> "is it done yet?" -> screenshot, which is N model calls with an
   * image each. This is one call that returns when the condition is actually met.
   */
  async wait_for({ text, text_gone, seconds, selector, timeout_s = 30 }) {
    const page = this.page()
    const deadline = Date.now() + Math.min(timeout_s, 300) * 1000
    if (seconds) {
      await page.waitForTimeout(Math.min(seconds, 30) * 1000)
      return this.envelope({ matched: true, waited_ms: Math.min(seconds, 30) * 1000 })
    }
    // `selector` scopes the check to one region. Waiting on whole-page text is a
    // trap on filtered views: the string you are waiting for is often already
    // present in a filter chip or heading, so the wait returns instantly and you
    // read the stale table underneath.
    const target = selector ? page.locator(selector).first() : page.locator('body')
    const started = Date.now()
    let sawTarget = false
    while (Date.now() < deadline) {
      const body = await target.innerText({ timeout: 2000 }).catch(() => null)
      if (body !== null) {
        sawTarget = true
        if (text && body.includes(text)) return this.envelope({ matched: true, waited_ms: Date.now() - started, scope: selector ?? 'body' })
        if (text_gone && !body.includes(text_gone)) return this.envelope({ matched: true, waited_ms: Date.now() - started, scope: selector ?? 'body' })
      }
      await page.waitForTimeout(500)
    }
    return this.envelope({
      matched: false,
      waited_ms: Date.now() - started,
      scope: selector ?? 'body',
      note: sawTarget ? 'condition not met before timeout' : `selector ${selector} never appeared`,
    })
  }

  async screenshot({ scope = 'viewport' }) {
    if (scope === 'full_desktop') {
      const { stdout } = await exec(
        '/usr/bin/ffmpeg',
        ['-loglevel', 'error', '-f', 'x11grab', '-video_size',
         `${process.env.SCREEN_WIDTH || 1280}x${process.env.SCREEN_HEIGHT || 800}`,
         '-i', process.env.DISPLAY || ':1', '-frames:v', '1', '-q:v', '6', '-f', 'image2', '-'],
        { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
      )
      return this.envelope({ image_base64: stdout.toString('base64'), mime: 'image/jpeg', scope })
    }
    const buf = await this.page().screenshot({ type: 'jpeg', quality: 70 })
    return this.envelope({ image_base64: buf.toString('base64'), mime: 'image/jpeg', scope })
  }

  async upload_file({ ref, paths }) {
    for (const p of paths) {
      if (!p.startsWith(WORK_DIR)) {
        throw new Fail('path_not_allowed', `${p} is outside ${WORK_DIR}`)
      }
    }
    const loc = await this.locate(ref)
    await loc.setInputFiles(paths, { timeout: 20000 })
    return this.envelope({ uploaded: paths })
  }

  // ------------------------------------------------------- the rest of Linux
  //
  // The browser is only half of this box. The container IS a full Linux machine,
  // and the reason it exists is to be the blast radius -- rootless, no host home
  // mounted, its own network namespace. So the agent gets a real shell in it.
  // curl, python3, jq, ffmpeg, git and node are all already in the image, which
  // makes a whole class of jobs a one-liner instead of twenty clicks.

  async run_bash({ command, timeout_s = 60, cwd = WORK_DIR }) {
    if (typeof command !== 'string' || !command.trim()) {
      throw new Fail('bad_command', 'command must be a non-empty string')
    }
    const started = Date.now()
    return await new Promise((resolve) => {
      const child = spawn('/bin/bash', ['-lc', command], {
        cwd,
        env: { ...process.env, TERM: 'dumb' },
      })
      let out = '', err = '', killed = false
      const CAP = 200_000
      child.stdout.on('data', (d) => { if (out.length < CAP) out += d })
      child.stderr.on('data', (d) => { if (err.length < CAP) err += d })
      const timer = setTimeout(() => { killed = true; child.kill('SIGKILL') }, Math.min(timeout_s, 600) * 1000)
      child.on('close', (code) => {
        clearTimeout(timer)
        const trunc = out.length >= CAP || err.length >= CAP
        resolve({
          ok: code === 0 && !killed,
          exit_code: killed ? 124 : code,
          stdout: out.slice(0, CAP),
          stderr: err.slice(0, CAP),
          truncated: trunc,
          timed_out: killed,
          cwd,
          took_ms: Date.now() - started,
          ...(code !== 0 && !killed ? { error: 'nonzero_exit', message: `exited ${code}` } : {}),
          ...(killed ? { error: 'timeout', message: `killed after ${timeout_s}s` } : {}),
        })
      })
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ ok: false, error: 'spawn_failed', message: e.message })
      })
    })
  }

  async read_file({ path, max_bytes = 200_000 }) {
    const buf = await readFile(path).catch((e) => { throw new Fail('read_failed', e.message) })
    return {
      ok: true, path, bytes: buf.length, truncated: buf.length > max_bytes,
      content: buf.subarray(0, max_bytes).toString('utf8'),
    }
  }

  async write_file({ path, content, append = false }) {
    // Writes stay under the work dir: that is the shared surface with the human,
    // and it keeps the agent from scribbling over the browser profile.
    if (!path.startsWith(WORK_DIR)) throw new Fail('path_not_allowed', `writes must be under ${WORK_DIR}`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, String(content ?? ''), { flag: append ? 'a' : 'w' })
      .catch((e) => { throw new Fail('write_failed', e.message) })
    const st = await stat(path)
    return { ok: true, path, bytes: st.size }
  }

  async list_files({ path = WORK_DIR }) {
    const names = await readdir(path, { withFileTypes: true })
      .catch((e) => { throw new Fail('list_failed', e.message) })
    const entries = []
    for (const d of names.slice(0, 300)) {
      const full = `${path}/${d.name}`
      const st = await stat(full).catch(() => null)
      entries.push({ name: d.name, dir: d.isDirectory(), bytes: st?.size ?? null })
    }
    return { ok: true, path, entries }
  }

  /** Last resort for canvas apps and native dialogs the CDP path cannot see. */
  async desktop_action({ action, x, y, to_x, to_y, keys, text }) {
    const args = {
      click: ['mousemove', String(x), String(y), 'click', '1'],
      double_click: ['mousemove', String(x), String(y), 'click', '--repeat', '2', '1'],
      right_click: ['mousemove', String(x), String(y), 'click', '3'],
      move: ['mousemove', String(x), String(y)],
      key: ['key', String(keys)],
      type: ['type', '--delay', '40', String(text)],
      drag: ['mousemove', String(x), String(y), 'mousedown', '1', 'mousemove', String(to_x), String(to_y), 'mouseup', '1'],
    }[action]
    if (!args) throw new Fail('bad_action', `unknown desktop action: ${action}`)
    await exec('/usr/bin/xdotool', args, { env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1' } })
    return this.envelope({ performed: action })
  }
}
