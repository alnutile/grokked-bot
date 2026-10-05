import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * The X clipboard, so the human can move text between their PC and the bot's
 * screen. noVNC 1.3 can't reach the host clipboard from inside the app, so the
 * desktop client does that half and hands the text over here.
 */
export async function readClipboard() {
  try {
    const { stdout } = await exec('xclip', ['-selection', 'clipboard', '-o'], { timeout: 3000 })
    return stdout
  } catch {
    return '' // xclip exits non-zero when nothing has been copied yet
  }
}

/** Sets CLIPBOARD and PRIMARY, then optionally presses Ctrl+V in the focused window. */
export async function writeClipboard(text, { paste = false } = {}) {
  for (const selection of ['clipboard', 'primary']) {
    // xclip forks to keep serving the selection. Its stdout must not be piped
    // back to us, or we'd wait on the fork forever.
    await new Promise((resolve, reject) => {
      const p = spawn('xclip', ['-selection', selection, '-i'], { stdio: ['pipe', 'ignore', 'ignore'] })
      p.on('error', reject)
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`xclip exited ${code}`))))
      p.stdin.end(text)
    })
  }
  if (paste) await exec('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], { timeout: 3000 })
}
