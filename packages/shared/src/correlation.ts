import { customAlphabet } from 'nanoid';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const nanoid16 = customAlphabet(alphabet, 16);

export function generateCorrelationId(): string {
  return `req_${nanoid16()}`;
}

export function generateEntityId(prefix: string): string {
  return `${prefix}_${nanoid16()}`;
}
