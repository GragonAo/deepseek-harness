import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_CWD, DEFAULT_SHELL_ARGS, DEFAULT_SHELL_PATH, resolveConfig, validateConfig } from '../src/config.ts'

describe('terminal-container config', () => {
  it('defaults to the shell type and the sandbox workspace root', () => {
    const resolved = resolveConfig({})
    expect(resolved).toMatchObject({
      backendType: 'shell',
      shellPath: DEFAULT_SHELL_PATH,
      shellArgs: DEFAULT_SHELL_ARGS,
      cwd: DEFAULT_CWD,
    })
    expect(() => validateConfig(resolved)).not.toThrow()
  })

  it('treats an empty shellArgs array as absent, like the loaded schema does', () => {
    expect(resolveConfig({ shellArgs: [] }).shellArgs).toEqual(DEFAULT_SHELL_ARGS)
    expect(resolveConfig({ shellArgs: ['-i'] }).shellArgs).toEqual(['-i'])
  })

  it('exposes the same defaults through the loaded schema', () => {
    const loaded = Config({})
    expect(loaded).toMatchObject({
      backendType: 'shell',
      shellPath: DEFAULT_SHELL_PATH,
      cwd: DEFAULT_CWD,
      rows: 40,
      cols: 160,
    })
  })

  it('rejects a non-positive or non-integer bound', () => {
    expect(() => validateConfig(resolveConfig({ rows: 0 }))).toThrow('rows must be a positive safe integer')
    expect(() => validateConfig(resolveConfig({ pollIntervalMs: 1.5 }))).toThrow(
      'pollIntervalMs must be a positive safe integer',
    )
  })

  it('rejects a read bound wider than the retained scrollback', () => {
    expect(() => validateConfig(resolveConfig({ scrollbackMaxBytes: 1_024, readMaxBytes: 2_048 }))).toThrow(
      'readMaxBytes must not exceed scrollbackMaxBytes',
    )
  })

  it('rejects a send deadline that silence can never settle first', () => {
    expect(() => validateConfig(resolveConfig({ idleSilenceMs: 5_000, timeoutMs: 1_000 }))).toThrow(
      'timeoutMs must be at least idleSilenceMs',
    )
  })

  it('rejects empty identity fields', () => {
    expect(() => validateConfig(resolveConfig({ backendType: '  ' }))).toThrow('backendType must be non-empty')
    expect(() => validateConfig(resolveConfig({ shellPath: '' }))).toThrow('shellPath must be non-empty')
    expect(() => validateConfig(resolveConfig({ cwd: '' }))).toThrow('cwd must be non-empty')
  })
})
