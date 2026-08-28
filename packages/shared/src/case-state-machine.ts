import { CaseStatus } from './constants.js';

export class InvalidCaseStateTransitionError extends Error {
  constructor(
    public readonly currentStatus: CaseStatus,
    public readonly attemptedStatus: CaseStatus,
    public readonly caseId?: string,
  ) {
    super(
      `Invalid state transition for case ${caseId || 'UNKNOWN'}: cannot transition from ${currentStatus} to ${attemptedStatus}`,
    );
    this.name = 'InvalidCaseStateTransitionError';
  }
}

export class CaseStateConflictError extends Error {
  constructor(
    message: string,
    public readonly caseId?: string,
    public readonly expectedStatus?: CaseStatus,
    public readonly attemptedStatus?: CaseStatus,
  ) {
    super(message);
    this.name = 'CaseStateConflictError';
  }
}

/**
 * Frozen Canonical State Transition Matrix for RevenueRiskCase
 *
 * States:
 * - OPEN: Initial case state when risk is detected. Can transition to WAITING, NEEDS_REVIEW, RECOVERED, STOPPED, EXHAUSTED.
 * - WAITING: Case is waiting for an action cooldown, customer response, or follow-up timer.
 * - NEEDS_REVIEW: Case requires human review / approval before further action.
 * - RECOVERED: Terminal state when revenue has been successfully recovered.
 * - STOPPED: Terminal state when recovery is permanently halted (hard decline, opt-out, manual stop).
 * - EXHAUSTED: Terminal state when all automated/manual recovery attempts are depleted.
 */
const LEGAL_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  [CaseStatus.OPEN]: [
    CaseStatus.WAITING,
    CaseStatus.NEEDS_REVIEW,
    CaseStatus.RECOVERED,
    CaseStatus.STOPPED,
    CaseStatus.EXHAUSTED,
    CaseStatus.OPEN, // Idempotent updates in OPEN state
  ],
  [CaseStatus.WAITING]: [
    CaseStatus.OPEN, // Triggered by follow-up timer or incoming event needing replan
    CaseStatus.RECOVERED, // External payment received or confirmation
    CaseStatus.NEEDS_REVIEW, // Human review condition hit during waiting
    CaseStatus.STOPPED, // Customer opt-out / hard failure
    CaseStatus.EXHAUSTED, // Expiration of wait window with no more retries
    CaseStatus.WAITING, // Idempotent update
  ],
  [CaseStatus.NEEDS_REVIEW]: [
    CaseStatus.WAITING, // Approved and action scheduled/dispatched
    CaseStatus.OPEN, // Rejected or sent back to replanning
    CaseStatus.RECOVERED, // Recovered externally while in review
    CaseStatus.STOPPED, // Human reviewer stopped recovery
    CaseStatus.EXHAUSTED, // Depleted
    CaseStatus.NEEDS_REVIEW, // Idempotent update
  ],
  // Terminal states cannot transition to ANY other state
  [CaseStatus.RECOVERED]: [CaseStatus.RECOVERED],
  [CaseStatus.STOPPED]: [CaseStatus.STOPPED],
  [CaseStatus.EXHAUSTED]: [CaseStatus.EXHAUSTED],
};

export function isValidCaseTransition(
  currentStatus: CaseStatus,
  nextStatus: CaseStatus,
): boolean {
  const allowed = LEGAL_TRANSITIONS[currentStatus];
  if (!allowed) {
    return false;
  }
  return allowed.includes(nextStatus);
}

export function validateCaseTransition(
  currentStatus: CaseStatus,
  nextStatus: CaseStatus,
  caseId?: string,
): void {
  if (!isValidCaseTransition(currentStatus, nextStatus)) {
    throw new InvalidCaseStateTransitionError(currentStatus, nextStatus, caseId);
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
  return status === CaseStatus.OPEN || status === CaseStatus.WAITING;
}
