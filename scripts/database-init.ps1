param([switch]$GenerateClient)
$ErrorActionPreference = 'Stop'
if (-not $env:DATABASE_URL) { throw 'Set DATABASE_URL securely before initializing the dedicated database' }
$repoPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $repoPath
try {
  & pnpm --filter '@zydj/api' exec prisma migrate deploy
  if ($LASTEXITCODE -ne 0) { throw 'Database migration failed; no reset or seed performed' }
  & pnpm --filter '@zydj/api' exec prisma migrate status
  if ($LASTEXITCODE -ne 0) { throw 'Database migration status failed' }
  if ($GenerateClient) {
    & pnpm --filter '@zydj/api' exec prisma generate
    if ($LASTEXITCODE -ne 0) { throw 'Client generation failed' }
  }
} finally { Pop-Location }
