# Pushes PayRescue env vars from .env.local to Vercel production.
#
# The agent CANNOT run this for you: Vercel needs YOUR Google login, which
# only works in your browser. Do these 3 steps once (2 minutes):
#
#   1. vercel login          # pick "Continue with Google" in YOUR browser
#   2. vercel link           # link to the razorpay-recovery project
#   3. powershell -ExecutionPolicy Bypass -File scripts/vercel-push-env.ps1
#
# The script reads values from .env.local (never prints them) and creates
# each variable in Vercel production. Re-running updates existing vars.

$ErrorActionPreference = "Continue"
$projectRoot = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $projectRoot ".env.local"

if (-not (Test-Path -LiteralPath $envFile)) {
  Write-Error ".env.local not found at $envFile"
  exit 1
}

$wanted = @(
  "DATABASE_URL",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "ADMIN_SECRET",
  "CRON_SECRET"
)

$values = @{}
Get-Content -LiteralPath $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"]*)"?\s*$') {
    $values[$Matches[1]] = $Matches[2]
  }
}

$ok = 0
$failed = @()
foreach ($name in $wanted) {
  if (-not $values.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($values[$name])) {
    Write-Warning "$name missing in .env.local — skipped (add it, then re-run)"
    $failed += $name
    continue
  }
  # If it already exists, remove first so re-runs update the value.
  $exists = vercel env ls production 2>$null | Select-String -Pattern "\b$name\b"
  if ($exists) {
    vercel env rm $name production -y 2>$null | Out-Null
  }
  $out = $values[$name] | vercel env add $name production 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) {
    Write-Host "OK: $name"
    $ok++
  } else {
    Write-Warning "FAILED: $name — paste it manually in Vercel dashboard (Settings > Environment Variables)"
    $failed += $name
  }
}

Write-Host ""
Write-Host "Done: $ok/$($wanted.Count) vars in Vercel production."
if ($failed.Count -gt 0) {
  Write-Host ("Manual fallback for: " + ($failed -join ", "))
  Write-Host "Dashboard: vercel.com > razorpay-recovery > Settings > Environment Variables"
}
