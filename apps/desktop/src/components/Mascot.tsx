/**
 * The app's own character: the same two-eyed blob as the bots (see Avatar.tsx),
 * peeking over the computer it works on. src-tauri/icons/icon.svg is this on a
 * tile, so keep the two in step.
 */
export function Mascot({ size = 96, mood = 'idle' }: { size?: number; mood?: 'idle' | 'working' | 'stuck' }) {
  const eyeRy = mood === 'stuck' ? 1.4 : 3.6
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className={`mascot mascot-${mood}`}>
      <g className="mascot-body">
        <path d="M15 31 C15 17 22 10 32 10 C42 10 49 17 49 31 Z" fill="#5b8cff" />
        <ellipse cx="27" cy="22" rx="2.4" ry={eyeRy} fill="#141414" />
        <ellipse cx="37" cy="22" rx="2.4" ry={eyeRy} fill="#141414" />
      </g>
      <rect x="8" y="29" width="48" height="27" rx="5" fill="#2b303a" />
      <rect x="12" y="33" width="40" height="19" rx="2.5" fill="#0f1012" />
      <path d="M17 38.5 L21 42 L17 45.5" stroke="#5b8cff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <rect className="mascot-caret" x="23.5" y="44" width="6" height="2" rx="1" fill="#5b8cff" />
      <circle cx="20" cy="30" r="3.4" fill="#5b8cff" />
      <circle cx="44" cy="30" r="3.4" fill="#5b8cff" />
      <rect x="28.5" y="56" width="7" height="3.5" fill="#2b303a" />
      <rect x="22" y="59" width="20" height="3" rx="1.5" fill="#2b303a" />
    </svg>
  )
}
