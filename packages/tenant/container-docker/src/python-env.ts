/**
 * Host-side reads for the Python environment `container-docker` mounts into
 * every sandbox. A deployment keeps one Python runtime on the host and mounts
 * it read-only, so the sandbox image carries no interpreter and an operator
 * reaches every sandbox by updating that one directory. Which environment
 * variables the sandbox needs follows from that directory's layout, which is
 * read on the host: the container's start arguments are fixed for its lifetime.
 * @module @deepseek-ai/dsh-container-docker/python-env
 */

import { readdirSync, statSync } from 'node:fs'

/** The host filesystem reads that resolving a mounted Python environment needs. */
export interface HostPathProbe {
  /**
   * Whether `path` exists as a directory.
   * @param path - absolute host path.
   * @returns true only for an existing directory.
   */
  isDirectory(path: string): boolean
  /**
   * Whether `path` exists as a regular file.
   * @param path - absolute host path.
   * @returns true only for an existing file.
   */
  isFile(path: string): boolean
  /**
   * The entry names directly under `path`.
   * @param path - absolute host path.
   * @returns the entry names, or an empty list when `path` is not a readable directory.
   */
  readdir(path: string): string[]
}

/**
 * Read the host filesystem directly. A `statSync` with `throwIfNoEntry: false`
 * reports a missing path and a dangling symlink alike, as absent, which is what
 * every caller asks.
 */
export const hostPathProbe: HostPathProbe = {
  isDirectory: path => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false,
  isFile: path => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
  readdir: (path) => {
    try {
      return readdirSync(path)
    } catch {
      // `path` is missing, a file, or unreadable; each yields no candidate and
      // nothing else reaches this call.
      return []
    }
  },
}

/** The parts of a mounted Python environment the sandbox must be pointed at. */
export interface PythonEnvironment {
  /** Host absolute path the environment is mounted at, unchanged inside the sandbox. */
  root: string
  /** `<root>/bin`, which goes to the front of `PATH`. Absent when that directory does not exist. */
  bin?: string
  /** `<root>`, exported as `VIRTUAL_ENV`. Absent unless `<root>/pyvenv.cfg` marks a virtual environment. */
  virtualEnv?: string
  /** Existing `<root>/lib/python3.<minor>/site-packages` directories, joined for `PYTHONPATH`. Absent when there is none. */
  sitePackages?: string
}

/** The directory name a CPython environment installs its packages under, e.g. `python3.11`. */
const SITE_PACKAGES_VERSION = /^python3\.\d+$/u

/**
 * Resolve what a mounted Python environment needs, from the layout the host
 * actually has. The three probes are independent: a directory holding only
 * `bin` gets `PATH` alone, `pyvenv.cfg` adds `VIRTUAL_ENV`, and
 * `PYTHONPATH` follows the packages the environment installed.
 *
 * Paths join with `/` and `PYTHONPATH` joins with `:` whatever the host
 * runs: these are container paths, handed to `docker -v` and to a Linux
 * interpreter.
 *
 * @param root - host absolute path of the environment to mount.
 * @param probe - host filesystem reads ({@link hostPathProbe} in production; injected for deterministic tests).
 * @returns the directories to expose, each field present only when the host has it.
 * @throws when `root` is not a directory this process can read, or holds none
 *   of the three markers — either way the mount would configure nothing, which
 *   looks exactly like a working deployment.
 */
export function resolvePythonEnvironment(root: string, probe: HostPathProbe): PythonEnvironment {
  if (!probe.isDirectory(root)) throw new Error(unreadableRootMessage(root))
  const environment: PythonEnvironment = { root }
  if (probe.isDirectory(`${root}/bin`)) environment.bin = `${root}/bin`
  if (probe.isFile(`${root}/pyvenv.cfg`)) environment.virtualEnv = root
  const sitePackages = probe.readdir(`${root}/lib`)
    .filter(entry => SITE_PACKAGES_VERSION.test(entry))
    .sort()
    .map(entry => `${root}/lib/${entry}/site-packages`)
    .filter(path => probe.isDirectory(path))
  if (sitePackages.length > 0) environment.sitePackages = sitePackages.join(':')
  if (environment.bin === undefined && environment.virtualEnv === undefined && environment.sitePackages === undefined) {
    throw new Error(emptyRootMessage(root))
  }
  return environment
}

/**
 * The diagnostic for a configured `pythonRoot` this process cannot read. The
 * harness reads that directory itself before handing the path to the container
 * runtime, so a path only the container daemon resolves is the usual cause: the
 * mount lands as an empty directory and the sandbox starts with no interpreter.
 * @param root - the configured host path.
 * @returns the message naming the path, the cause, and both ways out.
 */
function unreadableRootMessage(root: string): string {
  return `container-docker: pythonRoot '${root}' is not a directory this process can read, so no Python environment could be mounted. `
    + 'The harness reads that directory itself, so it must be visible inside the process running dsh: when dsh runs in its own container, mount the host directory into that container at the same absolute path '
    + `(docker run -v ${root}:${root}:ro). Drop pythonRoot to run without a mounted environment.`
}

/**
 * The diagnostic for a configured `pythonRoot` that is a directory with no
 * environment in it. Docker creates a missing bind-mount source as an empty
 * directory, so this is how a mount whose environment was never built at that
 * path presents itself.
 * @param root - the configured host path.
 * @returns the message naming the path, the three markers it lacks, the likely
 *   cause, and both ways out.
 */
function emptyRootMessage(root: string): string {
  return `container-docker: pythonRoot '${root}' is a directory holding no Python environment: it has no bin, no pyvenv.cfg, and no lib/python3.<minor>/site-packages, so the mount would set no variable at all. `
    + 'Docker creates a missing bind-mount source as an empty directory, so this is usually an environment that was never built at that path: install a complete relocatable Python (interpreter, standard library, and packages in this one directory) there, '
    + 'or drop pythonRoot to run without a mounted environment.'
}
