$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

function Install-Skill {
	param(
		[string]$Label,
		[string]$SrcDir,
		[string]$DestDir,
		[string]$HomeMarker
	)

	if (-not (Test-Path $HomeMarker)) {
		Write-Host "Skipping $Label ($HomeMarker not found)"
		return
	}

	$SkillSrc = Join-Path $SrcDir "SKILL.md"
	if (Test-Path $SkillSrc) {
		New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
		Copy-Item -Force $SkillSrc (Join-Path $DestDir "SKILL.md")
		Write-Host "Installed $Label: $DestDir\\SKILL.md"
	} else {
		Write-Host "Skipping $Label ($SkillSrc not found)"
	}
}

Install-Skill -Label "Claude Code skill" -SrcDir (Join-Path $ProjectDir "skills\\claude-code") -DestDir (Join-Path $env:USERPROFILE ".claude\\skills\\agent-memory") -HomeMarker (Join-Path $env:USERPROFILE ".claude")
Install-Skill -Label "Codex skill" -SrcDir (Join-Path $ProjectDir "skills\\codex") -DestDir (Join-Path $env:USERPROFILE ".codex\\skills\\agent-memory") -HomeMarker (Join-Path $env:USERPROFILE ".codex")
Install-Skill -Label "Cursor skill" -SrcDir (Join-Path $ProjectDir "skills\\cursor") -DestDir (Join-Path $env:USERPROFILE ".cursor\\skills\\agent-memory") -HomeMarker (Join-Path $env:USERPROFILE ".cursor")
Install-Skill -Label "Agent CLI skill" -SrcDir (Join-Path $ProjectDir "skills\\agent") -DestDir (Join-Path $env:USERPROFILE ".agents\\skills\\agent-memory") -HomeMarker (Join-Path $env:USERPROFILE ".agents")

Write-Host ""
Write-Host "Done."
Write-Host ""

$BinExe = Join-Path $ProjectDir "dist\\agent-memory.exe"
$Bin = Join-Path $ProjectDir "dist\\agent-memory"
if (Test-Path $BinExe) {
	Write-Host "Add this directory to your PATH:"
	Write-Host "  $(Join-Path $ProjectDir 'dist')"
} elseif (Test-Path $Bin) {
	Write-Host "Add this directory to your PATH:"
	Write-Host "  $(Join-Path $ProjectDir 'dist')"
} else {
	Write-Host "Build the CLI binary first:"
	Write-Host "  bun run build:cli"
	Write-Host "Then add this directory to your PATH:"
	Write-Host "  $(Join-Path $ProjectDir 'dist')"
}

Write-Host ""
Write-Host "Initialize memory: agent-memory init"
