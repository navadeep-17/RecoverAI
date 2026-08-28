import { PolicyDecision } from '@recoverai/shared';
import { PolicyExecutionContext, PolicyEvaluatedFacts } from '../policy-types.js';
import { PolicyReasonCode } from '../policy-reason-codes.js';

export interface RuleResult {
  decision: PolicyDecision;
  reasonCode: PolicyReasonCode;
  rationale: string;
  violation?: string;
}

export interface IPolicyRule {
  readonly name: string;
  evaluate(context: PolicyExecutionContext, facts: PolicyEvaluatedFacts): RuleResult | null;
}
