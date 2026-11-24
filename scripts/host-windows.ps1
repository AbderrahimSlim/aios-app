<#
  aios-host on Windows: start at logon, restart on failure, no console window.

    powershell -ExecutionPolicy Bypass -File scripts\host-windows.ps1 install
    powershell -ExecutionPolicy Bypass -File scripts\host-windows.ps1 status
    powershell -ExecutionPolicy Bypass -File scripts\host-windows.ps1 uninstall

  The task runs as YOU, at your logon ("Interactive"), because sessions need your Claude Code login
  and your profile. For a mini PC that must come back after a power cut, enable automatic logon of
  that account (netplwiz) or keep the machine locked rather than signed out.
  Output goes to %USERPROFILE%\.aios\host\logs\host.log. Run `npm run compile` after every update.
#>
param([Parameter(Position = 0)][ValidateSet('install', 'uninstall', 'status')][string]$Action = 'status')

$ErrorActionPreference = 'Stop'
$TaskName = 'AIOS Host'
$Repo = Split-Path -Parent $PSScriptRoot
$Entry = Join-Path $Repo 'out\host\main.js'
$LogDir = Join-Path $env:USERPROFILE '.aios\host\logs'

switch ($Action) {
  'install' {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { $node = 'C:\Program Files\nodejs\node.exe' }
    if (-not $node) { throw 'node.exe not found' }
    if (-not (Test-Path $Entry)) { throw "missing $Entry - run: npm run compile" }
    New-Item -ItemType Directory -Force $LogDir | Out-Null
    $log = Join-Path $LogDir 'host.log'
    # A hidden-window launcher: wscript runs cmd with window style 0 and WAITS, so the task sees the
    # host's real exit code and its restart-on-failure applies. (conhost --headless exits at once.)
    $cmd = "cmd.exe /d /s /c `"`"$node`" `"$Entry`" >> `"$log`" 2>&1`""
    $vbs = Join-Path (Split-Path -Parent $LogDir) 'run-host.vbs'
    $vbsBody = @(
      'Set sh = CreateObject("WScript.Shell")'
      ('sh.CurrentDirectory = "' + $Repo + '"')
      ('rc = sh.Run("' + $cmd.Replace('"', '""') + '", 0, True)')
      'WScript.Quit rc'
    ) -join "`r`n"
    Set-Content -Path $vbs -Value $vbsBody -Encoding ASCII
    $taskAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //NoLogo `"$vbs`"" -WorkingDirectory $Repo
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Installed and started '$TaskName'. Log: $log"
    Write-Output "Pair a device:  node `"$Entry`" pair"
    Write-Output "Remote access:  tailscale serve --bg --https=443 http://127.0.0.1:4800"
  }
  'uninstall' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Removed '$TaskName'."
  }
  'status' {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { Write-Output "'$TaskName' is not installed."; break }
    $i = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Output ("{0}: {1}, last run {2} (result {3})" -f $TaskName, $t.State, $i.LastRunTime, $i.LastTaskResult)
    try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4800/pair' -TimeoutSec 3 | Out-Null; Write-Output 'Listening on http://127.0.0.1:4800' }
    catch { Write-Output 'Not answering on 127.0.0.1:4800' }
  }
}
