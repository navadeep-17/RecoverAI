import { createHmac, timingSafeEqual } from 'node:crypto';
import { Role, prisma } from '@recoverai/db';
import { EnvConfig } from '@recoverai/shared';
import { FastifyReply, FastifyRequest } from 'fastify';

export type UserRole = Role;

export interface AuthenticatedPrincipal {
  userId: string;
  merchantId: string;
  role: UserRole;
}

export interface PrincipalResolver {
  resolve(candidate: AuthenticatedPrincipal): Promise<AuthenticatedPrincipal | null>;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: AuthenticatedPrincipal;
  }
}

const validRoles = new Set(Object.values(Role));

/** Resolves a supplied identity against the authoritative tenant membership record. */
export const databasePrincipalResolver: PrincipalResolver = {
  async resolve(candidate) {
    const user = await prisma.user.findUnique({ where: { id: candidate.userId }, include: { merchant: true } });
    if (!user || !user.merchant || user.merchantId !== candidate.merchantId || user.role !== candidate.role) return null;
    return { userId: user.id, merchantId: user.merchantId, role: user.role };
  },
};

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function signaturePayload(candidate: AuthenticatedPrincipal): string {
  return `${candidate.merchantId}.${candidate.userId}.${candidate.role}`;
}

export function createTrustedPrincipalSignature(candidate: AuthenticatedPrincipal, secret: string): string {
  return createHmac('sha256', secret).update(signaturePayload(candidate)).digest('hex');
}

function hasValidTrustedSignature(candidate: AuthenticatedPrincipal, received: string | undefined, secret: string | undefined): boolean {
  if (!received || !secret || !/^[a-f0-9]{64}$/i.test(received)) return false;
  const expected = Buffer.from(createTrustedPrincipalSignature(candidate, secret), 'hex');
  const actual = Buffer.from(received, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Development headers are explicit local-only configuration. Trusted headers require a gateway signature and membership validation. */
export function createAuthenticatePrincipalHook(env: EnvConfig, resolver: PrincipalResolver = databasePrincipalResolver) {
  return async function authenticatePrincipalHook(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (req.principal) return;
    const merchantId = headerValue(req, 'x-merchant-id') ?? headerValue(req, 'x-tenant-id');
    const userId = headerValue(req, 'x-user-id') ?? headerValue(req, 'x-reviewer-id');
    const rawRole = headerValue(req, 'x-user-role');
    if (!merchantId || !userId || !rawRole || !validRoles.has(rawRole as Role)) return;
    const candidate: AuthenticatedPrincipal = { merchantId, userId, role: rawRole as Role };
    if (env.AUTH_MODE === 'trusted_headers' && !hasValidTrustedSignature(candidate, headerValue(req, 'x-recoverai-auth-signature'), env.AUTH_TRUST_SECRET)) return;
    if (env.AUTH_MODE !== 'dev_headers' && env.AUTH_MODE !== 'trusted_headers') return;
    req.principal = await resolver.resolve(candidate) ?? undefined;
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
