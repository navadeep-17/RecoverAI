# RecoverAI

> **Policy-Governed Autonomous Revenue Recovery Agent**
> Built for Razorpay AI Buildathon 2026 — Track 03 (AI Revenue Recovery)

---

## Current Status: Phase 7 — Razorpay Test Mode Integration
- **Monorepo:** npm workspaces with `apps/api`, `apps/worker`, `apps/web`, and `packages/*`.
- **API Framework:** Node.js + Fastify + TypeScript + Zod + Pino structured logging.
- **Database & Persistence:** PostgreSQL + Prisma with full frozen domain schema.
- **Worker / Scheduler:** pg-boss integration foundation.
- **Frontend:** React + Vite + Tailwind CSS + TanStack Query app shell.
- **Quality Gates:** Vitest test suite, TypeScript strict typechecking, ESLint, Prettier.
- **Payment links:** A real Razorpay Test Mode adapter is available only for `CREATE_OR_SEND_PAYMENT_LINK`; it converts the authoritative case amount to paise and records link creation, never a recovery.
- **Webhook boundary:** `POST /webhooks/razorpay` verifies the exact raw request bytes with `RAZORPAY_WEBHOOK_SECRET`, persists a tenant-scoped receipt, and hands it to pg-boss for normalized processing.
- **Recovery confirmation:** Only a verified normalized payment-success event that correlates to the merchant's authoritative business identifiers may resolve recovery. Creating or sending a link is not confirmation.

---

## Quickstart & Local Setup

### 1. Prerequisites
- Node.js >= 18.0.0
- npm >= 9.0.0
- Docker & Docker Compose (or local PostgreSQL instance)

### 2. Installation
```bash
# Clone repository
git clone https://github.com/navadeep-17/RecoverAI.git
cd RecoverAI

# Install all workspace dependencies
npm install

# Copy environment template
cp .env.example .env
```

### 3. Start Database
```bash
# Start PostgreSQL via Docker Compose
docker compose up -d

# Generate Prisma Client & push schema
npm run --workspace=@recoverai/db db:generate
npm run --workspace=@recoverai/db db:push
```

### 4. Run Quality Checks
```bash
# Run unit & smoke tests
npm run test

# Typecheck all workspaces
npm run typecheck

# Lint all workspaces
npm run lint

# Build all workspaces
npm run build
```

### 5. Start Development Services
```bash
# Start API server (port 3000)
npm run dev --workspace=@recoverai/api

# Start Web dashboard (port 5173)
npm run dev --workspace=@recoverai/web

# Start Background Worker
npm run dev --workspace=@recoverai/worker
```

---

## Architecture Principles
1. **AI Proposes:** The LLM produces schema-validated next-action proposals from a frozen allowlist.
2. **Policy Decides:** The deterministic PolicyEngine authorizes (`ALLOW`), rejects (`DENY`), or escalates (`REVIEW`).
3. **Executor Acts:** Only allowlisted adapters execute external actions with idempotency keys.
4. **Observer Verifies:** Outcomes re-enter through normalized events, driving closed-loop replanning.

---

## Razorpay Test Mode setup

Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, and the deployment-bound `RAZORPAY_TEST_MERCHANT_ID` in the environment; `.env.example` contains placeholders only. Configure Razorpay Test Mode to deliver to `POST /webhooks/razorpay` with the same webhook secret. The API acknowledges only verified and durably handed-off receipts.

No credentials are committed, and the automated suite uses mocked provider responses. Deployments explicitly inject `RazorpayPaymentLinkProvider` into the existing `ProviderRegistry`; the registry's safe default remains the simulator. A live Test Mode evidence run is intentionally skipped when credentials and a test merchant are not supplied. `RETRY_PAYMENT` remains simulated/unsupported by the Razorpay adapter because RecoverAI does not retain payment authorization to safely retry a charge.
