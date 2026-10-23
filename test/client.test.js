import assert from 'node:assert/strict'
import test from 'node:test'

const factories = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      factories.set(id, factory)
    },
  },
}

await import('../src/client.js')
const factory = factories.get('@gitsang/dsh-daemon')
assert.equal(typeof factory, 'function')
const client = factory((specifier) => {
  if (specifier === 'react') {
    return {
      Fragment: {},
      createElement() { return null },
      useCallback: (fn) => fn,
      useEffect: () => {},
      useRef: (value) => ({ current: value }),
      useState: (value) => [value, () => {}],
    }
  }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    return { Button: () => null }
  }
  throw new Error(`unexpected require ${specifier}`)
})
const { apiUrl, formatBytes, formatTimestamp, stateKey, ROW_KEY } = client.__test

test('API paths stay relative for reverse-proxy prefix compatibility', () => {
  assert.equal(apiUrl('status'), 'api/dsh-daemon/status')
})

test('byte formatting keeps bounded units readable', () => {
  assert.equal(formatBytes(0), null)
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KiB')
  assert.equal(formatBytes(569000000), '543 MiB')
})

test('timestamps fall back to the raw systemd text when unparsable', () => {
  assert.equal(formatTimestamp(''), null)
  assert.equal(formatTimestamp('n/a'), null)
  assert.equal(formatTimestamp('not a date'), 'not a date')
  assert.equal(typeof formatTimestamp('Tue 2026-10-20 12:27:23 UTC'), 'string')
})

test('systemd states map to localized labels', () => {
  assert.equal(stateKey('active'), 'stateActive')
  assert.equal(stateKey('failed'), 'stateFailed')
  assert.equal(stateKey('something-new'), 'stateUnknown')
})

test('apply registers the Daemon row configuration page and dictionaries', () => {
  const events = []
  const ctx = {
    effect(fn, name) {
      events.push(['effect', name])
      return fn()
    },
    locale: {
      register(ns, dictionaries) {
        events.push(['locale', ns, Object.keys(dictionaries).sort()])
        return () => {}
      },
      bind(ns) {
        return (key) => `${ns}:${key}`
      },
    },
    slots: {
      inject(name, register) {
        events.push(['inject', name])
        return register()
      },
      register(options) {
        events.push(['register', options])
        return () => {}
      },
    },
  }

  client.apply(ctx)

  assert.deepEqual(events.find((event) => event[0] === 'locale'), ['locale', 'daemon', ['en', 'zh']])
  assert.deepEqual(events.find((event) => event[0] === 'inject'), ['inject', 'plugins.row.config'])
  const registration = events.find((event) => event[0] === 'register')[1]
  assert.equal(registration.name, 'plugins.row.config')
  assert.equal(registration.key, '@gitsang/dsh-daemon#daemon')
  assert.equal(registration.key, ROW_KEY)
  assert.equal(registration.locale, 'daemon')
})
