import {
  ActionRepository, AuditRepository, CaseRepository, CommitmentRepository, CustomerRepository,
  HumanReviewRepository, MerchantRepository, OutcomeRepository, PolicyConfigRepository,
} from '@recoverai/db';
import { ActionExecutor, DurableReviewGateService, HumanReviewService, IPolicyEngine } from '@recoverai/core';
import { ProviderRegistry } from '@recoverai/integrations';
import { PolicyEngine } from '@recoverai/policy';
import { EnvConfig, loadEnv } from '@recoverai/shared';

/** Real review authority graph used by the ordinary API executable. */
export function composeApiReviewService(env: EnvConfig = loadEnv()): HumanReviewService {
  const caseRepo = new CaseRepository();
  const actionRepo = new ActionRepository();
  const customerRepo = new CustomerRepository();
  const merchantRepo = new MerchantRepository();
  const policyConfigRepo = new PolicyConfigRepository();
  const auditRepo = new AuditRepository();
  const commitmentRepo = new CommitmentRepository();
  const outcomeRepo = new OutcomeRepository();
  const humanReviewRepo = new HumanReviewRepository();
  const policyEngine = new PolicyEngine();
  const executionPolicy = policyEngine as unknown as IPolicyEngine;
  const executor = new ActionExecutor({
    actionRepo, caseRepo, customerRepo, merchantRepo, policyConfigRepo, auditRepo,
    humanReviewRepo, commitmentRepo, policyEngine: executionPolicy,
    providerRegistry: ProviderRegistry.forRuntime({
      enabled: Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
      keyId: env.RAZORPAY_KEY_ID,
      keySecret: env.RAZORPAY_KEY_SECRET,
    }),
    reviewGateRequester: new DurableReviewGateService(humanReviewRepo, caseRepo, auditRepo),
  });
  const reviewService = new HumanReviewService({
    humanReviewRepo, caseRepo, actionRepo, customerRepo, merchantRepo, policyConfigRepo,
    commitmentRepo, outcomeRepo, auditRepo, policyEngine: executionPolicy, actionExecutor: executor,
  });
  executor.setReviewGateRequester(reviewService);
  return reviewService;
}
