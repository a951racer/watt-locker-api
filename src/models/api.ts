/**
 * API response envelope types for consistent REST API responses.
 */

/** A single structured API error */
export interface ApiError {
  code: string;
  message: string;
  field?: string;
  details?: unknown;
}

/** Standard API response envelope wrapping all endpoint responses */
export interface ApiResponse<T> {
  data: T | null;
  errors: ApiError[] | null;
  pagination: PaginationMeta | null;
}

/** Pagination metadata included in list responses */
export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/** Paginated result returned by repository list operations */
export interface PaginatedResult<T> {
  items: T[];
  pagination: PaginationMeta;
}

/** Error response shape (convenience alias for error-only responses) */
export interface ErrorResponse {
  data: null;
  errors: ApiError[];
  pagination: null;
  correlationId: string;
}
