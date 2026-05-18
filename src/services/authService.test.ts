import jwt from 'jsonwebtoken';
import { AuthService } from './authService';
import { IUserRepository, UserWithPassword } from '../repositories/userRepository';
import { UserProfile } from '../models/user';
import { ValidationError, AuthenticationError, ConflictError } from '../utils/errors';
import { config } from '../config/env';

// Mock password utils
jest.mock('../utils/password', () => ({
  hashPassword: jest.fn().mockResolvedValue('hashed-password'),
  comparePassword: jest.fn().mockResolvedValue(true),
}));

import { hashPassword, comparePassword } from '../utils/password';

const mockedHashPassword = hashPassword as jest.MockedFunction<typeof hashPassword>;
const mockedComparePassword = comparePassword as jest.MockedFunction<typeof comparePassword>;

describe('AuthService', () => {
  let authService: AuthService;
  let mockUserRepository: jest.Mocked<IUserRepository>;

  const mockUser: UserProfile = {
    id: '507f1f77bcf86cd799439011',
    email: 'test@example.com',
    createdAt: new Date('2024-01-01'),
  };

  const mockUserWithPassword: UserWithPassword = {
    id: '507f1f77bcf86cd799439011',
    email: 'test@example.com',
    passwordHash: 'hashed-password',
    createdAt: new Date('2024-01-01'),
  };

  beforeEach(() => {
    mockUserRepository = {
      create: jest.fn().mockResolvedValue(mockUser),
      findByEmail: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockResolvedValue(mockUser),
    };

    authService = new AuthService(mockUserRepository);

    // Reset mocks
    mockedHashPassword.mockResolvedValue('hashed-password');
    mockedComparePassword.mockResolvedValue(true);
  });

  describe('register', () => {
    it('should register a new user and return auth result', async () => {
      const result = await authService.register('test@example.com', 'password123');

      expect(mockUserRepository.findByEmail).toHaveBeenCalledWith('test@example.com');
      expect(mockedHashPassword).toHaveBeenCalledWith('password123');
      expect(mockUserRepository.create).toHaveBeenCalledWith('test@example.com', 'hashed-password');
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.expiresIn).toBe(900); // 15m = 900s
      expect(result.user).toEqual(mockUser);
    });

    it('should throw ConflictError if email already exists', async () => {
      mockUserRepository.findByEmail.mockResolvedValue(mockUserWithPassword);

      await expect(authService.register('test@example.com', 'password123')).rejects.toThrow(
        ConflictError,
      );
    });

    it('should throw ValidationError for invalid email', async () => {
      await expect(authService.register('invalid-email', 'password123')).rejects.toThrow(
        ValidationError,
      );
    });

    it('should throw ValidationError for empty email', async () => {
      await expect(authService.register('', 'password123')).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for short password', async () => {
      await expect(authService.register('test@example.com', 'short')).rejects.toThrow(
        ValidationError,
      );
    });

    it('should throw ValidationError for empty password', async () => {
      await expect(authService.register('test@example.com', '')).rejects.toThrow(ValidationError);
    });

    it('should generate a valid JWT access token', async () => {
      const result = await authService.register('test@example.com', 'password123');

      const decoded = jwt.verify(result.accessToken, config.jwt.secret) as {
        userId: string;
        email: string;
      };
      expect(decoded.userId).toBe(mockUser.id);
      expect(decoded.email).toBe(mockUser.email);
    });

    it('should generate a valid JWT refresh token', async () => {
      const result = await authService.register('test@example.com', 'password123');

      const decoded = jwt.verify(result.refreshToken, config.jwt.refreshSecret) as {
        userId: string;
        type: string;
      };
      expect(decoded.userId).toBe(mockUser.id);
      expect(decoded.type).toBe('refresh');
    });
  });

  describe('login', () => {
    beforeEach(() => {
      mockUserRepository.findByEmail.mockResolvedValue(mockUserWithPassword);
    });

    it('should login with valid credentials and return auth result', async () => {
      const result = await authService.login('test@example.com', 'password123');

      expect(mockUserRepository.findByEmail).toHaveBeenCalledWith('test@example.com');
      expect(mockedComparePassword).toHaveBeenCalledWith('password123', 'hashed-password');
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.expiresIn).toBe(900);
      expect(result.user.id).toBe(mockUser.id);
      expect(result.user.email).toBe(mockUser.email);
    });

    it('should throw AuthenticationError if user not found', async () => {
      mockUserRepository.findByEmail.mockResolvedValue(null);

      await expect(authService.login('unknown@example.com', 'password123')).rejects.toThrow(
        AuthenticationError,
      );
    });

    it('should throw AuthenticationError if password is incorrect', async () => {
      mockedComparePassword.mockResolvedValue(false);

      await expect(authService.login('test@example.com', 'wrongpassword')).rejects.toThrow(
        AuthenticationError,
      );
    });
  });

  describe('refreshToken', () => {
    it('should issue new tokens with a valid refresh token', async () => {
      const validRefreshToken = jwt.sign(
        { userId: mockUser.id, type: 'refresh' },
        config.jwt.refreshSecret,
        { expiresIn: '7d' },
      );

      const result = await authService.refreshToken(validRefreshToken);

      expect(mockUserRepository.findById).toHaveBeenCalledWith(mockUser.id);
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.user).toEqual(mockUser);
    });

    it('should throw AuthenticationError for an expired refresh token', async () => {
      const expiredToken = jwt.sign(
        { userId: mockUser.id, type: 'refresh' },
        config.jwt.refreshSecret,
        { expiresIn: '0s' },
      );

      // Wait a moment for the token to expire
      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(authService.refreshToken(expiredToken)).rejects.toThrow(AuthenticationError);
    });

    it('should throw AuthenticationError for an invalid token', async () => {
      await expect(authService.refreshToken('invalid-token')).rejects.toThrow(
        AuthenticationError,
      );
    });

    it('should throw AuthenticationError if token type is not refresh', async () => {
      const accessToken = jwt.sign(
        { userId: mockUser.id, email: mockUser.email },
        config.jwt.refreshSecret,
        { expiresIn: '15m' },
      );

      await expect(authService.refreshToken(accessToken)).rejects.toThrow(AuthenticationError);
    });

    it('should throw AuthenticationError if user no longer exists', async () => {
      mockUserRepository.findById.mockResolvedValue(null);

      const validRefreshToken = jwt.sign(
        { userId: mockUser.id, type: 'refresh' },
        config.jwt.refreshSecret,
        { expiresIn: '7d' },
      );

      await expect(authService.refreshToken(validRefreshToken)).rejects.toThrow(
        AuthenticationError,
      );
    });
  });

  describe('validateToken', () => {
    it('should return UserContext for a valid access token', async () => {
      const token = jwt.sign(
        { userId: mockUser.id, email: mockUser.email },
        config.jwt.secret,
        { expiresIn: '15m' },
      );

      const context = await authService.validateToken(token);

      expect(context.userId).toBe(mockUser.id);
      expect(context.email).toBe(mockUser.email);
    });

    it('should throw AuthenticationError for an expired access token', async () => {
      const expiredToken = jwt.sign(
        { userId: mockUser.id, email: mockUser.email },
        config.jwt.secret,
        { expiresIn: '0s' },
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(authService.validateToken(expiredToken)).rejects.toThrow(AuthenticationError);
    });

    it('should throw AuthenticationError for an invalid token', async () => {
      await expect(authService.validateToken('garbage-token')).rejects.toThrow(
        AuthenticationError,
      );
    });

    it('should throw AuthenticationError for a token signed with wrong secret', async () => {
      const token = jwt.sign(
        { userId: mockUser.id, email: mockUser.email },
        'wrong-secret',
        { expiresIn: '15m' },
      );

      await expect(authService.validateToken(token)).rejects.toThrow(AuthenticationError);
    });
  });
});
