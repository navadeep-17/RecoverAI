import { mkdirSync, writeFileSync } from 'node:fs';
import { parseCliOptions } from './cli-options.js';
import { evaluate } from './evaluator.js';

async function main(): Promise<void> {
  const { seed, split } = parseCliOptions(process.argv.slice(2));
  const results = await evaluate(seed, split);
  mkdirSync('results', { recursive: true });
  const summaries = results.map(({ results: _cases, ...summary }) => summary);
  writeFileSync(`results/${split}-summary.json`, JSON.stringify({ benchmarkLabel: 'SYNTHETIC BENCHMARK', seed, split, results: summaries }, null, 2));
  console.log(JSON.stringify(summaries, null, 2));
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
