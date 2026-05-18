/**
 * User-related data models for authentication and identity.
 */

/** Public user profile information */
export interface UserProfile {
  id: string;
  email: string;
  createdAt: Date;
}

/** Authenticated user context attached to requests */
export interface UserContext {
  userId: string;
  email: string;
}

/** Result of a successful authentication operation (login, register, refresh) */
export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: UserProfile;
}
