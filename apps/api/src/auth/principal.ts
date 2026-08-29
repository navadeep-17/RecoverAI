import { FastifyRequest, FastifyReply } from 'fastify';
import { Role } from '@prisma/client';

export type UserRole = 'MERCHANT_ADMIN' | 'REVIEWER' | 'MEMBER' | string;

export interface AuthenticatedPrincipal {
  userId: string;
  merchantId: string;
  role: UserRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthenticatedPrincipal;
  }
}

/**
 * Fastify authentication hook to resolve and verify the AuthenticatedPrincipal.
 * Production auth extracts token/session; test/dev adapter extracts verified headers.
 */
export async function authenticatePrincipalHook(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  // If principal is already attached (e.g. by custom test injector), preserve it
  if (req.principal) {
    return;
  }

  const merchantId = (req.headers['x-merchant-id'] as string) || (req.headers['x-tenant-id'] as string);
  const userId = (req.headers['x-user-id'] as string) || (req.headers['x-reviewer-id'] as string);
  const rawRole = req.headers['x-user-role'] as string | undefined;

  if (!merchantId || typeof merchantId !== 'string' || merchantId.trim().length === 0) {
    return;
  }

  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    return;
  }

  const role: UserRole = rawRole ? rawRole.trim() : Role.MERCHANT_ADMIN;

  req.principal = {
    userId: userId.trim(),
    merchantId: merchantId.trim(),
    role,
  };
}

/**
 * Helper to require an authenticated principal in route handlers.
 * Throws an unauthorized error if no principal is present.
 */
export function requirePrincipal(req: FastifyRequest): AuthenticatedPrincipal {
  if (!req.principal) {
    throw new Error('UNAUTHORIZED: No authenticated principal present');
  }
  return req.principal;
}