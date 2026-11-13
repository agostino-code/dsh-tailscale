// Teardown and lifecycle tests: mocks dependencies without touching real Tailscale.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { internals } from '../index.js'

const { teardown, setup } = internals

/** Builds mock dependencies object. */
function fakeDeps(overrides = {}) {
  const calls = []
  const persisted = []
  const deps = {
    calls,
    persisted,
    run: async (binary, args) => {
      calls.push({ binary, args })
      return { ok: true, code: 0, stdout: '', stderr: '' }
    },
    resolveBinary: async () => 'tailscale',
    readStatus: async () => ({ BackendState: 'Running', Self: { DNSName: 'host.ts.net.' } }),
    readServeStatus: async () => undefined,
    waitForPort: async () => 19387,
    persistState: async (scope, state) => {
      persisted.push(state)
    },
    announce: () => {},
    launchGui: async () => true,
    resolveGui: () => 'C:\\fake\\tailscale-ipn.exe',
    loadState: async () => undefined,
    ensureLoginSecret: async () => 'test-secret-0123456789abcdef',
    ...overrides,
  }
  return deps
}

/** Builds a minimal mock scope. */
function fakeScope({ port = 19387, trusted = [] } = {}) {
  const logs = []
  const routes = []
  const store = {
    webServer: { port },
    connection: {
      trustedHosts: trusted,
      authenticatedUrl: (u) => `${u}?token=abc`,
      browserAuth: { maxAgeMilliseconds: 30 * 86400000 },
    },
  }
  const fakeWebServer = {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  }
  return {
    logs,
    routes,
    store,
    logger: {
      info: (m) => logs.push(`info:${m}`),
      warn: (m) => logs.push(`warn:${m}`),
      error: (m) => logs.push(`error:${m}`),
    },
    get: (name) => store[name],
    inject: (_deps, callback) =>
      callback({
        get: (name) => (name === 'webServer' ? fakeWebServer : undefined),
        effect: (fn) => fn(),
      }),
  }
}

const CONFIG = {
  httpsPort: 7259,
  binaryPath: undefined,
  connectOnStart: true,
  serveOnStart: true,
  trustedHosts: true,
  readyTimeoutMs: 0,
  guiReadyTimeoutMs: 0,
  cookieMaxAgeDays: 0,
  loginRoute: true,
}

test('previously running tailscale: tears down route on exit, does not disconnect tailscale', async () => {
  const deps = fakeDeps()
  const scope = fakeScope({ trusted: ['host.ts.net:7259'] })
  const undo = { trustedHost: 'host.ts.net:7259', createdRoute: true, startedTailscale: false, binary: 'tailscale' }

  await teardown(scope, CONFIG, undo, deps)

  const args = deps.calls.map((c) => c.args.join(' '))
  assert.deepEqual(args, ['serve --https=7259 off'])
  assert.equal(scope.store.connection.trustedHosts.length, 0, 'trusted authority must be removed')
  assert.equal(undo.createdRoute, false)
})

test('tailscale started by DSH: tears down route + calls tailscale down', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: true, startedTailscale: true, binary: 'tailscale' }

  await teardown(scope, CONFIG, undo, deps)

  const args = deps.calls.map((c) => c.args.join(' '))
  assert.deepEqual(args, ['serve --https=7259 off', 'down'])
})

test('route not established but tailscale was started: still calls tailscale down', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: true, binary: 'tailscale' }

  await teardown(scope, CONFIG, undo, deps)

  const args = deps.calls.map((c) => c.args.join(' '))
  assert.deepEqual(args, ['down'])
})

test('no side-effects performed: teardown executes no commands', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: 'tailscale' }

  await teardown(scope, CONFIG, undo, deps)

  assert.equal(deps.calls.length, 0)
})

test('idempotency: multiple teardown calls only execute cleanup once', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: true, startedTailscale: true, binary: 'tailscale' }

  await teardown(scope, CONFIG, undo, deps)
  await teardown(scope, CONFIG, undo, deps)

  const args = deps.calls.map((c) => c.args.join(' '))
  assert.deepEqual(args, ['serve --https=7259 off', 'down'])
})

test('only removes own trusted authority, preserving others', async () => {
  const deps = fakeDeps()
  const scope = fakeScope({ trusted: ['other.example:1234', 'host.ts.net:7259', '127.0.0.1:9999'] })
  const undo = { trustedHost: 'host.ts.net:7259', createdRoute: false, startedTailscale: false, binary: 'tailscale' }

  await teardown(scope, CONFIG, undo, deps)

  assert.deepEqual(scope.store.connection.trustedHosts, ['other.example:1234', '127.0.0.1:9999'])
})

test('command failure does not throw (disposer must never reject)', async () => {
  const deps = fakeDeps({
    run: async (binary, args) => ({ ok: false, code: 1, stdout: '', stderr: 'boom' }),
  })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: true, startedTailscale: true, binary: 'tailscale' }

  await assert.doesNotReject(() => teardown(scope, CONFIG, undo, deps))
  assert.ok(scope.logs.some((l) => l.startsWith('warn:')), 'warning must be logged on command failure')
})

test('setup pushes trusted authority to connection and targets port', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.deepEqual(scope.store.connection.trustedHosts, ['host.ts.net:7259'])
  assert.equal(undo.trustedHost, 'host.ts.net:7259')
  const serve = deps.calls.find((c) => c.args[0] === 'serve' && c.args.includes('--bg'))
  assert.deepEqual(serve.args, ['serve', '--bg', '--https=7259', 'http://127.0.0.1:19387'])
  assert.equal(undo.createdRoute, true)
  assert.equal(deps.persisted.length, 1)
  assert.equal(deps.persisted[0].plainUrl, 'https://host.ts.net:7259/')
  assert.equal(deps.persisted[0].url, 'https://host.ts.net:7259/?token=abc')
})

test('exact matching route already present: reclaimed without recreating (crash recovery)', async () => {
  const deps = fakeDeps({
    readServeStatus: async () => ({
      Web: { 'host.ts.net:7259': { Handlers: { '/': { Proxy: 'http://127.0.0.1:19387' } } } },
      TCP: { '7259': { HTTPS: true } },
    }),
  })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.equal(deps.calls.some((c) => c.args[0] === 'serve' && c.args.includes('--bg')), false)
  assert.equal(undo.createdRoute, true)
  assert.equal(undo.trustedHost, 'host.ts.net:7259')
})

test('conflicting existing config: takes no action and leaves trustedHosts untouched', async () => {
  const deps = fakeDeps({
    readServeStatus: async () => ({
      Web: { 'host.ts.net:7259': { Handlers: { '/': { Proxy: 'http://10.0.0.9:80' } } } },
      TCP: { '7259': { HTTPS: true } },
    }),
  })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.equal(deps.calls.some((c) => c.args[0] === 'serve' && c.args.includes('--bg')), false)
  assert.equal(undo.createdRoute, false)
  assert.equal(undo.trustedHost, undefined)
  assert.ok(scope.logs.some((l) => l.includes('conflict')), 'conflict must be logged')
})

test('up does not start backend -> launches desktop client and configures route on success', async () => {
  let backendState = 'NoState'
  const deps = fakeDeps({
    readStatus: async () => ({
      BackendState: backendState,
      Self: backendState === 'Running' ? { DNSName: 'host.ts.net.' } : { DNSName: '' },
    }),
    launchGui: async () => {
      backendState = 'Running'
      return true
    },
  })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.ok(scope.logs.some((l) => l.includes('desktop client')))
  assert.equal(undo.startedTailscale, true)
  assert.deepEqual(scope.store.connection.trustedHosts, ['host.ts.net:7259'])
  assert.equal(undo.createdRoute, true)
})

test('up inactive and no desktop client found -> skips route and logs actionable warning', async () => {
  const deps = fakeDeps({
    readStatus: async () => ({ BackendState: 'NoState', Self: { DNSName: '' } }),
    resolveGui: () => undefined,
  })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.equal(undo.createdRoute, false)
  assert.equal(undo.trustedHost, undefined)
  assert.equal(undo.startedTailscale, false)
  assert.ok(scope.logs.some((l) => l.includes('open the Tailscale client')))
})

test('desktop client launch fails to start backend -> skips route', async () => {
  const deps = fakeDeps({
    readStatus: async () => ({ BackendState: 'NoState', Self: { DNSName: '' } }),
    launchGui: async () => true,
  })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.equal(undo.createdRoute, false)
  assert.equal(undo.startedTailscale, false)
  assert.ok(scope.logs.some((l) => l.includes('timed out waiting for tailscale to enter Running')))
})

test('tailscale not running and up fails: skips route and does not call down', async () => {
  const deps = fakeDeps({
    readStatus: async () => ({ BackendState: 'Stopped' }),
    resolveGui: () => undefined,
    run: async (binary, args) => {
      deps.calls.push({ binary, args })
      return { ok: false, code: 1, stdout: '', stderr: 'not logged in' }
    },
  })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.equal(undo.startedTailscale, false)
  assert.equal(undo.createdRoute, false)
  assert.deepEqual(deps.calls.map((c) => c.args.join(' ')), ['up'])
})

test('web port unavailable: skips route creation', async () => {
  const deps = fakeDeps({ waitForPort: async () => undefined })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.equal(undo.createdRoute, false)
  assert.equal(undo.trustedHost, undefined)
})

test('configures cookie maxAgeMilliseconds to match configured days', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, { ...CONFIG, cookieMaxAgeDays: 3650 }, undo, deps)

  assert.equal(
    scope.store.connection.browserAuth.maxAgeMilliseconds,
    3650 * 86400000,
  )
})

test('cookieMaxAgeDays=0 preserves DSH default 30-day value', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, { ...CONFIG, cookieMaxAgeDays: 0 }, undo, deps)

  assert.equal(scope.store.connection.browserAuth.maxAgeMilliseconds, 30 * 86400000)
})

test('login route uses persistent secret and saves to state file', async () => {
  const deps = fakeDeps({ ensureLoginSecret: async () => 'STABLE_SECRET_abcdefghijklmnop' })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  assert.equal(undo.loginPath, '/remote/STABLE_SECRET_abcdefghijklmnop')
  const state = deps.persisted.at(-1)
  assert.equal(state.loginUrl, 'https://host.ts.net:7259/remote/STABLE_SECRET_abcdefghijklmnop')
  assert.equal(state.loginSecret, 'STABLE_SECRET_abcdefghijklmnop')
})

test('reuses secret from previous state file or generates fresh secret', async () => {
  const { ensureLoginSecret } = internals
  const reused = await ensureLoginSecret(fakeScope(), CONFIG, {
    loadState: async () => ({ loginSecret: 'KEEP_THIS_0123456789abcdefgh' }),
  })
  assert.equal(reused, 'KEEP_THIS_0123456789abcdefgh')

  const fresh = await ensureLoginSecret(fakeScope(), CONFIG, { loadState: async () => undefined })
  assert.match(fresh, /^[A-Za-z0-9_-]{22,}$/)
  assert.notEqual(fresh, reused)
})

test('regenerates secret if state file secret format is invalid', async () => {
  const { ensureLoginSecret } = internals
  const bad = await ensureLoginSecret(fakeScope(), CONFIG, {
    loadState: async () => ({ loginSecret: 'short' }),
  })
  assert.match(bad, /^[A-Za-z0-9_-]{22,}$/)
  assert.notEqual(bad, 'short')
})

test('loginRoute=false skips registering login route and writing loginSecret', async () => {
  const deps = fakeDeps()
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, { ...CONFIG, loginRoute: false }, undo, deps)

  assert.equal(undo.loginPath, undefined)
  assert.equal(deps.persisted.at(-1).loginSecret, undefined)
})

test('login route handler: redirects with token when signing secret missing, 405 on non-GET', async () => {
  const deps = fakeDeps({ ensureLoginSecret: async () => 'SECRET_abcdefghijklmnopqrst' })
  const scope = fakeScope()
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  const route = scope.routes.find((r) => r.path === '/remote/SECRET_abcdefghijklmnopqrst')
  assert.ok(route !== undefined)
  assert.equal(route.kind, 'exact')

  const seen = []
  const res = {
    writeHead: (code, headers) => seen.push({ code, headers }),
    end: () => {},
  }
  route.handler({ method: 'GET' }, res)
  assert.equal(seen[0].code, 302)
  assert.equal(seen[0].headers.location, 'https://host.ts.net:7259/?token=abc')

  route.handler({ method: 'POST' }, res)
  assert.equal(seen[1].code, 405)
})

test('mints session cookie directly when signing secret is available', async () => {
  const deps = fakeDeps({ ensureLoginSecret: async () => 'SECRET_abcdefghijklmnopqrst' })
  const scope = fakeScope()
  scope.store.connection.browserAuth.secret = Buffer.alloc(32, 7)
  const undo = { trustedHost: undefined, createdRoute: false, startedTailscale: false, binary: undefined }

  await setup(scope, CONFIG, undo, deps)

  const route = scope.routes.find((r) => r.path === '/remote/SECRET_abcdefghijklmnopqrst')
  const seen = []
  route.handler({ method: 'GET' }, { writeHead: (c, h) => seen.push({ c, h }), end: () => {} })

  assert.equal(seen[0].c, 302)
  assert.equal(seen[0].h.location, 'https://host.ts.net:7259/')
  const cookie = seen[0].h['set-cookie']
  assert.ok(cookie.startsWith('dsh-auth-'))
  assert.match(cookie, /; HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Path=\//)
})

test('minted cookie matches client-connection encodeCookie format', async () => {
  const secret = Buffer.alloc(32, 9)
  const authority = 'host.ts.net:7259'
  const minted = internals.mintSessionCookie({ browserAuth: { secret } }, authority, 3650 * 86400000)

  const b64url = (b) => b.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  assert.equal(minted.name, `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`)

  const parts = minted.value.split('.')
  assert.equal(parts.length, 3)
  assert.equal(parts[0], 'v1')
  assert.equal(parts[2], b64url(createHmac('sha256', secret).update(parts[1]).digest()))

  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  assert.equal(payload.version, 1)
  assert.equal(payload.authority, authority)
  assert.ok(payload.expiresAt > payload.issuedAt)
  assert.ok(payload.expiresAt - payload.issuedAt <= 3650 * 86400000)
})

test('returns undefined when signing secret is unavailable without throwing', () => {
  assert.equal(internals.mintSessionCookie({ browserAuth: {} }, 'h:1', 1000), undefined)
  assert.equal(internals.mintSessionCookie(undefined, 'h:1', 1000), undefined)
  assert.equal(internals.mintSessionCookie({ browserAuth: { secret: 'not-a-buffer' } }, 'h:1', 1000), undefined)
})
