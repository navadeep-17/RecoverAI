$ErrorActionPreference = 'Stop'
if (-not $env:DATABASE_URL) { $env:DATABASE_URL = 'postgresql://recoverai:recoverai_secret@localhost:5432/recoverai?schema=public' }
if (-not $env:PG_BOSS_SCHEMA) { $env:PG_BOSS_SCHEMA = 'pgboss' }
Write-Host 'RecoverAI demo preparation: checking PostgreSQL and applying non-destructive migrations...'
npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host 'Ready. Start API, worker, and web in separate terminals with npm run --workspace=@recoverai/api dev; npm run --workspace=@recoverai/worker dev; npm run --workspace=@recoverai/web dev.'
