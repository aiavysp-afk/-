param(
    [Parameter(Mandatory)][string]$SshKeyPath,
    [Parameter(Mandatory)][ValidatePattern('^[a-z_][a-z0-9_-]*@[a-zA-Z0-9.-]+$')][string]$SshTarget,
    [ValidateRange(1024, 65535)][int]$LocalPort = 55349,
    [ValidateSet('staff', 'customer')][string]$Acceptance = 'staff'
)
$ErrorActionPreference = 'Stop'
$taskKey = (Resolve-Path -LiteralPath $SshKeyPath).Path
$taskHost = $SshTarget
$taskSuffix = [guid]::NewGuid().ToString('N').Substring(0, 10)
$taskDatabase = 'zydj_' + $Acceptance + '_auth_acceptance_' + (Get-Date -Format 'yyyyMMdd') + '_' + $taskSuffix
$taskRole = 'zydj_staff_auth_test_' + $taskSuffix
$taskSecret = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$taskPort = $LocalPort
$taskTunnel = $null
$taskCreated = $false
$taskOldDatabase = $env:DATABASE_URL
$taskOldAcceptance = $env:STAFF_AUTH_ACCEPTANCE_DATABASE_URL
$taskOldCustomerAcceptance = $env:CUSTOMER_AUTH_ACCEPTANCE_DATABASE_URL
$taskTemporaryRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$taskSchemaDirectory = Join-Path $taskTemporaryRoot ('zydj-staff-auth-schema-' + $taskSuffix)
if ($taskDatabase -notmatch '^zydj_(staff|customer)_auth_acceptance_[0-9]{8}_[a-z0-9]+$' -or $taskRole -notmatch '^zydj_staff_auth_test_[a-z0-9]+$' -or $taskSecret -notmatch '^[a-f0-9]{64}$') { throw 'Invalid isolated target' }
if (Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue) { throw 'Isolated tunnel port already occupied' }
try {
    # The only generated credential stays in memory and is sent on stdin.
    # psql cannot echo statements because -a/-e are deliberately not used.
    $taskSql = "CREATE ROLE $taskRole LOGIN PASSWORD '$taskSecret';`nCREATE DATABASE $taskDatabase OWNER $taskRole;"
    $taskCreated = $true
    $taskSql | & ssh -i $taskKey -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=2 $taskHost 'runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 postgres' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Isolated database creation failed' }
    $taskTunnel = Start-Process ssh -WindowStyle Hidden -PassThru -ArgumentList @('-i', $taskKey, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2', '-o', 'ExitOnForwardFailure=yes', '-L', "127.0.0.1:${taskPort}:127.0.0.1:5432", '-N', $taskHost)
    $taskListening = $false
    for ($taskAttempt = 0; $taskAttempt -lt 40; $taskAttempt++) {
        if ($taskTunnel.HasExited) { throw 'Isolated database tunnel failed' }
        if (Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue) { $taskListening = $true; break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $taskListening) { throw 'Isolated database tunnel timeout' }
    $taskUrl = "postgresql://${taskRole}:${taskSecret}@127.0.0.1:${taskPort}/${taskDatabase}?schema=public"
    $env:DATABASE_URL = $taskUrl
    # Copy migration sources to a fresh directory. Ignore old empty, untracked
    # local migration directories without deleting or editing user workspace data.
    New-Item -ItemType Directory -Path $taskSchemaDirectory | Out-Null
    Copy-Item -LiteralPath 'apps/api/prisma/schema.prisma' -Destination $taskSchemaDirectory
    $taskMigrationDirectory = Join-Path $taskSchemaDirectory 'migrations'
    New-Item -ItemType Directory -Path $taskMigrationDirectory | Out-Null
    Copy-Item -LiteralPath 'apps/api/prisma/migrations/migration_lock.toml' -Destination $taskMigrationDirectory
    Get-ChildItem -LiteralPath 'apps/api/prisma/migrations' -Directory | Where-Object {
        Test-Path -LiteralPath (Join-Path $_.FullName 'migration.sql')
    } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $taskMigrationDirectory -Recurse }
    & pnpm --filter '@zydj/api' exec prisma migrate deploy --schema (Join-Path $taskSchemaDirectory 'schema.prisma')
    if ($LASTEXITCODE -ne 0) { throw 'Isolated migration failed' }
    if ($Acceptance -eq 'customer') {
        $env:CUSTOMER_AUTH_ACCEPTANCE_DATABASE_URL = $taskUrl
        & pnpm --filter '@zydj/api' exec tsx scripts/verify-customer-login.ts
    } else {
        $env:STAFF_AUTH_ACCEPTANCE_DATABASE_URL = $taskUrl
        & pnpm --filter '@zydj/api' exec tsx scripts/verify-staff-password-trust.ts
    }
    if ($LASTEXITCODE -ne 0) { throw 'Isolated authentication acceptance failed' }
} finally {
    $env:DATABASE_URL = $taskOldDatabase
    $env:STAFF_AUTH_ACCEPTANCE_DATABASE_URL = $taskOldAcceptance
    $env:CUSTOMER_AUTH_ACCEPTANCE_DATABASE_URL = $taskOldCustomerAcceptance
    if ($taskTunnel -and -not $taskTunnel.HasExited) { Stop-Process -Id $taskTunnel.Id }
    if ($taskCreated) {
        # Exact generated targets, never a production or shared fixture database.
        # Recheck the database owner before terminating its connections or dropping it.
        $taskCleanup = @"
DO `$`$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = '$taskDatabase' AND pg_get_userbyid(datdba) <> '$taskRole') THEN
    RAISE EXCEPTION 'Isolated database owner mismatch';
  END IF;
END `$`$;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$taskDatabase' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS $taskDatabase;
DROP ROLE IF EXISTS $taskRole;
"@
        $taskCleanup | & ssh -i $taskKey -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=2 $taskHost 'runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 postgres' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Isolated database cleanup failed; needs inspection' }
        Write-Output 'Disposable authentication acceptance database and role removed; production data was not changed.'
    }
    if (Test-Path -LiteralPath $taskSchemaDirectory) {
        $taskResolvedSchema = [System.IO.Path]::GetFullPath($taskSchemaDirectory)
        if ([System.IO.Path]::GetDirectoryName($taskResolvedSchema) -ne $taskTemporaryRoot -or [System.IO.Path]::GetFileName($taskResolvedSchema) -ne ('zydj-staff-auth-schema-' + $taskSuffix)) { throw 'Temporary schema cleanup target mismatch' }
        Remove-Item -LiteralPath $taskResolvedSchema -Recurse
    }
    $taskSecret = $null
    $taskUrl = $null
    $taskSql = $null
}
