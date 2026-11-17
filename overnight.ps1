# overnight.ps1 - runs Claude Code in a loop AND shows progress in one window.
# Usage: powershell -ExecutionPolicy Bypass -File .\overnight.ps1 [-Hours 8] [-PauseSec 30] [-MaxCallMin 180]
# Stops by itself when Claude writes Docs\SESSION_DONE.txt (all items of NEXT_SESSION done), or at -Hours.
# Keys: Enter = refresh now / S = stop after the current call / K = kill the current call and stop / Q = quit now
# Keep this file ASCII only (Windows PowerShell 5.1 breaks on non-ASCII text without BOM).
param(
    [double]$Hours = 8,
    [int]$PauseSec = 30,
    [int]$MaxCallMin = 180,
    [string]$WatchProc = "electron"
)

$first = "Read CLAUDE.md and follow the autonomous mode section. Then read Docs/NEXT_SESSION.md and do every item in order. The user is asleep. Never stop; commit after each item."
$next  = "Continue. Re-read Docs/NEXT_SESSION.md and resume from the next unfinished item. Do not end with build errors; commit before finishing."

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
New-Item -ItemType Directory -Force Logs | Out-Null
# A finished session leaves Docs\SESSION_DONE.txt. Move it aside at startup so a new run is not stopped by an old marker.
if (Test-Path Docs\SESSION_DONE.txt) {
    Move-Item -Force Docs\SESSION_DONE.txt ("Logs\SESSION_DONE_{0:yyyyMMdd_HHmmss}.txt" -f (Get-Date))
    Write-Host "Previous SESSION_DONE marker moved to Logs." -ForegroundColor Yellow
}
$claudeExe = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claudeExe) { Write-Host "claude was not found in PATH." -ForegroundColor Red; exit 1 }

$start = Get-Date
$end = $start.AddHours($Hours)
$call = 0
$proc = $null
$callStart = $null
$callLog = $null
$nextAt = Get-Date
$stopAfter = $false
$finished = $false
$lastNote = ""

function Kill-Call {
    if ($script:proc -and -not $script:proc.HasExited) {
        & taskkill /PID $script:proc.Id /T /F 2>$null | Out-Null
    }
}

function Save-CallLog([string]$reason) {
    $body = ""
    if ($script:callLog -and (Test-Path $script:callLog)) { $body = Get-Content $script:callLog -Raw -Encoding UTF8 }
    $code = ""
    try { $code = $script:proc.ExitCode } catch {}
    $head = "===== call {0} {1:yyyy-MM-dd HH:mm:ss} -> {2:HH:mm:ss} exit={3} {4}" -f $script:call, $script:callStart, (Get-Date), $code, $reason
    Add-Content -Path Logs\overnight.log -Value $head -Encoding UTF8
    if ($body) { Add-Content -Path Logs\overnight.log -Value $body -Encoding UTF8 }
}

function Start-Call {
    $script:call++
    if ($script:call -eq 1) { $argStr = "-p `"$first`"" } else { $argStr = "-p --continue `"$next`"" }
    $script:callLog = "Logs\call_{0:D3}.log" -f $script:call
    $script:proc = Start-Process -FilePath $claudeExe -ArgumentList $argStr -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $script:callLog -RedirectStandardError ($script:callLog + ".err")
    $script:callStart = Get-Date
}

function Show-Screen {
    $now = Get-Date
    Clear-Host
    Write-Host "=== Overnight: MarshallEducater ===" -ForegroundColor Cyan
    Write-Host ("Elapsed: {0:hh\:mm\:ss}   Ends at: {1:HH:mm}   Left: {2:hh\:mm\:ss}" -f ($now - $start), $end, ([TimeSpan]::FromSeconds([math]::Max(0, ($end - $now).TotalSeconds))))
    if ($script:finished) {
        Write-Host "Loop: FINISHED $($script:lastNote)" -ForegroundColor Magenta
    } elseif ($script:proc) {
        Write-Host ("Loop: call #{0} running {1:hh\:mm\:ss} (max {2}m){3}" -f $script:call, ($now - $script:callStart), $MaxCallMin, $(if ($script:stopAfter) { "  [will stop after this call]" } else { "" })) -ForegroundColor Magenta
    } else {
        Write-Host ("Loop: next call in {0}s{1}" -f [math]::Max(0, [int]($script:nextAt - $now).TotalSeconds), $(if ($script:lastNote) { "  (" + $script:lastNote + ")" } else { "" })) -ForegroundColor Magenta
    }
    if (Test-Path Docs\STATUS.json) {
        try {
            $s = Get-Content Docs\STATUS.json -Raw -Encoding UTF8 | ConvertFrom-Json
            $pct = [math]::Floor(100 * $s.done / [math]::Max(1, $s.total))
            $bar = ("#" * [math]::Floor($pct / 5)).PadRight(20, "-")
            Write-Host ""
            Write-Host $s.phase -ForegroundColor Yellow
            Write-Host ("[{0}] {1}%  ({2}/{3})" -f $bar, $pct, $s.done, $s.total) -ForegroundColor Green
            Write-Host ("Now   : " + $s.current)
            Write-Host ("Detail: " + $s.detail)
            Write-Host ("Update: " + (Get-Item Docs\STATUS.json).LastWriteTime.ToString("HH:mm:ss"))
        } catch { Write-Host "STATUS.json is being written..." -ForegroundColor DarkGray }
    } else { Write-Host "STATUS.json not found yet..." -ForegroundColor DarkGray }
    Write-Host ""
    Write-Host "Recently changed files:" -ForegroundColor Cyan
    Get-ChildItem src, tests, Tools, Docs -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notlike "*\node_modules\*" -and $_.FullName -notlike "*\tests\tmp\*" } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 5 |
        ForEach-Object { Write-Host ("  {0}  {1}" -f $_.LastWriteTime.ToString("HH:mm:ss"), $_.Name) }
    Write-Host ""
    Write-Host "Last commits:" -ForegroundColor Cyan
    git log -5 --oneline 2>$null
    $w = Get-Process $WatchProc -ErrorAction SilentlyContinue
    Write-Host ""
    Write-Host ("Claude running: {0}   {1} running: {2}" -f [bool]($script:proc -and -not $script:proc.HasExited), $WatchProc, [bool]$w)
    Write-Host "(Enter: refresh / S: stop after this call / K: kill call and stop / Q: quit)" -ForegroundColor DarkGray
}

try {
    while ($true) {
        $now = Get-Date
        if ($proc) {
            if ($proc.HasExited) {
                Save-CallLog "done"
                $proc = $null
                $nextAt = $now.AddSeconds($PauseSec)
                $lastNote = "call #$call ended at {0:HH:mm:ss}" -f $now
                if (Test-Path Docs\SESSION_DONE.txt) {
                    $finished = $true
                    $lastNote = "(all items done - SESSION_DONE.txt found, stopping to save tokens)"
                }
            } elseif (($now - $callStart).TotalMinutes -gt $MaxCallMin) {
                Kill-Call; Save-CallLog "killed (over $MaxCallMin min)"
                $proc = $null
                $nextAt = $now.AddSeconds($PauseSec)
                $lastNote = "call #$call was over $MaxCallMin min and was stopped"
            }
        }
        if (-not $proc -and -not $finished) {
            if ($stopAfter) { $finished = $true; $lastNote = "(stopped by S/K)" }
            elseif ($now -ge $end) { $finished = $true; $lastNote = "(time limit reached)" }
            elseif ($now -ge $nextAt) { Start-Call }
        }
        Show-Screen
        if ($finished) { break }
        $t = 0
        while ($t -lt 100) {
            if ([Console]::KeyAvailable) {
                $k = [Console]::ReadKey($true)
                if ($k.Key -eq "Enter") { break }
                if ($k.Key -eq "S") { $stopAfter = -not $stopAfter; break }
                if ($k.Key -eq "K") { Kill-Call; if ($proc) { Save-CallLog "killed by user" }; $proc = $null; $stopAfter = $true; break }
                if ($k.Key -eq "Q") { throw "quit" }
            }
            if ($proc -and $proc.HasExited) { break }
            Start-Sleep -Milliseconds 100; $t++
        }
    }
} catch {
    if ("$_" -ne "quit") { Write-Host "Error: $_" -ForegroundColor Red }
} finally {
    if ($proc -and -not $proc.HasExited) {
        Kill-Call; Save-CallLog "killed (script closed)"
        Write-Host "The running Claude call was stopped." -ForegroundColor Yellow
    }
}
