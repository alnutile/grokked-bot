import * as z from 'zod'

export const PROTOCOL_VERSION = 1

/* ----------------------------------------------------------------- health */

export const Health = z.object({
  ok: z.boolean(),
  version: z.string(),
  protocol: z.number(),
  instance_id: z.string(),
  uptime_s: z.number(),
  db_ok: z.boolean(),
  active_runs: z.number(),
  pending_approvals: z.number(),
  server_seq: z.number(),
})
export type Health = z.infer<typeof Health>

/* ------------------------------------------------------------ ws: inbound */
/* Deliberately thin. Anything with a side effect goes over HTTP so it gets
   real status codes and retry semantics. */

export const ClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), topics: z.array(z.string()).max(64) }),
  z.object({ type: z.literal('unsubscribe'), topics: z.array(z.string()).max(64) }),
  z.object({ type: z.literal('ping') }),
])
export type ClientFrame = z.infer<typeof ClientFrame>

/* ----------------------------------------------------------- ws: outbound */

export const EVENT_TYPES = [
  'message.appended',
  'run.created',
  'run.state',
  'run.step',
  'run.delta',
  'run.finished',
  'approval.requested',
  'approval.resolved',
  'notification.created',
  'trigger.fired',
  'usage.updated',
  'bot.presence',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

/** Every server frame shares this envelope. `seq` is the `events` rowid. */
export const ServerFrame = z.object({
  v: z.literal(PROTOCOL_VERSION),
  seq: z.number(),
  ts: z.number(),
  type: z.string(),
  topic: z.string(),
  data: z.unknown(),
})
export type ServerFrame = z.infer<typeof ServerFrame>

/** Sent once on connect. `dropped` means the requested `since` fell outside
 *  retention, so the client must do a full refetch rather than trusting replay. */
export const Hello = z.object({
  daemon_version: z.string(),
  protocol: z.number(),
  instance_id: z.string(),
  server_seq: z.number(),
  dropped: z.boolean(),
})
export type Hello = z.infer<typeof Hello>

/* --------------------------------------------------------------- domain */

export const RunState = z.enum([
  'queued', 'running', 'awaiting_approval', 'sleeping',
  'blocked', 'paused_budget', 'succeeded', 'failed', 'cancelled',
])
export type RunState = z.infer<typeof RunState>

export const Presence = z.enum(['idle', 'thinking', 'working', 'waiting_on_you', 'blocked'])
export type Presence = z.infer<typeof Presence>

export const Risk = z.enum(['low', 'medium', 'high'])
export type Risk = z.infer<typeof Risk>

export const ModelRole = z.enum(['planner', 'worker', 'vision', 'distiller', 'classifier'])
export type ModelRole = z.infer<typeof ModelRole>

export const Bot = z.object({
  id: z.string(),
  name: z.string(),
  persona_md: z.string(),
  autonomy: z.enum(['supervised', 'semi', 'auto']),
  status: z.enum(['active', 'paused', 'archived']),
  container_ref: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
})
export type Bot = z.infer<typeof Bot>

export const Thread = z.object({
  id: z.string(),
  bot_id: z.string(),
  kind: z.enum(['chat', 'run']),
  title: z.string().nullable(),
  last_message_at: z.number().nullable(),
  created_at: z.number(),
})
export type Thread = z.infer<typeof Thread>

export const Message = z.object({
  id: z.string(),
  thread_id: z.string(),
  seq: z.number(),
  role: z.enum(['user', 'assistant', 'tool', 'system', 'event']),
  content: z.unknown(),
  tool_call_id: z.string().nullable(),
  run_id: z.string().nullable(),
  step_no: z.number().nullable(),
  created_at: z.number(),
})
export type Message = z.infer<typeof Message>

/* -------------------------------------------------------------- errors */

export const ApiError = z.object({
  error: z.string(),
  message: z.string(),
  ref: z.string().optional(),
})
export type ApiError = z.infer<typeof ApiError>

/* -------------------------------------------------------------- topics */

export const topics = {
  bot: (id: string) => `bot:${id}`,
  run: (id: string) => `run:${id}`,
  thread: (id: string) => `thread:${id}`,
  approvals: 'approvals',
  notifications: 'notifications',
  system: 'system',
} as const
