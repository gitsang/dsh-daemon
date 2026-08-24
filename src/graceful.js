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
 *     - reattaches/resumes each saved session by calling session.create
 *     - optionally sends a continuation prompt so the task can keep going
 *     - removes the state file after the pass
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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
const baseUrl = `http://${host}:${port}`

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function rpc(method, payload, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method,
        payload,
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    if (data?.type !== 'server-response') throw new Error('unexpected /api response')
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
  const result = await rpc('session.list', {}, 10_000)
  if (!result.ok) throw new Error(result.error?.message ?? 'session.list failed')
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
      const result = await rpc('session.cancel', { sessionId: entry.sessionId }, 10_000)
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
      const result = await rpc('session.create', {
        sessionId,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
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
        const result = await rpc('session.prompt', {
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: resumePrompt }],
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
  process.stderr.write('usage: graceful.js --phase before-stop|after-start [--host H] [--port P] [--state FILE] [--resume-prompt TEXT]\n')
  return 2
}

process.exitCode = await main()
