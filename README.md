# RecoverAI

> **Policy-Governed Autonomous Revenue Recovery Agent**
> Built for Razorpay AI Buildathon 2026 — Track 03 (AI Revenue Recovery)

---

## Current Status: Phase 0 — Repository Bootstrap Complete
- **Monorepo:** npm workspaces with pps/api, pps/worker, pps/web, and packages/*.
- **API Framework:** Node.js + Fastify + TypeScript + Zod + Pino structured logging.
- **Database & Persistence:** PostgreSQL + Prisma with full frozen domain schema.
- **Worker / Scheduler:** pg-boss integration foundation.
- **Frontend:** React + Vite + Tailwind CSS + TanStack Query app shell.
- **Quality Gates:** Vitest test suite, TypeScript strict typechecking, ESLint, Prettier.

---

## Quickstart & Local Setup

### 1. Prerequisites
- Node.js >= 18.0.0
- npm >= 9.0.0
- Docker & Docker Compose (or local PostgreSQL instance)

### 2. Installation
`ash
# Clone repository
git clone https://github.com/navadeep-17/RecoverAI.git
cd RecoverAI

# Install all workspace dependencies
npm install

# Copy environment template
cp .env.example .env
`

### 3. Start Database
`ash
# Start PostgreSQL via Docker Compose
docker compose up -d

# Generate Prisma Client & push schema
npm run --workspace=@recoverai/db db:generate
npm run --workspace=@recoverai/db db:push
`

### 4. Run Quality Checks
`ash
# Run unit & smoke tests
npm run test

# Typecheck all workspaces
npm run typecheck

# Lint all workspaces
npm run lint

# Build all workspaces
npm run build
`

### 5. Start Development Services
`ash
# Start API server (port 3000)
npm run dev --workspace=@recoverai/api

# Start Web dashboard (port 5173)
npm run dev --workspace=@recoverai/web

# Start Background Worker
npm run dev --workspace=@recoverai/worker
`

---

## Architecture Principles
1. **AI Proposes:** The LLM produces schema-validated next-action proposals from a frozen allowlist.
2. **Policy Decides:** The deterministic PolicyEngine authorizes (ALLOW), rejects (DENY), or escalates (REVIEW).
3. **Executor Acts:** Only allowlisted adapters execute external actions with idempotency keys.
4. **Observer Verifies:** Outcomes re-enter through normalized events, driving closed-loop replanning.
