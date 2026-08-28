export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export class CurrencyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurrencyMismatchError';
  }
}

export class Money {
  private readonly _paise: bigint;
  private readonly _currency: string;

  private constructor(paise: bigint, currency = 'INR') {
    if (paise < 0n) {
      throw new InvalidMoneyError('Monetary amounts in RecoverAI must be non-negative');
    }
    this._paise = paise;
    this._currency = currency.toUpperCase();
  }

  get currency(): string {
    return this._currency;
  }

  static fromPaise(paise: number | bigint, currency = 'INR'): Money {
    if (typeof paise === 'number') {
      if (!Number.isInteger(paise)) {
        throw new InvalidMoneyError(`Paise must be an integer, received float: ${paise}`);
      }
      if (!Number.isSafeInteger(paise)) {
        throw new InvalidMoneyError(`Paise exceeds safe integer limit: ${paise}`);
      }
      if (paise < 0) {
        throw new InvalidMoneyError(`Paise cannot be negative, received: ${paise}`);
      }
      return new Money(BigInt(paise), currency);
    }
    if (paise < 0n) {
      throw new InvalidMoneyError('Paise cannot be negative');
    }
    return new Money(paise, currency);
  }

  static fromDecimalString(amountStr: string, currency = 'INR'): Money {
    const trimmed = amountStr.trim();
    if (!trimmed) {
      throw new InvalidMoneyError('Monetary amount string cannot be empty');
    }

    const decimalRegex = /^([0-9]+)(?:.([0-9]{1,2}))?$/;
    const match = decimalRegex.exec(trimmed);

    if (!match) {
      throw new InvalidMoneyError(
        `Invalid monetary decimal string: "${trimmed}". Must be non-negative with at most 2 decimal places.`,
      );
    }

    const wholePart = BigInt(match[1]);
    const fractionPart = match[2] || '';
    const paddedFraction = fractionPart.padEnd(2, '0');
    const paisePart = BigInt(paddedFraction);

    const totalPaise = wholePart * 100n + paisePart;
    return new Money(totalPaise, currency);
  }

  toPaise(): bigint {
    return this._paise;
  }

  toPaiseNumber(): number {
    if (this._paise > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new InvalidMoneyError('Paise amount exceeds JavaScript MAX_SAFE_INTEGER');
    }
    return Number(this._paise);
  }

  toDecimalString(): string {
    const whole = this._paise / 100n;
    const fraction = this._paise % 100n;
    return `${whole}.${fraction.toString().padStart(2, '0')}`;
  }

  toFormattedString(): string {
    const dec = this.toDecimalString();
    const symbol = this._currency === 'INR' ? '₹' : `${this._currency} `;
    return `${symbol}${Number(dec).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this._paise + other._paise, this._currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    if (this._paise < other._paise) {
      throw new InvalidMoneyError(
        `Cannot subtract ${other.toDecimalString()} from ${this.toDecimalString()}: negative result not allowed`,
      );
    }
    return new Money(this._paise - other._paise, this._currency);
  }

  equals(other: Money): boolean {
    return this._currency === other._currency && this._paise === other._paise;
  }

  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this._paise > other._paise;
  }

  lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this._paise < other._paise;
  }

  private assertSameCurrency(other: Money): void {
    if (this._currency !== other._currency) {
      throw new CurrencyMismatchError(
        `Cannot operate between currencies ${this._currency} and ${other._currency}`,
      );
    }
  }
}
