import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import test from 'node:test'

const HELPER = fileURLToPath(new URL('../src/graceful.js', import.meta.url))

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url')
}

function verifyCookie(header, secret) {
  assert.equal(typeof header, 'string')
  const [pair] = header.split(';')
  const at = pair.indexOf('=')
  assert.notEqual(at, -1)
  const value = pair.slice(at + 1)
  const [version, body, signature] = value.split('.')
  assert.equal(version, 'v1')
  const expected = createHmac('sha256', secret).update(body).digest()
  assert.deepEqual(decodeBase64Url(signature), expected)
  const payload = JSON.parse(decodeBase64Url(body).toString('utf8'))
  assert.equal(payload.version, 1)
  return payload
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler)
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: address.port })
    })
  })
}

function makeDshHome(secret) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-daemon-test-'))
  writeFileSync(join(dir, '.credentials.yaml'), `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: ${base64Url(secret)}
`)
  return dir
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function runHelper(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('after-start authenticates and uses dsh 0.2 Remote endpoints', async () => {
  const secret = Buffer.from('0123456789abcdef0123456789abcdef')
  const dshHome = makeDshHome(secret)
  const stateFile = join(dshHome, 'daemon-resume.json')
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    sessions: [{ sessionId: 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cwd: '/tmp' }],
  }))

  const calls = []
  const { server, port } = await listen(async (request, response) => {
    const body = JSON.parse(await readBody(request))
    calls.push({ url: request.url, method: body.method, payload: body.payload })
    const authority = `127.0.0.1:${port}`
    const payload = verifyCookie(request.headers.cookie, secret)
    assert.equal(payload.authority, authority)
    if (payload.issuedAt > Date.now() || payload.expiresAt <= Date.now()) assert.fail('cookie is not current')

    let result
    if (body.method === 'session/list') result = { ok: true, value: { items: [] } }
    else if (body.method === 'session/create') result = { ok: true, value: { sessionId: body.payload.args.request.sessionId } }
    else if (body.method === 'session/prompt') result = { ok: true, value: { accepted: true } }
    else assert.fail(`unexpected method ${body.method}`)
    assert.equal(body.type, 'client-request')
    assert.equal(typeof body.rpcId, 'string')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
  })

  try {
    const run = await runHelper([
      '--phase', 'after-start',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--state', stateFile,
      '--dsh-home', dshHome,
      '--resume-prompt', 'continue',
    ])
    assert.equal(run.code, 0, run.stderr)
    assert.equal(existsSync(stateFile), false)

    assert.deepEqual(calls.map((call) => call.url), [
      '/api/session/list',
      '/api/session/create',
      '/api/session/prompt',
    ])
    assert.deepEqual(calls[0], { url: '/api/session/list', method: 'session/list', payload: { args: { _request: {} } } })
    assert.equal(calls[1].method, 'session/create')
    assert.deepEqual(calls[1].payload, {
      args: { request: { sessionId: 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', cwd: '/tmp' } },
    })
    assert.equal(calls[2].method, 'session/prompt')
    assert.equal(calls[2].payload.args.request.sessionId, 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    assert.equal(calls[2].payload.args.request.mode, 'queue')
    assert.match(calls[2].payload.args.request.requestId, /^[0-9a-f-]{36}$/u)
    assert.deepEqual(calls[2].payload.args.request.content, [{ type: 'text', text: 'continue' }])
  } finally {
    server.close()
    rmSync(dshHome, { recursive: true, force: true })
  }
})

test('before-stop cancels running turns and records resumable sessions', async () => {
  const secret = Buffer.from('fedcba9876543210fedcba9876543210')
  const dshHome = makeDshHome(secret)
  const stateFile = join(dshHome, 'daemon-resume.json')
  let listCalls = 0
  const calls = []
  const { server, port } = await listen(async (request, response) => {
    const body = JSON.parse(await readBody(request))
    calls.push({ url: request.url, method: body.method, payload: body.payload })
    verifyCookie(request.headers.cookie, secret)

    let result
    if (body.method === 'session/list') {
      listCalls += 1
      result = {
        ok: true,
        value: { items: [{ sessionId: 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', cwd: '/tmp', running: listCalls === 1 }] },
      }
    } else if (body.method === 'session/cancel') {
      result = { ok: true, value: { accepted: true } }
    } else {
      assert.fail(`unexpected method ${body.method}`)
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
  })

  try {
    const run = await runHelper([
      '--phase', 'before-stop',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--state', stateFile,
      '--dsh-home', dshHome,
    ])
    assert.equal(run.code, 0, run.stderr)
    assert.equal(listCalls, 2)
    assert.deepEqual(calls[1], {
      url: '/api/session/cancel',
      method: 'session/cancel',
      payload: { args: { request: { sessionId: 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } } },
    })
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).sessions, [
      { sessionId: 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', cwd: '/tmp' },
    ])
  } finally {
    server.close()
    rmSync(dshHome, { recursive: true, force: true })
  }
})
