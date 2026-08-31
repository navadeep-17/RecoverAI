import { randomBytes } from 'node:crypto';

function randomId(): string {
  return randomBytes(12).toString('hex');
}

export function generateCorrelationId(): string {
  return `req_${randomId()}`;
}

export function generateEntityId(prefix: string): string {
  return `${prefix}_${randomId()}`;
}
