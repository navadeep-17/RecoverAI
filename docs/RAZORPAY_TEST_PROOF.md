# Razorpay Test Mode External Proof Runbook

This runbook guides human operators through executing and verifying a real end-to-end Razorpay Test Mode payment recovery proof in RecoverAI.

> [!IMPORTANT]
> **Razorpay TEST MODE ONLY**: All interactions use Razorpay Test Mode keys (`rzp_test_...`). No live money movement has been tested, and no live credentials may ever be configured or committed.

> [!CAUTION]
> **Never commit `.env` or credentials**: Do not stage, commit, or push `.env` files, API keys, or webhook secrets. The repository CI must remain 100% credential-free.

> [!CAUTION]
> **Razorpay Test Mode 30-Link Limit**: Razorpay's official Payment Links documentation states that Test Mode allows up to 30 Payment Links per business. Avoid repeatedly approving and resetting the proof unnecessarily. Resetting RecoverAI local database records does not delete or cancel external Razorpay Test Payment Links in your Razorpay Dashboard. Operators should preserve a completed, successful proof rather than recreating links repeatedly.

---

## Why a Fresh Proof Fixture is Required

The deterministic demo review case (`recoverai-demo-case-review`) was created with a fixed timestamp in January 2026. RecoverAI's safety policy enforces `maxRecoveryWindowDays` (default 30 days). Under `ExpiredRecoveryWindowRule`, attempting to act on a January case today is safely and correctly **DENIED** by policy. Human review approval bypasses only the review gate; it does not and must not bypass hard safety policies like recovery expiration or quiet hours.

Therefore, RecoverAI provides dedicated tooling to seed a fresh external proof fixture (`recoverai-razorpay-proof-case`) with current timestamps, allowing natural policy evaluation without mutating frozen deterministic demo data or altering safety policies.

---

## End-to-End Operational Procedure

1. **Verify Environment Baseline**
   Ensure dependencies are installed and PostgreSQL is running.

2. **Run Normal Demo / Database Setup**
   ```bash
   npm run demo:setup
   ```
   This generates Prisma client, deploys migrations, and seeds the canonical `recoverai-demo-merchant` tenant.

3. **Create the Fresh Proof Fixture**
   ```bash
   npm run razorpay:proof:setup
   ```
   This creates:
   - Case: `recoverai-razorpay-proof-case` (Risk: `SUBSCRIPTION_FAILURE`, Amount: INR 65,000.00, Status: `NEEDS_REVIEW`)
   - Customer: `recoverai-razorpay-proof-customer` (`Aarav Sen`, explicit consent, optedOut = false)
   - Plan: `recoverai-razorpay-proof-plan` (proposing `CREATE_OR_SEND_PAYMENT_LINK`)
   - Review: `recoverai-razorpay-proof-review` (Status: `PENDING`, high-value approval gate)
   - Audit: `recoverai-razorpay-proof-audit-review` (`HUMAN_REVIEW_REQUESTED`)

4. **Configure Local Razorpay Test Mode Environment Values**
   In `.env` (never commit this file), set:
   ```dotenv
   RAZORPAY_KEY_ID="rzp_test_YOUR_KEY_ID"
   RAZORPAY_KEY_SECRET="YOUR_KEY_SECRET"
   RAZORPAY_WEBHOOK_SECRET="YOUR_WEBHOOK_SECRET"
   RAZORPAY_TEST_MERCHANT_ID="recoverai-demo-merchant"
   ```

5. **Expose `/webhooks/razorpay` via Public HTTPS**
   Razorpay cannot deliver webhooks to `localhost`; the webhook endpoint must be a publicly accessible HTTPS URL on public ports 80 or 443. Furthermore, Razorpay's official webhook documentation notes that many common tunneling and testing domains are blacklisted.

   Expose the RecoverAI API's configured port (default `3000`; if the operator changed `PORT` in the environment, expose that configured port instead) using either:
   - **Option A (Local development)**: Expose the RecoverAI API's configured port (default 3000) using `zrok` as recommended by Razorpay's current webhook-testing documentation (see [Razorpay Webhook Testing Guide](https://razorpay.com/docs/webhooks/testing-webhooks/)).
   - **Option B (Staging endpoint)**: Use an existing public HTTPS staging endpoint accepted by Razorpay that proxies to the API.

   Note the public HTTPS forwarding URL (e.g., `https://<public-subdomain>.<tunnel-domain>`). The canonical RecoverAI webhook path is `/webhooks/razorpay` (do not change this application route).

6. **Configure Webhook in Razorpay Dashboard**
   - Log into the Razorpay Dashboard in **Test Mode**.
   - Navigate to **Accounts & Settings** → **Webhooks** (under **Website and app settings**) → **Add New Webhook** (see [Razorpay Webhook Setup Guide](https://razorpay.com/docs/webhooks/setup-webhooks/)).
   - **Webhook URL**: `https://<public-endpoint>/webhooks/razorpay` (must be public HTTPS on port 80 or 443; `localhost` itself cannot be registered).
   - **Secret**: The exact string matching `RAZORPAY_WEBHOOK_SECRET` in `.env`.
   - **Active Events**: Select `payment_link.paid` (and optionally `payment.captured`).

7. **Start RecoverAI Services**
   In separate terminals, start:
   ```bash
   npm run dev:api
   npm run dev:worker
   npm run dev:web
   ```

8. **Confirm Sidebar Integration Status**
   Open the web UI at `http://localhost:5173`. Check the lower-left sidebar:
   - It should display: **Razorpay Test Mode · Configured**
   - Note that *Configured* represents local configuration readiness only, not external verification.

9. **Open Human Review Page**
   Navigate to `/reviews` in the operations UI.

10. **Locate and Inspect the Proof Review**
    Find `recoverai-razorpay-proof-review` for case `recoverai-razorpay-proof-case`.
    - Risk: `SUBSCRIPTION_FAILURE`
    - Amount: ₹65,000.00 (exceeds the ₹50,000.00 high-value threshold)
    - Action: `CREATE_OR_SEND_PAYMENT_LINK`

11. **Approve the Review Proposal**
    Click **Approve**.
    - `HumanReviewService` checks that the proposal is fresh.
    - `PolicyEngine` re-evaluates rules (all pass; `CaseNeedsReviewRule` is bypassed for explicit human approval).
    - `ActionExecutor` invokes `RazorpayPaymentLinkProvider`.
    - The provider calls Razorpay Test Mode API and receives a real `plink_...` ID and short URL (`https://rzp.io/i/...`).
    - The case transitions to `WAITING`.

12. **Open the Test Payment Link on Case Detail Page**
    Navigate to `/cases/recoverai-razorpay-proof-case`.
    - Under the executed recovery action, verify provider is `RAZORPAY_TEST_MODE_PAYMENT_LINKS`.
    - Click **Open Razorpay Test Payment Link**.

13. **Complete the Razorpay Test Payment**
    - On the Razorpay checkout page, select any Test Mode payment method (e.g., Netbanking / Success, or test card).
    - Complete the test payment successfully.

14. **Observe Webhook Ingestion and Worker Processing**
    - Razorpay dispatches the signed `payment_link.paid` webhook to your public HTTPS endpoint.
    - RecoverAI verifies the raw HMAC signature using `RAZORPAY_WEBHOOK_SECRET`.
    - `WebhookEvent` receipt is recorded with event-based provider identity (`event:<x-razorpay-event-id>`).
    - pg-boss hands the event to the worker subscriber.
    - The worker correlates the payment link ID (`plink_...`) with the `RecoveryAction`.
    - `OutcomeObserver` validates monetary truth and transitions the case to `RECOVERED` with ₹65,000.00 verified recovered.

15. **Run the Read-Only Proof Verifier**
    Once the case is `RECOVERED`, run:
    ```bash
    npm run razorpay:proof:verify
    ```
    Expected output:
    ```text
    RAZORPAY TEST MODE EXTERNAL PROOF
    RESULT: PASS
    merchant: recoverai-demo-merchant
    case: recoverai-razorpay-proof-case
    risk: SUBSCRIPTION_FAILURE
    amountAtRisk: INR 65000.00
    actionProvider: RAZORPAY_TEST_MODE_PAYMENT_LINKS
    paymentLinkId: plink_...
    webhookVerified: true
    webhookProcessed: true
    caseStatus: RECOVERED
    verifiedRecovered: INR 65000.00
    monetaryWinners: 1
    ```

16. **Preserve Evidence**
    Capture screenshots or recordings of:
    - Sidebar status (`Razorpay Test Mode · Configured`)
    - Approved review in `/reviews`
    - Case detail page with external action and checkout link
    - Completed payment screen
    - Verifier terminal output

17. **Clean Up / Reset Local Fixture**
    When external proof demonstration is complete:
    ```bash
    npm run razorpay:proof:reset
    ```
    *Note: Resetting local proof records does not delete or cancel links in the Razorpay Dashboard. Because Razorpay Test Mode allows a limit of up to 30 Payment Links per business, avoid repeatedly creating links and preserve completed proof runs.*

