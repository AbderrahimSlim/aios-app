<#
  A local service kept up at logon next to aios-host (hidden, restarted on failure, never duplicated).

    powershell -ExecutionPolicy Bypass -File scripts\service-windows.ps1 install -Name MyLittleCRM -Port 3001 `
      -Cwd C:\MyLittleCRM\apps\api -Entry dist\server.js
    powershell -ExecutionPolicy Bypass -File scripts\service-windows.ps1 uninstall -Name MyLittleCRM

  If something already listens on the port (an instance started by hand), the launcher does nothing.
  Log: %USERPROFILE%\.aios\host\logs\<Name>.log
#>
param(
  [Parameter(Position = 0)][ValidateSet('install', 'uninstall', 'status')][string]$Mode = 'status',
  [Parameter(Mandatory = $true)][string]$Name,
  [int]$Port,
  [string]$Cwd,
  [string]$Entry
)
$ErrorActionPreference = 'Stop'
$TaskName = "AIOS Service $Name"
$Repo = Split-Path -Parent $PSScriptRoot
$HostHome = Join-Path $env:USERPROFILE '.aios\host'
$LogDir = Join-Path $HostHome 'logs'

switch ($Mode) {
  'install' {
    if (-not $Port -or -not $Cwd -or -not $Entry) { throw 'install needs -Port, -Cwd and -Entry' }
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { $node = 'C:\Program Files\nodejs\node.exe' }
    if (-not $node) { throw 'node.exe not found' }
    $runner = Join-Path $Repo 'out\host\serviceRun.js'
    if (-not (Test-Path $runner)) { throw "missing $runner - run: npm run compile" }
    if (-not (Test-Path (Join-Path $Cwd $Entry))) { throw "missing $(Join-Path $Cwd $Entry)" }
    New-Item -ItemType Directory -Force $LogDir | Out-Null
    $log = Join-Path $LogDir "$Name.log"
    $cmd = "cmd.exe /d /s /c `"`"$node`" `"$runner`" $Port `"$Cwd`" `"$Entry`" >> `"$log`" 2>&1`""
    $vbs = Join-Path $HostHome "run-$Name.vbs"
    $vbsBody = @(
      'Set sh = CreateObject("WScript.Shell")'
      ('sh.CurrentDirectory = "' + $Cwd + '"')
      ('rc = sh.Run("' + $cmd.Replace('"', '""') + '", 0, True)')
      'WScript.Quit rc'
    ) -join "`r`n"
    Set-Content -Path $vbs -Value $vbsBody -Encoding ASCII
    $taskAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //NoLogo `"$vbs`"" -WorkingDirectory $Cwd
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Installed and started '$TaskName'. Log: $log"
  }
  'uninstall' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "Removed '$TaskName'."
  }
  'status' {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) { Write-Output "$TaskName : $($t.State)" } else { Write-Output "'$TaskName' is not installed." }
  }
}
