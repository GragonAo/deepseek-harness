import { describe, expect, it } from 'vitest'
import { handshakeLine, parseHandshake, parseState, signalArgv, stateScript } from '../src/session-probe.ts'

describe('parseHandshake', () => {
  it('reports the session from the shell\'s own answer, past its echoed prompt', () => {
    const output = `${handshakeLine()}\r\nDSH_PTY_SESSION 42\r\nbash-5.2# `
    expect(parseHandshake(output)).toEqual({ sessionId: 42, end: output.indexOf('bash-5.2# ') })
  })

  it('accepts the translated newline a terminal reports and the plain one a pipe would', () => {
    expect(parseHandshake('DSH_PTY_SESSION 42\r\nrest')?.sessionId).toBe(42)
    expect(parseHandshake('DSH_PTY_SESSION 42\nrest')?.sessionId).toBe(42)
  })

  it('ignores the echoed handshake text, which carries no digits', () => {
    const echo = 'printf \'DSH_PTY_SESSION %s\\n\' "$(read -r l < /proc/self/stat)"\r\n'
    expect(parseHandshake(echo)).toBeUndefined()
  })

  it('takes the last report when the line ran twice', () => {
    const output = 'DSH_PTY_SESSION 7\nDSH_PTY_SESSION 8\n'
    expect(parseHandshake(output)).toEqual({ sessionId: 8, end: output.length })
  })

  it('stays undefined until the newline arrives', () => {
    expect(parseHandshake('DSH_PTY_SESSION 42')).toBeUndefined()
  })
})

describe('parseState', () => {
  it('collects live groups, the foreground group, and the leader', () => {
    expect(parseState('DSH_PTY_MEMBER 42 42\nDSH_PTY_MEMBER 77 42\nDSH_PTY_LEADER 42 42\n')).toEqual({
      groups: [42, 77],
      foregroundPgid: 42,
      leaderPgid: 42,
    })
  })

  it('reads the kernel\'s -1 foreground as no foreground group', () => {
    expect(parseState('DSH_PTY_MEMBER 42 -1\nDSH_PTY_LEADER 42 -1\n')).toEqual({ groups: [42], leaderPgid: 42 })
  })

  it('ignores unknown lines and unreadable fields', () => {
    expect(parseState('noise\nDSH_PTY_MEMBER x y\nDSH_PTY_MEMBER 42 42\n')).toEqual({
      groups: [42],
      foregroundPgid: 42,
    })
  })

  it('reports nothing for an empty process table', () => {
    expect(parseState('')).toEqual({ groups: [] })
  })
})

describe('stateScript', () => {
  it('checks the requested session and skips zombies', () => {
    const script = stateScript(42)
    expect(script).toContain('[ "$4" = "42" ] || continue')
    expect(script).toContain('case "$1" in Z|X|x) continue ;; esac')
    expect(script).toContain('read -r l < /proc/42/stat 2>/dev/null || exit 0')
  })

  it('lists no group of its own, so callers count what the sandbox reports', () => {
    expect(stateScript(42).startsWith('for d in /proc/[0-9]*; do')).toBe(true)
  })
})

describe('signalArgv', () => {
  it('pins the argv that delivers one signal to a process group', () => {
    expect(signalArgv(42, 'SIGINT')).toEqual([
      '/bin/sh',
      ['-c', 'kill -s "${1#SIG}" -- "-$2"', 'sh', 'SIGINT', '42'],
    ])
  })

  it('names the interpreter by absolute path rather than through PATH', () => {
    expect(signalArgv(42, 'SIGTERM')[0]).toBe('/bin/sh')
  })

  it('carries the signal name and the group as positional parameters', () => {
    const [, args] = signalArgv(4242, 'SIGKILL')
    expect(args.slice(-2)).toEqual(['SIGKILL', '4242'])
  })

  it('keeps both values out of the program text, so neither can change it', () => {
    const [, first] = signalArgv(7, 'SIGHUP')
    const [, second] = signalArgv(4242, 'SIGKILL')
    expect(first[1]).toBe(second[1])
  })
})
