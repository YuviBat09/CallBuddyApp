# setup-google.ps1
# One-time Google Cloud setup for CallBuddy latency sheets.
# Usage: .\scripts\setup-google.ps1 -UserEmail your@gmail.com
#
# Requires: gcloud CLI installed (https://cloud.google.com/sdk/docs/install)
# Run from the project root (CallBuddyApp/).

param(
    [string]$UserEmail = "yuvrajs.batra@gmail.com"
)

$ErrorActionPreference = "Continue"

# ── helpers ──────────────────────────────────────────────────────────────────

function Log($msg) { Write-Host "[setup] $msg" -ForegroundColor Cyan }
function Ok($msg)  { Write-Host "[ok]    $msg" -ForegroundColor Green }
function Err($msg) { Write-Host "[err]   $msg" -ForegroundColor Red; exit 1 }

# ── 1. Check gcloud is available ─────────────────────────────────────────────

Log "Checking gcloud CLI..."
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    Err "gcloud not found. Install it from https://cloud.google.com/sdk/docs/install and re-run."
}
Ok "gcloud found"

# ── 2. Authenticate (browser popup) ──────────────────────────────────────────

Log "Authenticating with Google (a browser window will open)..."
gcloud auth login
Ok "Authenticated"

# ── 3. Create a GCP project ───────────────────────────────────────────────────

# Use a unique suffix to avoid name collisions
$suffix = Get-Date -Format "yyMMddHHmm"
$projectId = "callbuddy-latency-$suffix"

Log "Creating GCP project: $projectId ..."
$existing = gcloud projects list --filter="projectId=$projectId" --format="value(projectId)" 2>$null
if ($existing -eq $projectId) {
    Ok "Project already exists, reusing."
} else {
    gcloud projects create $projectId --name="CallBuddy Latency" 2>$null | Out-Null
    Ok "Project created: $projectId"
}

# Set as active project
gcloud config set project $projectId 2>&1 | Out-Null

# ── 4. Link billing (best-effort — Sheets API is free, but project needs billing enabled) ─

Log "Note: If you have never enabled billing on this GCP account, go to:"
Log "  https://console.cloud.google.com/billing?project=$projectId"
Log "and link a billing account. The Sheets API is free - this is just a requirement."

# ── 5. Enable APIs ────────────────────────────────────────────────────────────

Log "Enabling Sheets + Drive APIs (may take 30-60 seconds)..."
gcloud services enable sheets.googleapis.com drive.googleapis.com `
    --project=$projectId 2>&1 | Out-Null
Ok "APIs enabled"

# ── 6. Create service account ─────────────────────────────────────────────────

$saName   = "callbuddy-sheets"
$saEmail  = "$saName@$projectId.iam.gserviceaccount.com"

Log "Creating service account: $saEmail ..."
$existingSa = gcloud iam service-accounts list `
    --project=$projectId `
    --filter="email=$saEmail" `
    --format="value(email)" 2>$null

if ($existingSa -eq $saEmail) {
    Ok "Service account already exists, reusing."
} else {
    gcloud iam service-accounts create $saName `
        --project=$projectId `
        --display-name="CallBuddy Sheets Writer" 2>&1 | Out-Null
    Ok "Service account created"
}

# ── 7. Download JSON key ───────────────────────────────────────────────────────

$keyPath = Join-Path (Get-Location) "google-credentials.json"

if (Test-Path $keyPath) {
    Log "google-credentials.json already exists - skipping key creation."
    Ok "Using existing key at $keyPath"
} else {
    Log "Downloading service account key to google-credentials.json ..."
    gcloud iam service-accounts keys create $keyPath `
        --iam-account=$saEmail `
        --project=$projectId 2>&1 | Out-Null
    Ok "Key saved to $keyPath"
}

# ── 8. Call Node.js script to create the sheet ───────────────────────────────

Log "Creating Google Sheet and updating .env ..."
Log "  User email: $UserEmail"
Log "  Service account: $saEmail"

node scripts/create-sheet.mjs $UserEmail

# Done
Write-Host ""
Ok "Setup complete! Run 'npm run dev' and make a test call."
