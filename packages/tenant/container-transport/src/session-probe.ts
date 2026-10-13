/**
 * In-sandbox process facts for one interactive session, built as POSIX shell
 * programs and parsed as plain text so both halves are unit-testable without a
 * container.
 *
 * A session's identity is read from `/proc/<pid>/stat` directly, not through
 * `ps`: that every member inherits one session id, and that the terminal's
 * foreground group is the `tpgid` field they report, needs no process tool the
 * image may or may not install.
 *
 * @module @deepseek-ai/dsh-container-transport/session-probe
 */

import type { ContainerPtySignal } from '@deepseek-ai/dsh-container'

/** One line prefix the state probe writes for each live session member. */
const MEMBER = 'DSH_PTY_MEMBER'

/** One line prefix the state probe writes for the session's leader. */
const LEADER = 'DSH_PTY_LEADER'

/** One line prefix the handshake writes for the session it runs in. */
export const SESSION_HANDSHAKE = 'DSH_PTY_SESSION'

/** What one handshake reported about the terminal that runs it. */
export interface ContainerPtyHandshake {
  /** Session id shared by every process of the session. */
  sessionId: number
  /** Index just past the handshake's own line, i.e. the first byte of real output. */
  end: number
}

/** Process facts one state probe observed about a session. */
export interface ContainerPtyState {
  /** Process groups with at least one live member, in probe order and deduplicated. */
  groups: number[]
  /** The terminal's foreground process group; absent when the terminal has none. */
  foregroundPgid?: number
  /** Process group of the session's leader, while the leader is still alive. */
  leaderPgid?: number
}

/**
 * The line that makes an interactive shell report its own session.
 *
 * It runs inside the shell the session was opened with, so the shell answers
 * for itself; the fields come from `/proc/self/stat` rather than from `$$`,
 * because a shell may run the substitution in a child and only the session id
 * is inherited unchanged. Written in POSIX shell so it works under `bash`,
 * `dash`, and `sh`.
 *
 * @returns the line to write into the session's terminal, including its newline.
 */
export function handshakeLine(): string {
  return `printf '${SESSION_HANDSHAKE} %s\\n' "$(read -r l < /proc/self/stat; l=\${l##*) }; set -- $l; printf '%s' "$4")"\n`
}

/**
 * Read the session a handshake reported.
 *
 * The line travels through a shell that echoes what it is given, so the marker
 * also appears as literal text inside the echo; only a marker followed by
 * digits and a newline is the report itself. Output before `end` is boot noise.
 *
 * @param output - the session's output so far.
 * @returns the reported session, or `undefined` until the line has arrived.
 */
export function parseHandshake(output: string): ContainerPtyHandshake | undefined {
  // A terminal translates the newline it prints into CR LF, so the report
  // arrives as `\r\n`; a plain newline is what a non-terminal stream would send.
  const pattern = new RegExp(`${SESSION_HANDSHAKE} (\\d+)\\r?\\n`, 'g')
  const matches = [...output.matchAll(pattern)]
  const last = matches.at(-1)
  if (last === undefined || last.index === undefined) return undefined
  return { sessionId: Number(last[1]), end: last.index + last[0].length }
}

/**
 * The program that lists a session's live process groups and its terminal's
 * foreground group.
 *
 * Zombies are skipped: a group whose every member has exited holds no terminal
 * and must not count as a survivor, and its `tpgid` field is stale. `set --`
 * splits the `/proc` line after `comm`, which can itself contain spaces and
 * parentheses; positional parameters then are state, ppid, pgrp, session,
 * tty_nr, tpgid.
 *
 * @param sessionId - the session to inspect.
 * @returns a POSIX shell program printing one line per fact.
 */
export function stateScript(sessionId: number): string {
  const fields = 'l=${l##*) }; set -- $l'
  return [
    'for d in /proc/[0-9]*; do',
    '  [ -r "$d/stat" ] || continue',
    '  read -r l < "$d/stat" || continue',
    `  ${fields}`,
    '  case "$1" in Z|X|x) continue ;; esac',
    `  [ "$4" = "${String(sessionId)}" ] || continue`,
    `  printf '${MEMBER} %s %s\\n' "$3" "$6"`,
    'done',
    `read -r l < /proc/${String(sessionId)}/stat 2>/dev/null || exit 0`,
    `${fields}`,
    'case "$1" in Z|X|x) exit 0 ;; esac',
    `printf '${LEADER} %s %s\\n' "$3" "$6"`,
    '',
  ].join('\n')
}

/**
 * Read one state probe's output.
 *
 * A `tpgid` of `-1` is the kernel's way of saying the terminal has no
 * foreground group, so it is reported as absent rather than as a group id.
 *
 * @param output - the probe's stdout.
 * @returns the observed groups and foreground group.
 */
export function parseState(output: string): ContainerPtyState {
  const groups: number[] = []
  let foregroundPgid: number | undefined
  let leaderPgid: number | undefined
  for (const line of output.split('\n')) {
    const [prefix, first, second] = line.trim().split(/\s+/)
    if (prefix !== MEMBER && prefix !== LEADER) continue
    const pgid = Number(first)
    const tpgid = Number(second)
    if (!Number.isSafeInteger(pgid) || !Number.isSafeInteger(tpgid)) continue
    if (prefix === LEADER) {
      leaderPgid = pgid
    } else if (!groups.includes(pgid)) {
      groups.push(pgid)
    }
    if (foregroundPgid === undefined && tpgid > 0) foregroundPgid = tpgid
  }
  return {
    groups,
    ...foregroundPgid !== undefined ? { foregroundPgid } : {},
    ...leaderPgid !== undefined ? { leaderPgid } : {},
  }
}

/**
 * The interpreter that delivers the signal.
 *
 * `/bin/sh` by absolute path, never a bare `sh` resolved through `PATH`: the
 * builtin of this interpreter is what parses the operand list, so which shell
 * runs is part of what the command means. Every image with a POSIX shell has
 * `/bin/sh`.
 */
const SIGNAL_SHELL = '/bin/sh'

/**
 * The program {@link signalArgv} hands to the interpreter, which reads the
 * signal name from `$1` and the process group from `$2`.
 *
 * `kill` has to be the interpreter's own builtin: a negative operand is what
 * addresses a process group, and the `kill` program an image resolves from
 * `PATH` does not take one. procps-ng's — version 4.0.2 on Debian bookworm —
 * refuses `-s SIGNAL -- -PGID` with a usage error and leaves the group running;
 * dropping `--` does not help, because `-s SIGNAL -PGID` is refused the same way
 * and `-SIGNAL -PGID` exits 0 without signalling the group at all. `${1#SIG}`
 * drops the optional `SIG` prefix, because the builtin takes the `<signal.h>`
 * name without it: `dash` rejects `SIGTERM` outright.
 */
const SIGNAL_PROGRAM = 'kill -s "${1#SIG}" -- "-$2"'

/** The program name the interpreter reports in its own diagnostics. */
const SIGNAL_PROGRAM_NAME = 'sh'

/**
 * The argv that delivers one signal to a whole process group.
 *
 * The signal name and the group travel as the interpreter's positional
 * parameters, so neither is parsed as shell text and neither can change what
 * the command does. The group is addressed by a negative operand, which is why
 * this runs a shell at all rather than the `kill` on `PATH`.
 *
 * @param pgid - the process group to signal.
 * @param signal - the signal name, e.g. `SIGTERM`.
 * @returns the command and arguments for a one-shot container exec.
 */
export function signalArgv(pgid: number, signal: ContainerPtySignal): [string, string[]] {
  return [SIGNAL_SHELL, ['-c', SIGNAL_PROGRAM, SIGNAL_PROGRAM_NAME, signal, String(pgid)]]
}
