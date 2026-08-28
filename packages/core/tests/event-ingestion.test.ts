import { describe, it, expect } from 'vitest';
import {
  MerchantEventSource,
  NormalizedEventType,
  NormalizedMerchantEventSchema,
} from '@recoverai/shared';
import {
  RazorpayEventNormalizer,
  MerchantEventNormalizer,
  SimulatorEventNormalizer,
  TimerEventNormalizer,
} from '@recoverai/integrations';

describe('Event Normalizers & Schema Validation', () => {
  const merchantId = 'mch_test_norm_01';

  describe('1. RazorpayEventNormalizer', () => {
    it('normalizes Razorpay payment.failed payload with paise conversion and failure codes', () => {
      const rawPayload = {
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_rzp_fail_101',
              amount: 1499900, // 14999.00 INR (in paise)
              currency: 'INR',
              status: 'failed',
              order_id: 'order_rzp_001',
              method: 'card',
              email: 'customer@example.com',
              contact: '+919876543210',
              customer_id: 'cust_rzp_99',
              error_code: 'BAD_REQUEST_ERROR',
              error_reason: 'card_declined',
              error_description: 'Card balance insufficient',
              card: {
                network: 'Visa',
                last4: '1111',
                name: 'Test Customer',
              },
              created_at: 1724832000,
            },
          },
        },
      };

      const normalized = RazorpayEventNormalizer.normalize(merchantId, rawPayload, 'evt_rzp_01');

      expect(normalized.merchantId).toBe(merchantId);
      expect(normalized.source).toBe(MerchantEventSource.RAZORPAY);
      expect(normalized.eventType).toBe(NormalizedEventType.PAYMENT_FAILED);
      expect(normalized.amount).toBe('14999.00');
      expect(normalized.currency).toBe('INR');
      expect(normalized.payment?.paymentId).toBe('pay_rzp_fail_101');
      expect(normalized.payment?.verifiedFailureCode).toBe('BAD_REQUEST_ERROR');
      expect(normalized.payment?.gatewayErrorMessage).toBe('Card balance insufficient');
      expect(normalized.payment?.cardNetwork).toBe('Visa');
      expect(normalized.payment?.cardLast4).toBe('1111');
      expect(normalized.customer?.email).toBe('customer@example.com');
      expect(normalized.customer?.phone).toBe('+919876543210');
      expect(normalized.customer?.contactConsent).toBeNull();
    });

    it('normalizes Razorpay subscription.pending as SUBSCRIPTION_RENEWAL_FAILED', () => {
      const rawPayload = {
        event: 'subscription.pending',
        payload: {
          subscription: {
            entity: {
              id: 'sub_rzp_777',
              customer_id: 'cust_sub_01',
              status: 'pending',
            },
          },
          payment: {
            entity: {
              id: 'pay_sub_fail_1',
              amount: 299900,
              currency: 'INR',
              error_code: 'CARD_EXPIRED',
              error_description: 'Card expired',
            },
          },
        },
      };

      const normalized = RazorpayEventNormalizer.normalize(merchantId, rawPayload, 'evt_sub_01');

      expect(normalized.eventType).toBe(NormalizedEventType.SUBSCRIPTION_RENEWAL_FAILED);
      expect(normalized.amount).toBe('2999.00');
      expect(normalized.payment?.subscriptionId).toBe('sub_rzp_777');
      expect(normalized.payment?.verifiedFailureCode).toBe('CARD_EXPIRED');
    });

    it('normalizes payment.captured as PAYMENT_SUCCEEDED', () => {
      const rawPayload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_rzp_succ_01',
              amount: 500000,
              currency: 'INR',
              status: 'captured',
            },
          },
        },
      };

      const normalized = RazorpayEventNormalizer.normalize(merchantId, rawPayload, 'evt_succ_01');
      expect(normalized.eventType).toBe(NormalizedEventType.PAYMENT_SUCCEEDED);
      expect(normalized.amount).toBe('5000.00');
    });
    it('throws UnsupportedProviderEventError on unrecognized Razorpay events', () => {
      const unsupportedEvents = [
        'refund.processed',
        'payment.refunded',
        'subscription.cancelled',
        'dispute.created',
        'order.paid',
        'random.unsupported.event',
      ];

      for (const evtName of unsupportedEvents) {
        const rawPayload = {
          event: evtName,
          payload: {
            payment: {
              entity: {
                id: 'pay_unsupported_01',
                amount: 100000,
                currency: 'INR',
              },
            },
          },
        };

        expect(() => RazorpayEventNormalizer.normalize(merchantId, rawPayload, 'ext_evt_01')).toThrow(
          /Unsupported Razorpay event/,
        );
      }
    });

    it('rejects invalid or non-integer paise amounts with InvalidProviderAmountError', () => {
      const invalidAmounts = ['100abc', '100.5', -1, NaN, Infinity, -100, 100.25, 'invalid'];

      for (const badAmount of invalidAmounts) {
        const rawPayload = {
          event: 'payment.failed',
          payload: {
            payment: {
              entity: {
                id: 'pay_bad_amount',
                amount: badAmount,
                currency: 'INR',
              },
            },
          },
        };

        expect(() => RazorpayEventNormalizer.normalize(merchantId, rawPayload, 'ext_evt_02')).toThrow(
          /Invalid provider amount/,
        );
      }
    });

    it('generates deterministic dedupeKey without random or timestamp noise', () => {
      const rawPayloadWithId = {
        id: 'evt_rzp_deterministic_1',
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_det_001',
              amount: 100000,
              currency: 'INR',
            },
          },
        },
      };

      const norm1 = RazorpayEventNormalizer.normalize(merchantId, rawPayloadWithId);
      const norm2 = RazorpayEventNormalizer.normalize(merchantId, rawPayloadWithId);
      expect(norm1.dedupeKey).toBe('razorpay:mch_test_norm_01:event:evt_rzp_deterministic_1');
      expect(norm1.dedupeKey).toBe(norm2.dedupeKey);

      // Without explicit event id: falls back to entity id + event name
      const rawPayloadWithoutEventId = {
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_entity_only_999',
              amount: 200000,
              currency: 'INR',
            },
          },
        },
      };

      const normFallback1 = RazorpayEventNormalizer.normalize(merchantId, rawPayloadWithoutEventId);
      const normFallback2 = RazorpayEventNormalizer.normalize(merchantId, rawPayloadWithoutEventId);
      expect(normFallback1.dedupeKey).toBe('razorpay:mch_test_norm_01:payment:pay_entity_only_999:payment.failed');
      expect(normFallback1.dedupeKey).toBe(normFallback2.dedupeKey);
    });

    it('extracts subscriptionId strictly from subscription entity or invoice.subscription_id and never from invoice_id', () => {
      const rawInvoicePayload = {
        event: 'subscription.charged',
        payload: {
          invoice: {
            entity: {
              id: 'inv_rzp_999',
              subscription_id: 'sub_real_authoritative_123',
              amount: 500000,
              currency: 'INR',
            },
          },
          payment: {
            entity: {
              id: 'pay_inv_charge_1',
              amount: 500000,
              currency: 'INR',
            },
          },
        },
      };

      const normalized = RazorpayEventNormalizer.normalize(merchantId, rawInvoicePayload, 'ext_inv_charge');
      expect(normalized.payment?.subscriptionId).toBe('sub_real_authoritative_123');
      expect(normalized.invoice?.invoiceId).toBe('inv_rzp_999');
      // Proves invoice id is not used as subscription id
      expect(normalized.payment?.subscriptionId).not.toBe('inv_rzp_999');
    });
  });

  describe('2. MerchantEventNormalizer & SimulatorEventNormalizer', () => {
    it('normalizes checkout.started event with exact monetary format', () => {
      const normalized = MerchantEventNormalizer.normalize({
        merchantId,
        eventType: NormalizedEventType.CHECKOUT_STARTED,
        amount: '8499.00',
        currency: 'INR',
        checkout: {
          checkoutSessionId: 'sess_chk_123',
          cartItemsSummary: 'Pro Plan Annual',
        },
        customer: {
          email: 'buyer@example.com',
          contactConsent: null,
        },
      });

      expect(normalized.source).toBe(MerchantEventSource.MERCHANT);
      expect(normalized.eventType).toBe(NormalizedEventType.CHECKOUT_STARTED);
      expect(normalized.amount).toBe('8499.00');
      expect(normalized.checkout?.checkoutSessionId).toBe('sess_chk_123');
    });

    it('enforces required fact validation on merchant events', () => {
      // CHECKOUT_STARTED missing checkoutSessionId
      expect(() =>
        MerchantEventNormalizer.normalize({
          merchantId,
          eventType: NormalizedEventType.CHECKOUT_STARTED,
          amount: '1000.00',
          currency: 'INR',
        }),
      ).toThrow(/is missing required authoritative identity field/);

      // INVOICE_CREATED missing invoiceId
      expect(() =>
        MerchantEventNormalizer.normalize({
          merchantId,
          eventType: NormalizedEventType.INVOICE_CREATED,
          amount: '1000.00',
          currency: 'INR',
        }),
      ).toThrow(/is missing required authoritative identity field/);
    });

    it('normalizes invoice.created event', () => {
      const dueDate = new Date('2026-09-15T00:00:00Z');
      const normalized = MerchantEventNormalizer.normalize({
        merchantId,
        eventType: NormalizedEventType.INVOICE_CREATED,
        amount: '45000.00',
        currency: 'INR',
        invoice: {
          invoiceId: 'inv_mch_888',
          invoiceNumber: 'INV-2026-0888',
          dueDate,
          paid: false,
        },
      });

      expect(normalized.eventType).toBe(NormalizedEventType.INVOICE_CREATED);
      expect(normalized.amount).toBe('45000.00');
      expect(normalized.invoice?.invoiceId).toBe('inv_mch_888');
      expect(normalized.invoice?.paid).toBe(false);
    });

    it('normalizes simulated events with SIMULATOR source', () => {
      const normalized = SimulatorEventNormalizer.normalize({
        merchantId,
        eventType: NormalizedEventType.PAYMENT_FAILED,
        amount: '1200.00',
        currency: 'INR',
        payment: {
          paymentId: 'sim_pay_01',
          verifiedFailureCode: 'DO_NOT_HONOR',
        },
      });

      expect(normalized.source).toBe(MerchantEventSource.SIMULATOR);
      expect(normalized.amount).toBe('1200.00');
    });
  });

  describe('3. TimerEventNormalizer', () => {
    it('normalizes timer fired events with TIMER source', () => {
      const now = new Date();
      const normalized = TimerEventNormalizer.normalize({
        merchantId,
        timerType: 'CHECKOUT_ABANDONMENT_TIMER',
        timerId: 'timer_job_999',
        firedAt: now,
        referenceId: 'sess_chk_123',
      });

      expect(normalized.source).toBe(MerchantEventSource.TIMER);
      expect(normalized.eventType).toBe(NormalizedEventType.RECOVERY_TIMER_FIRED);
      expect(normalized.externalEventId).toBe('timer_job_999');
    });
  });

  describe('4. Strict NormalizedMerchantEventSchema Validation', () => {
    it('rejects invalid or malformed monetary strings (>2 decimal places)', () => {
      const invalidEvent = {
        merchantId: 'mch_01',
        source: MerchantEventSource.MERCHANT,
        eventType: NormalizedEventType.PAYMENT_FAILED,
        occurredAt: new Date(),
        dedupeKey: 'dedupe_1',
        amount: '100.555', // Invalid 3 decimal places
      };

      expect(() => NormalizedMerchantEventSchema.parse(invalidEvent)).toThrow();
    });

    it('rejects negative monetary amounts', () => {
      const invalidEvent = {
        merchantId: 'mch_01',
        source: MerchantEventSource.MERCHANT,
        eventType: NormalizedEventType.PAYMENT_FAILED,
        occurredAt: new Date(),
        dedupeKey: 'dedupe_1',
        amount: '-50.00', // Invalid negative amount
      };

      expect(() => NormalizedMerchantEventSchema.parse(invalidEvent)).toThrow();
    });
  });
});
