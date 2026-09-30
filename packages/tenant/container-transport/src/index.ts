/**
 * Transport seams a container-runtime provider is constructed with, separated
 * from the provider so its mount, naming, routing, and lifecycle logic is
 * unit-tested against fakes for a child process and an HTTP round trip.
 * @module @deepseek-ai/dsh-container-transport
 */

export { cliRunner } from './cli-runner.ts'
export type { ContainerCliRunner } from './cli-runner.ts'
export { execToolCommand } from './tool-exec.ts'
export type { ToolExecClient, ToolExecRequest, ToolExecResult } from './tool-exec.ts'
