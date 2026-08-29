import { Money } from '@recoverai/shared';

export enum CustomerReplyIntent {
  PAYMENT_METHOD_WILL_UPDATE = 'PAYMENT_METHOD_WILL_UPDATE',
  NEED_MORE_TIME = 'NEED_MORE_TIME',
  PROMISE_TO_PAY = 'PROMISE_TO_PAY',
  REFUSES_PAYMENT = 'REFUSES_PAYMENT',
  OPT_OUT = 'OPT_OUT',
  UNKNOWN = 'UNKNOWN',
}

export interface ClassifiedCustomerReply {
  intent: CustomerReplyIntent;
  confidence: number;
  extractedPromisedDate?: Date | null;
  extractedPromisedAmount?: string | null;
  rawText: string;
}

export class CustomerReplyClassifier {
  /**
   * Classifies inbound customer communication into bounded structured concepts.
   * Deterministic safety state remains authoritative.
   * Never fabricates dates or uses floating-point financial parsing.
   */
  classify(text: string, referenceTime: Date = new Date()): ClassifiedCustomerReply {
    const raw = text.trim();
    const lower = raw.toLowerCase();

    // 1. Opt-out check (highest precedence)
    if (
      lower.includes('stop') ||
      lower.includes('unsubscribe') ||
      lower.includes('opt out') ||
      lower.includes('optout') ||
      lower.includes('do not contact') ||
      lower.includes("don't message") ||
      lower.includes('cancel subscription') ||
      lower.includes('leave me alone')
    ) {
      return {
        intent: CustomerReplyIntent.OPT_OUT,
        confidence: 0.98,
        rawText: raw,
      };
    }

    // 2. Refusal to pay
    if (
      lower.includes("won't pay") ||
      lower.includes('refuse to pay') ||
      lower.includes('not paying') ||
      lower.includes('fraudulent') ||
      lower.includes('scam') ||
      lower.includes('dispute') ||
      lower.includes('chargeback')
    ) {
      return {
        intent: CustomerReplyIntent.REFUSES_PAYMENT,
        confidence: 0.95,
        rawText: raw,
      };
    }

    // 3. Payment method update indication
    if (
      lower.includes('card expired') ||
      lower.includes('new card') ||
      lower.includes('updated my card') ||
      lower.includes('update card') ||
      lower.includes('updated payment') ||
      lower.includes('will update payment') ||
      lower.includes('change card') ||
      lower.includes('card details updated')
    ) {
      return {
        intent: CustomerReplyIntent.PAYMENT_METHOD_WILL_UPDATE,
        confidence: 0.92,
        rawText: raw,
      };
    }

    // 4. Promise to pay
    const promiseKeywords = [
      'will pay',
      'promise to pay',
      'pay on',
      'pay by',
      'transfer by',
      'settle by',
      'send money on',
      'pay you on',
      'pay this friday',
      'promise',
    ];

    const isPromise = promiseKeywords.some((kw) => lower.includes(kw));

    if (isPromise) {
      const extractedPromisedDate = this.extractDate(lower, referenceTime);
      const extractedPromisedAmount = this.extractAmount(lower);

      return {
        intent: CustomerReplyIntent.PROMISE_TO_PAY,
        confidence: 0.90,
        extractedPromisedDate: extractedPromisedDate ?? null,
        extractedPromisedAmount: extractedPromisedAmount ?? null,
        rawText: raw,
      };
    }

    // 5. Need more time / extension
    if (
      lower.includes('more time') ||
      lower.includes('few more days') ||
      lower.includes('extension') ||
      lower.includes('delay') ||
      lower.includes('next week') ||
      lower.includes('can i get some time')
    ) {
      return {
        intent: CustomerReplyIntent.NEED_MORE_TIME,
        confidence: 0.85,
        rawText: raw,
      };
    }

    return {
      intent: CustomerReplyIntent.UNKNOWN,
      confidence: 0.50,
      rawText: raw,
    };
  }

  private extractDate(lower: string, ref: Date): Date | null {
    const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    
    for (let i = 0; i < daysOfWeek.length; i++) {
      if (lower.includes(daysOfWeek[i])) {
        const targetDay = i;
        const currentDay = ref.getDay();
        let daysAhead = targetDay - currentDay;
        if (daysAhead <= 0) {
          daysAhead += 7;
        }
        const targetDate = new Date(ref.getTime() + daysAhead * 24 * 60 * 60 * 1000);
        targetDate.setHours(17, 0, 0, 0); // 5:00 PM on target day
        return targetDate;
      }
    }

    if (lower.includes('tomorrow')) {
      const tomorrow = new Date(ref.getTime() + 24 * 60 * 60 * 1000);
      tomorrow.setHours(17, 0, 0, 0);
      return tomorrow;
    }

    // Check for ISO-like dates e.g. 2026-09-01
    const isoMatch = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (isoMatch && isoMatch[1]) {
      const d = new Date(isoMatch[1]);
      if (!isNaN(d.getTime())) {
        return d;
      }
    }

    // Never fabricate dates: return null if customer did not specify a date
    return null;
  }

  private extractAmount(lower: string): string | undefined {
    // Look for currency prefix followed by monetary digits: ₹85,000, Rs. 85000, 85000, 1500.00
    const match = lower.match(/(?:₹|rs\.?|inr)\s*([0-9]+(?:,[0-9]+)*(?:\.[0-9]{1,2})?)/);
    if (match && match[1]) {
      const cleaned = match[1].replace(/,/g, '');
      if (Money.isValidDecimalString(cleaned)) {
        return Money.fromDecimalString(cleaned).toDecimalString();
      }
    }

    // Also match verbs like "pay 85000" or "settle 85000"
    const contextMatch = lower.match(/(?:pay|transfer|settle|send)\s+([0-9]+(?:,[0-9]+)*(?:\.[0-9]{1,2})?)/);
    if (contextMatch && contextMatch[1]) {
      const cleaned = contextMatch[1].replace(/,/g, '');
      if (Money.isValidDecimalString(cleaned)) {
        return Money.fromDecimalString(cleaned).toDecimalString();
      }
    }

    return undefined;
  }
}
