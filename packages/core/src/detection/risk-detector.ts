import {
  RiskType,
  CaseStatus,
  NormalizedEventType,
  NormalizedMerchantEvent,
  AuditActorType,
  Money,
  MissingEventIdentityError,
} from '@recoverai/shared';
import {
  CaseRepository,
  CustomerRepository,
  PolicyConfigRepository,
  AuditRepository,
  EventRepository,
  RevenueRiskCase,
} from '@recoverai/db';
import { generateIncidentKey } from './incident-identity.js';
import { IJobScheduler } from './job-scheduler-interface.js';

export interface DetectionResult {
  riskDetected: boolean;
  caseCreated: boolean;
  caseId?: string;
  case?: RevenueRiskCase;
  riskType?: RiskType;
  suppressed?: boolean;
  deduplicated?: boolean;
  scheduledJobId?: string;
  reason?: string;
}

export class RiskDetector {
  constructor(
    private caseRepo: CaseRepository,
    private customerRepo: CustomerRepository,
    private policyConfigRepo: PolicyConfigRepository,
    private auditRepo: AuditRepository,
    private eventRepo: EventRepository,
    private jobScheduler?: IJobScheduler,
  ) {}

  /** Revenue-risk cases require authoritative, positive, exactly representable money. */
  private async validateRevenueRiskMoney(
    merchantId: string,
    eventType: string,
    amount: unknown,
    currency: unknown,
    identity: Record<string, unknown>,
  ): Promise<{ amount: string; currency: string } | null> {
    const normalizedCurrency = typeof currency === 'string' ? currency.toUpperCase() : '';
    if (
      typeof amount !== 'string' ||
      !Money.isValidDecimalString(amount) ||
      !/^[A-Z]{3}$/.test(normalizedCurrency) ||
      Money.fromDecimalString(amount, normalizedCurrency).toPaise() <= 0n
    ) {
      await this.auditRepo.record(merchantId, {
        eventType: 'DETECTION_ERROR',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { eventType, amount: typeof amount === 'string' ? amount : null, currency: typeof currency === 'string' ? currency : null, ...identity },
        reasonCode: 'REVENUE_RISK_MONEY_REQUIRED',
      });
      return null;
    }
    return { amount, currency: normalizedCurrency };
  }

  /**
   * Main entrypoint for processing normalized merchant events.
   * Deterministically identifies revenue risk or suppresses false cases.
   */
  async handleNormalizedEvent(event: NormalizedMerchantEvent): Promise<DetectionResult> {
    switch (event.eventType) {
      case NormalizedEventType.PAYMENT_FAILED:
        return this.handlePaymentFailed(event);

      case NormalizedEventType.SUBSCRIPTION_RENEWAL_FAILED:
        return this.handleSubscriptionRenewalFailed(event);

      case NormalizedEventType.CHECKOUT_STARTED:
        return this.handleCheckoutStarted(event);

      case NormalizedEventType.CHECKOUT_COMPLETED:
        return this.handleCheckoutCompleted(event);

      case NormalizedEventType.INVOICE_CREATED:
        return this.handleInvoiceCreated(event);

      case NormalizedEventType.INVOICE_PAID:
        return this.handleInvoicePaid(event);

      case NormalizedEventType.PAYMENT_SUCCEEDED:
        return this.handlePaymentSucceeded(event);

      default:
        return {
          riskDetected: false,
          caseCreated: false,
          reason: `Event type ${event.eventType} does not trigger revenue risk detection`,
        };
    }
  }

  /**
   * 1. PAYMENT_FAILED -> PAYMENT_FAILURE
   */
  private async handlePaymentFailed(event: NormalizedMerchantEvent): Promise<DetectionResult> {
    const merchantId = event.merchantId;
    const paymentId = event.payment?.paymentId || event.externalEventId;

    if (!paymentId) {
      throw new MissingEventIdentityError('PAYMENT_FAILED', 'paymentId or externalEventId');
    }

    const incidentKey = generateIncidentKey(merchantId, RiskType.PAYMENT_FAILURE, paymentId);

    // 1. Check if a PAYMENT_SUCCEEDED event already arrived for this payment (suppression)
    const successEvent = await this.eventRepo.findEventByTypeAndField(
      merchantId,
      NormalizedEventType.PAYMENT_SUCCEEDED,
      ['payment', 'paymentId'],
      paymentId,
    );

    if (successEvent) {
      await this.auditRepo.record(merchantId, {
        eventType: 'RISK_SUPPRESSED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { incidentKey, paymentId, reason: 'PAYMENT_SUCCEEDED_ALREADY_EXISTS' },
        reasonCode: 'PAYMENT_ALREADY_SUCCEEDED',
      });
      return {
        riskDetected: false,
        caseCreated: false,
        suppressed: true,
        reason: 'Payment has already succeeded; failure risk suppressed',
      };
    }

    // 2. Case Deduplication: Check if an active case already exists for this incident
    const existingCase = await this.caseRepo.findActiveCaseByIncidentKey(merchantId, incidentKey);
    if (existingCase) {
      await this.auditRepo.record(merchantId, {
        caseId: existingCase.id,
        eventType: 'DETECTION_SKIPPED_DUPLICATE',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { incidentKey, existingCaseId: existingCase.id },
        reasonCode: 'DUPLICATE_PAYMENT_FAILURE_INCIDENT',
      });
      return {
        riskDetected: true,
        caseCreated: false,
        caseId: existingCase.id,
        case: existingCase,
        riskType: RiskType.PAYMENT_FAILURE,
        deduplicated: true,
        reason: 'Active case already exists for this payment failure incident',
      };
    }

    const money = await this.validateRevenueRiskMoney(merchantId, 'PAYMENT_FAILED', event.amount, event.currency, { paymentId });
    if (!money) {
      return { riskDetected: false, caseCreated: false, suppressed: true, reason: 'Payment failure lacks authoritative positive amount and ISO currency; risk case suppressed' };
    }

    // 3. Resolve or create customer if customer reference is present
    let customerId: string | undefined = undefined;
    if (event.customer && (event.customer.externalCustomerId || event.customer.email || event.customer.phone)) {
      const customer = await this.customerRepo.getOrCreateCustomer(merchantId, {
        externalCustomerId: event.customer.externalCustomerId || undefined,
        email: event.customer.email || undefined,
        phone: event.customer.phone || undefined,
        name: event.customer.name || undefined,
        contactConsent: event.customer.contactConsent,
      });
      customerId = customer.id;
    }

    // 4. Create new PAYMENT_FAILURE RevenueRiskCase
    const amountAtRisk = money.amount;
    const currency = money.currency;
    const verifiedFailureCode = event.payment?.verifiedFailureCode || null;

    const { case: newCase, created } = await this.caseRepo.createCaseIdempotently(merchantId, {
      customerId,
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk,
      currency,
      incidentKey,
      contextJson: {
        incidentKey,
        source: event.source,
        externalEventId: event.externalEventId,
        paymentId,
        orderId: event.payment?.orderId,
        subscriptionId: event.payment?.subscriptionId,
        verifiedPaymentFailureCode: verifiedFailureCode,
        gatewayErrorMessage: event.payment?.gatewayErrorMessage,
        paymentMethod: event.payment?.paymentMethod,
        cardNetwork: event.payment?.cardNetwork,
        cardLast4: event.payment?.cardLast4,
        bankName: event.payment?.bankName,
        metadata: event.metadata,
      },
    });

    if (!created) {
      await this.auditRepo.record(merchantId, {
        caseId: newCase.id,
        eventType: 'DETECTION_SKIPPED_DUPLICATE',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { incidentKey, existingCaseId: newCase.id },
        reasonCode: 'DUPLICATE_PAYMENT_FAILURE_INCIDENT',
      });
      return {
        riskDetected: true,
        caseCreated: false,
        caseId: newCase.id,
        case: newCase,
        riskType: RiskType.PAYMENT_FAILURE,
        deduplicated: true,
        reason: 'Concurrent creation resolved to existing incident case',
      };
    }

    await this.auditRepo.record(merchantId, {
      caseId: newCase.id,
      eventType: 'RISK_DETECTED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: {
        incidentKey,
        riskType: RiskType.PAYMENT_FAILURE,
        amount: amountAtRisk,
        currency,
        verifiedFailureCode,
      },
      outputSummaryJson: { caseId: newCase.id, status: CaseStatus.OPEN },
      reasonCode: 'PAYMENT_FAILED_DETECTED',
    });

    return {
      riskDetected: true,
      caseCreated: true,
      caseId: newCase.id,
      case: newCase,
      riskType: RiskType.PAYMENT_FAILURE,
      reason: 'Payment failure detected; case opened',
    };
  }

  /**
   * 2. SUBSCRIPTION_RENEWAL_FAILED -> SUBSCRIPTION_FAILURE
   */
  private async handleSubscriptionRenewalFailed(event: NormalizedMerchantEvent): Promise<DetectionResult> {
    const merchantId = event.merchantId;
    const subscriptionId = event.payment?.subscriptionId;

    if (!subscriptionId) {
      throw new MissingEventIdentityError('SUBSCRIPTION_RENEWAL_FAILED', 'payment.subscriptionId');
    }

    const incidentKey = generateIncidentKey(merchantId, RiskType.SUBSCRIPTION_FAILURE, subscriptionId);

    // 1. Case Deduplication
    const existingCase = await this.caseRepo.findActiveCaseByIncidentKey(merchantId, incidentKey);
    if (existingCase) {
      await this.auditRepo.record(merchantId, {
        caseId: existingCase.id,
        eventType: 'DETECTION_SKIPPED_DUPLICATE',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { incidentKey, existingCaseId: existingCase.id },
        reasonCode: 'DUPLICATE_SUBSCRIPTION_FAILURE_INCIDENT',
      });
      return {
        riskDetected: true,
        caseCreated: false,
        caseId: existingCase.id,
        case: existingCase,
        riskType: RiskType.SUBSCRIPTION_FAILURE,
        deduplicated: true,
        reason: 'Active case already exists for this subscription renewal incident',
      };
    }

    const money = await this.validateRevenueRiskMoney(merchantId, 'SUBSCRIPTION_RENEWAL_FAILED', event.amount, event.currency, { subscriptionId });
    if (!money) {
      return { riskDetected: false, caseCreated: false, suppressed: true, reason: 'Subscription failure lacks authoritative positive amount and ISO currency; risk case suppressed' };
    }

    // 2. Resolve or create customer
    let customerId: string | undefined = undefined;
    if (event.customer && (event.customer.externalCustomerId || event.customer.email || event.customer.phone)) {
      const customer = await this.customerRepo.getOrCreateCustomer(merchantId, {
        externalCustomerId: event.customer.externalCustomerId || undefined,
        email: event.customer.email || undefined,
        phone: event.customer.phone || undefined,
        name: event.customer.name || undefined,
        contactConsent: event.customer.contactConsent,
      });
      customerId = customer.id;
    }

    // 3. Create SUBSCRIPTION_FAILURE RevenueRiskCase with authoritative incidentKey
    const amountAtRisk = money.amount;
    const currency = money.currency;
    const verifiedFailureCode = event.payment?.verifiedFailureCode || null;

    const { case: newCase, created } = await this.caseRepo.createCaseIdempotently(merchantId, {
      customerId,
      riskType: RiskType.SUBSCRIPTION_FAILURE,
      amountAtRisk,
      currency,
      incidentKey,
      contextJson: {
        incidentKey,
        source: event.source,
        externalEventId: event.externalEventId,
        subscriptionId,
        paymentId: event.payment?.paymentId,
        verifiedPaymentFailureCode: verifiedFailureCode,
        gatewayErrorMessage: event.payment?.gatewayErrorMessage,
        paymentMethod: event.payment?.paymentMethod,
        metadata: event.metadata,
      },
    });

    if (!created) {
      await this.auditRepo.record(merchantId, {
        caseId: newCase.id,
        eventType: 'DETECTION_SKIPPED_DUPLICATE',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { incidentKey, existingCaseId: newCase.id },
        reasonCode: 'DUPLICATE_SUBSCRIPTION_FAILURE_INCIDENT',
      });
      return {
        riskDetected: true,
        caseCreated: false,
        caseId: newCase.id,
        case: newCase,
        riskType: RiskType.SUBSCRIPTION_FAILURE,
        deduplicated: true,
        reason: 'Concurrent creation resolved to existing incident case',
      };
    }

    await this.auditRepo.record(merchantId, {
      caseId: newCase.id,
      eventType: 'RISK_DETECTED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: {
        incidentKey,
        riskType: RiskType.SUBSCRIPTION_FAILURE,
        subscriptionId,
        amount: amountAtRisk,
        currency,
      },
      outputSummaryJson: { caseId: newCase.id, status: CaseStatus.OPEN },
      reasonCode: 'SUBSCRIPTION_RENEWAL_FAILED_DETECTED',
    });

    return {
      riskDetected: true,
      caseCreated: true,
      caseId: newCase.id,
      case: newCase,
      riskType: RiskType.SUBSCRIPTION_FAILURE,
      reason: 'Subscription renewal failure detected; case opened',
    };
  }

  /**
   * 3. CHECKOUT_STARTED -> Schedule durable abandonment timer
   */
  private async handleCheckoutStarted(event: NormalizedMerchantEvent): Promise<DetectionResult> {
    const merchantId = event.merchantId;
    const checkoutSessionId = event.checkout?.checkoutSessionId;

    if (!checkoutSessionId) {
      throw new MissingEventIdentityError('CHECKOUT_STARTED', 'checkout.checkoutSessionId');
    }

    const incidentKey = generateIncidentKey(merchantId, RiskType.CHECKOUT_ABANDONMENT, checkoutSessionId);

    // 1. Check if CHECKOUT_COMPLETED already arrived
    const completedEvent = await this.eventRepo.findEventByTypeAndField(
      merchantId,
      NormalizedEventType.CHECKOUT_COMPLETED,
      ['checkout', 'checkoutSessionId'],
      checkoutSessionId,
    );

    if (completedEvent) {
      await this.auditRepo.record(merchantId, {
        eventType: 'RISK_SUPPRESSED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { incidentKey, checkoutSessionId, reason: 'CHECKOUT_ALREADY_COMPLETED' },
        reasonCode: 'CHECKOUT_ALREADY_COMPLETED',
      });
      return {
        riskDetected: false,
        caseCreated: false,
        suppressed: true,
        reason: 'Checkout already completed; abandonment timer not scheduled',
      };
    }

    // 2. Check if active CHECKOUT_ABANDONMENT case already exists
    const existingCase = await this.caseRepo.findActiveCaseByIncidentKey(merchantId, incidentKey);
    if (existingCase) {
      return {
        riskDetected: true,
        caseCreated: false,
        caseId: existingCase.id,
        case: existingCase,
        riskType: RiskType.CHECKOUT_ABANDONMENT,
        deduplicated: true,
        reason: 'Active abandonment case already exists for checkout session',
      };
    }

    // 3. Load and validate PolicyConfig threshold
    const config = await this.policyConfigRepo.getOrCreateConfig(merchantId);
    const thresholdMinutes = config.checkoutAbandonmentThresholdMinutes ?? 30;
    if (!Number.isInteger(thresholdMinutes) || thresholdMinutes <= 0) {
      await this.auditRepo.record(merchantId, {
        eventType: 'DETECTION_ERROR',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { thresholdMinutes, merchantId },
        reasonCode: 'INVALID_CHECKOUT_ABANDONMENT_CONFIG',
      });
      return {
        riskDetected: false,
        caseCreated: false,
        reason: 'Invalid checkoutAbandonmentThresholdMinutes in policy config; timer scheduling skipped safely',
      };
    }

    // 4. Enforce durable scheduler availability
    if (!this.jobScheduler) {
      await this.auditRepo.record(merchantId, {
        eventType: 'DETECTION_ERROR',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { merchantId, checkoutSessionId },
        reasonCode: 'DURABLE_SCHEDULER_UNAVAILABLE',
      });
      return {
        riskDetected: false,
        caseCreated: false,
        reason: 'Durable job scheduler is required but unavailable; timer not scheduled',
      };
    }

    const scheduledFor = new Date(event.occurredAt.getTime() + thresholdMinutes * 60 * 1000);

    // 5. Schedule durable abandonment recheck
    let scheduledJobId: string | undefined;
    try {
      const job = await this.jobScheduler.schedule({
        merchantId,
        jobType: 'CHECKOUT_ABANDONMENT_CHECK',
        scheduledFor,
        payloadJson: {
          merchantId,
          checkoutSessionId,
          incidentKey,
          amount: event.amount,
          currency: event.currency,
          customer: event.customer,
          checkout: event.checkout,
          metadata: event.metadata,
        },
      });
      scheduledJobId = job.id;
    } catch (err: unknown) {
      await this.auditRepo.record(merchantId, {
        eventType: 'SCHEDULING_FAILED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { incidentKey, checkoutSessionId, err: String(err) },
        reasonCode: 'CHECKOUT_ABANDONMENT_SCHEDULING_FAILED',
      });
      return {
        riskDetected: false,
        caseCreated: false,
        reason: 'Failed to schedule durable checkout abandonment check',
      };
    }

    await this.auditRepo.record(merchantId, {
      eventType: 'TIMER_SCHEDULED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: {
        incidentKey,
        checkoutSessionId,
        thresholdMinutes,
        scheduledFor,
        scheduledJobId,
      },
      reasonCode: 'CHECKOUT_ABANDONMENT_TIMER_SCHEDULED',
    });

    return {
      riskDetected: false, // Not yet abandoned
      caseCreated: false,
      scheduledJobId,
      reason: `Checkout started; abandonment recheck scheduled for ${scheduledFor.toISOString()} (${thresholdMinutes}m)`,
    };
  }

  /**
   * 4. evaluateCheckoutTimer: Fired by worker / scheduler when threshold elapsed
   */
  async evaluateCheckoutTimer(
    merchantId: string,
    checkoutSessionId: string,
    context?: Record<string, unknown>,
  ): Promise<DetectionResult> {
    const incidentKey = generateIncidentKey(merchantId, RiskType.CHECKOUT_ABANDONMENT, checkoutSessionId);

    await this.auditRepo.record(merchantId, {
      eventType: 'TIMER_FIRED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: { incidentKey, checkoutSessionId, timerType: 'CHECKOUT_ABANDONMENT_CHECK' },
      reasonCode: 'CHECKOUT_ABANDONMENT_TIMER_FIRED',
    });

    // 1. Check if CHECKOUT_COMPLETED event exists in DB
    const completedEvent = await this.eventRepo.findEventByTypeAndField(
      merchantId,
      NormalizedEventType.CHECKOUT_COMPLETED,
      ['checkout', 'checkoutSessionId'],
      checkoutSessionId,
    );

    if (completedEvent) {
      await this.auditRepo.record(merchantId, {
        eventType: 'RISK_SUPPRESSED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { incidentKey, checkoutSessionId, reason: 'CHECKOUT_COMPLETED_OBSERVED' },
        reasonCode: 'CHECKOUT_COMPLETED_SUPPRESSES_ABANDONMENT',
      });
      return {
        riskDetected: false,
        caseCreated: false,
        suppressed: true,
        reason: 'Checkout completed before timer; abandonment risk suppressed',
      };
    }

    // 2. Case Deduplication
    const existingCase = await this.caseRepo.findActiveCaseByIncidentKey(merchantId, incidentKey);
    if (existingCase) {
      await this.auditRepo.record(merchantId, {
        caseId: existingCase.id,
        eventType: 'DETECTION_SKIPPED_DUPLICATE',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { incidentKey, existingCaseId: existingCase.id },
        reasonCode: 'DUPLICATE_CHECKOUT_ABANDONMENT_INCIDENT',
      });
      return {
        riskDetected: true,
        caseCreated: false,
        caseId: existingCase.id,
        case: existingCase,
        riskType: RiskType.CHECKOUT_ABANDONMENT,
        deduplicated: true,
        reason: 'Active case already exists for this checkout abandonment incident',
      };
    }

    const money = await this.validateRevenueRiskMoney(
      merchantId,
      'CHECKOUT_ABANDONMENT_CHECK',
      context?.amount,
      context?.currency,
      { checkoutSessionId },
    );
    if (!money) {
      return { riskDetected: false, caseCreated: false, suppressed: true, reason: 'Checkout abandonment lacks authoritative positive amount and ISO currency; risk case suppressed' };
    }

    // 3. Resolve customer if provided
    let customerId: string | undefined = undefined;
    const customerData = context?.customer as Record<string, unknown> | undefined;
    if (customerData && (customerData.externalCustomerId || customerData.email || customerData.phone)) {
      const customer = await this.customerRepo.getOrCreateCustomer(merchantId, {
        externalCustomerId: (customerData.externalCustomerId as string) || undefined,
        email: (customerData.email as string) || undefined,
        phone: (customerData.phone as string) || undefined,
        name: (customerData.name as string) || undefined,
        contactConsent: customerData.contactConsent as boolean | null | undefined,
      });
      customerId = customer.id;
    }

    // 4. Create CHECKOUT_ABANDONMENT case with authoritative incidentKey
    const amountAtRisk = money.amount;
    const currency = money.currency;

    const { case: newCase, created } = await this.caseRepo.createCaseIdempotently(merchantId, {
      customerId,
      riskType: RiskType.CHECKOUT_ABANDONMENT,
      amountAtRisk,
      currency,
      incidentKey,
      contextJson: {
        incidentKey,
        checkoutSessionId,
        checkout: context?.checkout,
        metadata: context?.metadata,
      },
    });

    if (!created) {
      await this.auditRepo.record(merchantId, {
        caseId: newCase.id,
        eventType: 'DETECTION_SKIPPED_DUPLICATE',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { incidentKey, existingCaseId: newCase.id },
        reasonCode: 'DUPLICATE_CHECKOUT_ABANDONMENT_INCIDENT',
      });
      return {
        riskDetected: true,
        caseCreated: false,
        caseId: newCase.id,
        case: newCase,
        riskType: RiskType.CHECKOUT_ABANDONMENT,
        deduplicated: true,
        reason: 'Concurrent creation resolved to existing incident case',
      };
    }

    await this.auditRepo.record(merchantId, {
      caseId: newCase.id,
      eventType: 'RISK_DETECTED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: {
        incidentKey,
        riskType: RiskType.CHECKOUT_ABANDONMENT,
        checkoutSessionId,
        amount: amountAtRisk,
        currency,
      },
      outputSummaryJson: { caseId: newCase.id, status: CaseStatus.OPEN },
      reasonCode: 'CHECKOUT_ABANDONMENT_CONFIRMED',
    });

    return {
      riskDetected: true,
      caseCreated: true,
      caseId: newCase.id,
      case: newCase,
      riskType: RiskType.CHECKOUT_ABANDONMENT,
      reason: 'Checkout abandonment threshold elapsed without completion; case opened',
    };
  }

  /**
   * 5. INVOICE_CREATED -> Schedule durable overdue timer
   */
  private async handleInvoiceCreated(event: NormalizedMerchantEvent): Promise<DetectionResult> {
    const merchantId = event.merchantId;
    const invoiceId = event.invoice?.invoiceId;

    if (!invoiceId) {
      throw new MissingEventIdentityError('INVOICE_CREATED', 'invoice.invoiceId');
    }

    const incidentKey = generateIncidentKey(merchantId, RiskType.OVERDUE_RECEIVABLE, invoiceId);

    // 1. Check if INVOICE_PAID already arrived
    const paidEvent = await this.eventRepo.findEventByTypeAndField(
      merchantId,
      NormalizedEventType.INVOICE_PAID,
      ['invoice', 'invoiceId'],
      invoiceId,
    );

    if (paidEvent || event.invoice?.paid === true) {
      await this.auditRepo.record(merchantId, {
        eventType: 'RISK_SUPPRESSED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { incidentKey, invoiceId, reason: 'INVOICE_ALREADY_PAID' },
        reasonCode: 'INVOICE_ALREADY_PAID',
      });
      return {
        riskDetected: false,
        caseCreated: false,
        suppressed: true,
        reason: 'Invoice already paid; overdue timer not scheduled',
      };
    }

    // 2. Load and validate PolicyConfig grace period
    const config = await this.policyConfigRepo.getOrCreateConfig(merchantId);
    const graceDays = config.overdueGracePeriodDays ?? 3;
    if (!Number.isInteger(graceDays) || graceDays < 0) {
      await this.auditRepo.record(merchantId, {
        eventType: 'DETECTION_ERROR',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { graceDays, merchantId },
        reasonCode: 'INVALID_OVERDUE_GRACE_PERIOD_CONFIG',
      });
      return {
        riskDetected: false,
        caseCreated: false,
        reason: 'Invalid overdueGracePeriodDays in policy config; timer scheduling skipped safely',
      };
    }

    // 3. Enforce durable scheduler availability
    if (!this.jobScheduler) {
      await this.auditRepo.record(merchantId, {
        eventType: 'DETECTION_ERROR',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { merchantId, invoiceId },
        reasonCode: 'DURABLE_SCHEDULER_UNAVAILABLE',
      });
      return {
        riskDetected: false,
        caseCreated: false,
        reason: 'Durable job scheduler is required but unavailable; timer not scheduled',
      };
    }

    const dueDate = event.invoice?.dueDate || event.occurredAt;
    const scheduledFor = new Date(dueDate.getTime() + graceDays * 24 * 60 * 60 * 1000);

    // 4. Schedule durable overdue recheck
    let scheduledJobId: string | undefined;
    try {
      const job = await this.jobScheduler.schedule({
        merchantId,
        jobType: 'INVOICE_OVERDUE_CHECK',
        scheduledFor,
        payloadJson: {
          merchantId,
          invoiceId,
          incidentKey,
          amount: event.amount,
          currency: event.currency,
          customer: event.customer,
          invoice: event.invoice,
          dueDate,
          metadata: event.metadata,
        },
      });
      scheduledJobId = job.id;
    } catch (err: unknown) {
      await this.auditRepo.record(merchantId, {
        eventType: 'SCHEDULING_FAILED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { incidentKey, invoiceId, err: String(err) },
        reasonCode: 'INVOICE_OVERDUE_SCHEDULING_FAILED',
      });
      return {
        riskDetected: false,
        caseCreated: false,
        reason: 'Failed to schedule durable invoice overdue check',
      };
    }

    await this.auditRepo.record(merchantId, {
      eventType: 'TIMER_SCHEDULED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: {
        incidentKey,
        invoiceId,
        dueDate,
        graceDays,
        scheduledFor,
        scheduledJobId,
      },
      reasonCode: 'INVOICE_OVERDUE_TIMER_SCHEDULED',
    });

    return {
      riskDetected: false,
      caseCreated: false,
      scheduledJobId,
      reason: `Invoice created; overdue recheck scheduled for ${scheduledFor.toISOString()} (due + ${graceDays}d grace)`,
    };
  }

  /**
   * 6. evaluateInvoiceTimer: Fired by worker / scheduler when due date + grace period elapsed
   */
  async evaluateInvoiceTimer(
    merchantId: string,
    invoiceId: string,
    context?: Record<string, unknown>,
  ): Promise<DetectionResult> {
    const incidentKey = generateIncidentKey(merchantId, RiskType.OVERDUE_RECEIVABLE, invoiceId);

    await this.auditRepo.record(merchantId, {
      eventType: 'TIMER_FIRED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: { incidentKey, invoiceId, timerType: 'INVOICE_OVERDUE_CHECK' },
      reasonCode: 'INVOICE_OVERDUE_TIMER_FIRED',
    });

    // 1. Check if INVOICE_PAID event exists in DB
    const paidEvent = await this.eventRepo.findEventByTypeAndField(
      merchantId,
      NormalizedEventType.INVOICE_PAID,
      ['invoice', 'invoiceId'],
      invoiceId,
    );

    if (paidEvent) {
      await this.auditRepo.record(merchantId, {
        eventType: 'RISK_SUPPRESSED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { incidentKey, invoiceId, reason: 'INVOICE_PAID_OBSERVED' },
        reasonCode: 'INVOICE_PAID_SUPPRESSES_RECEIVABLE_RISK',
      });
      return {
        riskDetected: false,
        caseCreated: false,
        suppressed: true,
        reason: 'Invoice paid before overdue timer; receivable risk suppressed',
      };
    }

    // 2. Case Deduplication
    const existingCase = await this.caseRepo.findActiveCaseByIncidentKey(merchantId, incidentKey);
    if (existingCase) {
      await this.auditRepo.record(merchantId, {
        caseId: existingCase.id,
        eventType: 'DETECTION_SKIPPED_DUPLICATE',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { incidentKey, existingCaseId: existingCase.id },
        reasonCode: 'DUPLICATE_OVERDUE_RECEIVABLE_INCIDENT',
      });
      return {
        riskDetected: true,
        caseCreated: false,
        caseId: existingCase.id,
        case: existingCase,
        riskType: RiskType.OVERDUE_RECEIVABLE,
        deduplicated: true,
        reason: 'Active case already exists for this overdue invoice incident',
      };
    }

    const money = await this.validateRevenueRiskMoney(
      merchantId,
      'INVOICE_OVERDUE_CHECK',
      context?.amount,
      context?.currency,
      { invoiceId },
    );
    if (!money) {
      return { riskDetected: false, caseCreated: false, suppressed: true, reason: 'Overdue invoice lacks authoritative positive amount and ISO currency; risk case suppressed' };
    }

    // 3. Resolve customer if provided
    let customerId: string | undefined = undefined;
    const customerData = context?.customer as Record<string, unknown> | undefined;
    if (customerData && (customerData.externalCustomerId || customerData.email || customerData.phone)) {
      const customer = await this.customerRepo.getOrCreateCustomer(merchantId, {
        externalCustomerId: (customerData.externalCustomerId as string) || undefined,
        email: (customerData.email as string) || undefined,
        phone: (customerData.phone as string) || undefined,
        name: (customerData.name as string) || undefined,
        contactConsent: customerData.contactConsent as boolean | null | undefined,
      });
      customerId = customer.id;
    }

    // 4. Create OVERDUE_RECEIVABLE case with authoritative incidentKey
    const amountAtRisk = money.amount;
    const currency = money.currency;

    const { case: newCase, created } = await this.caseRepo.createCaseIdempotently(merchantId, {
      customerId,
      riskType: RiskType.OVERDUE_RECEIVABLE,
      amountAtRisk,
      currency,
      incidentKey,
      contextJson: {
        incidentKey,
        invoiceId,
        invoice: context?.invoice,
        dueDate: context?.dueDate,
        metadata: context?.metadata,
      },
    });

    if (!created) {
      await this.auditRepo.record(merchantId, {
        caseId: newCase.id,
        eventType: 'DETECTION_SKIPPED_DUPLICATE',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { incidentKey, existingCaseId: newCase.id },
        reasonCode: 'DUPLICATE_OVERDUE_RECEIVABLE_INCIDENT',
      });
      return {
        riskDetected: true,
        caseCreated: false,
        caseId: newCase.id,
        case: newCase,
        riskType: RiskType.OVERDUE_RECEIVABLE,
        deduplicated: true,
        reason: 'Concurrent creation resolved to existing incident case',
      };
    }

    await this.auditRepo.record(merchantId, {
      caseId: newCase.id,
      eventType: 'RISK_DETECTED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: {
        incidentKey,
        riskType: RiskType.OVERDUE_RECEIVABLE,
        invoiceId,
        amount: amountAtRisk,
        currency,
      },
      outputSummaryJson: { caseId: newCase.id, status: CaseStatus.OPEN },
      reasonCode: 'INVOICE_OVERDUE_CONFIRMED',
    });

    return {
      riskDetected: true,
      caseCreated: true,
      caseId: newCase.id,
      case: newCase,
      riskType: RiskType.OVERDUE_RECEIVABLE,
      reason: 'Invoice due date and grace period elapsed without payment; case opened',
    };
  }

  /** Monetary success is persisted for suppression; OutcomeObserver owns recovery credit and terminal state. */
  private async handlePaymentSucceeded(event: NormalizedMerchantEvent): Promise<DetectionResult> {
    await this.auditRepo.record(event.merchantId, {
      eventType: 'PAYMENT_SUCCEEDED_OBSERVED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: { paymentId: event.payment?.paymentId ?? null, amount: event.amount, currency: event.currency },
      reasonCode: 'MONETARY_RECOVERY_DEFERRED_TO_OUTCOME_OBSERVER',
    });
    return { riskDetected: false, caseCreated: false, reason: 'Payment success persisted for suppression; OutcomeObserver owns monetary recovery' };
  }

  /** Checkout completion remains available for timer suppression; OutcomeObserver owns money recovery. */
  private async handleCheckoutCompleted(event: NormalizedMerchantEvent): Promise<DetectionResult> {
    const checkoutSessionId = event.checkout?.checkoutSessionId || event.externalEventId;
    if (!checkoutSessionId) throw new MissingEventIdentityError('CHECKOUT_COMPLETED', 'checkoutSessionId');
    await this.auditRepo.record(event.merchantId, {
      eventType: 'CHECKOUT_COMPLETED_OBSERVED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: { checkoutSessionId, occurredAt: event.occurredAt },
      reasonCode: 'MONETARY_RECOVERY_DEFERRED_TO_OUTCOME_OBSERVER',
    });
    return { riskDetected: false, caseCreated: false, reason: 'Checkout completion persisted for suppression; OutcomeObserver owns monetary recovery' };
  }

  /** Invoice payment remains available for overdue suppression; OutcomeObserver owns money recovery. */
  private async handleInvoicePaid(event: NormalizedMerchantEvent): Promise<DetectionResult> {
    const invoiceId = event.invoice?.invoiceId || event.externalEventId;
    if (!invoiceId) throw new MissingEventIdentityError('INVOICE_PAID', 'invoiceId');
    await this.auditRepo.record(event.merchantId, {
      eventType: 'INVOICE_PAID_OBSERVED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: { invoiceId, amount: event.amount, currency: event.currency },
      reasonCode: 'MONETARY_RECOVERY_DEFERRED_TO_OUTCOME_OBSERVER',
    });
    return { riskDetected: false, caseCreated: false, reason: 'Invoice payment persisted for suppression; OutcomeObserver owns monetary recovery' };
  }
}
