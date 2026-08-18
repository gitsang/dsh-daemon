import { spawn } from 'node:child_process'

/**
 * Run a command with the terminal attached, resolving to its exit code.
 * `stdio: 'inherit'` keeps status/logs interactive and lets Ctrl-C reach the
 * child (same foreground process group) for `journalctl -f`.
 */
export function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' })
    child.on('error', (err) => {
      process.stderr.write(`dsh-daemon: ${cmd}: ${err.message}\n`)
      resolve(1)
    })
    child.on('close', (code, signal) => {
      resolve(signal ? 1 : code ?? 0)
    })
  })
}

export const systemctl = (...args) => run('systemctl', ['--user', ...args])
export const journalctl = (...args) => run('journalctl', ['--user', ...args])
