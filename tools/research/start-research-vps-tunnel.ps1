param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]*$')]
    [string]$ServerAddress,

    [Parameter(Mandatory)]
    [ValidatePattern('^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$')]
    [string]$HostPublicKey
)

$ErrorActionPreference = 'Stop'
$workspace = Join-Path $PSScriptRoot '../..'
Push-Location -LiteralPath $workspace
try {
    $identity = '.tools/research-vps-client-ed25519'
    $knownHosts = '.tools/research-vps-known-hosts'
    $hostEntry = "$ServerAddress $HostPublicKey"

    if (-not (Test-Path -LiteralPath $identity -PathType Leaf)) {
        throw 'SSH private key missing. Create the registry client key on this PC.'
    }
    if (Test-Path -LiteralPath $knownHosts) {
        if ((Get-Content -LiteralPath $knownHosts -Raw).Trim() -cne $hostEntry) {
            throw 'The supplied host key differs from the saved registry host key.'
        }
    } else {
        Set-Content -LiteralPath $knownHosts -Value $hostEntry -Encoding ASCII
    }

    Write-Output 'Keep this window open while using the registry on port 55433.'
    & ssh.exe -F none -N -T -i $identity -o IdentitiesOnly=yes -o PasswordAuthentication=no `
        -o KbdInteractiveAuthentication=no -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 `
        -o "UserKnownHostsFile=$knownHosts" -o GlobalKnownHostsFile=none -o ExitOnForwardFailure=yes `
        -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 `
        -L '127.0.0.1:55433:127.0.0.1:5432' "dota-registry-tunnel@$ServerAddress"
    $sshExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $sshExitCode
