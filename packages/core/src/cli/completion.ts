/**
 * Print a bash or zsh completion script for `mba`.
 * Install: eval "$(mba completion)"  or  mba completion zsh
 */

const GROUPS = "models m servers server s machine status help completion migrate-paths estimate-memory";
const MODEL_SUB = "list show set open pull search edit";
const SERVER_SUB = "list boot stop logs";
const MACHINE_SUB = "enforce warn off";

function bashScript(): string {
  return `# mba completion
_mba() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${GROUPS}" -- "\$cur") )
    return
  fi

  local cmd="\${COMP_WORDS[1]}"
  case "\$cmd" in
    models|m)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        local ids
        ids=$(mba models list --json 2>/dev/null | command sed -n 's/.*"id": "\\([^"]*\\)".*/\\1/p')
        COMPREPLY=( $(compgen -W "${MODEL_SUB} \$ids" -- "\$cur") )
      elif [[ "\$prev" == "show" || "\$prev" == "set" || "\$prev" == "open" || "\$prev" == "edit" ]]; then
        local ids
        ids=$(mba models list --json 2>/dev/null | command sed -n 's/.*"id": "\\([^"]*\\)".*/\\1/p')
        COMPREPLY=( $(compgen -W "\$ids" -- "\$cur") )
      fi
      ;;
    servers|server|s)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "${SERVER_SUB}" -- "\$cur") )
      elif [[ "\$prev" == "boot" ]]; then
        local ids
        ids=$(mba models list --json 2>/dev/null | command sed -n 's/.*"id": "\\([^"]*\\)".*/\\1/p')
        COMPREPLY=( $(compgen -W "\$ids" -- "\$cur") )
      fi
      ;;
    machine|machine-overlay)
      COMPREPLY=( $(compgen -W "${MACHINE_SUB}" -- "\$cur") )
      ;;
    completion)
      COMPREPLY=( $(compgen -W "bash zsh" -- "\$cur") )
      ;;
    help)
      COMPREPLY=( $(compgen -W "models servers machine status" -- "\$cur") )
      ;;
  esac
}
complete -F _mba mba
`;
}

function zshScript(): string {
  return `#compdef mba
_mba() {
  local -a groups modelsubs serversubs
  groups=(models m servers server s machine status help completion migrate-paths estimate-memory)
  modelsubs=(list show set open pull search edit)
  serversubs=(list boot stop logs)
  case $CURRENT in
    2) _describe 'command' groups ;;
    *)
      case $words[2] in
        models|m)
          local -a ids
          ids=(\${(f)"$(mba models list --json 2>/dev/null | command sed -n 's/.*"id": "\\([^"]*\\)".*/\\1/p')"})
          _describe 'models' modelsubs && _describe 'id' ids
          ;;
        servers|server|s) _describe 'servers' serversubs ;;
        machine) _describe 'mode' '(enforce warn off)' ;;
        completion) _describe 'shell' '(bash zsh)' ;;
        help) _describe 'topic' '(models servers machine status)' ;;
      esac
      ;;
  esac
}
_mba
`;
}

export function cmdCompletion(args: readonly string[]): void {
  const shell = args[0] ?? "bash";
  if (shell === "zsh") {
    process.stdout.write(zshScript());
    return;
  }
  if (shell === "bash" || shell === undefined) {
    process.stdout.write(bashScript());
    return;
  }
  process.stderr.write(`[mba] unknown completion shell '${shell}' — use bash or zsh\n`);
  process.exit(2);
}
