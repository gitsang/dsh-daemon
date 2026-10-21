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

/**
 * Run a command without a terminal and capture bounded output for the Web
 * control surface. Callers get a resolved result for every failure mode; they
 * never construct a shell command from user input.
 */
export function runCapture(cmd, args, { timeoutMs = 30_000, maxBytes = 512 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: 1, signal: null, stdout: '', stderr: `${cmd}: ${err.message}`, truncated: false, timedOut: false })
      return
    }

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false
    let killTimer

    const collect = (stream, chunk) => {
      if (stream === 'stdout') {
        if (stdout.length < maxBytes) stdout += chunk.toString('utf8')
        else truncated = true
      } else if (stderr.length < maxBytes) {
        stderr += chunk.toString('utf8')
      } else {
        truncated = true
      }
    }
    child.stdout.on('data', (chunk) => { collect('stdout', chunk) })
    child.stderr.on('data', (chunk) => { collect('stderr', chunk) })

    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (truncated) {
        stdout = stdout.slice(0, maxBytes)
        stderr = stderr.slice(0, maxBytes)
      }
      resolve({ code: timedOut ? 124 : code ?? 1, signal, stdout, stderr, truncated, timedOut })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => { child.kill('SIGKILL') }, 1_000)
    }, timeoutMs)

    child.on('error', (err) => {
      if (stderr === '') stderr = `${cmd}: ${err.message}`
      finish(1, null)
    })
    child.on('close', (code, signal) => { finish(code, signal) })
  })
}
