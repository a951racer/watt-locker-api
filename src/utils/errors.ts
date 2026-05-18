/**
 * Base application error with an associated HTTP status code and machine-readable error code.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly field?: string;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    options?: { field?: string; details?: unknown },
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.field = options?.field;
    this.details = options?.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 400 Bad Request — invalid input, schema violations, or malformed data.
 */
export class ValidationError extends AppError {
  constructor(message: string, options?: { field?: string; details?: unknown }) {
    super(message, 400, 'VALIDATION_ERROR', options);
  }
}

/**
 * 401 Unauthorized — missing, expired, or invalid credentials.
 */
export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'AUTHENTICATION_ERROR');
  }
}

/**
 * 404 Not Found — requested resource does not exist.
 */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

/**
 * 409 Conflict — duplicate resource or state conflict.
 */
export class ConflictError extends AppError {
  constructor(message: string, options?: { details?: unknown }) {
    super(message, 409, 'CONFLICT', options);
  }
}
