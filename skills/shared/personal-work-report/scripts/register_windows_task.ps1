param(
  [string]$SkillPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$Time = "08:00",
  [string]$TaskName = "PersonalWorkReportDaily"
)

$python = (Get-Command python -ErrorAction Stop).Source
$script = Join-Path $SkillPath "scripts\run_workday_report.py"
if (-not (Test-Path -LiteralPath $script)) {
  throw "Cannot find $script"
}

$action = New-ScheduledTaskAction -Execute $python -Argument "`"$script`"" -WorkingDirectory $SkillPath
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Generate previous-day personal work report via lark-cli" -Force
Write-Host "Registered scheduled task $TaskName at $Time"
