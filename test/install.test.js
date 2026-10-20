import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProxyDropIn, buildUnit } from '../src/unit.js'

test('proxy drop-in enables env proxying and writes both proxy variables', () => {
  const text = buildProxyDropIn({
    proxy: 'http://proxy.example.com:7890',
    noProxy: 'localhost,127.0.0.1,::1,*.internal.example.com',
  })

  assert.match(text, /^\[Service\]$/mu)
  assert.match(text, /^Environment=NODE_USE_ENV_PROXY=1$/mu)
  assert.match(text, /^Environment=HTTP_PROXY=http:\/\/proxy\.example\.com:7890$/mu)
  assert.match(text, /^Environment=HTTPS_PROXY=http:\/\/proxy\.example\.com:7890$/mu)
  assert.match(text, /^Environment=NO_PROXY=localhost,127\.0\.0\.1,::1,\*\.internal\.example\.com$/mu)
})

test('proxy drop-in uses the default NO_PROXY list when not requested', () => {
  const text = buildProxyDropIn({ proxy: 'http://user:p@ss word@proxy.example.com:7890' })

  assert.match(text, /^Environment=NO_PROXY=localhost,127\.0\.0\.1,::1,\*\.internal\.example\.com$/mu)
  assert.match(text, /^Environment="HTTP_PROXY=http:\/\/user:p@ss word@proxy\.example\.com:7890"$/mu)
  assert.match(text, /^Environment="HTTPS_PROXY=http:\/\/user:p@ss word@proxy\.example\.com:7890"$/mu)
})

test('proxy drop-in allows overriding NO_PROXY', () => {
  const text = buildProxyDropIn({
    proxy: 'http://proxy.example.com:7890',
    noProxy: 'localhost,*.corp.example.com',
  })

  assert.match(text, /^Environment=NO_PROXY=localhost,\*\.corp\.example\.com$/mu)
  assert.doesNotMatch(text, /internal\.example\.com/u)
})

test('generated unit starts dsh web without opening a browser', () => {
  const text = buildUnit({ cwd: '/tmp' })

  assert.match(text, /^ExecStart=.*"web" "--no-open"$/mu)
})
