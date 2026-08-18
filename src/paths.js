import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Absolute path of the node binary running this dsh invocation. */
export function resolveNode() {
  return process.execPath
}

/**
 * Absolute path of the dsh CLI entry script.
 *
 * `process.argv[1]` is the path the launcher was invoked through; it may be a
 * symlink (fnm's `aliases/default/bin/dsh`), so realpath it to the real
 * `lib/bin.js`. Running `<node> <bin.js> web` is byte-for-byte equivalent to
 * `dsh web` and avoids depending on shebang resolution or PATH in the unit.
 */
export function resolveDshBin() {
  if (!process.argv[1]) throw new Error('cannot resolve the dsh entry script (process.argv[1] missing)')
  return realpathSync(process.argv[1])
}

/** The dsh home directory: $DSH_HOME or ~/.dsh. */
export function resolveDshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** Where the user-scope systemd unit lives. */
export function resolveUnitPath() {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configHome, 'systemd', 'user', 'dsh-daemon.service')
}

/** Resolve and validate the daemon's working directory (defaults to $HOME). */
export function resolveWorkingDirectory(cwd) {
  if (!cwd) return homedir()
  const abs = resolve(cwd)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`--cwd is not a directory: ${abs}`)
  }
  return abs
}

/** The directory holding `node`, used to build a sane PATH for the unit. */
export function nodeBinDir() {
  return dirname(resolveNode())
}
