/**
 * Safe monetary calculations using integer paise to avoid IEEE-754 floating-point errors.
 */

export class Money {
  private readonly amountInPaise: bigint;
  public readonly currency: string;

  constructor(amountInPaise: bigint | number | string, currency = 'INR') {
    this.currency = currency.toUpperCase();
    if (typeof amountInPaise === 'bigint') {
      this.amountInPaise = amountInPaise;
    } else if (typeof amountInPaise === 'number') {
      if (!Number.isInteger(amountInPaise)) {
        throw new Error(`Monetary amount in paise must be an integer, received: ${amountInPaise}`);
      }
      this.amountInPaise = BigInt(amountInPaise);
    } else if (typeof amountInPaise === 'string') {
      if (!/^-?\d+$/.test(amountInPaise)) {
        throw new Error(`Invalid string representation of paise: ${amountInPaise}`);
      }
      this.amountInPaise = BigInt(amountInPaise);
    } else {
      throw new Error('Unsupported paise amount type');
    }
  }

  /**
   * Create Money from decimal rupees (e.g. "14999.50" or 14999)
   */
  static fromRupees(rupees: number | string, currency = 'INR'): Money {
    if (typeof rupees === 'number') {
      if (isNaN(rupees) || !isFinite(rupees)) {
        throw new Error(`Invalid rupee amount: ${rupees}`);
      }
      const paise = Math.round(rupees * 100);
      return new Money(paise, currency);
    }

    const trimmed = rupees.trim();
    if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
      throw new Error(`Invalid decimal rupee string: ${rupees}`);
    }

    const [integerPart, fractionalPart = ''] = trimmed.split('.');
    const paddedFraction = (fractionalPart + '00').slice(0, 2);
    const sign = integerPart.startsWith('-') ? -1n : 1n;
    const absInteger = BigInt(integerPart.replace('-', ''));
    const totalPaise = sign * (absInteger * 100n + BigInt(paddedFraction));

    return new Money(totalPaise, currency);
  }

  get paise(): bigint {
    return this.amountInPaise;
  }

  get paiseNumber(): number {
    return Number(this.amountInPaise);
  }

  /**
   * Returns exact decimal rupee string (e.g. "14999.00")
   */
  toDecimalString(): string {
    const isNegative = this.amountInPaise < 0n;
    const absPaise = isNegative ? -this.amountInPaise : this.amountInPaise;
    const rupees = absPaise / 100n;
    const remainder = absPaise % 100n;
    const formattedFraction = remainder.toString().padStart(2, '0');
    return `${isNegative ? '-' : ''}${rupees.toString()}.${formattedFraction}`;
  }

  /**
   * Formats for display (e.g. ₹14,999.00)
   */
  toFormattedString(): string {
    const dec = parseFloat(this.toDecimalString());
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: this.currency,
      minimumFractionDigits: 2,
    }).format(dec);
  }

  add(other: Money): Money {
    this.assertMatchingCurrency(other);
    return new Money(this.amountInPaise + other.amountInPaise, this.currency);
  }

  subtract(other: Money): Money {
    this.assertMatchingCurrency(other);
    return new Money(this.amountInPaise - other.amountInPaise, this.currency);
  }

  isGreaterThan(other: Money): boolean {
    this.assertMatchingCurrency(other);
    return this.amountInPaise > other.amountInPaise;
  }

  isLessThan(other: Money): boolean {
    this.assertMatchingCurrency(other);
    return this.amountInPaise < other.amountInPaise;
  }

  isZero(): boolean {
    return this.amountInPaise === 0n;
  }

  isPositive(): boolean {
    return this.amountInPaise > 0n;
  }

  private assertMatchingCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}
