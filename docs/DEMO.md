# RecoverAI Judge Demo

This guide is designed for a 3–5 minute walkthrough. The goal is to show RecoverAI's decision boundaries and money truth, not just a sequence of screens.

## Prepare

From a clean checkout:

```bash
npm ci
cp .env.example .env
npm run docker:up
npm run demo:setup
```

Start the services in separate terminals:

```bash
npm run dev:api
npm run dev:worker
npm run dev:web
```

Open `http://localhost:5173`. The seeded local identity is `recoverai-demo-admin` under `recoverai-demo-merchant`. No external credentials are needed: the default demo uses mock AI and simulated providers.

If rehearsal changed the demo tenant, restore only that tenant:

```bash
npm run demo:reset
```

## 1. Revenue Radar — 30 seconds

Open **Revenue Radar**.

Show:

- three active cases;
- one case each in `OPEN`, `WAITING`, and `NEEDS_REVIEW`;
- total revenue at risk; and
- verified and agent-attributed recovered amounts at zero.

Say:

> These cases came from payment failure, checkout abandonment, and overdue-receivable events. RecoverAI shows money at risk, but does not fabricate recovered revenue just because it took an action.

## 2. Open Case and Proposal — 40 seconds

Open `recoverai-demo-case-open`.

Show the customer and failed-payment context, the structured diagnosis and versioned proposal, the failed simulated retry, the non-monetary outcome, and the audit history.

Say:

> Risk detection is rule- and event-driven. AI proposes a structured next action, but that proposal is not permission. Deterministic policy and the executor remain authoritative.

## 3. Waiting and Durable Work — 35 seconds

Open `recoverai-demo-case-waiting`.

Show the `WAITING` state, persisted promise to pay, and scheduled follow-up.

Say:

> Waiting is durable state, not an in-memory sleep. The commitment and follow-up live in PostgreSQL, and pg-boss delivers due work so a process restart does not forget the customer promise.

## 4. Human Review — 60 seconds

Open **Human Review**, then select the pending review for `recoverai-demo-case-review`.

Show the exact proposal, `CREATE_OR_SEND_PAYMENT_LINK`, the high-value review reason, consent evidence, and warning context. Add a reviewer note and approve the exact proposal. Then show the refreshed review, case, and action state.

Explain the approved transition:

- the case moves from `NEEDS_REVIEW` to `WAITING` before execution;
- current policy is evaluated again;
- approval authorizes only the persisted proposal; and
- the default local provider remains the simulator.

Say:

> Human approval is narrow authority, not a policy bypass. If circumstances now produce a hard denial, the approved action still will not execute.

Run `npm run demo:reset` after rehearsal if you need to restore the pending review.

## 5. Explain Money Truth — 35 seconds

Return to Revenue Radar or a case detail page.

Say:

> A successful action is not automatically money. A created payment link or payment-method update records progress only. Recovery requires an authoritative Razorpay or simulator monetary event correlated to the case. Each case has one atomic recovery winner, and agent-attributed recovery is always a subset of verified recovery.

The invariant is:

```text
agentAttributedRecovered <= verifiedRecovered
```

## 6. Evaluation — 35 seconds

Open **Evaluation**.

Say:

> This is a frozen synthetic safety benchmark, not merchant revenue and not an uplift study. On the 100-case heldout split, Rules+Policy recovered ₹334,042.89 with 24 independently classified unsafe actions; RecoverAI recovered ₹281,695.00 with 35. Both had zero policy violations. RecoverAI trailed by ₹52,347.89, so the honest result is reproducible safety enforcement with clear room to improve proposal quality.

## 7. Optional Razorpay Test Mode — 30 seconds

First check the sidebar. It says **Razorpay Test Mode · Configured** only when the API has a complete local Test Mode configuration for the signed-in merchant; otherwise it says **Not configured** and the simulator remains available. This status does not perform a live Razorpay connectivity check or verify Dashboard webhook registration or reachability.

Explain the external path without claiming a live payment:

1. Policy approves a payment-link proposal.
2. The Test Mode adapter sends the case amount in exact paise.
3. A successful action exposes **Open Razorpay Test Payment Link** on the case page; link creation remains unresolved and non-monetary.
4. Razorpay signs a webhook over the exact raw payload.
5. RecoverAI verifies, persists, queues, normalizes, and correlates it.
6. Only authoritative correlated monetary evidence can win recovery.

Say:

> Razorpay support is Test Mode only. The local judge path is deterministic and requires no credentials; live money movement is not claimed.

For a human-operated external proof, configure all four local secrets—`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_TEST_MERCHANT_ID`, and `RAZORPAY_WEBHOOK_SECRET`—without committing `.env`. Create or approve a payment-link action, open the displayed Test Mode link, complete a Razorpay test payment, and confirm that the signed webhook is persisted and processed. The proof is complete only when the same case has exactly one authoritative recovery winner and its verified amount is updated; agent attribution additionally requires the winning event to correlate to that RecoverAI action.

## Terminal Acceptance Trace

For a compact, deterministic proof using real PostgreSQL and simulated providers:

```bash
npm run demo
```

The trace covers event ingestion and detection, policy-governed orchestration, authoritative recovery, checkout timers, durable promises, follow-up scheduling, and human-review routing. It does not claim Gemini quality, live Razorpay execution, or direct pg-boss delivery for every scenario.

## Reset Safety

`demo:seed` and `demo:reset` are scoped to the exact demo merchant ID and slug. Reset deletes and recreates only that tenant; it does not truncate tables, drop schemas, or touch unrelated merchants.
