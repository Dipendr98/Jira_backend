export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500,
    public details?: object
  ) {
    super(message)
    this.name = 'AppError'
  }
}
