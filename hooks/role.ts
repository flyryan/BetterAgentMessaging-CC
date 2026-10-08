/**
 * What this process is in an agent team: the lead (or any session that is no
 * pane teammate), or a teammate the lead started in a terminal pane of its own.
 *
 * A pane teammate is a separate `claude` process launched with
 * `--agent-name <name> --team-name <team>`; nothing in its environment names
 * it, so the flags are read off the process tree.
 */
export type Role =
  | { kind: 'lead'; chain: string[] }
  | { kind: 'teammate'; name: string; team: string; chain: string[] }

/**
 * Walks up from the shell's parent until it meets a claude process, printing
 * `pid<TAB>command` per step; only that last process's flags are read, so a
 * claude started from a teammate's Bash is not mistaken for the teammate.
 */
export const ROLE_WALK = [
  'p=$PPID',
  'for i in 1 2 3 4 5 6; do',
  '  c=$(ps -o command= -p "$p" 2>/dev/null)',
  '  printf "%s\\t%s\\n" "$p" "$c"',
  '  case "$c" in *claude*) exit 0;; esac',
  '  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ")',
  '  if [ -z "$p" ] || [ "$p" = 1 ]; then exit 0; fi',
  'done',
].join('\n')

export function parseRole(stdout: string): Role {
  const chain = stdout.split('\n').filter(line => line.length > 0)
  const claude = chain.at(-1) ?? ''
  const name = /--agent-name[ =](\S+)/.exec(claude)?.[1]
  const team = /--team-name[ =](\S+)/.exec(claude)?.[1]
  const short = chain.map(line => line.slice(0, 240))

  return name !== undefined && team !== undefined
    ? { kind: 'teammate', name, team, chain: short }
    : { kind: 'lead', chain: short }
}
