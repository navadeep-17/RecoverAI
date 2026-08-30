/** Exact decimal helpers for canonical currency values (up to two fractional digits). */
export function decimalToMinorUnits(value: string | null | undefined): bigint {
  const source = value ?? '0';
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(source);
  if (!match) throw new Error(`Expected canonical non-negative money amount, received "${source}"`);
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}

export function minorUnitsToDecimal(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

export function sumMoney(values: Array<string | null | undefined>): string {
  return minorUnitsToDecimal(values.reduce((total, value) => total + decimalToMinorUnits(value), 0n));
}
