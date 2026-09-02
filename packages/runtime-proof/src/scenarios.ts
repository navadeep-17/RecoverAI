import { RiskType } from '@recoverai/shared';

export const RUNTIME_PROOF_LABEL = 'Deterministic Runtime Acceptance Batch';
export const RUNTIME_PROOF_PROVIDER = 'deterministic-mock';

export type RuntimeScenarioKind = 'payment' | 'subscription' | 'checkout' | 'invoice';
export type ExpectedRuntimeBranch = 'recover' | 'review' | 'stop' | 'exhaust' | 'waiting';

export interface RuntimeProofScenario {
  id: string;
  kind: RuntimeScenarioKind;
  riskType: RiskType;
  amount: string;
  failureCode?: string;
  consent?: boolean;
  optedOut?: boolean;
  expected: ExpectedRuntimeBranch;
  authoritativeOutcome?: 'payment' | 'checkout' | 'invoice';
  duplicate?: boolean;
}

/** Fixed source-controlled acceptance scenarios. Outcome intent is fulfilled only through OutcomeObserver. */
export const RUNTIME_PROOF_SCENARIOS: readonly RuntimeProofScenario[] = [
  { id: 'payment-soft-recover', kind: 'payment', riskType: RiskType.PAYMENT_FAILURE, amount: '1250.00', failureCode: 'INSUFFICIENT_FUNDS', consent: true, expected: 'recover', authoritativeOutcome: 'payment', duplicate: true },
  { id: 'payment-hard-decline', kind: 'payment', riskType: RiskType.PAYMENT_FAILURE, amount: '1350.00', failureCode: 'DO_NOT_HONOR', consent: true, expected: 'waiting' },
  { id: 'payment-expired-method', kind: 'payment', riskType: RiskType.PAYMENT_FAILURE, amount: '1450.00', failureCode: 'CARD_EXPIRED', consent: true, expected: 'waiting' },
  { id: 'payment-missing-consent', kind: 'payment', riskType: RiskType.PAYMENT_FAILURE, amount: '1550.00', failureCode: 'INSUFFICIENT_FUNDS', consent: false, expected: 'exhaust' },
  { id: 'payment-opt-out', kind: 'payment', riskType: RiskType.PAYMENT_FAILURE, amount: '1650.00', failureCode: 'INSUFFICIENT_FUNDS', consent: true, optedOut: true, expected: 'stop' },
  { id: 'payment-organic-recover', kind: 'payment', riskType: RiskType.PAYMENT_FAILURE, amount: '1750.00', failureCode: 'INSUFFICIENT_FUNDS', consent: true, expected: 'recover', authoritativeOutcome: 'payment' },
  { id: 'subscription-soft-recover', kind: 'subscription', riskType: RiskType.SUBSCRIPTION_FAILURE, amount: '2200.00', failureCode: 'INSUFFICIENT_FUNDS', consent: true, expected: 'recover', authoritativeOutcome: 'payment' },
  { id: 'subscription-expired', kind: 'subscription', riskType: RiskType.SUBSCRIPTION_FAILURE, amount: '2300.00', failureCode: 'CARD_EXPIRED', consent: true, expected: 'waiting' },
  { id: 'subscription-hard-decline', kind: 'subscription', riskType: RiskType.SUBSCRIPTION_FAILURE, amount: '2400.00', failureCode: 'FRAUD', consent: true, expected: 'waiting' },
  { id: 'subscription-missing-consent', kind: 'subscription', riskType: RiskType.SUBSCRIPTION_FAILURE, amount: '2500.00', failureCode: 'INSUFFICIENT_FUNDS', consent: false, expected: 'exhaust' },
  { id: 'subscription-high-value-review', kind: 'subscription', riskType: RiskType.SUBSCRIPTION_FAILURE, amount: '85000.00', failureCode: 'INSUFFICIENT_FUNDS', consent: true, expected: 'review' },
  { id: 'checkout-recover', kind: 'checkout', riskType: RiskType.CHECKOUT_ABANDONMENT, amount: '800.00', consent: true, expected: 'recover', authoritativeOutcome: 'checkout' },
  { id: 'checkout-waiting', kind: 'checkout', riskType: RiskType.CHECKOUT_ABANDONMENT, amount: '900.00', consent: true, expected: 'waiting' },
  { id: 'checkout-missing-consent', kind: 'checkout', riskType: RiskType.CHECKOUT_ABANDONMENT, amount: '1000.00', consent: false, expected: 'exhaust' },
  { id: 'checkout-opt-out', kind: 'checkout', riskType: RiskType.CHECKOUT_ABANDONMENT, amount: '1100.00', consent: true, optedOut: true, expected: 'stop' },
  { id: 'checkout-completed', kind: 'checkout', riskType: RiskType.CHECKOUT_ABANDONMENT, amount: '1200.00', consent: true, expected: 'recover', authoritativeOutcome: 'checkout' },
  { id: 'invoice-recover', kind: 'invoice', riskType: RiskType.OVERDUE_RECEIVABLE, amount: '3600.00', consent: true, expected: 'recover', authoritativeOutcome: 'invoice' },
  { id: 'invoice-waiting', kind: 'invoice', riskType: RiskType.OVERDUE_RECEIVABLE, amount: '3700.00', consent: true, expected: 'waiting' },
  { id: 'invoice-high-value-review', kind: 'invoice', riskType: RiskType.OVERDUE_RECEIVABLE, amount: '90000.00', consent: true, expected: 'review' },
  { id: 'invoice-missing-consent', kind: 'invoice', riskType: RiskType.OVERDUE_RECEIVABLE, amount: '3900.00', consent: false, expected: 'exhaust' },
];

export function validateRuntimeProofScenarios(scenarios: readonly RuntimeProofScenario[] = RUNTIME_PROOF_SCENARIOS): void {
  if (scenarios.length < 16 || scenarios.length > 24) throw new Error(`Runtime proof requires 16–24 scenarios; received ${scenarios.length}`);
  const types = new Set(scenarios.map((scenario) => scenario.riskType));
  for (const riskType of Object.values(RiskType)) {
    if (!types.has(riskType)) throw new Error(`Runtime proof is missing risk type ${riskType}`);
  }
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) throw new Error('Runtime proof scenario IDs must be unique');
}
