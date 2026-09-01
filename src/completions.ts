import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	COMMAND_DESCRIPTIONS,
	COMMAND_OPTIONS,
	COMMANDS,
	GLOBAL_OPTIONS,
	OPTION_SPECS,
	optionDescription,
	PLUGIN_COMMAND_DESCRIPTIONS,
	PLUGIN_COMMAND_OPTIONS,
	PLUGIN_COMMANDS,
	SCRATCHPAD_ACTION_DESCRIPTIONS,
	SCRATCHPAD_ACTION_OPTIONS,
	SCRATCHPAD_ACTIONS,
	SHELL_DESCRIPTIONS,
	WORKER_ACTION_DESCRIPTIONS,
	WORKER_ACTION_OPTIONS,
	WORKER_ACTIONS,
} from "./cli-spec.js";

export type CompletionShell = "bash" | "zsh" | "fish" | "powershell";

export interface CompletionInstallResult {
	shell: CompletionShell;
	completionPath: string;
	profilePath?: string;
	profileUpdated: boolean;
}

export interface CompletionUninstallResult {
	shell: CompletionShell;
	completionPath: string;
	removed: boolean;
	profilePath?: string;
	profileUpdated: boolean;
}

function words(values: readonly string[]): string {
	return values.join(" ");
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function powerShellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function zshOptionValue(command: string, option: string): string {
	if (option === "--target") {
		return command === "read"
			? ":target:(daily long_term scratchpad list topic topics)"
			: ":target:(daily long_term topic)";
	}
	if (option === "--mode") return command === "search" ? ":mode:(keyword semantic deep)" : ":mode:(append overwrite)";
	if (option === "--scope") return ":scope:(global current)";
	if (option === "--host") return command === "web" ? ":host:(127.0.0.1 localhost ::1)" : ":host:(pi codex claude)";
	if (option === "--only") return ":agent:(claude codex cursor opencode pi)";
	const value = OPTION_SPECS[option]?.value;
	if (value?.kind === "directory") return `:${value.label}:_directories`;
	if (value?.kind === "file") return `:${value.label}:_files`;
	if (value) return `:${value.label}:`;
	return "";
}

function zshOptionSpecs(command: string, options: readonly string[] = COMMAND_OPTIONS[command] ?? []): string {
	return options
		.map((option) => shellSingleQuote(`${option}[${optionDescription(option)}]${zshOptionValue(command, option)}`))
		.join(" ");
}

function fishOption(command: string, condition: string, option: string): string {
	const spec = OPTION_SPECS[option];
	const value = spec?.value ? " -r" : "";
	let suggestions = "";
	if (option === "--target")
		suggestions =
			command === "read" ? " -a 'daily long_term scratchpad list topic topics'" : " -a 'daily long_term topic'";
	else if (option === "--mode")
		suggestions = command === "search" ? " -a 'keyword semantic deep'" : " -a 'append overwrite'";
	else if (option === "--scope") suggestions = " -a 'global current'";
	else if (option === "--host")
		suggestions = command === "web" ? " -a '127.0.0.1 localhost ::1'" : " -a 'pi codex claude'";
	else if (option === "--only") suggestions = " -a 'claude codex cursor opencode pi'";
	else if (spec?.value?.kind === "directory") suggestions = " -a '(__fish_complete_directories)'";
	else if (spec?.value?.kind === "file") suggestions = " -F";
	return `complete -c agent-memory -n ${shellSingleQuote(condition)} -l ${option.slice(2)}${value}${suggestions} -d ${shellSingleQuote(optionDescription(option))}`;
}

function bashCompletion(): string {
	return `# agent-memory completion for Bash
# Installed automatically by: agent-memory completion bash
# Print this script instead with: agent-memory completion bash --stdout
_agent_memory_completion() {
  local cur command sub action
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  command="\${COMP_WORDS[1]}"
  sub="\${COMP_WORDS[2]}"
  action="\${COMP_WORDS[3]}"

  if [[ "$cur" == --*=* ]]; then return 0; fi
  case "\${COMP_WORDS[COMP_CWORD-1]}" in
    --target)
      if [[ "$command" == read ]]; then COMPREPLY=( $(compgen -W "daily long_term scratchpad list topic topics" -- "$cur") );
      else COMPREPLY=( $(compgen -W "daily long_term topic" -- "$cur") ); fi; return 0 ;;
    --mode)
      if [[ "$command" == search ]]; then COMPREPLY=( $(compgen -W "keyword semantic deep" -- "$cur") );
      else COMPREPLY=( $(compgen -W "append overwrite" -- "$cur") ); fi; return 0 ;;
    --scope) COMPREPLY=( $(compgen -W "global current" -- "$cur") ); return 0 ;;
    --host)
      if [[ "$command" == web ]]; then COMPREPLY=( $(compgen -W "127.0.0.1 localhost ::1" -- "$cur") );
      else COMPREPLY=( $(compgen -W "pi codex claude" -- "$cur") ); fi; return 0 ;;
    --only) COMPREPLY=( $(compgen -W "claude codex cursor opencode pi" -- "$cur") ); return 0 ;;
    --dir|--cwd|--pi|--codex|--claude|--state|--journal|--candidates-dir|--decisions-dir|--auto-dir|--output)
      COMPREPLY=( $(compgen -f -- "$cur") ); return 0 ;;
  esac

  if (( COMP_CWORD == 1 )); then
    COMPREPLY=( $(compgen -W "${words(COMMANDS)}" -- "$cur") ); return 0
  fi
  if [[ "$command" == plugin && $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "${words(PLUGIN_COMMANDS)}" -- "$cur") ); return 0
  fi
  if [[ "$command" == plugin && "$sub" == worker && $COMP_CWORD -eq 3 ]]; then
    COMPREPLY=( $(compgen -W "${words(WORKER_ACTIONS)}" -- "$cur") ); return 0
  fi
  if [[ "$command" == scratchpad && $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "${words(SCRATCHPAD_ACTIONS)}" -- "$cur") ); return 0
  fi
  if [[ "$command" == completion && $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "bash zsh fish powershell" -- "$cur") ); return 0
  fi
  local command_options=""
  if [[ "$command" == plugin ]]; then
    case "$sub" in
${Object.entries(PLUGIN_COMMAND_OPTIONS)
	.map(([command, options]) => `      ${command}) command_options="${words(options)}" ;;`)
	.join("\n")}
    esac
    if [[ "$sub" == worker && -n "$action" ]]; then
      case "$action" in
${Object.entries(WORKER_ACTION_OPTIONS)
	.map(([action, options]) => `        ${action}) command_options="${words(options)}" ;;`)
	.join("\n")}
      esac
    fi
  elif [[ "$command" == scratchpad && -n "$sub" ]]; then
    case "$sub" in
${Object.entries(SCRATCHPAD_ACTION_OPTIONS)
	.map(([action, options]) => `      ${action}) command_options="${words(options)}" ;;`)
	.join("\n")}
    esac
  else
    case "$command" in
${Object.entries(COMMAND_OPTIONS)
	.map(([command, options]) => `    ${command}) command_options="${words(options)}" ;;`)
	.join("\n")}
    esac
  fi
  COMPREPLY=( $(compgen -W "${words(GLOBAL_OPTIONS)} $command_options" -- "$cur") )
}
complete -F _agent_memory_completion agent-memory
`;
}

function zshCompletion(): string {
	return `#compdef agent-memory
# agent-memory completion for Zsh
# Installed automatically by: agent-memory completion zsh
# Print this script instead with: agent-memory completion zsh --stdout
_agent-memory() {
  local -a commands plugin_commands worker_actions scratchpad_actions shells
  local command="$words[2]"
  local subcommand="$words[3]"
	local action="$words[4]"
  local command_position=$CURRENT
  commands=(${COMMANDS.map((command) => shellSingleQuote(`${command}:${COMMAND_DESCRIPTIONS[command] ?? command}`)).join(" ")})
  plugin_commands=(${PLUGIN_COMMANDS.map((command) => shellSingleQuote(`${command}:${PLUGIN_COMMAND_DESCRIPTIONS[command]}`)).join(" ")})
  worker_actions=(${WORKER_ACTIONS.map((action) => shellSingleQuote(`${action}:${WORKER_ACTION_DESCRIPTIONS[action]}`)).join(" ")})
  scratchpad_actions=(${SCRATCHPAD_ACTIONS.map((action) => shellSingleQuote(`${action}:${SCRATCHPAD_ACTION_DESCRIPTIONS[action]}`)).join(" ")})
  shells=(${Object.entries(SHELL_DESCRIPTIONS)
		.map(([shell, description]) => shellSingleQuote(`${shell}:${description}`))
		.join(" ")})

  _arguments -C \\
    '(-h --help)'{-h,--help}'[show help]' \\
    '(-V --version)'{-V,--version}'[show version]' \\
    '--json[emit structured JSON]' \\
    '--dir[memory directory]:directory:_directories' \\
    '1:command:->command' \\
    '*::argument:->args'

  case $state in
    command) _describe 'command' commands ;;
    args)
      case $command in
        plugin)
          if (( command_position == 3 )); then _describe 'plugin command' plugin_commands
		  elif [[ "$subcommand" == worker ]] && (( command_position == 4 )); then _describe 'worker action' worker_actions
          else
            if [[ "$subcommand" == worker && -n "$action" ]]; then
			  case "$action" in
${Object.entries(WORKER_ACTION_OPTIONS)
	.map(
		([action, options]) =>
			`                ${action}) _arguments ${zshOptionSpecs(`plugin:worker:${action}`, options)} ;;`,
	)
	.join("\n")}
			  esac
			else
			  case "$subcommand" in
${Object.entries(PLUGIN_COMMAND_OPTIONS)
	.map(
		([command, options]) => `              ${command}) _arguments ${zshOptionSpecs(`plugin:${command}`, options)} ;;`,
	)
	.join("\n")}
			  esac
			fi
          fi ;;
        scratchpad)
          if (( command_position == 3 )); then _describe 'action' scratchpad_actions
          else
            case "$subcommand" in
${Object.entries(SCRATCHPAD_ACTION_OPTIONS)
	.map(([action, options]) => `              ${action}) _arguments ${zshOptionSpecs("scratchpad", options)} ;;`)
	.join("\n")}
            esac
          fi ;;
		completion)
		  if (( command_position == 3 )); then _describe 'shell' shells
		  else _arguments ${zshOptionSpecs("completion")}; fi ;;
${Object.keys(COMMAND_OPTIONS)
	.filter((command) => command !== "plugin" && command !== "scratchpad" && command !== "completion")
	.map((command) => `        ${command}) _arguments ${zshOptionSpecs(command)} ;;`)
	.join("\n")}
        *) _arguments ;;
      esac ;;
  esac
}
compdef _agent-memory agent-memory
`;
}

function fishCompletion(): string {
	const lines = [
		"# agent-memory completion for Fish",
		"# Installed automatically by: agent-memory completion fish",
		"# Print this script instead with: agent-memory completion fish --stdout",
		"complete -c agent-memory -f",
		...COMMANDS.map(
			(command) =>
				`complete -c agent-memory -n '__fish_use_subcommand' -a '${command}' -d ${shellSingleQuote(COMMAND_DESCRIPTIONS[command] ?? command)}`,
		),
		...PLUGIN_COMMANDS.map(
			(command) =>
				`complete -c agent-memory -n '__fish_seen_subcommand_from plugin; and not __fish_seen_subcommand_from ${words(PLUGIN_COMMANDS)}' -a '${command}' -d ${shellSingleQuote(PLUGIN_COMMAND_DESCRIPTIONS[command])}`,
		),
		...WORKER_ACTIONS.map(
			(action) =>
				`complete -c agent-memory -n '__fish_seen_subcommand_from plugin; and __fish_seen_subcommand_from worker; and not __fish_seen_subcommand_from ${words(WORKER_ACTIONS)}' -a '${action}' -d ${shellSingleQuote(WORKER_ACTION_DESCRIPTIONS[action])}`,
		),
		...SCRATCHPAD_ACTIONS.map(
			(action) =>
				`complete -c agent-memory -n '__fish_seen_subcommand_from scratchpad; and not __fish_seen_subcommand_from ${words(SCRATCHPAD_ACTIONS)}' -a '${action}' -d ${shellSingleQuote(SCRATCHPAD_ACTION_DESCRIPTIONS[action])}`,
		),
		...Object.entries(SHELL_DESCRIPTIONS).map(
			([shell, description]) =>
				`complete -c agent-memory -n '__fish_seen_subcommand_from completion' -a '${shell}' -d ${shellSingleQuote(description)}`,
		),
		"complete -c agent-memory -l dir -r -a '(__fish_complete_directories)' -d 'override the active memory directory'",
		"complete -c agent-memory -l json -d 'emit command-specific structured JSON'",
		"complete -c agent-memory -s h -l help -d 'show help for the selected command'",
		"complete -c agent-memory -s V -l version -d 'print the installed version and exit'",
	];
	for (const [command, options] of Object.entries(COMMAND_OPTIONS)) {
		if (command === "scratchpad") continue;
		for (const option of options) {
			lines.push(fishOption(command, `__fish_seen_subcommand_from ${command}`, option));
		}
	}
	for (const [subcommand, options] of Object.entries(PLUGIN_COMMAND_OPTIONS)) {
		if (subcommand === "worker") continue;
		for (const option of options) {
			lines.push(
				fishOption(
					`plugin:${subcommand}`,
					`__fish_seen_subcommand_from plugin; and __fish_seen_subcommand_from ${subcommand}`,
					option,
				),
			);
		}
	}
	for (const [action, options] of Object.entries(WORKER_ACTION_OPTIONS)) {
		for (const option of options) {
			lines.push(
				fishOption(
					`plugin:worker:${action}`,
					`__fish_seen_subcommand_from plugin; and __fish_seen_subcommand_from worker; and __fish_seen_subcommand_from ${action}`,
					option,
				),
			);
		}
	}
	for (const [action, options] of Object.entries(SCRATCHPAD_ACTION_OPTIONS)) {
		for (const option of options) {
			lines.push(
				fishOption(
					"scratchpad",
					`__fish_seen_subcommand_from scratchpad; and __fish_seen_subcommand_from ${action}`,
					option,
				),
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

function powershellCompletion(): string {
	const psOptions = (options: readonly string[]) => (options.length ? `@('${options.join("','")}')` : "@()");
	const optionCases = Object.entries(COMMAND_OPTIONS)
		.map(([command, options]) => `      '${command}' { $candidates += ${psOptions(options)} }`)
		.join("\n");
	const pluginOptionCases = Object.entries(PLUGIN_COMMAND_OPTIONS)
		.map(([command, options]) => `        '${command}' { $candidates += ${psOptions(options)} }`)
		.join("\n");
	const workerOptionCases = Object.entries(WORKER_ACTION_OPTIONS)
		.map(([action, options]) => `        '${action}' { $candidates += ${psOptions(options)} }`)
		.join("\n");
	const scratchpadOptionCases = Object.entries(SCRATCHPAD_ACTION_OPTIONS)
		.map(([action, options]) => `        '${action}' { $candidates += ${psOptions(options)} }`)
		.join("\n");
	return `# agent-memory completion for PowerShell
# Installed automatically by: agent-memory completion powershell
# Print this script instead with: agent-memory completion powershell --stdout
Register-ArgumentCompleter -Native -CommandName agent-memory -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
  $commands = @('${COMMANDS.join("','")}')
  $pluginCommands = @('${PLUGIN_COMMANDS.join("','")}')
  $workerActions = @('${WORKER_ACTIONS.join("','")}')
  $scratchpadActions = @('${SCRATCHPAD_ACTIONS.join("','")}')
  $shells = @('bash','zsh','fish','powershell')
  $commandDescriptions = @{
${Object.entries(COMMAND_DESCRIPTIONS)
	.map(([command, description]) => `    '${command}' = ${powerShellSingleQuote(description)}`)
	.join("\n")}
  }
  $pluginCommandDescriptions = @{
${Object.entries(PLUGIN_COMMAND_DESCRIPTIONS)
	.map(([command, description]) => `    '${command}' = ${powerShellSingleQuote(description)}`)
	.join("\n")}
  }
  $workerActionDescriptions = @{
${Object.entries(WORKER_ACTION_DESCRIPTIONS)
	.map(([action, description]) => `    '${action}' = ${powerShellSingleQuote(String(description))}`)
	.join("\n")}
  }
  $scratchpadActionDescriptions = @{
${Object.entries(SCRATCHPAD_ACTION_DESCRIPTIONS)
	.map(([action, description]) => `    '${action}' = ${powerShellSingleQuote(description)}`)
	.join("\n")}
  }
  $shellDescriptions = @{
${Object.entries(SHELL_DESCRIPTIONS)
	.map(([shell, description]) => `    '${shell}' = ${powerShellSingleQuote(description)}`)
	.join("\n")}
  }
  $optionDescriptions = @{
${Object.keys(OPTION_SPECS)
	.map((option) => `    '${option}' = ${powerShellSingleQuote(optionDescription(option))}`)
	.join("\n")}
  }
  $globalOptions = @('${GLOBAL_OPTIONS.join("','")}')
  $command = if ($tokens.Count -gt 1) { $tokens[1] } else { '' }
  $subcommand = if ($tokens.Count -gt 2) { $tokens[2] } else { '' }
  $action = if ($tokens.Count -gt 3) { $tokens[3] } else { '' }
  $candidates = @()
  $candidateDescriptions = @{}

  if ($tokens.Count -le 2) { $candidates = $commands + $globalOptions; $candidateDescriptions = $commandDescriptions }
  elseif ($command -eq 'plugin' -and $tokens.Count -le 4 -and $tokens[2] -eq 'worker') { $candidates = $workerActions + $globalOptions; $candidateDescriptions = $workerActionDescriptions }
  elseif ($command -eq 'plugin' -and $tokens.Count -le 3) { $candidates = $pluginCommands + $globalOptions; $candidateDescriptions = $pluginCommandDescriptions }
  elseif ($command -eq 'scratchpad' -and $tokens.Count -le 3) { $candidates = $scratchpadActions + $globalOptions; $candidateDescriptions = $scratchpadActionDescriptions }
  elseif ($command -eq 'completion' -and $tokens.Count -le 3) { $candidates = $shells; $candidateDescriptions = $shellDescriptions }
  else {
    $candidates = $globalOptions
    $candidateDescriptions = $optionDescriptions
    if ($command -eq 'plugin') {
      if ($subcommand -eq 'worker' -and $action) {
        switch ($action) {
${workerOptionCases}
        }
      } else {
        switch ($subcommand) {
${pluginOptionCases}
        }
      }
    } elseif ($command -eq 'scratchpad') {
      switch ($subcommand) {
${scratchpadOptionCases}
      }
    } else {
      switch ($command) {
${optionCases}
      }
    }
  }

  $candidates | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    $description = if ($candidateDescriptions.ContainsKey($_)) { $candidateDescriptions[$_] } elseif ($optionDescriptions.ContainsKey($_)) { $optionDescriptions[$_] } else { $_ }
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $description)
  }
}
`;
}

export function generateCompletion(shell: CompletionShell): string {
	switch (shell) {
		case "bash":
			return bashCompletion();
		case "zsh":
			return zshCompletion();
		case "fish":
			return fishCompletion();
		case "powershell":
			return powershellCompletion();
	}
}

export function detectCompletionShell(
	environment: Record<string, string | undefined> = process.env,
	platform = process.platform,
): CompletionShell | null {
	const shell = path.basename(environment.SHELL ?? "").toLowerCase();
	if (shell === "bash" || shell === "zsh" || shell === "fish") return shell;
	if (shell.includes("pwsh") || shell.includes("powershell")) return "powershell";
	if (platform === "win32" && environment.PSModulePath) return "powershell";
	return null;
}

function writeCompletionFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
	fs.writeFileSync(filePath, content, { mode: 0o644 });
}

function ensureProfileBlock(filePath: string, lines: string[]): boolean {
	const start = "# >>> agent-memory completion >>>";
	const end = "# <<< agent-memory completion <<<";
	const block = `${start}\n${lines.join("\n")}\n${end}`;
	const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
	const startIndex = current.indexOf(start);
	const endIndex = startIndex === -1 ? -1 : current.indexOf(end, startIndex);
	let updated: string;

	if (startIndex !== -1 && endIndex !== -1) {
		updated = `${current.slice(0, startIndex)}${block}${current.slice(endIndex + end.length)}`;
	} else {
		const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
		updated = `${current}${separator}${block}\n`;
	}
	if (updated === current) return false;
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
	fs.writeFileSync(filePath, updated, { mode: 0o600 });
	return true;
}

/** Reverse of {@link ensureProfileBlock}: strips the marker block, if present, from the given file. */
function removeProfileBlock(filePath: string): boolean {
	const start = "# >>> agent-memory completion >>>";
	const end = "# <<< agent-memory completion <<<";
	if (!fs.existsSync(filePath)) return false;
	const current = fs.readFileSync(filePath, "utf8");
	const startIndex = current.indexOf(start);
	const endIndex = startIndex === -1 ? -1 : current.indexOf(end, startIndex);
	if (startIndex === -1 || endIndex === -1) return false;
	const updated = (current.slice(0, startIndex) + current.slice(endIndex + end.length)).replace(/\n{3,}/g, "\n\n");
	if (updated === current) return false;
	fs.writeFileSync(filePath, updated, { mode: 0o600 });
	return true;
}

function removeCompletionFile(filePath: string): boolean {
	if (!fs.existsSync(filePath)) return false;
	fs.unlinkSync(filePath);
	return true;
}

export function installCompletion(
	shell: CompletionShell,
	options: { homeDir?: string; platform?: NodeJS.Platform } = {},
): CompletionInstallResult {
	const homeDir = options.homeDir ?? os.homedir();
	const platform = options.platform ?? process.platform;
	const completionDir = path.join(homeDir, ".config", "agent-memory", "completions");

	if (shell === "fish") {
		const completionPath = path.join(homeDir, ".config", "fish", "completions", "agent-memory.fish");
		writeCompletionFile(completionPath, generateCompletion(shell));
		return { shell, completionPath, profileUpdated: false };
	}

	const extension = shell === "powershell" ? "ps1" : shell;
	const completionPath = path.join(completionDir, `agent-memory.${extension}`);
	writeCompletionFile(completionPath, generateCompletion(shell));

	if (shell === "bash") {
		const profilePath = path.join(homeDir, ".bashrc");
		const profileUpdated = ensureProfileBlock(profilePath, [
			`if [[ -r "$HOME/.config/agent-memory/completions/agent-memory.bash" ]]; then`,
			`  source "$HOME/.config/agent-memory/completions/agent-memory.bash"`,
			"fi",
		]);
		return { shell, completionPath, profilePath, profileUpdated };
	}

	if (shell === "zsh") {
		const profilePath = path.join(homeDir, ".zshrc");
		const profileUpdated = ensureProfileBlock(profilePath, [
			"autoload -Uz compinit",
			"if (( ! $+functions[compdef] )); then compinit; fi",
			`source "$HOME/.config/agent-memory/completions/agent-memory.zsh"`,
		]);
		return { shell, completionPath, profilePath, profileUpdated };
	}

	const profilePath =
		platform === "win32"
			? path.join(homeDir, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1")
			: path.join(homeDir, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
	const profileUpdated = ensureProfileBlock(profilePath, [
		`. "$HOME/.config/agent-memory/completions/agent-memory.ps1"`,
	]);
	return { shell, completionPath, profilePath, profileUpdated };
}

function uninstallShellCompletion(
	shell: CompletionShell,
	homeDir: string,
	platform: NodeJS.Platform,
): CompletionUninstallResult {
	const completionDir = path.join(homeDir, ".config", "agent-memory", "completions");

	if (shell === "fish") {
		const completionPath = path.join(homeDir, ".config", "fish", "completions", "agent-memory.fish");
		return { shell, completionPath, removed: removeCompletionFile(completionPath), profileUpdated: false };
	}

	const extension = shell === "powershell" ? "ps1" : shell;
	const completionPath = path.join(completionDir, `agent-memory.${extension}`);
	const removed = removeCompletionFile(completionPath);

	if (shell === "bash") {
		const profilePath = path.join(homeDir, ".bashrc");
		return { shell, completionPath, removed, profilePath, profileUpdated: removeProfileBlock(profilePath) };
	}

	if (shell === "zsh") {
		const profilePath = path.join(homeDir, ".zshrc");
		return { shell, completionPath, removed, profilePath, profileUpdated: removeProfileBlock(profilePath) };
	}

	const profilePath =
		platform === "win32"
			? path.join(homeDir, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1")
			: path.join(homeDir, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
	return { shell, completionPath, removed, profilePath, profileUpdated: removeProfileBlock(profilePath) };
}

/** Reverse of {@link installCompletion} across every supported shell. */
export function uninstallCompletion(
	options: { homeDir?: string; platform?: NodeJS.Platform } = {},
): CompletionUninstallResult[] {
	const homeDir = options.homeDir ?? os.homedir();
	const platform = options.platform ?? process.platform;
	return (["bash", "zsh", "fish", "powershell"] as const).map((shell) =>
		uninstallShellCompletion(shell, homeDir, platform),
	);
}
