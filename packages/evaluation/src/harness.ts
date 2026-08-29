import { createHash } from 'node:crypto';
import { RiskType } from '@recoverai/shared';

export const STRATEGIES = ['NO_INTERVENTION', 'NAIVE_RECOVERY', 'RULE_BASED', 'RULE_BASED_WITH_POLICY', 'RECOVERAI', 'POLICY_AWARE_ORACLE'] as const;
export type EvaluationStrategyName = (typeof STRATEGIES)[number];
export type Split = 'dev' | 'validation' | 'heldout';

export interface ObservableScenario {
  id: string; riskType: RiskType; split: Split; amountPaise: bigint; optedOut: boolean;
  contactConsent: boolean; verifiedFailureCode: string | null; highValue: boolean;
}
/** Evaluator-only truth. This object is never part of normal strategy context. */
export interface OracleScenario {
  recoverable: boolean; requiresContact: boolean; requiresRetry: boolean; shouldEscalate: boolean;
  shouldStop: boolean; naturalRecoveryMinute: number | null; respondsToContact: boolean;
}
export interface Scenario { observable: ObservableScenario; oracle: OracleScenario; }

const FAMILIES = [RiskType.PAYMENT_FAILURE, RiskType.SUBSCRIPTION_FAILURE, RiskType.CHECKOUT_ABANDONMENT, RiskType.OVERDUE_RECEIVABLE] as const;
function seededRandom(seed: number): () => number { let state = seed >>> 0; return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; }; }

export function generateScenarios(seed = 42): Scenario[] {
  const random = seededRandom(seed); const scenarios: Scenario[] = [];
  for (const [familyIndex, riskType] of FAMILIES.entries()) for (let index = 0; index < 125; index += 1) {
    const split: Split = index < 75 ? 'dev' : index < 100 ? 'validation' : 'heldout';
    const amountPaise = BigInt(10_000 + Math.floor(random() * 9_900_000));
    const hardDecline = index % 11 === 0; const optedOut = index % 13 === 0;
    const recoverable = !hardDecline && index % 5 !== 0;
    const requiresContact = riskType === RiskType.CHECKOUT_ABANDONMENT || riskType === RiskType.OVERDUE_RECEIVABLE || index % 3 === 0;
    const naturalRecoveryMinute = recoverable && index % 10 === 1 ? 300 : null;
    const shouldEscalate = amountPaise >= 5_000_000n || index % 17 === 0;
    scenarios.push({ observable: {
      id: `${familyIndex}-${index}`, riskType, split, amountPaise, optedOut, contactConsent: !optedOut,
      verifiedFailureCode: hardDecline ? 'DO_NOT_HONOR' : riskType === RiskType.PAYMENT_FAILURE && requiresContact ? 'CARD_EXPIRED' : null,
      highValue: amountPaise >= 5_000_000n,
    }, oracle: { recoverable, requiresContact, requiresRetry: riskType === RiskType.PAYMENT_FAILURE || riskType === RiskType.SUBSCRIPTION_FAILURE,
      shouldEscalate, shouldStop: !recoverable && !shouldEscalate, naturalRecoveryMinute, respondsToContact: recoverable && requiresContact } });
  }
  return scenarios;
}

export function corpusFingerprint(seed = 42): string {
  const serialized = JSON.stringify(generateScenarios(seed), (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  return `sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`;
}
