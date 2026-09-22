<#
.SYNOPSIS
  Start the unattended Gemini labelling run, keep Windows awake, and clean up after.

.DESCRIPTION
  Run this from a normal PowerShell window (NOT inside Claude Code) before bed:

      cd C:\Users\aryan\anand_project_2\AudioVis
      powershell -ExecutionPolicy Bypass -File scripts\mood-labels\overnight.ps1

  - Asks for your Gemini key (typed hidden, kept only in this process, never
    written to disk) unless GEMINI_API_KEY is already set.
  - Blocks idle sleep for as long as the run lasts (no power-plan change; the
    screen may still turn off). Closing the laptop lid can still suspend it, so
    leave it open or set "lid close = do nothing" yourself, and plug it in.
  - Everything is resumable: if the window closes or the PC restarts, run the
    same command again and it continues from the cached labels.
  - Any extra arguments go to overnight.mjs, e.g. -ExtraArgs '--samples','5'.

  Morning: read corpus\labels\OVERNIGHT-REPORT.md
#>
param([string[]]$ExtraArgs = @())

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $repo

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node was not found on PATH.' }
$count = (Get-ChildItem corpus\audio -Filter *.mp3 -ErrorAction SilentlyContinue | Measure-Object).Count
if ($count -eq 0) { throw 'corpus\audio is empty. Run: node corpus\select-eval-set.mjs' }

$askedForKey = $false
if (-not $env:GEMINI_API_KEY -and -not $env:GOOGLE_API_KEY) {
  $secure = Read-Host 'Paste your Gemini API key (hidden)' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $env:GEMINI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  $askedForKey = $true
}

# ES_CONTINUOUS | ES_SYSTEM_REQUIRED: no idle sleep while this process runs.
Add-Type -Namespace Win32 -Name Power -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
# Decimal on purpose: PowerShell reads 0x80000001 as a NEGATIVE Int32, which cannot become a UInt32.
$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
[void][Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)

try {
  Write-Host "Starting overnight labelling ($count clips on disk). Leave this window open." -ForegroundColor Cyan
  Write-Host "Progress log: corpus\labels\overnight.log   Report: corpus\labels\OVERNIGHT-REPORT.md`n"
  & node scripts\mood-labels\overnight.mjs @ExtraArgs
  $code = $LASTEXITCODE
  if ($code -eq 0) { Write-Host "`nDone. Open corpus\labels\OVERNIGHT-REPORT.md" -ForegroundColor Green }
  else { Write-Host "`nFinished with exit code $code - some tracks may be unlabelled. Read the report, then re-run this same command to retry." -ForegroundColor Yellow }
}
finally {
  [void][Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS)   # ES_CONTINUOUS alone: allow sleep again
  if ($askedForKey) { Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue }
}
