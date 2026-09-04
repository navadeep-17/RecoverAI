import { prisma } from '../packages/db/src/client.js';
import { seedDemoData } from '../packages/db/src/demo/demo-data.js';

async function main(): Promise<void> {
  try {
    const summary = await seedDemoData();
    console.log('RecoverAI deterministic demo seed is ready.');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('Demo seed failed:', error);
  process.exitCode = 1;
});
