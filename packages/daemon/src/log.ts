import { pino } from 'pino'

export const log = pino({
  level: process.env.GROKKED_LOG_LEVEL ?? 'info',
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
})
