import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname } from 'node:path'
import { resolveUnitPath, resolveWorkingDirectory } from './paths.js'
import { journalctl, systemctl } from './systemctl.js'
import { buildUnit } from './unit.js'

const SERVICE = 'dsh-daemon'

/**
 * Run one parsed `daemon` subcommand and request process exit with its code.
 * Handlers are async because they await child processes; `ctx.appExit` is
 * called only after the work completes, so the exit code is always honest.
 */
export async function runCommand(ctx, command) {
  const exit = ctx.get('appExit')
  try {
    const code = await HANDLERS[command.verb](command.opts ?? {})
    exit(code ?? 0)
  } catch (err) {
    process.stderr.write(`dsh-daemon: ${err?.message ?? err}\n`)
    exit(1)
  }
}

function hintLinger() {
  const username = userInfo().username
  const r = spawnSync('loginctl', ['show-user', username, '-p', 'Linger'], { encoding: 'utf8' })
  if (r.status === 0 && !/Linger=yes/.test(r.stdout ?? '')) {
    process.stderr.write('dsh-daemon: hint: run `loginctl enable-linger` so the daemon survives logout\n')
  }
}

/** Await a child process and throw if it exited nonzero. */
async function must(promise, what) {
  const code = await promise
  if (code !== 0) throw new Error(`${what} failed (exit ${code})`)
}

/**
 * Reject a --trusted-host value that is not a bare host[:port] authority.
 * Mirrors dsh-client-connection's canonical-form validation so a typo fails
 * here, at install time, instead of the daemon failing to boot later.
 */
function assertTrustedHost(entry) {
  let url
  try {
    url = new URL(`http://${entry}`)
  } catch {
    throw new Error(`--trusted-host ${JSON.stringify(entry)} is not a bare host[:port] authority`)
  }
  const canonical = url.port ? `${url.hostname}:${url.port}` : url.hostname
  if (canonical !== entry.toLowerCase()) {
    throw new Error(`--trusted-host ${JSON.stringify(entry)} is not a bare host[:port] authority`)
  }
}

const HANDLERS = {
  async install({ host, port, trustedHost, cwd }) {
    if (host === '0.0.0.0') {
      throw new Error('--host 0.0.0.0 is not supported (remote code execution risk); use 127.0.0.1 and --trusted-host for LAN access')
    }
    if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      throw new Error(`--port must be an integer in 1..65535, got ${JSON.stringify(port)}`)
    }
    for (const entry of trustedHost ?? []) assertTrustedHost(entry)
    const workDir = resolveWorkingDirectory(cwd)
    const unitPath = resolveUnitPath()
    const text = buildUnit({ host, port, trustedHosts: trustedHost ?? [], cwd: workDir })

    mkdirSync(dirname(unitPath), { recursive: true })
    writeFileSync(unitPath, text)

    await must(systemctl('daemon-reload'), 'systemctl --user daemon-reload')
    await must(systemctl('enable', '--now', SERVICE), 'systemctl --user enable --now dsh-daemon')

    process.stdout.write(`dsh-daemon: installed ${unitPath}\n`)
    hintLinger()
    return 0
  },

  async uninstall() {
    await systemctl('disable', '--now', SERVICE)
    rmSync(resolveUnitPath(), { force: true })
    await must(systemctl('daemon-reload'), 'systemctl --user daemon-reload')
    process.stdout.write('dsh-daemon: uninstalled\n')
    return 0
  },

  start: () => systemctl('start', SERVICE),
  stop: () => systemctl('stop', SERVICE),
  restart: () => systemctl('restart', SERVICE),
  status: () => systemctl('status', SERVICE),

  logs: ({ follow }) => journalctl('-u', SERVICE, ...(follow ? ['-f'] : ['-n', '200'])),
}
