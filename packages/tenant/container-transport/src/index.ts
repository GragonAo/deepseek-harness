/**
 * Transport seams a container-runtime provider is constructed with, separated
 * from the provider so its mount, naming, routing, and lifecycle logic is
 * unit-tested against fakes for a child process, an HTTP round trip, and a
 * terminal-holding CLI invocation.
 * @module @deepseek-ai/dsh-container-transport
 */

export { cliRunner } from './cli-runner.ts'
export type { ContainerCliRunner } from './cli-runner.ts'
export { ptyRunner } from './pty-runner.ts'
export type { ContainerPtyRunner, ContainerPtyStart, ContainerPtyTransport } from './pty-runner.ts'
export { openContainerPty } from './pty-session.ts'
export type { ContainerPtyOpen, ContainerSessionExec } from './pty-session.ts'
export { execToolCommand } from './tool-exec.ts'
export type { ToolExecClient, ToolExecRequest, ToolExecResult } from './tool-exec.ts'
