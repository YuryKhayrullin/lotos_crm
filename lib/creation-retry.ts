/** Keeps one immutable creation attempt until the server confirms it. */
export class CreationRetry<T> {
  attempt: { payload: T; requestId: string } | null = null
  running = false
  private uncertain = false

  async submit<R>(
    payload: T,
    makeId: () => string,
    send: (payload: T, requestId: string) => Promise<R>,
    definitiveRejection: (error: unknown) => boolean,
  ): Promise<R | undefined> {
    if (this.running) return undefined
    this.running = true
    try {
      if (!this.attempt) this.attempt = { payload: JSON.parse(JSON.stringify(payload)) as T, requestId: makeId() }
      const result = await send(this.attempt.payload, this.attempt.requestId)
      this.attempt = null
      this.uncertain = false
      return result
    } catch (error) {
      // A later rejection cannot prove that an earlier lost reply did not commit.
      if (!this.uncertain && definitiveRejection(error)) this.attempt = null
      else this.uncertain = true
      throw error
    } finally {
      this.running = false
    }
  }
}
