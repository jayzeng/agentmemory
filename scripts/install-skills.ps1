$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

# Claude Code skill
$ClaudeSkillDir = Join-Path $env:USERPROFILE ".claude\\skills\\agent-memory"
$ClaudeSkillSrc = Join-Path $ProjectDir "skills\\claude-code\\SKILL.md"
if (Test-Path $ClaudeSkillSrc) {
	New-Item -ItemType Directory -Force -Path $ClaudeSkillDir | Out-Null
	Copy-Item -Force $ClaudeSkillSrc (Join-Path $ClaudeSkillDir "SKILL.md")
	Write-Host "Installed Claude Code skill: $ClaudeSkillDir\\SKILL.md"
} else {
	Write-Host "Skipping Claude Code skill (skills\\claude-code\\SKILL.md not found)"
}

# Codex skill
$CodexSkillDir = Join-Path $env:USERPROFILE ".codex\\skills\\agent-memory"
$CodexSkillSrc = Join-Path $ProjectDir "skills\\codex\\SKILL.md"
if (Test-Path $CodexSkillSrc) {
	New-Item -ItemType Directory -Force -Path $CodexSkillDir | Out-Null
	Copy-Item -Force $CodexSkillSrc (Join-Path $CodexSkillDir "SKILL.md")
	Write-Host "Installed Codex skill: $CodexSkillDir\\SKILL.md"
} else {
	Write-Host "Skipping Codex skill (skills\\codex\\SKILL.md not found)"
}

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
