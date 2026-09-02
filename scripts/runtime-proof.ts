import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '@recoverai/db';
import { CaseStatus, MerchantEventSource, NormalizedEventType } from '@recoverai/shared';
import { generateIncidentKey } from '@recoverai/core';
import { composeWorkerRuntime } from '../apps/worker/src/runtime.js';
import { RecoveryWorkerService } from '../apps/worker/src/worker.js';
import { RUNTIME_PROOF_LABEL, RUNTIME_PROOF_PROVIDER, RUNTIME_PROOF_SCENARIOS, assertRuntimeProofSafety, calculateRuntimeProofMetrics, validateRuntimeProofScenarios } from '../packages/runtime-proof/src/index.js';

const POLL_INTERVAL_MS = 100;
const WAIT_TIMEOUT_MS = 30_000;
const sleep = () => new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
const count = (values: readonly { status: string }[], status: string) => values.filter((value) => value.status === status).length;
const money = (value: string) => `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function waitFor<T>(scenarioId: string, expected: string, read: () => Promise<T | null>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let observed: T | null = null;
  while (Date.now() < deadline) {
    observed = await read();
    if (observed && predicate(observed)) return observed;
    await sleep();
  }
  throw new Error(`Runtime proof timeout for ${scenarioId}: expected ${expected}; observed ${JSON.stringify(observed)}`);
}

function eventFor(scenario: typeof RUNTIME_PROOF_SCENARIOS[number], merchantId: string, suffix: string) {
  const externalId = `${scenario.id}-${suffix}`;
  const customer = { externalCustomerId: `customer-${scenario.id}-${suffix}`, email: `${scenario.id}-${suffix}@runtime-proof.test`, contactConsent: scenario.consent ?? true };
  const common = { merchantId, source: MerchantEventSource.SIMULATOR, externalEventId: `evt-${externalId}`, occurredAt: new Date(), dedupeKey: `runtime-proof:${externalId}`, amount: scenario.amount, currency: 'INR', customer };
  if (scenario.kind === 'payment') return { ...common, eventType: NormalizedEventType.PAYMENT_FAILED, payment: { paymentId: `payment-${externalId}`, verifiedFailureCode: scenario.failureCode } };
  if (scenario.kind === 'subscription') return { ...common, eventType: NormalizedEventType.SUBSCRIPTION_RENEWAL_FAILED, payment: { subscriptionId: `subscription-${externalId}`, paymentId: `payment-${externalId}`, verifiedFailureCode: scenario.failureCode } };
  if (scenario.kind === 'checkout') return { ...common, eventType: NormalizedEventType.CHECKOUT_STARTED, occurredAt: new Date(Date.now() - 31 * 60 * 1000), checkout: { checkoutSessionId: `checkout-${externalId}` } };
  return { ...common, eventType: NormalizedEventType.INVOICE_CREATED, invoice: { invoiceId: `invoice-${externalId}`, dueDate: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000), paid: false } };
}

async function main(): Promise<void> {
  validateRuntimeProofScenarios();
  const suffix = `${Date.now()}-${process.pid}`;
  const schema = `pgboss_runtime_proof_${suffix.replace(/[^a-z0-9_]/gi, '_')}`.toLowerCase();
  const merchant = await prisma.merchant.create({ data: { name: 'RecoverAI Deterministic Runtime Proof', slug: `runtime-proof-${suffix}` } });
  await prisma.policyConfig.create({ data: { merchantId: merchant.id, checkoutAbandonmentThresholdMinutes: 1, overdueGracePeriodDays: 0, quietHoursStart: 0, quietHoursEnd: 0 } });
  const runtime = composeWorkerRuntime({ NODE_ENV: 'test', AI_PROVIDER: 'mock', DATABASE_URL: process.env.DATABASE_URL!, PG_BOSS_SCHEMA: schema, LOG_LEVEL: 'error' } as never);
  const worker = runtime.worker as unknown as RecoveryWorkerService;
  const created = new Map<string, { scenario: typeof RUNTIME_PROOF_SCENARIOS[number]; event: ReturnType<typeof eventFor>; caseId: string }>();
  try {
    await worker.start();
    const ingester = worker.getEventIngestionService(); const observer = worker.getOutcomeObserver();
    if (!ingester || !observer) throw new Error('Runtime worker did not compose EventIngestionService and OutcomeObserver');
    for (const scenario of RUNTIME_PROOF_SCENARIOS) {
      const event = eventFor(scenario, merchant.id, suffix);
      if (scenario.optedOut) await prisma.customer.create({ data: { merchantId: merchant.id, externalCustomerId: event.customer.externalCustomerId!, email: event.customer.email!, optedOut: true, contactConsent: true } });
      const ingested = await ingester.ingestEvent(event);
      if (scenario.duplicate && !(await ingester.ingestEvent(event)).deduplicated) throw new Error(`Duplicate delivery was not deduplicated for ${scenario.id}`);
      let caseId = ingested.detectionResult.caseId;
      if (!caseId) {
        const identity = scenario.kind === 'checkout' ? event.checkout!.checkoutSessionId! : scenario.kind === 'invoice' ? event.invoice!.invoiceId : scenario.kind === 'subscription' ? event.payment!.subscriptionId! : event.payment!.paymentId!;
        caseId = (await waitFor(scenario.id, 'risk case created by timer', () => prisma.revenueRiskCase.findFirst({ where: { merchantId: merchant.id, incidentKey: generateIncidentKey(merchant.id, scenario.riskType, identity) } }), () => true)).id;
      }
      created.set(scenario.id, { scenario, event, caseId });
    }
    for (const { scenario, caseId } of created.values()) {
      await waitFor(scenario.id, 'plan, action, or review persisted by real pg-boss worker', async () => {
        const [plans, actions, reviews, caseRecord] = await Promise.all([prisma.recoveryPlanVersion.count({ where: { caseId } }), prisma.recoveryAction.count({ where: { caseId } }), prisma.humanReview.count({ where: { caseId } }), prisma.revenueRiskCase.findUnique({ where: { id: caseId } })]);
        return { plans, actions, reviews, status: caseRecord?.status || 'MISSING' };
      }, (state) => state.plans + state.actions + state.reviews > 0 || [CaseStatus.STOPPED, CaseStatus.EXHAUSTED].includes(state.status as CaseStatus));
    }
    for (const { scenario, event, caseId } of created.values()) {
      if (!scenario.authoritativeOutcome) continue;
      const type = scenario.authoritativeOutcome === 'payment' ? NormalizedEventType.PAYMENT_SUCCEEDED : scenario.authoritativeOutcome === 'checkout' ? NormalizedEventType.CHECKOUT_COMPLETED : NormalizedEventType.INVOICE_PAID;
      const outcomeEvent = { merchantId: merchant.id, source: MerchantEventSource.SIMULATOR, externalEventId: `outcome-${scenario.id}-${suffix}`, dedupeKey: `runtime-proof:outcome:${scenario.id}:${suffix}`, eventType: type, occurredAt: new Date(), amount: scenario.amount, currency: 'INR', ...(scenario.kind === 'checkout' ? { checkout: event.checkout } : scenario.kind === 'invoice' ? { invoice: event.invoice } : { payment: event.payment }) };
      const persisted = await ingester.ingestEvent(outcomeEvent, { skipRiskDetection: true });
      const result = await observer.observeMerchantEvent(outcomeEvent, persisted.event.id);
      if (!result.observed || result.caseId !== caseId) throw new Error(`Authoritative outcome was not observed for ${scenario.id}: ${result.reason || 'unknown reason'}`);
    }
    // Two real non-monetary replan wakes deliberately prove distinct bounded branches:
    // limit exhaustion and a persisted policy DENY. Neither event may credit money.
    const observePaymentMethodUpdate = async (scenarioId: string) => {
      const target = created.get(scenarioId)!;
      const updateEvent = { merchantId: merchant.id, source: MerchantEventSource.SIMULATOR, externalEventId: `method-update-${scenarioId}-${suffix}`, dedupeKey: `runtime-proof:method-update:${scenarioId}:${suffix}`, eventType: NormalizedEventType.PAYMENT_METHOD_UPDATED, occurredAt: new Date(), payment: target.event.payment };
      const persisted = await ingester.ingestEvent(updateEvent, { skipRiskDetection: true });
      const observed = await observer.observeMerchantEvent(updateEvent, persisted.event.id);
      if (!observed.observed || !observed.replanTriggered) throw new Error(`PAYMENT_METHOD_UPDATED did not create an authoritative replan for ${scenarioId}`);
    };
    await prisma.policyConfig.update({ where: { merchantId: merchant.id }, data: { maxActionsPerCase: 1 } });
    await observePaymentMethodUpdate('payment-expired-method');
    await waitFor('payment-expired-method', 'EXHAUSTED after bounded replan', () => prisma.revenueRiskCase.findUnique({ where: { id: created.get('payment-expired-method')!.caseId } }), (caseRecord) => caseRecord.status === CaseStatus.EXHAUSTED);
    await prisma.policyConfig.update({ where: { merchantId: merchant.id }, data: { maxActionsPerCase: 5, cooldownHoursBetweenActions: 24 } });
    await observePaymentMethodUpdate('subscription-expired');
    await waitFor('subscription-expired', 'persisted policy DENY audit after replan', () => prisma.auditEvent.findFirst({ where: { caseId: created.get('subscription-expired')!.caseId, eventType: 'ACTION_BLOCKED_BY_POLICY' } }), () => true);
    const promise = created.get('payment-hard-decline')!;
    await observer.observeCustomerReply({ merchantId: merchant.id, caseId: promise.caseId, messageId: `promise-${suffix}`, replyText: 'I promise to pay 1350.00 today', occurredAt: new Date(Date.now() - 1_000) });
    await waitFor('promise-broken', 'case NEEDS_REVIEW after durable promise check', () => prisma.revenueRiskCase.findUnique({ where: { id: promise.caseId } }), (caseRecord) => caseRecord.status === CaseStatus.NEEDS_REVIEW);
    const cases = await prisma.revenueRiskCase.findMany({ where: { merchantId: merchant.id }, include: { recoveryOutcome: { select: { actionId: true, amountRecovered: true } }, actions: true, auditEvents: true, outcomes: true } });
    const metrics = calculateRuntimeProofMetrics(cases.map((item) => ({ status: item.status, amountAtRisk: item.amountAtRisk.toString(), recoveredAmount: item.recoveredAmount?.toString() || null, recoveryOutcomeId: item.recoveryOutcomeId, recoveryOutcome: item.recoveryOutcome ? { actionId: item.recoveryOutcome.actionId, amountRecovered: item.recoveryOutcome.amountRecovered?.toString() || null } : null })));
    const actions = cases.flatMap((item) => item.actions); const audits = cases.flatMap((item) => item.auditEvents); const outcomes = cases.flatMap((item) => item.outcomes);
    const terminalActions = actions.filter((action) => {
      const terminalCase = cases.find((item) => item.id === action.caseId);
      return Boolean(terminalCase?.resolvedAt && action.createdAt > terminalCase.resolvedAt);
    }).length;
    const safety = assertRuntimeProofSafety({ denyExecuted: actions.filter((action) => action.policyDecision === 'DENY' && action.status === 'SUCCESS').length, terminalActions, duplicateRecoveryCredits: cases.filter((item) => item.outcomes.filter((outcome) => outcome.amountRecovered !== null).length > 1).length, agentAttributedRecovered: metrics.agentAttributedRecovered, verifiedRecovered: metrics.verifiedRecovered, nonMonetaryCredits: outcomes.filter((outcome) => outcome.outcomeType === 'PAYMENT_METHOD_UPDATED' && outcome.amountRecovered !== null).length, recoveredWithoutEvidence: cases.filter((item) => item.status === CaseStatus.RECOVERED && (!item.recoveryOutcomeId || !item.recoveryOutcome?.amountRecovered)).length, executionsWithoutPolicy: actions.filter((action) => action.status === 'SUCCESS' && !action.policyDecision).length, casesWithoutAudit: cases.filter((item) => item.auditEvents.length === 0).length });
    const policy = { ALLOW: actions.filter((action) => action.policyDecision === 'ALLOW').length, REVIEW: audits.filter((audit) => audit.eventType === 'REVIEW_REQUESTED').length, DENY: audits.filter((audit) => audit.eventType === 'ACTION_BLOCKED_BY_POLICY').length };
    if (![CaseStatus.RECOVERED, CaseStatus.NEEDS_REVIEW, CaseStatus.STOPPED, CaseStatus.EXHAUSTED].every((status) => cases.some((item) => item.status === status))) throw new Error('Runtime batch did not represent every required terminal/review branch');
    if (!policy.ALLOW || !policy.REVIEW || !policy.DENY) throw new Error('Runtime batch did not persist ALLOW, REVIEW, and DENY evidence');
    const execution = { providerActions: actions.filter((action) => action.status === 'SUCCESS' && action.providerName && action.providerName !== 'SIMULATED').length, simulatedActions: actions.filter((action) => action.status === 'SUCCESS' && action.providerName === 'SIMULATED').length };
    const summary = { label: RUNTIME_PROOF_LABEL, provider: RUNTIME_PROOF_PROVIDER, generatedAt: new Date().toISOString(), casesProcessed: metrics.casesProcessed, money: metrics, caseOutcomes: metrics.caseOutcomes, policy, execution, audit: { events: audits.length }, safetyAssertions: safety };
    await mkdir(path.resolve('runtime-proof'), { recursive: true }); await writeFile(path.resolve('runtime-proof/latest-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`RecoverAI — ${RUNTIME_PROOF_LABEL}\n\nProposal provider: ${RUNTIME_PROOF_PROVIDER}\nRazorpay mode: Test Mode / simulated according to scenario\nCases: ${metrics.casesProcessed}\n\nMONEY\nInitial revenue at risk          ${money(metrics.initialRevenueAtRisk)}\nVerified recovered               ${money(metrics.verifiedRecovered)}\nAgent-attributed recovered       ${money(metrics.agentAttributedRecovered)}\nOrganic verified recovered       ${money(metrics.organicVerifiedRecovered)}\n\nCASE OUTCOMES\nRecovered                        ${count(cases, 'RECOVERED')}\nNeeds review                     ${count(cases, 'NEEDS_REVIEW')}\nStopped                          ${count(cases, 'STOPPED')}\nExhausted                        ${count(cases, 'EXHAUSTED')}\nActive / waiting                 ${count(cases, 'OPEN') + count(cases, 'WAITING')}\n\nPOLICY\nALLOW                            ${policy.ALLOW}\nREVIEW                           ${policy.REVIEW}\nDENY                             ${policy.DENY}\n\nEXECUTION\nProvider/Test Mode actions       ${execution.providerActions}\nSimulated actions                ${execution.simulatedActions}\n\nAUDIT\nAudit events                     ${audits.length}\n\nSAFETY\n✓ no DENY action executed\n✓ no terminal case re-executed\n✓ no duplicate recovery credit\n✓ agent-attributed <= verified recovered\n✓ non-monetary events credited zero\n\nRESULT: PASS`);
  } finally {
    await worker.stop().catch(() => undefined);
    await prisma.merchant.delete({ where: { id: merchant.id } }).catch(() => undefined);
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS \"${schema}\" CASCADE`).catch(() => undefined);
    await runtime.closeDatabase().catch(() => undefined);
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
