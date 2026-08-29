import type { Split } from './harness.js';

export interface CliOptions { seed: number; split: Split; }

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing required ${flag}`);
  return args[index + 1];
}

export function parseCliOptions(args: string[]): CliOptions {
  const seed = Number(valueAfter(args, '--seed'));
  if (!Number.isSafeInteger(seed)) throw new Error('--seed must be a safe integer');
  const split = valueAfter(args, '--split');
  if (!['dev', 'validation', 'heldout'].includes(split)) throw new Error('Use --split dev|validation|heldout');
  return { seed, split: split as Split };
}
