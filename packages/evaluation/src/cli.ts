import { mkdirSync, writeFileSync } from 'node:fs';
import { evaluate } from './evaluator.js';
import type { Split } from './harness.js';

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing required ${flag}`);
  return args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const seed = Number(valueAfter(args, '--seed'));
  if (!Number.isSafeInteger(seed)) throw new Error('--seed must be a safe integer');
  const split = valueAfter(args, '--split');
  if (!['dev', 'validation', 'heldout'].includes(split)) throw new Error('Use --split dev|validation|heldout');
  const results = await evaluate(seed, split as Split);
  mkdirSync('results', { recursive: true });
  const summaries = results.map(({ results: _cases, ...summary }) => summary);
  writeFileSync(`results/${split}-summary.json`, JSON.stringify({ benchmarkLabel: 'SYNTHETIC BENCHMARK', seed, split, results: summaries }, null, 2));
  console.log(JSON.stringify(summaries, null, 2));
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
