import { CaseStatus } from '@recoverai/shared';

export class InvalidCaseStateTransitionError extends Error {
  constructor(
    public readonly currentStatus: CaseStatus,
    public readonly attemptedStatus: CaseStatus,
    public readonly reason?: string,
  ) {
    super(
      `Illegal case state transition from '${currentStatus}' to '${attemptedStatus}'${
        reason ? `: ${reason}` : ''
      }`,
    );
    this.name = 'InvalidCaseStateTransitionError';
  }
}

/**
 * Explicit map of legal transitions for RevenueRiskCase lifecycle.
 */
const LEGAL_TRANSITIONS: Record<CaseStatus, ReadonlySet<CaseStatus>> = {
  [CaseStatus.OPEN]: new Set([
    CaseStatus.WAITING,
    CaseStatus.NEEDS_REVIEW,
    CaseStatus.RECOVERED,
    CaseStatus.STOPPED,
    CaseStatus.EXHAUSTED,
  ]),
  [CaseStatus.WAITING]: new Set([
    CaseStatus.OPEN,
    CaseStatus.NEEDS_REVIEW,
    CaseStatus.RECOVERED,
    CaseStatus.STOPPED,
    CaseStatus.EXHAUSTED,
  ]),
  [CaseStatus.NEEDS_REVIEW]: new Set([
    CaseStatus.WAITING,
    CaseStatus.OPEN,
    CaseStatus.RECOVERED,
    CaseStatus.STOPPED,
    CaseStatus.EXHAUSTED,
  ]),
  // Terminal states allow NO further transitions
  [CaseStatus.RECOVERED]: new Set([]),
  [CaseStatus.STOPPED]: new Set([]),
  [CaseStatus.EXHAUSTED]: new Set([]),
};

export function isValidCaseTransition(current: CaseStatus, next: CaseStatus): boolean {
  if (current === next) {
    return true; // No-op idempotent transition
  }
  const allowedNext = LEGAL_TRANSITIONS[current];
  return allowedNext ? allowedNext.has(next) : false;
}

export function validateCaseTransition(current: CaseStatus, next: CaseStatus, reason?: string): void {
  if (!isValidCaseTransition(current, next)) {
    throw new InvalidCaseStateTransitionError(current, next, reason);
  }
}

export function isTerminalState(status: CaseStatus): boolean {
  return (
    status === CaseStatus.RECOVERED ||
    status === CaseStatus.STOPPED ||
    status === CaseStatus.EXHAUSTED
  );
}

export function canExecuteActionsInState(status: CaseStatus): boolean {
  return status === CaseStatus.OPEN || status === CaseStatus.WAITING || status === CaseStatus.NEEDS_REVIEW;
}
