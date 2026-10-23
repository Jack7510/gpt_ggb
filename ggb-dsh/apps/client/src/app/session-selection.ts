/**
 * Guards the chat panel against out-of-order Session reads. A slower earlier
 * click must never replace the history selected by the user's later click.
 */
export class SessionSelection {
  private request = 0

  public begin(): number {
    this.request += 1
    return this.request
  }

  public isCurrent(request: number): boolean {
    return request === this.request
  }

  public invalidate(): void {
    this.request += 1
  }
}
