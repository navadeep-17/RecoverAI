# RecoverAI — Buildathon Submission

## Project

**RecoverAI** is a policy-governed, closed-loop revenue recovery agent for merchants.

> AI proposes. Policy decides. Executor acts. Observer verifies.

Repository: <https://github.com/navadeep-17/RecoverAI>

Deployment URL: not provided. The project is packaged for deterministic local execution.

## Problem

Failed payments, subscription renewals, abandoned checkouts, and overdue receivables are often handled by disconnected retry jobs and manual workflows. That fragmentation makes recovery inconsistent, difficult to audit, and prone to unsafe customer contact or false revenue attribution.

## Solution

RecoverAI converts trusted events into durable revenue-risk cases. An AI provider diagnoses case context and proposes one structured action. Deterministic policy then allows, denies, or routes the proposal to human review. An idempotent executor performs only approved work, and an outcome observer closes the loop using authoritative evidence.

The implemented risk types are `PAYMENT_FAILURE`, `SUBSCRIPTION_FAILURE`, `CHECKOUT_ABANDONMENT`, and `OVERDUE_RECEIVABLE`. Detection is rules- and event-driven, not predictive ML.

## What Is Innovative

- A complete observe–decide–act–verify loop rather than one-shot message generation.
- A hard authority boundary between probabilistic proposals and deterministic execution policy.
- Durable promises, follow-ups, reviews, and timers backed by PostgreSQL and pg-boss.
- Atomic action claims and a single authoritative recovery winner for concurrency safety.
- Explicit separation of verified recovery, agent-attributed recovery, and non-monetary progress.
- A frozen synthetic benchmark that independently scores unsafe proposals and policy violations.

## AI Boundary

AI supplies contextual diagnosis and structured next-action proposals through a provider interface supporting Gemini and a deterministic mock. It cannot call payment APIs, bypass policy, mutate recovery state, or mark money recovered. No model was trained for this project, and no predictive-risk claim is made.

## Razorpay Test Mode

RecoverAI can create payment links through a Razorpay Test Mode adapter after policy approval. It converts the authoritative case amount to paise, binds execution and webhook ingestion to the configured merchant, verifies webhook signatures over exact raw bytes, persists receipts, and hands normalized work to pg-boss. Creating the link is not recovery; only a later authoritative, correlated monetary event can win the case.

Razorpay charge retries are intentionally unsupported because RecoverAI does not retain payment authorization. The project makes no live-money claim.

## Safety and Human Review

Policy enforces consent and opt-out, quiet hours, cooldowns, limits, recovery windows, action compatibility, high-value review, terminal states, and a merchant kill switch. A human approval authorizes only the exact stored proposal and is revalidated against current policy before execution. All material decisions are persisted for audit.

## Money Truth

- Payment-link creation and payment-method updates are non-monetary.
- Merchant-reported monetary success is not authoritative recovery evidence.
- Verified recovery requires correlated Razorpay or simulator monetary evidence.
- A case can have one authoritative monetary winner.
- Agent-attributed recovery is a subset of verified recovery.

## Frozen Evaluation Result

Evaluation V2 contains 500 deterministic synthetic scenarios: 300 development, 100 validation, and 100 heldout. The frozen heldout run used evaluator checkpoint `f599312bd1e81ea4f9d4d9fc3d2acd880b2d9849` and fingerprint `sha256:f07508e41e4c7a29a1a3c09b2206fa5d7c8cb2dca20a75de9d59e927f8bb8e96`.

| Strategy     | Synthetic recovered | Recovery rate | Unsafe actions | Policy violations |
| ------------ | ------------------: | ------------: | -------------: | ----------------: |
| Rules+Policy |         ₹334,042.89 |       6.5724% |             24 |                 0 |
| RecoverAI    |         ₹281,695.00 |       5.5425% |             35 |                 0 |

RecoverAI trailed the Rules+Policy baseline by **₹52,347.89** and produced 11 more independently classified unsafe proposals. Deterministic policy prevented policy-violating execution in both strategies. These synthetic results demonstrate a reproducible safety boundary and identify proposal quality as future work; they do not establish revenue uplift.

## Technology

TypeScript, Node.js, Fastify, Zod, PostgreSQL 16, Prisma, pg-boss, React, Vite, Tailwind CSS, TanStack Query, Gemini provider integration, Vitest, Playwright, and GitHub Actions.

## Run Locally

Prerequisites: Node.js 18+, npm 9+, and Docker with Docker Compose.

```bash
git clone https://github.com/navadeep-17/RecoverAI.git
cd RecoverAI
npm ci
cp .env.example .env
npm run docker:up
npm run demo:setup
```

Start `npm run dev:api`, `npm run dev:worker`, and `npm run dev:web` in separate terminals, then open `http://localhost:5173`.

For the deterministic PostgreSQL-backed acceptance trace:

```bash
npm run demo
```

See [the judge demo guide](DEMO.md) and [architecture reference](architecture.md) for the presentation path and system diagrams.
