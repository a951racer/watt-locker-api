import { ApiResponse, PaginationMeta } from '../models/api';

/**
 * Wrap a successful response payload in the standard API envelope.
 */
export function successResponse<T>(data: T, pagination?: PaginationMeta): ApiResponse<T> {
  return {
    data,
    errors: null,
    pagination: pagination ?? null,
  };
}

/**
 * Wrap an error response in the standard API envelope.
 */
export function errorResponse(
  errors: { code: string; message: string; field?: string; details?: unknown }[],
): ApiResponse<null> {
  return {
    data: null,
    errors,
    pagination: null,
  };
}
