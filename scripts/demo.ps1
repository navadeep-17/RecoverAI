$ErrorActionPreference = 'Stop'
if (-not $env:DATABASE_URL) { $env:DATABASE_URL = 'postgresql://recoverai:recoverai_secret@localhost:5432/recoverai?schema=public' }
if (-not $env:PG_BOSS_SCHEMA) { $env:PG_BOSS_SCHEMA = 'pgboss' }
if (-not $env:AI_PROVIDER) { $env:AI_PROVIDER = 'mock' }
if ($env:AI_PROVIDER -eq 'mock') { Write-Host 'DEMO MOCK AI: deterministic test infrastructure; this does not prove Gemini quality.' } else { Write-Host 'REAL GEMINI configuration selected; no provider action will be sent by this harness.' }
Write-Host 'Communication provider: SIMULATED_RECOVERY_PROVIDER unless Razorpay Test Mode is separately configured.'
Write-Host 'Verified recovered and agent-attributed recovered are reported separately by the acceptance traces.'
npx vitest run packages/db/tests/closed-loop.integration.test.ts apps/worker/tests/worker.integration.test.ts --reporter=verbose
exit $LASTEXITCODE
