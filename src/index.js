import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { runCommand } from './command.js'

export const name = 'daemon'
export const inject = ['cmdlineArgs']

/**
 * The daemon profile's command surface. Serving is deliberately NOT here: the
 * systemd unit runs the untouched `web` profile via a bare `dsh web`.
 */
export function apply(ctx) {
  const args = ctx.get('cmdlineArgs').get()

  const program = new Command('dsh --profile daemon')
    .description('Manage the dsh web systemd --user daemon')
    .helpOption('-h, --help', 'show this help')

  program.command('install')
    .description('Write the systemd unit and enable --now')
    .option('--host <host>', 'bind host for the served web app (default: 127.0.0.1)')
    .option('--port <port>', 'listen port for the served web app (default: 3080)')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts, e.g. the reverse-proxy hostname (host or host:port; repeatable)')
    .option('--cwd <dir>', 'working directory of the daemon (default: $HOME)')
    .action((opts) => { command = { verb: 'install', opts } })

  program.command('start').description('Start the daemon').action(() => { command = { verb: 'start' } })
  program.command('stop').description('Stop the daemon').action(() => { command = { verb: 'stop' } })
  program.command('restart').description('Restart the daemon').action(() => { command = { verb: 'restart' } })
  program.command('status').description('Show the daemon status').action(() => { command = { verb: 'status' } })
  program.command('logs')
    .description('Show the daemon journal')
    .option('-f, --follow', 'follow new output')
    .action((opts) => { command = { verb: 'logs', opts } })
  program.command('uninstall').description('Disable and remove the systemd unit').action(() => { command = { verb: 'uninstall' } })

  let command

  // Bare `dsh --profile daemon` prints help and exits 0.
  if (args.length === 0) {
    program.outputHelp()
    ctx.get('appExit')(0)
    return
  }

  parseCmdline(ctx, program)

  if (command === undefined) return
  return runCommand(ctx, command)
}
