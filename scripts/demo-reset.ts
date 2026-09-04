import { prisma } from '../packages/db/src/client.js';
import { resetDemoData } from '../packages/db/src/demo/demo-data.js';

async function main(): Promise<void> {
  try {
    const summary = await resetDemoData();
    console.log('RecoverAI deterministic demo tenant was reset and recreated.');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('Demo reset failed:', error);
  process.exitCode = 1;
});
