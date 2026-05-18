import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { AuthResult, UserContext, UserProfile } from '../models/user';
import { IUserRepository } from '../repositories/userRepository';
import { hashPassword, comparePassword } from '../utils/password';
import { ValidationError, AuthenticationError, ConflictError } from '../utils/errors';

/** AuthService interface for authentication operations */
export interface IAuthService {
  register(email: string, password: string): Promise<AuthResult>;
  login(email: string, password: string): Promise<AuthResult>;
  refreshToken(refreshToken: string): Promise<AuthResult>;
  validateToken(token: string): Promise<UserContext>;
}

/** JWT payload structure for access tokens */
interface AccessTokenPayload {
  userId: string;
  email: string;
}

/** JWT payload structure for refresh tokens */
interface RefreshTokenPayload {
  userId: string;
  type: 'refresh';
}

export class AuthService implements IAuthService {
  constructor(private readonly userRepository: IUserRepository) {}

  async register(email: string, password: string): Promise<AuthResult> {
    this.validateEmail(email);
    this.validatePassword(password);

    const existingUser = await this.userRepository.findByEmail(email);
    if (existingUser) {
      throw new ConflictError('A user with this email already exists');
    }

    const passwordHash = await hashPassword(password);
    const user = await this.userRepository.create(email, passwordHash);

    return this.generateAuthResult(user);
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const userWithPassword = await this.userRepository.findByEmail(email);
    if (!userWithPassword) {
      throw new AuthenticationError('Invalid email or password');
    }

    const isValid = await comparePassword(password, userWithPassword.passwordHash);
    if (!isValid) {
      throw new AuthenticationError('Invalid email or password');
    }

    const user: UserProfile = {
      id: userWithPassword.id,
      email: userWithPassword.email,
      createdAt: userWithPassword.createdAt,
    };

    return this.generateAuthResult(user);
  }

  async refreshToken(refreshToken: string): Promise<AuthResult> {
    let payload: RefreshTokenPayload;

    try {
      payload = jwt.verify(refreshToken, config.jwt.refreshSecret) as RefreshTokenPayload;
    } catch {
      throw new AuthenticationError('Invalid or expired refresh token');
    }

    if (payload.type !== 'refresh') {
      throw new AuthenticationError('Invalid token type');
    }

    const user = await this.userRepository.findById(payload.userId);
    if (!user) {
      throw new AuthenticationError('User not found');
    }

    return this.generateAuthResult(user);
  }

  async validateToken(token: string): Promise<UserContext> {
    try {
      const payload = jwt.verify(token, config.jwt.secret) as AccessTokenPayload;
      return {
        userId: payload.userId,
        email: payload.email,
      };
    } catch {
      throw new AuthenticationError('Invalid or expired access token');
    }
  }

  private generateAuthResult(user: UserProfile): AuthResult {
    const accessToken = this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken(user.id);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.parseExpiryToSeconds(config.jwt.accessExpiry),
      user,
    };
  }

  private generateAccessToken(user: UserProfile): string {
    const payload: AccessTokenPayload = {
      userId: user.id,
      email: user.email,
    };

    return jwt.sign(payload, config.jwt.secret, {
      expiresIn: this.parseExpiryToSeconds(config.jwt.accessExpiry),
    });
  }

  private generateRefreshToken(userId: string): string {
    const payload: RefreshTokenPayload = {
      userId,
      type: 'refresh',
    };

    return jwt.sign(payload, config.jwt.refreshSecret, {
      expiresIn: this.parseExpiryToSeconds(config.jwt.refreshExpiry),
    });
  }

  private validateEmail(email: string): void {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      throw new ValidationError('Invalid email format', { field: 'email' });
    }
  }

  private validatePassword(password: string): void {
    if (!password || password.length < 8) {
      throw new ValidationError('Password must be at least 8 characters long', {
        field: 'password',
      });
    }
  }

  /** Parse a time string like '15m' or '7d' into seconds */
  private parseExpiryToSeconds(expiry: string): number {
    const match = expiry.match(/^(\d+)([smhd])$/);
    if (!match) return 900; // default 15 minutes

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 3600;
      case 'd':
        return value * 86400;
      default:
        return 900;
    }
  }
}
