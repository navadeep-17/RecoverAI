import { RecoveryActionType } from '@recoverai/shared';

/**
 * Deterministically constructs an idempotency key for recovery side-effects.
 * Guaranteed to be stable across worker restarts and retries.
 * Never uses Date.now(), Math.random(), or non-deterministic tokens.
 */
export function generateActionIdempotencyKey(
  merchantId: string,
  caseId: string,
  actionType: RecoveryActionType,
  attemptOrVersion: string | number = 'v1',
): string {
  const cleanMerchantId = merchantId.trim();
  const cleanCaseId = caseId.trim();
  const cleanVersion = String(attemptOrVersion).trim();

  return `rec_act:${cleanMerchantId}:${cleanCaseId}:${actionType}:${cleanVersion}`;
}
