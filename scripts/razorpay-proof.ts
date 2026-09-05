import { prisma } from '../packages/db/src/client.js';
import {
  RAZORPAY_PROOF_IDS,
  resetRazorpayProofFixture,
  seedRazorpayProofFixture,
  verifyRazorpayProof,
} from '../packages/db/src/demo/razorpay-proof-data.js';
import { checkQuietHours } from '../packages/policy/src/quiet-hours.js';

async function handleSetup(): Promise<void> {
  const now = new Date();
  const summary = await seedRazorpayProofFixture(prisma, now);

  console.log('RecoverAI Razorpay Test Mode Proof Fixture Created');
  console.log(`Merchant:     ${summary.merchantId}`);
  console.log(`Customer:     ${summary.customerId}`);
  console.log(`Case:         ${summary.caseId}`);
  console.log(`Plan:         ${summary.planVersionId}`);
  console.log(`Review:       ${summary.reviewId}`);
  console.log(`Risk Type:    ${summary.riskType}`);
  console.log(`Amount:       ${summary.currency} ${summary.amountAtRisk}`);
  console.log(`Status:       ${summary.status}`);
  console.log(`Opened At:    ${summary.openedAt}`);

  // Quiet hours preflight check
  try {
    const policyConfig = await prisma.policyConfig.findUnique({
      where: { merchantId: RAZORPAY_PROOF_IDS.merchant },
    });
    if (policyConfig) {
      const quietCheck = checkQuietHours({
        currentTime: now,
        timezone: policyConfig.quietHoursTimezone,
        startHour: policyConfig.quietHoursStart,
        endHour: policyConfig.quietHoursEnd,
      });
      if (quietCheck.inQuietHours) {
        console.warn(
          `\n[PREFLIGHT WARNING] Current merchant time (${quietCheck.localHour}:00 in ${quietCheck.timezone}) ` +
            `is within configured quiet hours (${quietCheck.startHour}:00 to ${quietCheck.endHour}:00). ` +
            `Review approval of customer-facing payment links will be denied by policy until quiet hours end.`,
        );
      }
    }
  } catch {
    // Non-fatal preflight check
  }

  console.log('\nNext steps:');
  console.log('1. Configure local Razorpay Test Mode credentials in .env (do not commit .env).');
  console.log('2. Expose /webhooks/razorpay and configure webhook in Razorpay Dashboard.');
  console.log('3. Start API, worker, and web apps.');
  console.log('4. Open Human Review in web UI and approve the fresh proof proposal.');
  console.log('5. Complete the test payment on the displayed Razorpay checkout page.');
  console.log('6. Run "npm run razorpay:proof:verify" to confirm authoritative recovery.');
}

async function handleReset(): Promise<void> {
  const summary = await resetRazorpayProofFixture(prisma);
  console.log('RecoverAI Razorpay Test Mode Proof Fixture Reset');
  console.log(`Merchant: ${summary.merchantId}`);
  console.log('Deleted records:');
  console.log(`- Human reviews:  ${summary.deletedCounts.reviews}`);
  console.log(`- Plan versions:  ${summary.deletedCounts.planVersions}`);
  console.log(`- Actions:        ${summary.deletedCounts.actions}`);
  console.log(`- Outcomes:       ${summary.deletedCounts.outcomes}`);
  console.log(`- Audits:         ${summary.deletedCounts.audits}`);
  console.log(`- Cases:          ${summary.deletedCounts.cases}`);
  console.log(`- Customers:      ${summary.deletedCounts.customers}`);
  console.log(
    '\nNOTICE: Deleting local proof data does NOT cancel or delete an already-created external ' +
      'Razorpay Test Payment Link in your Razorpay Dashboard.',
  );
}

async function handleVerify(): Promise<void> {
  const result = await verifyRazorpayProof(prisma);

  if (result.pass) {
    console.log('RAZORPAY TEST MODE EXTERNAL PROOF');
    console.log('RESULT: PASS');
    console.log(`merchant: ${result.merchantId}`);
    console.log(`case: ${result.caseId}`);
    console.log(`risk: ${result.riskType}`);
    console.log(`amountAtRisk: ${result.amountAtRisk}`);
    console.log(`actionProvider: ${result.actionProvider}`);
    console.log(`paymentLinkId: ${result.paymentLinkId}`);
    console.log(`webhookVerified: ${result.webhookVerified}`);
    console.log(`webhookProcessed: ${result.webhookProcessed}`);
    console.log(`caseStatus: ${result.caseStatus}`);
    console.log(`verifiedRecovered: ${result.verifiedRecovered}`);
    console.log(`monetaryWinners: ${result.monetaryWinners}`);
  } else {
    console.error('RAZORPAY TEST MODE EXTERNAL PROOF');
    console.error('RESULT: INCOMPLETE');
    console.error(`merchant: ${result.merchantId}`);
    console.error(`case: ${result.caseId}`);
    if (result.caseStatus) console.error(`caseStatus: ${result.caseStatus}`);
    if (result.missingCondition) console.error(`Missing condition: ${result.missingCondition}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];

  try {
    switch (command) {
      case 'setup':
        await handleSetup();
        break;
      case 'reset':
        await handleReset();
        break;
      case 'verify':
        await handleVerify();
        break;
      default:
        console.error('Usage: npm run razorpay:proof:[setup|reset|verify]');
        process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('Razorpay proof command failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

