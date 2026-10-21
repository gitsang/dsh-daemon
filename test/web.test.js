import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDaemonApi,
  parseAction,
  parseLogLines,
  parseSystemctlShow,
  registerDaemonRoutes,
  ROUTE,
} from '../src/web.js'

function fakeRun(handler) {
  const calls = []
  const run = async (cmd, args, options) => {
    calls.push({ cmd, args, options })
    return handler(cmd, args, options)
  }
  return { run, calls }
}

test('systemctl show output parses into properties', () => {
  assert.deepEqual(parseSystemctlShow('LoadState=loaded\nActiveState=active\nMainPID=123\n'), {
    LoadState: 'loaded',
    ActiveState: 'active',
    MainPID: '123',
  })
  assert.deepEqual(parseSystemctlShow('=ignored\nNoEquals\n'), {})
})

test('status reads bounded properties and reports install/proxy state', async () => {
  const { run, calls } = fakeRun(() => ({
    code: 0,
    stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=4242\nActiveEnterTimestamp=Tue 2026-10-20 12:27:23 UTC\nMemoryCurrent=569000000\nResult=success\nFragmentPath=/home/sang/.config/systemd/user/dsh-daemon.service\nNeedDaemonReload=no\n',
    stderr: '',
  }))
  const api = createDaemonApi({
    run,
    fileExists: (path) => path.endsWith('proxy.conf'),
    unitPath: '/u/dsh-daemon.service',
    proxyDropInPath: '/u/proxy.conf',
  })
  const status = await api.status()

  assert.equal(calls[0].cmd, 'systemctl')
  assert.deepEqual(calls[0].args.slice(0, 4), ['--user', 'show', 'dsh-daemon', '--no-pager'])
  assert.match(calls[0].args[4], /ActiveState/u)
  assert.equal(status.available, true)
  assert.equal(status.installed, true)
  assert.equal(status.activeState, 'active')
  assert.equal(status.mainPid, 4242)
  assert.equal(status.memoryBytes, 569000000)
  assert.equal(status.proxyConfigured, true)
  assert.equal(status.needDaemonReload, false)
})

test('missing unit is a normal status response', async () => {
  const { run } = fakeRun(() => ({ code: 0, stdout: 'LoadState=not-found\nActiveState=inactive\n', stderr: '' }))
  const api = createDaemonApi({ run, fileExists: () => false, unitPath: '/u', proxyDropInPath: '/p' })
  const status = await api.status()

  assert.equal(status.installed, false)
  assert.equal(status.loadState, 'not-found')
  assert.equal(status.activeState, 'inactive')
})

test('lifecycle actions use systemctl --no-block and reject anything else', async () => {
  const { run, calls } = fakeRun(() => ({ code: 0, stdout: '', stderr: '' }))
  const api = createDaemonApi({ run })

  assert.deepEqual(await api.action('restart'), { action: 'restart', stdout: '', stderr: '' })
  assert.deepEqual(calls[0].args, ['--user', 'restart', '--no-block', 'dsh-daemon'])
  await assert.rejects(() => api.action('uninstall'), /start, stop, or restart/u)
  assert.throws(() => parseAction('status'), /start, stop, or restart/u)
})

test('journal reads validate and bound the requested line count', async () => {
  const { run, calls } = fakeRun(() => ({ code: 0, stdout: 'line one\n', stderr: '', truncated: false }))
  const api = createDaemonApi({ run })

  assert.deepEqual(await api.logs('250'), { lines: 250, text: 'line one\n', truncated: false })
  assert.deepEqual(calls[0].args, ['--user', '-u', 'dsh-daemon', '-n', '250', '--no-pager', '--output=short-iso'])
  assert.equal(parseLogLines(null), 200)
  assert.throws(() => parseLogLines('0'), /1\.\.2000/u)
  assert.throws(() => parseLogLines('2001'), /1\.\.2000/u)
  assert.throws(() => parseLogLines('x'), /integer/u)
})

test('routes are registered on the authenticated connection carrier', async () => {
  const routes = []
  const ctx = {
    effect(fn, name) {
      const dispose = fn()
      assert.equal(typeof dispose, 'function')
      assert.match(name, /dsh-daemon/u)
      return dispose
    },
    connection: {
      fetch: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
    },
  }
  registerDaemonRoutes(ctx, {
    status: async () => ({ installed: true, activeState: 'active' }),
    action: async () => ({ action: 'start' }),
    logs: async () => ({ lines: 10, text: '', truncated: false }),
  })

  assert.deepEqual(routes.map((route) => route.path), [
    `${ROUTE}/status`,
    `${ROUTE}/action`,
    `${ROUTE}/logs`,
  ])
  const statusResponse = await routes[0].fetch(new Request(`http://127.0.0.1${ROUTE}/status`, { headers: { origin: 'http://127.0.0.1' } }))
  assert.equal(statusResponse.status, 200)
  assert.deepEqual(await statusResponse.json(), { ok: true, status: { installed: true, activeState: 'active' } })
})
