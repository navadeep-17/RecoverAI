$ErrorActionPreference = 'Stop'
if (-not $env:DATABASE_URL) { $env:DATABASE_URL = 'postgresql://recoverai:recoverai_secret@localhost:5432/recoverai?schema=public' }
if (-not $env:PG_BOSS_SCHEMA) { $env:PG_BOSS_SCHEMA = 'pgboss' }
if (-not $env:AI_PROVIDER) { $env:AI_PROVIDER = 'mock' }
Write-Host 'DEMO AI: deterministic MockLLMProvider (acceptance harness).'
if ($env:AI_PROVIDER -eq 'gemini') { Write-Host 'Gemini is configured for normal runtime, but the deterministic acceptance harness uses MockLLMProvider.' }
Write-Host 'Acceptance harness provider: SIMULATED_RECOVERY_PROVIDER.'
Write-Host 'Normal runtime uses Razorpay Test Mode for payment-link actions when credentials are configured.'
Write-Host 'Verified recovered and agent-attributed recovered are reported separately by the acceptance traces.'
npx vitest run packages/db/tests/closed-loop.integration.test.ts apps/worker/tests/worker.integration.test.ts --reporter=verbose
exit $LASTEXITCODE
