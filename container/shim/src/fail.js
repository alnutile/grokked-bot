/** A refusal the agent can act on: a code to branch on and, ideally, what to do next. */
export class Fail extends Error {
  constructor(code, message, recovery) {
    super(message)
    this.code = code
    this.recovery = recovery
  }
}
