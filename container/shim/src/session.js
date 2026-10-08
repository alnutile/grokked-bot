import { chromium } from 'playwright-core'
import { execFile, spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { aiSnapshot, fullSnapshot, refPattern } from './snapshot.js'

const exec = promisify(execFile)
const CDP = `http://127.0.0.1:${process.env.CDP_PORT || 9222}`
const WORK_DIR = process.env.WORK_DIR || '/data/work'

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
        // Follow new windows the moment they open: "Sign in with Google" and
        // target=_blank links both land in one, and acting on the old page
        // meanwhile is acting on the wrong thing. Closing it falls back (page()).
        for (const p of this.#context.pages()) this.#watchAuth(p)
        this.#context.on('page', (p) => {
          this.#watchAuth(p)
          this.#page = p
          this.windowNote = 'A new window opened and you are now in it. Snapshot before acting; when it closes you return to the previous one.'
          void p.bringToFront().catch(() => {})
          p.on('close', () => { this.windowNote = 'That window closed; you are back in the previous one. Snapshot before acting.' })
        })
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

  /** Notice HTTP basic-auth challenges. Chrome answers them with its own
   *  sign-in popup, outside the page: the bot can't see it in a snapshot or
   *  click it, so it has to be told (see envelope) and answer with http_auth. */
  #watchAuth(p) {
    p.on('response', (r) => {
      if (r.status() !== 401 || !r.request().isNavigationRequest()) return
      const header = r.headers()['www-authenticate'] ?? ''
      if (!/^\s*(basic|digest)\b/i.test(header)) return
      this.authChallenge = { url: r.url(), realm: /realm="([^"]*)"/i.exec(header)?.[1] ?? '' }
    })
  }

  #authNote() {
    const c = this.authChallenge
    if (!c) return null
    const host = new URL(c.url).host
    return {
      url: c.url,
      host,
      realm: c.realm,
      message: `${host} asks for an HTTP sign-in (a browser popup outside the page that you cannot see or click). ` +
        `Call credentials_list, then browser_http_auth with the saved login for ${new URL(c.url).hostname}. If none is saved, ask_human.`,
    }
  }

  page() {
    // If the current window closed (an SSO popup finishing), fall back to the newest one left.
    const pages = this.#context?.pages() ?? []
    if (pages.length && !pages.includes(this.#page)) {
      this.#page = pages[pages.length - 1]
      void this.#page.bringToFront().catch(() => {})
    }
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

  /** s7e121 -> Playwright's aria-ref=e121. Playwright keeps an element's ref
   *  stable across snapshots, so any ref works while its element is on the page;
   *  a vanished element is a hard stale_ref, never a click on something else.
   *  (The aria-ref engine resolves against the latest full snapshot, which is
   *  why scoped snapshots and find() always take a full one underneath.) */
  async locate(ref) {
    const m = refPattern.exec(String(ref ?? ''))
    if (!m) throw new Fail('bad_ref', `not a ref: ${ref}`)
    const loc = this.page().locator(`aria-ref=${m[2]}`)
    if ((await loc.count().catch(() => 0)) === 0) {
      throw new Fail('stale_ref', `ref ${ref} is no longer on the page (it changed); take a fresh snapshot`, 'snapshot')
    }
    return loc.first()
  }

  async snapshot({ ref } = {}) {
    const page = this.page()
    this.gen += 1
    const scope = ref ? refPattern.exec(String(ref))?.[2] && String(ref).replace(/^s\d+/, `s${this.gen}`) : null
    if (ref && !scope) throw new Fail('bad_ref', `not a ref: ${ref}`)
    // A click that triggers navigation tears down the execution context out from
    // under us. That is a race, not a failure: settle and try once more.
    let result
    try {
      result = await aiSnapshot(page, this.gen, scope)
    } catch (e) {
      if (!/Execution context was destroyed|Target closed|frame was detached|navigat/i.test(String(e?.message))) {
        throw new Fail('snapshot_failed', e.message, 'screenshot')
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {})
      await page.waitForTimeout(400)
      result = await aiSnapshot(page, this.gen, scope)
        .catch((e2) => { throw new Fail('snapshot_failed', e2.message, 'screenshot') })
    }
    if (result.missingScope) throw new Fail('stale_ref', `${ref} is no longer on the page; take a full snapshot`, 'snapshot')
    this.lastSnapshot = result.full
    return {
      text: result.text,
      interactive: result.refs,
      // When the tree is barren the model cannot work from refs, so the caller
      // attaches a screenshot and unlocks the pixel escape hatch instead.
      needs_vision: result.refs < 5 || result.canvasHeavy,
      url: result.url,
      title: result.title,
    }
  }

  async envelope(extra = {}) {
    const page = this.page()
    const note = this.windowNote
    this.windowNote = undefined
    const auth = this.#authNote()
    return {
      ok: true, url: page.url(), title: await page.title().catch(() => ''),
      ...(note ? { window: note } : {}), ...(auth ? { http_auth_required: auth } : {}), ...extra,
    }
  }

  // ---------------------------------------------------------------- actions

  /** Where the browser is, cheaply. The daemon checks this before typing a saved
   *  password, so a secret only ever goes to its own site. */
  async page_info() {
    return this.envelope()
  }

  async navigate({ url }) {
    this.assertAllowed(url)
    const page = this.page()
    this.authChallenge = null
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    } catch (e) {
      // Under Playwright, a basic-auth challenge with no credentials fails the
      // navigation outright; say what it was rather than a bare net:: error.
      const auth = this.#authNote()
      if (auth || /ERR_INVALID_AUTH_CREDENTIALS/.test(String(e?.message))) {
        throw new Fail('http_auth_required', auth?.message ??
          `${new URL(url).host} asks for an HTTP sign-in. Call credentials_list, then browser_http_auth; if none is saved, ask_human.`,
          'browser_http_auth')
      }
      throw e
    }
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
    return this.envelope({ snapshot: (await this.snapshot()).text })
  }

  /** Answer an HTTP basic-auth challenge with a saved login the daemon hands
   *  over. Playwright can't scope credentials to one site, so they're set only
   *  for this one load and cleared at once; Chrome caches an accepted login for
   *  the site, so its later requests keep working. The daemon has already
   *  checked that the site matches the login's domain. */
  async http_auth({ username, password, url }) {
    const page = this.page()
    const target = url || this.authChallenge?.url || page.url()
    this.assertAllowed(target)
    let res
    try {
      await this.#context.setHTTPCredentials({ username: String(username), password: String(password) })
      res = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null)
    } finally {
      await this.#context.setHTTPCredentials(null).catch(() => {})
    }
    if (!res || res.status() === 401) {
      throw new Fail('auth_rejected', `the site rejected the saved login for ${new URL(target).host}`, 'ask_human')
    }
    this.authChallenge = null
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
    return this.envelope({ status: res.status(), snapshot: (await this.snapshot()).text })
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

  /** Lines of the whole page (never the cut-down snapshot) that mention the
   *  query, with their refs. Refs from earlier snapshots stay valid. */
  async find({ query, role }) {
    await this.snapshot()
    const needle = String(query).toLowerCase()
    const lines = this.lastSnapshot.split('\n')
    const matches = []
    lines.forEach((line, i) => {
      if (!line.toLowerCase().includes(needle)) return
      if (role && !line.trimStart().startsWith(`- ${role}`)) return
      // A bare text hit is usually the label inside something clickable: show
      // the nearest line above it that has a ref.
      let j = i
      while (j > 0 && !lines[j].includes('[ref=')) j--
      matches.push(lines[j] === line ? line.trim() : `${lines[j].trim()}  ⟶  ${line.trim()}`)
    })
    // One entry per element: a link and its own /url line would otherwise both match.
    const seen = new Set()
    const unique = matches.filter((m) => {
      const ref = /\[ref=([^\]]+)\]/.exec(m)?.[1] ?? m
      if (seen.has(ref)) return false
      seen.add(ref)
      return true
    }).slice(0, 25)
    if (unique.length === 0) {
      throw new Fail('not_found', `nothing matching ${JSON.stringify(query)} on this page`, 'read_text')
    }
    return this.envelope({ matches: unique })
  }

  async read_text({ ref, max_chars = 6000 }) {
    const loc = ref ? await this.locate(ref) : this.page().locator('body')
    let raw = await loc.innerText({ timeout: 15000 }).catch(() => '')
    // innerText misses text that lives in shadow roots (web-component sites).
    // The accessibility snapshot sees it, so fall back to that, minus the refs.
    if (!ref && raw.trim().length < 200) {
      const snap = await fullSnapshot(this.page(), this.gen).catch(() => null)
      if (snap && snap.text.length > raw.length) raw = snap.text.replace(/ \[ref=[^\]]+\]/g, '')
    }
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
    // page.screenshot can hang on a page that never finishes loading fonts; the
    // X display always answers, so fall back to it rather than lose the step.
    const buf = await this.page().screenshot({ type: 'jpeg', quality: 70, timeout: 8000 }).catch(() => null)
    if (!buf) return { ...(await this.screenshot({ scope: 'full_desktop' })), note: 'browser screenshot timed out; this is the whole desktop' }
    return this.envelope({ image_base64: buf.toString('base64'), mime: 'image/jpeg', scope })
  }

  /** Attach files to an upload control. Real sites hide the <input type=file>
   *  behind a styled "Upload" button, so a ref to that button works too: we
   *  click it and fill the file chooser it opens -- the native dialog, which
   *  nothing could drive, never appears. */
  async upload_file({ ref, paths }) {
    for (const p of paths) {
      if (!p.startsWith(WORK_DIR)) {
        throw new Fail('path_not_allowed', `${p} is outside ${WORK_DIR}`)
      }
      await stat(p).catch(() => { throw new Fail('no_such_file', `${p} does not exist; list_files or run_bash ls to find it`) })
    }
    const loc = await this.locate(ref)
    const isFileInput = await loc.evaluate((el) => el instanceof HTMLInputElement && el.type === 'file').catch(() => false)
    if (isFileInput) {
      await loc.setInputFiles(paths, { timeout: 20000 })
    } else {
      const [chooser] = await Promise.all([
        this.page().waitForEvent('filechooser', { timeout: 8000 }),
        loc.click({ timeout: 10000 }),
      ]).catch(() => { throw new Fail('no_file_chooser', `clicking ${ref} did not open a file chooser; snapshot and pick the upload button or file input`, 'snapshot') })
      await chooser.setFiles(paths)
    }
    return this.envelope({ uploaded: paths.map((p) => p.split('/').pop()) })
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
  // `op`, not `action`: the request body's own `action` field names the shim
  // action ("desktop_action"), and sharing the key used to overwrite it.
  async desktop_action({ op, x, y, to_x, to_y, keys, text }) {
    const action = op
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
