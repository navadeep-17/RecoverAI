import { describe, it, expect } from 'vitest';
import {
  CaseStatus,
  isValidCaseTransition,
  validateCaseTransition,
  InvalidCaseStateTransitionError,
  isTerminalState,
  canExecuteActionsInState,
} from '../src/index.js';

describe('RevenueRiskCase State Machine Contract', () => {
  describe('Legal Transitions from OPEN', () => {
    it('allows OPEN -> WAITING (action dispatched)', () => {
      expect(isValidCaseTransition(CaseStatus.OPEN, CaseStatus.WAITING)).toBe(true);
      expect(() => validateCaseTransition(CaseStatus.OPEN, CaseStatus.WAITING)).not.toThrow();
    });

    it('allows OPEN -> NEEDS_REVIEW (policy review gate)', () => {
      expect(isValidCaseTransition(CaseStatus.OPEN, CaseStatus.NEEDS_REVIEW)).toBe(true);
      expect(() => validateCaseTransition(CaseStatus.OPEN, CaseStatus.NEEDS_REVIEW)).not.toThrow();
    });

    it('allows OPEN -> RECOVERED (payment verified)', () => {
      expect(isValidCaseTransition(CaseStatus.OPEN, CaseStatus.RECOVERED)).toBe(true);
      expect(() => validateCaseTransition(CaseStatus.OPEN, CaseStatus.RECOVERED)).not.toThrow();
    });

    it('allows OPEN -> STOPPED (hard decline / opt-out)', () => {
      expect(isValidCaseTransition(CaseStatus.OPEN, CaseStatus.STOPPED)).toBe(true);
      expect(() => validateCaseTransition(CaseStatus.OPEN, CaseStatus.STOPPED)).not.toThrow();
    });

    it('allows OPEN -> EXHAUSTED (attempt limit reached)', () => {
      expect(isValidCaseTransition(CaseStatus.OPEN, CaseStatus.EXHAUSTED)).toBe(true);
      expect(() => validateCaseTransition(CaseStatus.OPEN, CaseStatus.EXHAUSTED)).not.toThrow();
    });

    it('allows idempotent self-transition OPEN -> OPEN', () => {
      expect(isValidCaseTransition(CaseStatus.OPEN, CaseStatus.OPEN)).toBe(true);
    });
  });

  describe('Legal Transitions from WAITING', () => {
    it('allows WAITING -> OPEN (replanning on new event/timer)', () => {
      expect(isValidCaseTransition(CaseStatus.WAITING, CaseStatus.OPEN)).toBe(true);
    });

    it('allows WAITING -> RECOVERED (payment succeeded)', () => {
      expect(isValidCaseTransition(CaseStatus.WAITING, CaseStatus.RECOVERED)).toBe(true);
    });

    it('allows WAITING -> NEEDS_REVIEW (review condition triggered)', () => {
      expect(isValidCaseTransition(CaseStatus.WAITING, CaseStatus.NEEDS_REVIEW)).toBe(true);
    });

    it('allows WAITING -> STOPPED (customer stop / opt-out)', () => {
      expect(isValidCaseTransition(CaseStatus.WAITING, CaseStatus.STOPPED)).toBe(true);
    });

    it('allows WAITING -> EXHAUSTED (timeout)', () => {
      expect(isValidCaseTransition(CaseStatus.WAITING, CaseStatus.EXHAUSTED)).toBe(true);
    });
  });

  describe('Legal Transitions from NEEDS_REVIEW', () => {
    it('allows NEEDS_REVIEW -> WAITING (approved & executed)', () => {
      expect(isValidCaseTransition(CaseStatus.NEEDS_REVIEW, CaseStatus.WAITING)).toBe(true);
    });

    it('allows NEEDS_REVIEW -> OPEN (rejected / re-opened for replan)', () => {
      expect(isValidCaseTransition(CaseStatus.NEEDS_REVIEW, CaseStatus.OPEN)).toBe(true);
    });

    it('allows NEEDS_REVIEW -> RECOVERED (external settlement during review)', () => {
      expect(isValidCaseTransition(CaseStatus.NEEDS_REVIEW, CaseStatus.RECOVERED)).toBe(true);
    });

    it('allows NEEDS_REVIEW -> STOPPED (human closed / stopped)', () => {
      expect(isValidCaseTransition(CaseStatus.NEEDS_REVIEW, CaseStatus.STOPPED)).toBe(true);
    });

    it('allows NEEDS_REVIEW -> EXHAUSTED', () => {
      expect(isValidCaseTransition(CaseStatus.NEEDS_REVIEW, CaseStatus.EXHAUSTED)).toBe(true);
    });
  });

  describe('Strict Terminal Invariants (RECOVERED, STOPPED, EXHAUSTED)', () => {
    const terminalStates = [CaseStatus.RECOVERED, CaseStatus.STOPPED, CaseStatus.EXHAUSTED];
    const nonTerminalStates = [CaseStatus.OPEN, CaseStatus.WAITING, CaseStatus.NEEDS_REVIEW];

    terminalStates.forEach((termState) => {
      it("identifies " + termState + " as terminal", () => {
        expect(isTerminalState(termState)).toBe(true);
        expect(canExecuteActionsInState(termState)).toBe(false);
      });

      nonTerminalStates.forEach((targetState) => {
        it("strictly forbids transition from terminal " + termState + " to " + targetState, () => {
          expect(isValidCaseTransition(termState, targetState)).toBe(false);
          expect(() => validateCaseTransition(termState, targetState, 'test')).toThrow(
            InvalidCaseStateTransitionError,
          );
        });
      });
    });
  });
});
