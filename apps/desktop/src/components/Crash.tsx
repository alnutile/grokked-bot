import { Component, type ReactNode } from 'react'
import { Mascot } from './Mascot.tsx'

/** A render error otherwise unmounts everything and leaves a black window
 *  with no clue. Show what broke and a way out instead. */
export class Crash extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="boot">
        <Mascot size={112} mood="stuck" />
        <h1>Something broke on this screen</h1>
        <p className="boot-msg">Your bots keep working in the background. Reloading usually fixes it.</p>
        <div className="boot-actions">
          <button className="btn" onClick={() => location.reload()}>Reload</button>
        </div>
        <pre className="logs">{error.message}{'\n'}{error.stack?.split('\n').slice(1, 6).join('\n')}</pre>
      </div>
    )
  }
}
