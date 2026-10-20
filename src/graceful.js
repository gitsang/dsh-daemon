#!/usr/bin/env node
/**
 * Graceful dsh web restart helper.
 *
 * systemd invokes this from the dsh-daemon unit:
 *
 *   before-stop:
 *     - lists running sessions through the local /api
 *     - asks each one to cancel/abort the active turn (keeping queued work)
 *     - waits until they are no longer running
 *     - writes their ids (and cwd) to a small state file
 *
 *   after-start:
 *     - waits for the web API to come back
 *     - reattaches/resumes each saved session by calling session/create
 *     - optionally sends a continuation prompt so the task can keep going
 *     - removes the state file after the pass
 *
 * The dsh 0.2 HTTP carrier is authenticated even on loopback. This helper
 * therefore mints the same authority-bound browser-session cookie that dsh
 * creates after its launch-token exchange, using the signing secret in
 * $DSH_HOME/.credentials.yaml.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const STATE_VERSION = 1
const DEFAULT_PORT = '3080'
const SLEEP_MS = 500
const BEFORE_STOP_TIMEOUT_MS = 10_000
const AFTER_START_TIMEOUT_MS = 60_000

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const phase = argValue('--phase')
const host = argValue('--host') ?? '127.0.0.1'
const port = argValue('--port') ?? DEFAULT_PORT
const stateFile = argValue('--state')
const resumePrompt = argValue('--resume-prompt')
const dshHome = argValue('--dsh-home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const baseUrl = `http://${host}:${port}`
const authority = new URL(baseUrl).host

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

/**
 * Read the dsh browser-session signing secret from the credentials store.
 * The file is a small fixed YAML document owned by dsh; a dependency-free
 * scanner avoids making this helper depend on a particular YAML package.
 */
function readBrowserSessionSecret() {
  const credentialsPath = join(dshHome, '.credentials.yaml')
  let text
  try {
    text = readFileSync(credentialsPath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read dsh credentials at ${credentialsPath}: ${error?.message ?? error}`)
  }

  let inRecord = false
  for (const line of text.split(/\r?\n/u)) {
    if (/^  ["']?client-connection\/browser-session["']?:\s*$/u.test(line)) {
      inRecord = true
      continue
    }
    if (!inRecord) continue
    if (/^  \S/u.test(line)) break
    const match = /^\s+secret:\s*["']?([A-Za-z0-9_-]+)["']?(?:\s+#.*)?$/u.exec(line)
    if (match === null) continue
    const secret = Buffer.from(match[1], 'base64url')
    if (secret.byteLength !== 32) throw new Error(`invalid browser-session secret in ${credentialsPath}`)
    return secret
  }

  throw new Error(`browser-session secret not found in ${credentialsPath}; open the dsh web URL once so it is created`)
}

function browserSessionCookie() {
  // Tests and unusual credential-provider layouts can supply a ready cookie.
  if (process.env.DSH_DAEMON_COOKIE) return process.env.DSH_DAEMON_COOKIE

  const secret = readBrowserSessionSecret()
  const now = Date.now()
  const payload = {
    version: 1,
    authority,
    issuedAt: now - 1_000,
    expiresAt: now + 60 * 60 * 1_000,
  }
  const body = base64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = createHmac('sha256', secret).update(body).digest()
  const name = `dsh-auth-${base64Url(createHash('sha256').update(authority).digest())}`
  return `${name}=v1.${body}.${base64Url(signature)}`
}

/**
 * Invoke one Typert Remote endpoint through dsh's HTTP carrier.
 *
 * dsh 0.2 uses slash-separated canonical endpoints (`session/list`) and wraps
 * every invocation in `{ args: { ...wireArguments } }`. The HTTP body still
 * uses the generic Connection envelope.
 */
async function rpc(endpoint, args, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: browserSessionCookie(),
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: endpoint,
        payload: { args },
      }),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      const detail = text.trim() === '' ? '' : `: ${text.trim().slice(0, 200)}`
      throw new Error(`HTTP ${response.status} from ${endpoint}${detail}`)
    }
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`unexpected non-JSON /api response from ${endpoint}`)
    }
    if (data?.type !== 'server-response' || typeof data.result?.ok !== 'boolean') {
      throw new Error(`unexpected /api response from ${endpoint}`)
    }
    return data.result
  } finally {
    clearTimeout(timer)
  }
}

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.sessions)) return null
    return parsed.sessions
  } catch {
    return null
  }
}

function writeState(sessions) {
  if (!stateFile) return
  mkdirSync(dirname(stateFile), { recursive: true })
  const payload = JSON.stringify({
    version: STATE_VERSION,
    savedAt: new Date().toISOString(),
    sessions,
  }, null, 2)
  const tmp = `${stateFile}.tmp`
  writeFileSync(tmp, payload)
  renameSync(tmp, stateFile)
}

async function listSessions() {
  const result = await rpc('session/list', { _request: {} }, 10_000)
  if (!result.ok) throw new Error(result.error?.message ?? 'session/list failed')
  return result.value.items ?? []
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      await listSessions()
      return
    } catch (error) {
      lastError = error
      await sleep(SLEEP_MS)
    }
  }
  throw lastError ?? new Error('timed out waiting for dsh web API')
}

async function beforeStop() {
  let running
  try {
    const items = await listSessions()
    running = items.filter((item) => item.running === true && item.sessionId)
  } catch (error) {
    // The service may already be down or not yet up. Keep any state saved by
    // an earlier graceful stop so a later start can still resume it.
    process.stderr.write(`dsh-daemon: graceful before-stop: cannot list sessions (${error?.message ?? error})\n`)
    if (!readState()?.length) writeState([])
    return 0
  }

  const sessions = running.map(({ sessionId, cwd }) => ({ sessionId, cwd }))
  if (sessions.length === 0) {
    writeState([])
    return 0
  }

  const wanted = new Set(sessions.map((entry) => entry.sessionId))
  for (const entry of sessions) {
    try {
      const result = await rpc('session/cancel', { request: { sessionId: entry.sessionId } }, 10_000)
      if (!result.ok) {
        process.stderr.write(`dsh-daemon: graceful before-stop: cancel ${entry.sessionId} refused: ${result.error?.code ?? 'error'}: ${result.error?.message ?? ''}\n`)
      }
    } catch (error) {
      process.stderr.write(`dsh-daemon: graceful before-stop: cancel ${entry.sessionId} failed: ${error?.message ?? error}\n`)
    }
  }

  // Wait for the cancelled turns to drain and flush before systemd stops us.
  const deadline = Date.now() + BEFORE_STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const items = await listSessions()
      const stillRunning = items.some((item) => wanted.has(item.sessionId) && item.running === true)
      if (!stillRunning) break
    } catch {
      // Server may already be going away; proceed with what we recorded.
      break
    }
    await sleep(SLEEP_MS)
  }

  writeState(sessions)
  process.stderr.write(`dsh-daemon: graceful before-stop: recorded ${sessions.length} running session(s)\n`)
  return 0
}

async function afterStart() {
  const sessions = readState()
  if (!sessions || sessions.length === 0) return 0

  await waitForServer(AFTER_START_TIMEOUT_MS)

  for (const entry of sessions) {
    const sessionId = entry?.sessionId
    if (!sessionId) continue
    try {
      const result = await rpc('session/create', {
        request: {
          sessionId,
          ...(entry.cwd ? { cwd: entry.cwd } : {}),
        },
      }, 15_000)
      if (!result.ok) {
        process.stderr.write(`dsh-daemon: graceful after-start: resume ${sessionId} refused: ${result.error?.code ?? 'error'}: ${result.error?.message ?? ''}\n`)
        continue
      }
    } catch (error) {
      process.stderr.write(`dsh-daemon: graceful after-start: resume ${sessionId} failed: ${error?.message ?? error}\n`)
      continue
    }

    if (resumePrompt !== undefined && resumePrompt !== '') {
      try {
        const result = await rpc('session/prompt', {
          request: {
            requestId: randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: resumePrompt }],
          },
        }, 15_000)
        if (!result.ok) {
          process.stderr.write(`dsh-daemon: graceful after-start: continue ${sessionId} refused: ${result.error?.code ?? 'error'}: ${result.error?.message ?? ''}\n`)
        }
      } catch (error) {
        process.stderr.write(`dsh-daemon: graceful after-start: continue ${sessionId} failed: ${error?.message ?? error}\n`)
      }
    }
  }

  rmSync(stateFile, { force: true })
  return 0
}

async function main() {
  if (phase === 'before-stop') return beforeStop()
  if (phase === 'after-start') return afterStart()
  process.stderr.write('usage: graceful.js --phase before-stop|after-start [--host H] [--port P] [--state FILE] [--dsh-home DIR] [--resume-prompt TEXT]\n')
  return 2
}

process.exitCode = await main()
