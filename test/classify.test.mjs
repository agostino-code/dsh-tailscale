// Run with node --test: node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { internals } from '../index.js'

const { classifyServe, normalizeConfig, dnsNameOf, resolveDshHome } = internals

const PORT = 7259
const TARGET = 'http://127.0.0.1:19387'

/** Builds a mock serve status object with authority using tailnet hostname. */
function statusWith(proxy, { authority = `host.ts.net:${PORT}`, extraPaths = null, tcp = undefined } = {}) {
  const handlers = extraPaths ?? { '/': { Proxy: proxy } }
  return {
    Web: { [authority]: { Handlers: handlers } },
    ...(tcp === undefined ? { TCP: { [String(PORT)]: { HTTPS: true } } } : { TCP: tcp }),
  }
}

test('empty configuration -> absent', () => {
  assert.equal(classifyServe(undefined, PORT, TARGET).kind, 'absent')
  assert.equal(classifyServe({}, PORT, TARGET).kind, 'absent')
  assert.equal(classifyServe({ Web: {}, TCP: {} }, PORT, TARGET).kind, 'absent')
})

test('already proxying our target -> exact (no action taken)', () => {
  const state = classifyServe(statusWith(TARGET), PORT, TARGET)
  assert.equal(state.kind, 'exact')
  assert.equal(state.authority, `host.ts.net:${PORT}`)
})

test('same target with differing trailing slash treated as exact (avoids teardown of external routes)', () => {
  const state = classifyServe(statusWith(`${TARGET}/`), PORT, TARGET)
  assert.equal(state.kind, 'exact')
})

test('stale route pointing to another loopback port -> stale (can claim)', () => {
  const state = classifyServe(statusWith('http://127.0.0.1:3080'), PORT, TARGET)
  assert.equal(state.kind, 'stale')
  assert.equal(state.previousProxy, 'http://127.0.0.1:3080')
})

test('pointing elsewhere (non-loopback) -> conflict, never overwrite', () => {
  const state = classifyServe(statusWith('http://192.168.1.50:8080'), PORT, TARGET)
  assert.equal(state.kind, 'conflict')
})

test('other path handlers present besides root -> conflict', () => {
  const state = classifyServe(statusWith(TARGET, { extraPaths: { '/': { Proxy: TARGET }, '/api': { Proxy: TARGET } } }), PORT, TARGET)
  assert.equal(state.kind, 'conflict')
})

test('root handler is not a reverse proxy -> conflict', () => {
  const state = classifyServe(statusWith(undefined, { extraPaths: { '/': { Text: 'hi' } } }), PORT, TARGET)
  assert.equal(state.kind, 'conflict')
})

test('port claimed by TCP but has no Web handlers -> conflict', () => {
  const state = classifyServe({ Web: {}, TCP: { [String(PORT)]: { HTTPS: true } } }, PORT, TARGET)
  assert.equal(state.kind, 'conflict')
})

test('Web handler on port belongs to another authority -> classified by proxy target', () => {
  const status = {
    Web: { 'other.ts.net:7259': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } },
    TCP: { [String(PORT)]: { HTTPS: true } },
  }
  const state = classifyServe(status, PORT, TARGET)
  assert.equal(state.kind, 'stale')
  assert.equal(state.authority, 'other.ts.net:7259')
})

test('Web handler on port belongs to another authority and points externally -> conflict', () => {
  const status = {
    Web: { 'other.ts.net:7259': { Handlers: { '/': { Proxy: 'http://10.0.0.9:80' } } } },
    TCP: { [String(PORT)]: { HTTPS: true } },
  }
  assert.equal(classifyServe(status, PORT, TARGET).kind, 'conflict')
})

test('configs on other ports do not affect classification', () => {
  const status = {
    Web: { 'host.ts.net:9527': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9527' } } } },
    TCP: { '9527': { HTTPS: true } },
  }
  assert.equal(classifyServe(status, PORT, TARGET).kind, 'absent')
})

test('Handlers is not an object -> conflict', () => {
  const status = { Web: { [`host.ts.net:${PORT}`]: { Handlers: null } }, TCP: {} }
  assert.equal(classifyServe(status, PORT, TARGET).kind, 'conflict')
})

test('config normalization: invalid port falls back to 7259, explicit falses retained', () => {
  const c = normalizeConfig({ httpsPort: 'abc', serveOnStart: false })
  assert.equal(c.httpsPort, 7259)
  assert.equal(c.serveOnStart, false)
  assert.equal(c.enabled, true)
})

test('config normalization: enabled:false with custom port', () => {
  const c = normalizeConfig({ enabled: false, httpsPort: 8443 })
  assert.equal(c.enabled, false)
  assert.equal(c.httpsPort, 8443)
})

test('config normalization: out of bounds port falls back to default', () => {
  assert.equal(normalizeConfig({ httpsPort: 70000 }).httpsPort, 7259)
  assert.equal(normalizeConfig({ httpsPort: -1 }).httpsPort, 7259)
  assert.equal(normalizeConfig({ httpsPort: 0 }).httpsPort, 7259)
})

test('config normalization: null/non-object arguments do not throw', () => {
  assert.equal(normalizeConfig(null).httpsPort, 7259)
  assert.equal(normalizeConfig(undefined).enabled, true)
  assert.equal(normalizeConfig('nonsense').enabled, true)
})

test('DNS name strips trailing dot and lowercases', () => {
  assert.equal(dnsNameOf({ Self: { DNSName: 'Ckarefulon.Beardie-Tet.Ts.Net.' } }), 'ckarefulon.beardie-tet.ts.net')
  assert.equal(dnsNameOf({ Self: {} }), undefined)
  assert.equal(dnsNameOf(undefined), undefined)
})

test('DSH home resolution: explicit config takes precedence, then $DSH_HOME', () => {
  const original = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = 'C:\\env-home'
    assert.equal(resolveDshHome('C:\\explicit'), 'C:\\explicit')
    assert.equal(resolveDshHome(undefined), 'C:\\env-home')
    assert.equal(resolveDshHome('   '), 'C:\\env-home', 'whitespace treated as unset')
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
  }
})

test('DSH home resolution: falls back to ~/.dsh when $DSH_HOME is missing', () => {
  const original = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    const home = resolveDshHome(undefined)
    assert.ok(home.endsWith('.dsh'), `should fall back to ~/.dsh, got ${home}`)
    assert.ok(home.length > '.dsh'.length, 'must be an absolute path')
  } finally {
    if (original !== undefined) process.env.DSH_HOME = original
  }
})

test('DSH home resolution: falls back when $DSH_HOME is empty string', () => {
  const original = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '   '
    assert.ok(resolveDshHome(undefined).endsWith('.dsh'))
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
  }
})
