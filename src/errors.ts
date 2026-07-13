export class ShimonError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ShimonError";
  }
}

export function operationalError(error: unknown): ShimonError {
  if (error instanceof ShimonError) return error;
  if (error instanceof Error) {
    return new ShimonError("operation_failed", error.message, undefined, { cause: error });
  }
  return new ShimonError("operation_failed", String(error));
}
