import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  prisma,
  EventRepository,
  MerchantRepository,
  AuditRepository,
  CustomerRepository,
  CaseRepository,
  PolicyConfigRepository,
  ScheduledJobRepository,
} from '../src/index.js';
import {
  MerchantEventSource,
  NormalizedEventType,
  RiskType,
  CaseStatus,
} from '@recoverai/shared';
import {
  EventIngestionService,
  RiskDetector,
} from '@recoverai/core';

describe('MerchantEvent Tenant-Scoped Deduplication & Idempotent Ingestion', () => {
  let dbAvailable = false;
  let eventRepo: EventRepository;
  let merchantRepo: MerchantRepository;
  let auditRepo: AuditRepository;
  let customerRepo: CustomerRepository;
  let caseRepo: CaseRepository;
  let policyConfigRepo: PolicyConfigRepository;
  let scheduledJobRepo: ScheduledJobRepository;
  let riskDetector: RiskDetector;
  let ingestionService: EventIngestionService;

  let merchantAId: string;
  let merchantBId: string;

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbAvailable = true;

      eventRepo = new EventRepository();
      merchantRepo = new MerchantRepository();
      auditRepo = new AuditRepository();
      customerRepo = new CustomerRepository();
      caseRepo = new CaseRepository();
      policyConfigRepo = new PolicyConfigRepository();
      scheduledJobRepo = new ScheduledJobRepository();

      riskDetector = new RiskDetector(
        caseRepo,
        customerRepo,
        policyConfigRepo,
        auditRepo,
        eventRepo,
      );

      ingestionService = new EventIngestionService(eventRepo, auditRepo, riskDetector, customerRepo);

      // Create test merchants
      const mchA = await merchantRepo.createMerchant({
        name: 'Merchant Event Ingestion A',
        slug: `mch-evt-a-${Date.now()}`,
      });
      merchantAId = mchA.id;

      const mchB = await merchantRepo.createMerchant({
        name: 'Merchant Event Ingestion B',
        slug: `mch-evt-b-${Date.now()}`,
      });
      merchantBId = mchB.id;
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      if (merchantAId) await merchantRepo.deleteMerchant(merchantAId).catch(() => {});
      if (merchantBId) await merchantRepo.deleteMerchant(merchantBId).catch(() => {});
      await prisma.$disconnect();
    }
  });

  it('records normal MerchantEvent successfully with payloadJson', async () => {
    if (!dbAvailable) return;

    const dedupeKey = `test:dedupe:${Date.now()}`;
    const { created, event } = await eventRepo.recordMerchantEvent(merchantAId, {
      source: MerchantEventSource.RAZORPAY,
      externalEventId: 'pay_evt_001',
      type: NormalizedEventType.PAYMENT_FAILED,
      dedupeKey,
      payloadJson: { amount: '14999.00', currency: 'INR' },
    });

    expect(created).toBe(true);
    expect(event.id).toBeDefined();
    expect(event.merchantId).toBe(merchantAId);
    expect(event.dedupeKey).toBe(dedupeKey);
    expect(event.type).toBe(NormalizedEventType.PAYMENT_FAILED);
  });

  it('re-using same dedupeKey for same merchant returns existing record with created=false', async () => {
    if (!dbAvailable) return;

    const dedupeKey = `test:dup:same_tenant:${Date.now()}`;

    // First insertion
    const first = await eventRepo.recordMerchantEvent(merchantAId, {
      source: MerchantEventSource.MERCHANT,
      externalEventId: 'ext_1',
      type: NormalizedEventType.CHECKOUT_STARTED,
      dedupeKey,
      payloadJson: { checkoutSessionId: 'sess_1' },
    });
    expect(first.created).toBe(true);

    // Duplicate insertion
    const second = await eventRepo.recordMerchantEvent(merchantAId, {
      source: MerchantEventSource.MERCHANT,
      externalEventId: 'ext_1',
      type: NormalizedEventType.CHECKOUT_STARTED,
      dedupeKey,
      payloadJson: { checkoutSessionId: 'sess_1' },
    });
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
  });

  it('same dedupeKey across different merchants creates separate records without collision', async () => {
    if (!dbAvailable) return;

    const sharedDedupeKey = `shared_dedupe_across_tenants_${Date.now()}`;

    const eventA = await eventRepo.recordMerchantEvent(merchantAId, {
      source: MerchantEventSource.RAZORPAY,
      externalEventId: 'evt_cross_tenant',
      type: NormalizedEventType.PAYMENT_FAILED,
      dedupeKey: sharedDedupeKey,
      payloadJson: { merchant: 'A' },
    });
    expect(eventA.created).toBe(true);
    expect(eventA.event.merchantId).toBe(merchantAId);

    // Merchant B with exact same dedupeKey
    const eventB = await eventRepo.recordMerchantEvent(merchantBId, {
      source: MerchantEventSource.RAZORPAY,
      externalEventId: 'evt_cross_tenant',
      type: NormalizedEventType.PAYMENT_FAILED,
      dedupeKey: sharedDedupeKey,
      payloadJson: { merchant: 'B' },
    });
    expect(eventB.created).toBe(true);
    expect(eventB.event.merchantId).toBe(merchantBId);
    expect(eventB.event.id).not.toBe(eventA.event.id);
  });

  it('EventIngestionService performs end-to-end ingestion and skips risk detection on duplicate', async () => {
    if (!dbAvailable) return;

    const dedupeKey = `e2e:ingest:${Date.now()}`;
    const eventInput = {
      merchantId: merchantAId,
      source: MerchantEventSource.RAZORPAY,
      externalEventId: 'e2e_pay_1',
      eventType: NormalizedEventType.PAYMENT_FAILED,
      occurredAt: new Date(),
      dedupeKey,
      amount: '9999.00',
      currency: 'INR',
      payment: {
        paymentId: 'e2e_pay_1',
        verifiedFailureCode: 'INSUFFICIENT_FUNDS',
      },
    };

    // First ingestion -> Creates event + creates PAYMENT_FAILURE case
    const res1 = await ingestionService.ingestEvent(eventInput);
    expect(res1.created).toBe(true);
    expect(res1.deduplicated).toBe(false);
    expect(res1.detectionResult.caseCreated).toBe(true);
    expect(res1.detectionResult.riskType).toBe(RiskType.PAYMENT_FAILURE);

    // Second ingestion with same dedupeKey -> Returns existing event + skips detection
    const res2 = await ingestionService.ingestEvent(eventInput);
    expect(res2.created).toBe(false);
    expect(res2.deduplicated).toBe(true);
    expect(res2.detectionResult.caseCreated).toBe(false);
    expect(res2.event.id).toBe(res1.event.id);
  });

  it('persists explicit merchant consent while leaving missing consent unknown', async () => {
    if (!dbAvailable) return;
    const customerId = `consent-${Date.now()}`;
    const common = { merchantId: merchantAId, source: MerchantEventSource.MERCHANT, occurredAt: new Date(), amount: '8499.00', currency: 'INR', checkout: { checkoutSessionId: `checkout-${customerId}` } };
    await ingestionService.ingestEvent({ ...common, externalEventId: `evt-consent-${customerId}`, dedupeKey: `dedupe-consent-${customerId}`, eventType: NormalizedEventType.CHECKOUT_STARTED, customer: { externalCustomerId: customerId, contactConsent: true } });
    expect((await customerRepo.getOrCreateCustomer(merchantAId, { externalCustomerId: customerId })).contactConsent).toBe(true);
    const unknownId = `${customerId}-unknown`;
    await ingestionService.ingestEvent({ ...common, externalEventId: `evt-unknown-${customerId}`, dedupeKey: `dedupe-unknown-${customerId}`, checkout: { checkoutSessionId: `checkout-${unknownId}` }, eventType: NormalizedEventType.CHECKOUT_STARTED, customer: { externalCustomerId: unknownId } });
    expect((await customerRepo.getOrCreateCustomer(merchantAId, { externalCustomerId: unknownId })).contactConsent).toBeNull();
  });

  it('preserves merchant consent when Razorpay reports unknown consent, while explicit booleans remain authoritative', async () => {
    if (!dbAvailable) return;
    const suffix = Date.now();
    const grantedCustomer = `consent-granted-${suffix}`;
    const deniedCustomer = `consent-denied-${suffix}`;
    await customerRepo.upsertAuthoritativeCustomerFacts(merchantAId, { externalCustomerId: grantedCustomer, contactConsent: true });
    await customerRepo.upsertAuthoritativeCustomerFacts(merchantAId, { externalCustomerId: deniedCustomer, contactConsent: false });

    const unknownConsentEvent = async (externalCustomerId: string, externalEventId: string) => ingestionService.ingestEvent({
      merchantId: merchantAId,
      source: MerchantEventSource.RAZORPAY,
      externalEventId,
      dedupeKey: `razorpay:${externalEventId}`,
      eventType: NormalizedEventType.CHECKOUT_STARTED,
      occurredAt: new Date(),
      amount: '500.00',
      currency: 'INR',
      checkout: { checkoutSessionId: `checkout-${externalEventId}` },
      customer: { externalCustomerId, contactConsent: null },
    });

    await unknownConsentEvent(grantedCustomer, `evt-consent-unknown-granted-${suffix}`);
    await unknownConsentEvent(deniedCustomer, `evt-consent-unknown-denied-${suffix}`);
    expect((await customerRepo.getOrCreateCustomer(merchantAId, { externalCustomerId: grantedCustomer })).contactConsent).toBe(true);
    expect((await customerRepo.getOrCreateCustomer(merchantAId, { externalCustomerId: deniedCustomer })).contactConsent).toBe(false);

    await customerRepo.upsertAuthoritativeCustomerFacts(merchantAId, { externalCustomerId: grantedCustomer, contactConsent: false });
    await customerRepo.upsertAuthoritativeCustomerFacts(merchantAId, { externalCustomerId: deniedCustomer, contactConsent: true });
    expect((await customerRepo.getOrCreateCustomer(merchantAId, { externalCustomerId: grantedCustomer })).contactConsent).toBe(false);
    expect((await customerRepo.getOrCreateCustomer(merchantAId, { externalCustomerId: deniedCustomer })).contactConsent).toBe(true);

    await customerRepo.upsertAuthoritativeCustomerFacts(merchantBId, { externalCustomerId: grantedCustomer, contactConsent: true });
    expect((await customerRepo.getOrCreateCustomer(merchantBId, { externalCustomerId: grantedCustomer })).contactConsent).toBe(true);
    expect((await customerRepo.getOrCreateCustomer(merchantAId, { externalCustomerId: grantedCustomer })).contactConsent).toBe(false);
  });
});
