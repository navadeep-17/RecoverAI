# RecoverAI Architecture Documentation

## 1. System Architecture Overview
RecoverAI is a policy-governed autonomous revenue recovery agent.

`
                    [ External Signals ]
          (Razorpay Webhooks | Merchant Events | Timers)
                            │
                            ▼
                  [ Event Gateway / Dedup ]
                            │
                            ▼
               [ Revenue Risk Case Detector ]
                            │
                            ▼
                   [ AI Recovery Agent ]
              (Diagnose context -> Propose next action)
                            │
                            ▼
                [ Deterministic Policy Firewall ]
              ┌─────────────┼─────────────┐
           ALLOW          DENY          REVIEW
              │             │             │
              ▼             ▼             ▼
       [ActionExecutor]  [Stopped]  [Human Review Inbox]
              │                           │
              │◄──── (Revalidated Action) ┘
              ▼
      [Provider Adapters]
 (Razorpay Test Mode | Simulators)
              │
              ▼
     [ Outcome Observer ] ──(Replanning Loop)──► [ Revenue Risk Case ]
`

## 2. Monorepo Structure
- pps/api: Fastify HTTP server and webhook gateway.
- pps/worker: pg-boss background recovery worker.
- pps/web: React + Vite + Tailwind + TanStack Query merchant command center.
- packages/shared: Shared types, constants, schemas, logging, and correlation ID primitives.
- packages/db: Prisma schema, migrations, and PostgreSQL client.
- packages/core: Domain interfaces, case lifecycle, detector, and observer contracts.
- packages/policy: Deterministic authorization engine (ALLOW, DENY, REVIEW).
- packages/integrations: Provider adapters (Razorpay Test Mode, simulators, LLM provider).
- packages/evaluation: 500-case dataset generator and benchmark harness.

## 3. Core Architectural Principles
- **AI Proposes, Policy Decides, Executor Acts, Observer Verifies.**
- **Durable Scheduling:** Delayed recovery work is persisted via PostgreSQL-backed job queue.
- **Idempotency & Concurrency Safety:** Unique deterministic idempotency keys and atomic claims.
- **Truthful Integrations:** Clear boundaries separating Razorpay Test Mode from simulated channels.
