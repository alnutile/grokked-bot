import type { Bot } from '../api.ts'

/** Blob, hexagon, drop, mound: each bot is a coloured shape with two eyes. */
const SHAPES = [
  'M14 30 C14 18 22 12 32 12 C42 12 50 18 50 30 C50 44 42 50 32 50 C22 50 14 44 14 30 Z',
  'M32 8 L53 20 L53 44 L32 56 L11 44 L11 20 Z',
  'M32 6 C38 18 50 28 50 40 C50 50 42 57 32 57 C22 57 14 50 14 40 C14 28 26 18 32 6 Z',
  'M32 10 C36 10 39 13 42 19 L54 44 C57 51 53 56 46 56 L18 56 C11 56 7 51 10 44 L22 19 C25 13 28 10 32 10 Z',
]
const EYES_Y = [27, 29, 35, 34]

function hashOf(id: string): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}

/** The bot's stored look, or a stable one derived from its id for older bots. */
export function look(bot: Pick<Bot, 'id' | 'avatar'>): { shape: number; hue: number } {
  const h = hashOf(bot.id)
  return {
    shape: bot.avatar?.shape ?? h % SHAPES.length,
    hue: bot.avatar?.hue ?? (h >>> 3) % 360,
  }
}

export function Avatar({ bot, size = 40 }: { bot: Pick<Bot, 'id' | 'avatar'>; size?: number }) {
  const { shape, hue } = look(bot)
  const s = shape % SHAPES.length
  const y = EYES_Y[s]!
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className="avatar-svg">
      <path d={SHAPES[s]} fill={`hsl(${hue} 62% 52%)`} />
      <ellipse cx="27" cy={y} rx="2.4" ry="3.6" fill="#141414" />
      <ellipse cx="37" cy={y} rx="2.4" ry="3.6" fill="#141414" />
    </svg>
  )
}

/** The bot's face as a square PNG (data URL), for a Slack app icon. */
export async function avatarPng(bot: Pick<Bot, 'id' | 'avatar'>, size = 1024): Promise<string> {
  const { shape, hue } = look(bot)
  const s = shape % SHAPES.length
  const y = EYES_Y[s]!
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
    <rect width="64" height="64" fill="${avatarBackground(bot)}"/>
    <g transform="translate(6.4 6.4) scale(0.8)">
      <path d="${SHAPES[s]}" fill="hsl(${hue} 62% 52%)"/>
      <ellipse cx="27" cy="${y}" rx="2.4" ry="3.6" fill="#141414"/>
      <ellipse cx="37" cy="${y}" rx="2.4" ry="3.6" fill="#141414"/>
    </g></svg>`
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  canvas.getContext('2d')!.drawImage(img, 0, 0, size, size)
  return canvas.toDataURL('image/png')
}

/** A dark tint of the bot's colour, as #rrggbb: the icon's ground and the Slack app's colour. */
export function avatarBackground(bot: Pick<Bot, 'id' | 'avatar'>): string {
  const { hue } = look(bot)
  const l = 0.2, sat = 0.35, a = sat * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + hue / 30) % 12
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}
