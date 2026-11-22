param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]*$')]
    [string]$ServerAddress
)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$backupPort = 55434
$runLog = Join-Path $workspace '.tools/research-vps-backup.last.log'
$sshLog = Join-Path $workspace '.tools/research-vps-backup-ssh.last.log'
$tunnel = $null
$exitCode = 1

Push-Location -LiteralPath $workspace
try {
    if (Get-NetTCPConnection -State Listen -LocalPort $backupPort -ErrorAction SilentlyContinue) {
        throw "Backup SSH port $backupPort is already in use."
    }
    foreach ($path in @('.env', '.tools/research-vps-client-ed25519', '.tools/research-vps-known-hosts')) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing local backup input: $path" }
    }
    $sshArguments = @(
        '-F', 'none', '-N', '-T', '-i', '.tools/research-vps-client-ed25519',
        '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'GlobalKnownHostsFile=none',
        '-o', 'UserKnownHostsFile=.tools/research-vps-known-hosts', '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
        '-L', "127.0.0.1:${backupPort}:127.0.0.1:5432", "dota-registry-tunnel@$ServerAddress"
    )
    $tunnel = Start-Process -FilePath ssh.exe -ArgumentList $sshArguments -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardError $sshLog -PassThru
    $ready = $false
    for ($attempt = 0; $attempt -lt 48; $attempt++) {
        $tunnel.Refresh()
        if ($tunnel.HasExited) { throw 'Backup SSH exited. See the SSH log.' }
        if (Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort $backupPort -OwningProcess $tunnel.Id -ErrorAction SilentlyContinue) {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'Backup SSH did not open the local port.' }
    $env:RESEARCH_BACKUP_TUNNEL_PORT = "$backupPort"
    & node.exe --env-file=.env tools/research/backup-shared-registry.mjs .tools/pgsql/bin .tools/research-vps-backups *> $runLog
    $exitCode = $LASTEXITCODE
} catch {
    $_.Exception.Message | Set-Content -LiteralPath $runLog -Encoding UTF8
} finally {
    if ($tunnel) {
        $tunnel.Refresh()
        if (-not $tunnel.HasExited) { Stop-Process -InputObject $tunnel -ErrorAction SilentlyContinue }
        $tunnel.Dispose()
    }
    Pop-Location
}
exit $exitCode
