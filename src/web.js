/**
 * Authenticated Web control surface for the dsh-daemon systemd user unit.
 *
 * The browser never receives a generic command runner. It can read the unit's
 * status and journal and submit the three lifecycle verbs this package already
 * owns. Every route is registered on dsh's authenticated `/api` carrier, so it
 * inherits the browser-session cookie and Host/Origin fence.
 */
import { existsSync } from 'node:fs'
import { resolveProxyDropInPath, resolveUnitPath } from './paths.js'
import { runCapture } from './systemctl.js'

export const ROUTE = '/api/dsh-daemon'
export const SERVICE = 'dsh-daemon'

const STATUS_PROPERTIES = [
  'LoadState',
  'ActiveState',
  'SubState',
  'UnitFileState',
  'MainPID',
  'ActiveEnterTimestamp',
  'MemoryCurrent',
  'Result',
  'FragmentPath',
  'NeedDaemonReload',
].join(',')

const ACTIONS = new Set(['start', 'stop', 'restart'])
const MAX_BODY_BYTES = 4 * 1024
const MAX_OUTPUT_BYTES = 512 * 1024
const MAX_LOG_LINES = 2_000
const STATUS_TIMEOUT_MS = 15_000
const ACTION_TIMEOUT_MS = 15_000
const LOGS_TIMEOUT_MS = 20_000

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function asError(error) {
  return error instanceof Error ? error.message : String(error)
}

function commandError(result) {
  const detail = (result.stderr || result.stdout || '').trim()
  return detail === '' ? `exited with code ${result.code}` : detail
}

/** Parse the KEY=VALUE lines emitted by `systemctl show`. */
export function parseSystemctlShow(text) {
  const values = {}
  for (const line of String(text).split(/\r?\n/u)) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    values[line.slice(0, at)] = line.slice(at + 1)
  }
  return values
}

/** A numeric systemd property, or null for `<unset>`/`[not set]`/`infinity`. */
function numericProperty(value) {
  if (value === undefined || !/^\d+$/u.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

/** Parse the query's line count; reject anything outside the bounded journal read. */
export function parseLogLines(value) {
  if (value === null || value === '') return 200
  if (!/^\d+$/u.test(value)) throw Object.assign(new Error('lines must be an integer'), { status: 400 })
  const lines = Number(value)
  if (lines < 1 || lines > MAX_LOG_LINES) {
    throw Object.assign(new Error(`lines must be in 1..${MAX_LOG_LINES}`), { status: 400 })
  }
  return lines
}

/** Accept only the lifecycle verbs the web surface exposes. */
export function parseAction(value) {
  if (typeof value !== 'string' || !ACTIONS.has(value)) {
    throw Object.assign(new Error('action must be start, stop, or restart'), { status: 400 })
  }
  return value
}

async function readJson(request) {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) {
    throw Object.assign(new Error('request body too large'), { status: 413 })
  }
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 })
  }
}

/**
 * The three operations over an injected command runner. Tests substitute the
 * runner; production uses systemctl's capture mode rather than a shell.
 */
export function createDaemonApi({
  run = runCapture,
  fileExists = existsSync,
  unitPath = resolveUnitPath(),
  proxyDropInPath = resolveProxyDropInPath(),
} = {}) {
  return {
    /**
     * One point-in-time read of the unit. A missing unit is a normal answer;
     * a failed systemctl call returns the same shape with `available: false`
     * and the command's diagnostic.
     */
    async status() {
      const result = await run(
        'systemctl',
        ['--user', 'show', SERVICE, '--no-pager', `--property=${STATUS_PROPERTIES}`],
        { timeoutMs: STATUS_TIMEOUT_MS, maxBytes: MAX_OUTPUT_BYTES },
      )
      const values = result.code === 0 ? parseSystemctlShow(result.stdout) : {}
      const loadState = values.LoadState || 'unknown'
      return {
        available: result.code === 0,
        installed: loadState !== 'not-found' && loadState !== 'unknown',
        loadState,
        activeState: values.ActiveState || 'unknown',
        subState: values.SubState || 'unknown',
        unitFileState: values.UnitFileState || '',
        mainPid: numericProperty(values.MainPID),
        activeEnterTimestamp: values.ActiveEnterTimestamp || '',
        memoryBytes: numericProperty(values.MemoryCurrent),
        result: values.Result || '',
        fragmentPath: values.FragmentPath || '',
        needDaemonReload: values.NeedDaemonReload === 'yes',
        unitPath,
        proxyDropInPath,
        proxyConfigured: fileExists(proxyDropInPath),
        ...result.code === 0 ? {} : { error: commandError(result) },
      }
    },

    /**
     * Submit one lifecycle job. `--no-block` matters when the page itself is
     * served by this unit: the request can finish before systemd tears the
     * connection down.
     */
    async action(value) {
      const action = parseAction(value)
      const result = await run(
        'systemctl',
        ['--user', action, '--no-block', SERVICE],
        { timeoutMs: ACTION_TIMEOUT_MS, maxBytes: MAX_OUTPUT_BYTES },
      )
      if (result.code !== 0) {
        throw Object.assign(new Error(commandError(result)), { status: 500 })
      }
      return { action, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
    },

    /** Read the most recent journal lines through journalctl's user scope. */
    async logs(value) {
      const lines = parseLogLines(value)
      const result = await run(
        'journalctl',
        ['--user', '-u', SERVICE, '-n', String(lines), '--no-pager', '--output=short-iso'],
        { timeoutMs: LOGS_TIMEOUT_MS, maxBytes: MAX_OUTPUT_BYTES },
      )
      if (result.code !== 0) {
        throw Object.assign(new Error(commandError(result)), { status: 500 })
      }
      return { lines, text: result.stdout, truncated: result.truncated === true }
    },
  }
}

/**
 * Register the status, action, and journal routes on the host connection.
 * @param ctx - host plugin context carrying the `connection` service.
 * @param api - injectable operation set; production uses createDaemonApi().
 */
export function registerDaemonRoutes(ctx, api = createDaemonApi()) {
  const routes = [
    {
      path: `${ROUTE}/status`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return json(200, { ok: true, status: await api.status() })
        } catch (error) {
          return json(500, { ok: false, error: asError(error) })
        }
      },
    },
    {
      path: `${ROUTE}/action`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await readJson(request)
          return json(200, { ok: true, result: await api.action(body.action) })
        } catch (error) {
          return json(error?.status ?? 500, { ok: false, error: asError(error) })
        }
      },
    },
    {
      path: `${ROUTE}/logs`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const lines = new URL(request.url).searchParams.get('lines')
          return json(200, { ok: true, logs: await api.logs(lines) })
        } catch (error) {
          return json(error?.status ?? 500, { ok: false, error: asError(error) })
        }
      },
    },
  ]
  for (const route of routes) {
    ctx.effect(() => ctx.connection.fetch.register(route), `dsh-daemon: ${route.path}`)
  }
}
