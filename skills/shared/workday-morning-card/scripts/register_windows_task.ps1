param(
  [string]$SkillPath = ".",
  [string]$Time = "09:30",
  [string]$TaskName = "WorkdayMorningCard"
)

$resolved = Resolve-Path -LiteralPath $SkillPath
$script = Join-Path $resolved "scripts\generate_morning_card.py"
if (!(Test-Path -LiteralPath $script)) {
  throw "未找到脚本: $script"
}

$python = (Get-Command python).Source
$action = New-ScheduledTaskAction -Execute $python -Argument "`"$script`"" -WorkingDirectory $resolved
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Output "已注册定时任务 $TaskName，每天 $Time 运行。"
