export class ApiError extends Error {
  readonly status: number

  constructor(status: number, statusText: string, body: string) {
    super(`${status} ${statusText}${body ? ': ' + body : ''}`)
    this.status = status
  }
}
