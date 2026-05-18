import { successResponse, errorResponse } from './response';

describe('response utilities', () => {
  describe('successResponse', () => {
    it('wraps data in the standard envelope', () => {
      const result = successResponse({ id: '123', name: 'test' });

      expect(result).toEqual({
        data: { id: '123', name: 'test' },
        errors: null,
        pagination: null,
      });
    });

    it('includes pagination when provided', () => {
      const pagination = { page: 1, pageSize: 10, totalItems: 50, totalPages: 5 };
      const result = successResponse([1, 2, 3], pagination);

      expect(result).toEqual({
        data: [1, 2, 3],
        errors: null,
        pagination,
      });
    });

    it('handles null data', () => {
      const result = successResponse(null);

      expect(result).toEqual({
        data: null,
        errors: null,
        pagination: null,
      });
    });
  });

  describe('errorResponse', () => {
    it('wraps errors in the standard envelope', () => {
      const result = errorResponse([{ code: 'VALIDATION_ERROR', message: 'Invalid input' }]);

      expect(result).toEqual({
        data: null,
        errors: [{ code: 'VALIDATION_ERROR', message: 'Invalid input' }],
        pagination: null,
      });
    });

    it('supports multiple errors', () => {
      const errors = [
        { code: 'VALIDATION_ERROR', message: 'Field required', field: 'email' },
        { code: 'VALIDATION_ERROR', message: 'Too short', field: 'password' },
      ];
      const result = errorResponse(errors);

      expect(result.errors).toHaveLength(2);
      expect(result.data).toBeNull();
      expect(result.pagination).toBeNull();
    });
  });
});
