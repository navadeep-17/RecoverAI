import { Money, RecoveryActionType } from '@recoverai/shared';
import {
  IActionProvider,
  ProviderActionInput,
  ProviderActionResult,
  ProviderExecutionOutcome,
} from './provider-contracts.js';

export interface RazorpayPaymentLinkProviderOptions {
  keyId?: string;
  keySecret?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const DEFAULT_RAZORPAY_REQUEST_TIMEOUT_MS = 10_000;

type RazorpayPaymentLinkResponse = {
  id?: string;
  short_url?: string;
  status?: string;
  reference_id?: string;
};

/**
 * Real Razorpay Test Mode adapter for payment-link creation only. A created link
 * is an accepted recovery action, never proof that money was recovered.
 */
export class RazorpayPaymentLinkProvider implements IActionProvider {
  readonly providerName = 'RAZORPAY_TEST_MODE_PAYMENT_LINKS';
  readonly isSimulated = false;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: RazorpayPaymentLinkProviderOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl || 'https://api.razorpay.com';
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RAZORPAY_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError('Razorpay request timeout must be a positive finite duration');
    }
  }

  supports(actionType: RecoveryActionType): boolean {
    return actionType === RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK;
  }

  async execute(input: ProviderActionInput): Promise<ProviderActionResult> {
    if (!this.options.keyId || !this.options.keySecret) {
      return this.failure(input, 'Razorpay Test Mode credentials are unavailable', 'UNSUPPORTED');
    }
    if (!this.supports(input.actionType)) {
      return this.failure(input, 'Razorpay provider does not support this action type', 'UNSUPPORTED');
    }
    if (!input.caseSummary) {
      return this.failure(input, 'Authoritative case amount and currency are required', 'INVALID_REQUEST');
    }

    let amount: number;
    try {
      amount = Money.fromDecimalString(input.caseSummary.amountAtRisk, input.caseSummary.currency).toPaiseNumber();
    } catch {
      return this.failure(input, 'Authoritative amount is invalid for Razorpay paise conversion', 'INVALID_REQUEST');
    }

    const referenceId = this.referenceId(input.actionId);
    const body = {
      amount,
      currency: input.caseSummary.currency.toUpperCase(),
      reference_id: referenceId,
      description: `RecoverAI recovery action ${input.actionId}`,
      customer: this.customer(input),
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: {
        recoverai_merchant_id: input.merchantId,
        recoverai_case_id: input.caseId,
        recoverai_action_id: input.actionId,
      },
    };

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const authorization = Buffer.from(`${this.options.keyId}:${this.options.keySecret}`).toString('base64');
      const response = await this.fetchImpl(`${this.apiBaseUrl}/v1/payment_links`, {
        method: 'POST',
        headers: { authorization: `Basic ${authorization}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await this.parseResponse(response);
      if (!response.ok || !payload.id) {
        return this.failure(input, 'Razorpay payment-link request was not accepted', this.classify(response.status));
      }
      return {
        providerName: this.providerName,
        isSimulated: false,
        outcome: ProviderExecutionOutcome.SUCCESS,
        idempotencyKey: input.idempotencyKey,
        externalActionId: payload.id,
        metadata: {
          paymentLinkId: payload.id,
          paymentLinkUrl: payload.short_url,
          paymentLinkStatus: payload.status,
          referenceId: payload.reference_id || referenceId,
          amountPaise: amount,
          currency: body.currency,
          recoveryConfirmed: false,
        },
      };
    } catch {
      // Both timeout and transport loss have ambiguous provider state. The
      // executor records retryable failure; this invocation never issues a
      // second payment link or claims recovered money.
      return this.failure(
        input,
        timedOut
          ? 'Razorpay payment-link request timed out with ambiguous provider state'
          : 'Razorpay payment-link request could not be confirmed',
        'NETWORK_TIMEOUT',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private customer(input: ProviderActionInput): Record<string, string> | undefined {
    const customer: Record<string, string> = {};
    if (input.customer?.name) customer.name = input.customer.name;
    if (input.customer?.email) customer.email = input.customer.email;
    if (input.customer?.phone) customer.contact = input.customer.phone;
    return Object.keys(customer).length > 0 ? customer : undefined;
  }

  private referenceId(actionId: string): string {
    return `rcv_${actionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 36)}`;
  }

  private async parseResponse(response: Response): Promise<RazorpayPaymentLinkResponse> {
    try {
      return await response.json() as RazorpayPaymentLinkResponse;
    } catch {
      return {};
    }
  }

  private classify(status: number): ProviderActionResult['errorClassification'] {
    if (status === 401 || status === 403) return 'AUTH_ERROR';
    if (status === 429) return 'RATE_LIMIT';
    if (status >= 500) return 'PROVIDER_ERROR';
    return 'INVALID_REQUEST';
  }

  private failure(
    input: ProviderActionInput,
    errorMessage: string,
    errorClassification: ProviderActionResult['errorClassification'],
  ): ProviderActionResult {
    return {
      providerName: this.providerName,
      isSimulated: false,
      outcome: errorClassification === 'NETWORK_TIMEOUT' || errorClassification === 'RATE_LIMIT' || errorClassification === 'PROVIDER_ERROR'
        ? ProviderExecutionOutcome.RETRYABLE_FAILURE
        : ProviderExecutionOutcome.PERMANENT_FAILURE,
      idempotencyKey: input.idempotencyKey,
      errorMessage,
      errorClassification,
    };
  }
}
