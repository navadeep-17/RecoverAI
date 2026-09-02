export interface RuntimeProofCaseRecord {
  status: string;
  amountAtRisk: string;
  recoveredAmount: string | null;
  recoveryOutcomeId: string | null;
  recoveryOutcome?: { actionId: string | null; amountRecovered: string | null } | null;
}

export interface RuntimeProofMetrics {
  casesProcessed: number;
  initialRevenueAtRisk: string;
  verifiedRecovered: string;
  agentAttributedRecovered: string;
  organicVerifiedRecovered: string;
  caseOutcomes: Record<string, number>;
}

function paise(value: string | null): bigint {
  if (!value) return 0n;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error(`Non-canonical money value: ${value}`);
  return BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
}

function decimal(value: bigint): string { return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`; }

export function calculateRuntimeProofMetrics(cases: readonly RuntimeProofCaseRecord[]): RuntimeProofMetrics {
  let initial = 0n; let verified = 0n; let attributed = 0n;
  const caseOutcomes: Record<string, number> = {};
  for (const item of cases) {
    initial += paise(item.amountAtRisk);
    caseOutcomes[item.status] = (caseOutcomes[item.status] || 0) + 1;
    if (item.status !== 'RECOVERED') continue;
    if (!item.recoveryOutcomeId || !item.recoveryOutcome?.amountRecovered || item.recoveredAmount !== item.recoveryOutcome.amountRecovered) {
      throw new Error('Recovered case is missing matching authoritative recovery evidence');
    }
    const amount = paise(item.recoveredAmount);
    verified += amount;
    if (item.recoveryOutcome.actionId) attributed += amount;
  }
  return {
    casesProcessed: cases.length,
    initialRevenueAtRisk: decimal(initial),
    verifiedRecovered: decimal(verified),
    agentAttributedRecovered: decimal(attributed),
    organicVerifiedRecovered: decimal(verified - attributed),
    caseOutcomes,
  };
}
