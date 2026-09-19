export class AppError extends Error {
  constructor(message, status = 500, code) {
    if (typeof code !== "string" || code.length === 0) {
      throw new Error("AppError requires an explicit, non-empty code");
    }
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}
