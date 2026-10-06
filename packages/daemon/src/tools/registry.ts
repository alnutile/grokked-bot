import * as z from 'zod'
import type { ToolDef } from '../model/openrouter.ts'
import type { BotRuntime } from '../runtime/container.ts'
import type { Db } from '../db/index.ts'
import { hostMatches, vault } from '../vault.ts'

export type Risk = 'low' | 'medium' | 'high'

export interface ToolCtx {
  runtime: BotRuntime
  runId: string
  botId: string
  db: Db
}

export interface Tool {
  name: string
  description: string
  schema: z.ZodType
  risk: Risk
  approval: 'always' | 'never'
  /** Pure reads are safe to re-run after a crash; mutating ones are not. */
  replaySafe: boolean
  /** Terminal tools end the run rather than producing a tool result. */
  control?: 'finish' | 'give_up' | 'ask_human'
  run?: (args: any, ctx: ToolCtx) => Promise<unknown>
}

const passthrough = (action: string) => (args: any, ctx: ToolCtx) => ctx.runtime.act(action, args)

const S = z.strictObject

export const TOOLS: Tool[] = [
  // ---------------------------------------------------------------- browser
  {
    name: 'browser_navigate',
    description: 'Point the browser at a URL and wait for it to settle. Returns a fresh snapshot.',
    schema: S({ url: z.string().describe('Absolute URL including scheme.') }),
    risk: 'low', approval: 'never', replaySafe: true, run: passthrough('navigate'),
  },
  {
    name: 'browser_snapshot',
    description:
      'Get the accessibility outline of the current page: every interactive element with a stable [ref=...]. ' +
      'Call before your first interaction with a page and after anything that changes it. ' +
      'Returns text, not an image — prefer this over browser_screenshot.',
    schema: S({}),
    risk: 'low', approval: 'never', replaySafe: true, run: passthrough('snapshot'),
  },
  {
    name: 'browser_click',
    description:
      'Click an element by ref from the MOST RECENT snapshot. Waits for it to be visible, stable and enabled. ' +
      'Refs from older snapshots are rejected.',
    schema: S({
      ref: z.string().describe("A ref from the current snapshot, e.g. 's7e21'."),
      element: z.string().describe("What you are clicking, in plain words, e.g. 'Save button'. Shown in the log and to the human."),
      button: z.enum(['left', 'right', 'middle']).default('left'),
      click_count: z.union([z.literal(1), z.literal(2)]).default(1),
    }),
    risk: 'medium', approval: 'never', replaySafe: false, run: passthrough('click'),
  },
  {
    name: 'browser_type',
    description:
      'Type into a textbox by ref. Does NOT invalidate other refs, so you can fill a whole form from one snapshot. ' +
      'Set submit=true to press Enter afterwards.',
    schema: S({
      ref: z.string(),
      element: z.string().describe('Name of the field, in plain words.'),
      text: z.string(),
      clear: z.boolean().default(true),
      submit: z.boolean().default(false),
    }),
    risk: 'medium', approval: 'never', replaySafe: false, run: passthrough('type'),
  },
  {
    name: 'browser_select',
    description:
      'Choose an option in a dropdown (a combobox or listbox in the snapshot, e.g. a native <select>) by its ' +
      'visible label. Use this rather than clicking or typing into a dropdown. Returns a fresh snapshot.',
    schema: S({
      ref: z.string(),
      element: z.string().describe('Name of the dropdown, in plain words.'),
      values: z.array(z.string()).min(1).describe('Option label(s) to choose, e.g. ["House candidates"].'),
    }),
    risk: 'medium', approval: 'never', replaySafe: false, run: passthrough('select'),
  },
  {
    name: 'browser_find',
    description:
      'Find elements whose text matches a query when the snapshot was truncated or the element is off-screen. ' +
      'Returns refs. Much cheaper than a screenshot.',
    schema: S({ query: z.string(), role: z.string().optional().describe("Optional role filter, e.g. 'button'.") }),
    risk: 'low', approval: 'never', replaySafe: true, run: passthrough('find'),
  },
  {
    name: 'browser_read_text',
    description:
      'Read the rendered text of the page as markdown. Use this to READ content. ' +
      'Never take a screenshot just to read text — this is far cheaper and more accurate.',
    schema: S({ ref: z.string().optional(), max_chars: z.number().default(6000) }),
    risk: 'low', approval: 'never', replaySafe: true, run: passthrough('read_text'),
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page or a scrollable element.',
    schema: S({
      direction: z.enum(['down', 'up', 'top', 'bottom']),
      ref: z.string().optional(),
      amount: z.number().optional(),
    }),
    risk: 'low', approval: 'never', replaySafe: true, run: passthrough('scroll'),
  },
  {
    name: 'browser_wait_for',
    description:
      'Wait until text appears or disappears. ALWAYS prefer this over repeated snapshots when something is loading. ' +
      'Pass `selector` to scope the check to one region — waiting on whole-page text is a trap on filtered views, ' +
      'because the string is often already present in a heading or filter chip, so the wait returns instantly ' +
      'and you read the stale content underneath.',
    schema: S({
      text: z.string().optional(),
      text_gone: z.string().optional(),
      selector: z.string().optional().describe("CSS selector to scope the check, e.g. 'table'."),
      seconds: z.number().optional(),
      timeout_s: z.number().default(30),
    }),
    risk: 'low', approval: 'never', replaySafe: true, run: passthrough('wait_for'),
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture the screen as an image. EXPENSIVE and imprecise. Use browser_snapshot for structure and ' +
      'browser_read_text for content. Only use this for canvas/drawing apps, when a snapshot returned nothing ' +
      "usable, or when you must visually confirm a result. scope='full_desktop' includes browser chrome and any OS dialog.",
    schema: S({ scope: z.enum(['viewport', 'full_desktop']).default('viewport') }),
    risk: 'low', approval: 'never', replaySafe: true, run: passthrough('screenshot'),
  },

  // ------------------------------------------------------- the rest of Linux
  {
    name: 'run_bash',
    description:
      'Run a bash command on YOUR computer. This is a full Ubuntu machine with curl, python3, node, git, ' +
      'ffmpeg and the usual tools. Use it for anything easier in a shell than in a browser: parsing files, ' +
      'reshaping data, arithmetic, checking what you downloaded. Downloads land in /data/work/downloads; ' +
      'put anything you produce for the human in /data/work/out.',
    schema: S({
      command: z.string(),
      timeout_s: z.number().default(60),
      cwd: z.string().default('/data/work'),
    }),
    risk: 'medium', approval: 'never', replaySafe: false, run: passthrough('run_bash'),
  },
  {
    name: 'write_file',
    description:
      'Write a file under /data/work. Use this for scripts rather than heredocs in run_bash — quoting through ' +
      'bash is a common source of mistakes. Write a .py file, then run it with run_bash.',
    schema: S({ path: z.string(), content: z.string(), append: z.boolean().default(false) }),
    risk: 'medium', approval: 'never', replaySafe: false, run: passthrough('write_file'),
  },
  {
    name: 'desktop_action',
    description:
      'LAST RESORT. Drive the raw desktop by pixel coordinate or keystroke, outside the browser. Only use when ' +
      'browser_snapshot returned no usable refs (a canvas app) or a native OS dialog is on screen. Coordinates ' +
      'are in 1280x800 full-desktop screenshot space. Requires human approval and is slow.',
    schema: S({
      action: z.enum(['click', 'double_click', 'right_click', 'move', 'key', 'type', 'drag']),
      x: z.number().optional(), y: z.number().optional(),
      to_x: z.number().optional(), to_y: z.number().optional(),
      keys: z.string().optional().describe("xdotool syntax, e.g. 'ctrl+shift+t' or 'Return'."),
      text: z.string().optional(),
      reason: z.string().describe('Why a ref-based tool could not do this. Shown to the human approving.'),
    }),
    risk: 'high', approval: 'always', replaySafe: false,
    // The shim request's own `action` names the shim action, so the desktop op
    // travels as `op`. Sharing the key silently turned every call into a click.
    run: ({ action, ...rest }: any, ctx: ToolCtx) => ctx.runtime.act('desktop_action', { ...rest, op: action }),
  },

  // ---------------------------------------------------------------- saved logins
  {
    name: 'credentials_list',
    description:
      'List the logins the human has saved for you, each with how_to_sign_in: the exact steps for that site, ' +
      'including sites that sign in with Google or another provider. Passwords are never shown to you. ' +
      'Check this before asking the human to sign you in, and follow how_to_sign_in.',
    schema: S({}),
    risk: 'low', approval: 'never', replaySafe: true,
    run: async (_args, ctx) => ({ ok: true, credentials: vault.forBotWithSteps(ctx.db, ctx.botId) }),
  },
  {
    name: 'browser_fill_credential',
    description:
      'Type a saved username or password into a field by ref, without you ever seeing it. Only works on a page ' +
      "on the credential's own site. Call once for the username field and once for the password field, then " +
      'click the sign-in button yourself.',
    schema: S({
      credential_id: z.string().describe('An id from credentials_list.'),
      field: z.enum(['username', 'password']),
      ref: z.string().describe('The textbox ref from the current snapshot.'),
      element: z.string().describe('Name of the field, in plain words.'),
    }),
    risk: 'medium', approval: 'never', replaySafe: false,
    run: async (args, ctx) => {
      const sso = vault.ssoSiteFor(ctx.db, args.credential_id)
      if (sso) {
        return {
          ok: false, error: 'sign_in_with_provider',
          message: `${sso.label} has no password of its own; it signs in with ${sso.sign_in_with}. Click its ` +
            `${sso.sign_in_with} button, then fill the provider account` +
            (sso.via_credential_id ? ` (credential ${sso.via_credential_id}) on the provider's page.` : '; none is saved, so ask_human.'),
        }
      }
      const c = vault.secretFor(ctx.db, args.credential_id, ctx.botId)
      if (!c) return { ok: false, error: 'no_such_credential', message: 'No saved login with that id is available to you.' }
      const text = args.field === 'username' ? c.row.username : c.secret
      if (!text) {
        return { ok: false, error: 'not_saved', message: `No ${args.field} is saved for ${c.row.label}. Ask the human.`, recovery: 'ask_human' }
      }
      // Never type a secret into the wrong site: a lookalike page or a redirect
      // must not be able to collect it.
      const page = await ctx.runtime.act('page_info', {}) as { ok: boolean; url?: string }
      let host = ''
      try { host = new URL(String(page.url)).hostname } catch { /* about:blank etc. */ }
      if (!host || !hostMatches(host, c.row.domain)) {
        return {
          ok: false, error: 'wrong_site',
          message: `This page is on ${host || 'no site'}, but ${c.row.label} is for ${c.row.domain}. ` +
                   'Saved logins are only typed on their own site.',
        }
      }
      const out = await ctx.runtime.act('type', { ref: args.ref, text, clear: true, submit: false }) as
        { ok: boolean; url?: string; error?: string; message?: string }
      // The shim echoes the field's value back; that must not reach the model.
      if (out.ok === false) {
        return { ok: false, error: out.error, message: String(out.message ?? '').replaceAll(text, '•••') }
      }
      return {
        ok: true, url: out.url,
        typed: args.field === 'password' ? 'the saved password (hidden from you)' : `the username ${c.row.username}`,
        note: 'refs still valid; snapshot not regenerated',
      }
    },
  },

  // ---------------------------------------------------------------- control
  {
    name: 'finish',
    description: 'Declare the task done. Call this exactly once, at the end.',
    schema: S({
      status: z.enum(['success', 'partial']),
      summary: z.string().describe("What you did, in the user's terms."),
      artifacts: z.array(z.string()).default([]).describe('Paths under /data/work/out that you produced.'),
    }),
    risk: 'low', approval: 'never', replaySafe: true, control: 'finish',
  },
  {
    name: 'give_up',
    description:
      'Stop because you cannot proceed. Use this rather than burning steps pretending. Say precisely what blocked you.',
    schema: S({ reason: z.string(), tried: z.array(z.string()).default([]) }),
    risk: 'low', approval: 'never', replaySafe: true, control: 'give_up',
  },
  {
    name: 'ask_human',
    description:
      'Pause and ask the person. Use for a login wall, an MFA challenge, a CAPTCHA, an ambiguous choice, or ' +
      'anything irreversible you are unsure about. They may answer, or take over the screen themselves and hand it back.',
    schema: S({ question: z.string(), attach_screenshot: z.boolean().default(true) }),
    risk: 'low', approval: 'never', replaySafe: true, control: 'ask_human',
  },
]

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/** One Zod declaration yields the wire schema, runtime validation and the static type. */
export function toolDefs(names?: string[]): ToolDef[] {
  const list = names ? TOOLS.filter((t) => names.includes(t.name)) : TOOLS
  return list.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema, { io: 'input' }),
    },
  }))
}
