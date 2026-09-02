export type RuntimeExecutionCategory = 'externalProvider' | 'simulated' | 'internal';

export interface RuntimeExecutionEvidence {
  category: RuntimeExecutionCategory;
  razorpayTestMode: boolean;
}

/** Absent or unrecognized provider identity is internal, never presumed external. */
export function classifyRuntimeExecutionEvidence(providerName: string | null): RuntimeExecutionEvidence {
  if (!providerName) return { category: 'internal', razorpayTestMode: false };
  if (providerName.toUpperCase().includes('SIMULATED')) return { category: 'simulated', razorpayTestMode: false };
  if (providerName === 'RAZORPAY_TEST_MODE_PAYMENT_LINKS') return { category: 'externalProvider', razorpayTestMode: true };
  return { category: 'internal', razorpayTestMode: false };
}
