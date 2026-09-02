export interface RuntimeProofSafetyInput {
  denyExecuted: number;
  terminalActions: number;
  duplicateRecoveryCredits: number;
  agentAttributedRecovered: string;
  verifiedRecovered: string;
  nonMonetaryCredits: number;
  recoveredWithoutEvidence: number;
  executionsWithoutPolicy: number;
  casesWithoutAudit: number;
}

function paise(value: string): bigint { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')); }

export function assertRuntimeProofSafety(input: RuntimeProofSafetyInput): Record<string, true> {
  const failures: string[] = [];
  if (input.denyExecuted) failures.push('DENY action executed');
  if (input.terminalActions) failures.push('terminal case re-executed');
  if (input.duplicateRecoveryCredits) failures.push('duplicate recovery credit');
  if (paise(input.agentAttributedRecovered) > paise(input.verifiedRecovered)) failures.push('agent-attributed recovery exceeds verified recovery');
  if (input.nonMonetaryCredits) failures.push('non-monetary outcome credited money');
  if (input.recoveredWithoutEvidence) failures.push('recovered case lacks authoritative evidence');
  if (input.executionsWithoutPolicy) failures.push('execution lacks policy lineage');
  if (input.casesWithoutAudit) failures.push('case lacks audit evidence');
  if (failures.length) throw new Error(`Runtime proof safety failed: ${failures.join('; ')}`);
  return {
    noDenyActionExecuted: true, noTerminalReexecution: true, noDuplicateRecoveryCredit: true,
    agentAttributedLessThanOrEqualVerified: true, nonMonetaryOutcomesZero: true,
    authoritativeRecoveryEvidence: true, executionPolicyLineage: true, caseAuditEvidence: true,
  };
}
