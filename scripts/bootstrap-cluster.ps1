#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ClusterName = "crispy-crawler",
    [string]$Region      = "us-east-1",
    [string]$CloudProvider = "AWS",
    [string]$SqlUser     = "mauirocks",
    [string]$Database    = "defaultdb"
)

$ErrorActionPreference = "Stop"

# ── Resolve ccloud ────────────────────────────────────────────────────────────
$ccloud = (Get-Command ccloud -ErrorAction SilentlyContinue).Source
if (-not $ccloud) { $ccloud = Join-Path $env:APPDATA "ccloud\ccloud.exe" }
if (-not (Test-Path $ccloud)) {
    throw "ccloud not found. Install it, or pass its path."
}
Write-Host "ccloud: $ccloud" -ForegroundColor DarkGray

# ── Verify authentication ─────────────────────────────────────────────────────
$clusterJson = & $ccloud cluster list -o json --quiet
if ($LASTEXITCODE -ne 0) {
    throw "Not authenticated. Run: ccloud auth login"
}
$clusters = $clusterJson | ConvertFrom-Json

# ── Find or create cluster ────────────────────────────────────────────────────
$cluster = $clusters | Where-Object { $_.name -eq $ClusterName }

if ($cluster) {
    Write-Host "Cluster '$ClusterName' already exists ($($cluster.state))" -ForegroundColor Green
} else {
    Write-Host "Creating cluster '$ClusterName' in $CloudProvider/$Region ..." -ForegroundColor Yellow
    & $ccloud cluster create serverless $ClusterName $Region --cloud $CloudProvider --wait
    if ($LASTEXITCODE -ne 0) { throw "Cluster creation failed." }

    $cluster = & $ccloud cluster list -o json --quiet |
        ConvertFrom-Json |
        Where-Object { $_.name -eq $ClusterName }
}

if ($cluster.state -ne "CREATED") {
    Write-Warning "Cluster state is '$($cluster.state)'. Connections may fail until it reaches CREATED."
}

# ── Ensure SQL user ───────────────────────────────────────────────────────────
$users = & $ccloud cluster user list $ClusterName -o json --quiet | ConvertFrom-Json
$existing = $users | Where-Object { $_.name -eq $SqlUser -or $_.username -eq $SqlUser }

if ($existing) {
    Write-Host "SQL user '$SqlUser' already exists" -ForegroundColor Green
} else {
    Write-Host "Creating SQL user '$SqlUser' ..." -ForegroundColor Yellow
    Write-Warning "The generated password is shown ONCE. Copy it now."
    & $ccloud cluster user create $ClusterName $SqlUser
    if ($LASTEXITCODE -ne 0) { throw "SQL user creation failed." }
}

# ── Print connection URL ──────────────────────────────────────────────────────
$url = & $ccloud cluster sql $ClusterName --connection-url -u $SqlUser --database $Database --quiet
if ($LASTEXITCODE -ne 0) { throw "Could not retrieve connection URL." }

Write-Host ""
Write-Host "Connection URL (password not included):" -ForegroundColor Cyan
Write-Host $url
Write-Host ""
Write-Host "Add to .env as DATABASE_URL, splicing in the password after the username." -ForegroundColor DarkGray
Write-Host "Percent-encode special characters in the password (@ becomes %40)." -ForegroundColor DarkGray
Write-Host "Then verify with: npm run smoke:crdb" -ForegroundColor DarkGray
