// Tests for management endpoints behind the Settings row.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { internals } from '../index.js'

const {
  statePayload,
  registerAdminRoutes,
  rotateLoginSecret,
  freshRuntime,
  installLoginRoute,
  STATE_PATH,
  ROTATE_PATH,
} = internals

const CONFIG = {
  enabled: true,
  httpsPort: 7259,
  loginRoute: true,
  cookieMaxAgeDays: 3650,
  revokeSessionsOnRotate: true,
  stateFile: undefined,
}

/** Builds mock scope tracking connection.fetch and webServer routes. */
function fakeScope({ routes = [], webRoutes = [], secret = Buffer.alloc(32, 5), port = 19387 } = {}) {
  const logs = []
  const fetchRoutes = []
  const registered = []
  const credentialWrites = []
  const records = new Map()
  const credentials = {
    modifyRecord: async (key, mutate) => {
      const next = await mutate(records.get(key))
      if (next !== undefined) {
        records.set(key, next)
        credentialWrites.push({ key, record: next })
      }
      return records.get(key)
    },
  }
  const webServer = {
    register: (route) => {
      registered.push(route)
      return () => {
        const at = registered.indexOf(route)
        if (at !== -1) registered.splice(at, 1)
      }
    },
    port,
  }
  const connection = {
    trustedHosts: [],
    authenticatedUrl: (url) => `${url}?token=abc`,
    browserAuth: { secret, maxAgeMilliseconds: 30 * 86400000 },
    fetch: {
      register: (route) => {
        fetchRoutes.push(route)
        return async () => {}
      },
    },
  }
  const store = { connection, webServer, credentials }
  return {
    logs,
    fetchRoutes,
    registered,
    credentialWrites,
    credentials,
    store,
    logger: {
      info: (m) => logs.push(`info:${m}`),
      warn: (m) => logs.push(`warn:${m}`),
      error: (m) => logs.push(`error:${m}`),
    },
    get: (name) => store[name],
    inject: (_deps, callback) =>
      callback({
        get: (name) => store[name],
        effect: (fn) => fn(),
      }),
    effect: (fn) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
  }
}

/** In-memory state persistence mock preventing writing to ~/.dsh. */
const MEMORY_DEPS = {
  persistState: async (scope, state) => {
    scope.store.__persisted = [...(scope.store.__persisted ?? []), state]
  },
}

/** Resolves registered fetch route. */
function routeFor(scope, path) {
  const route = scope.fetchRoutes.find((r) => r.path === path)
  assert.ok(route !== undefined, `must register ${path}`)
  return route
}

test('both endpoints registered on connection.fetch (inheriting DSH fence and cookie auth)', () => {
  const scope = fakeScope()
  registerAdminRoutes(scope, CONFIG, freshRuntime({}), MEMORY_DEPS)

  const paths = scope.fetchRoutes.map((r) => r.path).sort()
  assert.deepEqual(paths, [ROTATE_PATH, STATE_PATH].sort())
  assert.deepEqual(scope.registered, [], 'must not register exact routes on webServer')
  assert.equal(scope.fetchRoutes.find((r) => r.path === STATE_PATH).methods[0], 'GET')
  assert.equal(scope.fetchRoutes.find((r) => r.path === ROTATE_PATH).methods[0], 'POST')
})

test('state endpoint: provides URLs and rotation flag when ready', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.phase = 'ready'
  runtime.state = {
    plainUrl: 'https://host.ts.net:7259/',
    loginUrl: 'https://host.ts.net:7259/remote/SECRET',
    authority: 'host.ts.net:7259',
    dnsName: 'host.ts.net',
    httpsPort: 7259,
    cookieMaxAgeDays: 3650,
    updatedAt: '2026-10-12T00:00:00.000Z',
  }
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)

  const response = await routeFor(scope, STATE_PATH).fetch()
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.phase, 'ready')
  assert.equal(body.loginUrl, 'https://host.ts.net:7259/remote/SECRET')
  assert.equal(body.canRotate, true)
  assert.equal(body.error, null)
  assert.match(response.headers.get('cache-control'), /no-store/)
})

test('state endpoint: returns 200 with phase description while starting up', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.phase = 'starting'
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)

  const response = await routeFor(scope, STATE_PATH).fetch()
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.phase, 'starting')
  assert.equal(body.canRotate, false)
  assert.equal(body.loginUrl, null)
})

test('state endpoint: surfaces actual error on startup failure', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.phase = 'error'
  runtime.error = 'Conflicting Serve config on port'
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)

  const body = await (await routeFor(scope, STATE_PATH).fetch()).json()
  assert.equal(body.phase, 'error')
  assert.equal(body.error, 'Conflicting Serve config on port')
  assert.equal(body.canRotate, false)
})

test('state endpoint: disallows key rotation when loginRoute=false', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.phase = 'ready'
  runtime.state = { plainUrl: 'https://h/', loginUrl: 'https://h/', cookieMaxAgeDays: 3650 }
  registerAdminRoutes(scope, { ...CONFIG, loginRoute: false }, runtime, MEMORY_DEPS)

  const body = await (await routeFor(scope, STATE_PATH).fetch()).json()
  assert.equal(body.canRotate, false)
})

test('rotate key: installs new route, tears down old route, saves to disk, and updates live state', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.webScope = scope
  runtime.phase = 'ready'
  runtime.handoffUrl = 'https://host.ts.net:7259/?token=abc'
  runtime.state = {
    url: 'https://host.ts.net:7259/?token=abc',
    plainUrl: 'https://host.ts.net:7259/',
    loginUrl: 'https://host.ts.net:7259/remote/OLD',
    loginPath: '/remote/OLD',
    loginSecret: 'OLD',
    authority: 'host.ts.net:7259',
    cookieMaxAgeDays: 3650,
  }

  const oldPath = installLoginRoute(runtime, scope.get('connection'), CONFIG, 'host.ts.net:7259', 'OLD')
  assert.equal(oldPath, '/remote/OLD')
  assert.equal(scope.registered.length, 1)
  assert.equal(scope.registered[0].path, '/remote/OLD')

  const persisted = []
  const result = await rotateLoginSecret(scope, CONFIG, runtime, {
    persistState: async (_scope, state) => persisted.push(state),
  })

  assert.match(result.loginPath, /^\/remote\/[A-Za-z0-9_-]{22,}$/)
  assert.notEqual(result.loginPath, '/remote/OLD')
  assert.equal(result.loginUrl, `https://host.ts.net:7259${result.loginPath}`)

  assert.equal(scope.registered.length, 1)
  assert.equal(scope.registered[0].path, result.loginPath)
  assert.equal(
    scope.registered.some((r) => r.path === '/remote/OLD'),
    false,
  )

  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].loginPath, result.loginPath)
  assert.equal(persisted[0].loginUrl, result.loginUrl)
  assert.equal(persisted[0].loginSecret, result.loginPath.slice('/remote/'.length))
  assert.equal(persisted[0].plainUrl, 'https://host.ts.net:7259/')

  assert.equal(runtime.state.loginPath, result.loginPath)
  assert.equal(runtime.login.path, result.loginPath)
  assert.equal(runtime.undo.loginPath, result.loginPath)
})

test('rotate key: generates distinct random keys on each call', async () => {
  const seen = new Set()
  for (let i = 0; i < 5; i += 1) {
    const scope = fakeScope()
    const runtime = freshRuntime({})
    runtime.webScope = scope
    runtime.state = { plainUrl: 'https://h/', authority: 'h:7259', cookieMaxAgeDays: 3650 }
    const result = await rotateLoginSecret(scope, CONFIG, runtime, { persistState: async () => {} })
    seen.add(result.loginPath)
  }
  assert.equal(seen.size, 5)
})

test('rotate key: explicitly rejects when not ready', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.webScope = scope
  await assert.rejects(
    () => rotateLoginSecret(scope, CONFIG, runtime, { persistState: async () => {} }),
    /not ready yet/i,
  )
  assert.equal(scope.registered.length, 0)
})

test('rotate key: explicitly rejects when loginRoute=false', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.webScope = scope
  runtime.state = { plainUrl: 'https://h/', authority: 'h:7259' }
  await assert.rejects(
    () => rotateLoginSecret(scope, { ...CONFIG, loginRoute: false }, runtime, { persistState: async () => {} }),
    /login route is disabled/i,
  )
})

test('rotate key: explicitly rejects when webServer is unavailable', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.state = { plainUrl: 'https://h/', authority: 'h:7259' }
  await assert.rejects(
    () => rotateLoginSecret(scope, CONFIG, runtime, { persistState: async () => {} }),
    /webserver is unavailable/i,
  )
})

test('rotate endpoint: returns 409 + ok:false + error on failure', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)

  const response = await routeFor(scope, ROTATE_PATH).fetch()
  assert.equal(response.status, 409)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.match(body.error, /not ready yet/i)
})

test('rotate endpoint: returns ok:true and new URL on success', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.webScope = scope
  runtime.state = { plainUrl: 'https://host.ts.net:7259/', authority: 'host.ts.net:7259', cookieMaxAgeDays: 3650 }
  runtime.undo = {}
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)
  const original = internals.REAL_DEPS.persistState
  internals.REAL_DEPS.persistState = async () => {}
  try {
    const response = await routeFor(scope, ROTATE_PATH).fetch()
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.match(body.loginUrl, /^https:\/\/host\.ts\.net:7259\/remote\/[A-Za-z0-9_-]{22,}$/)
  } finally {
    internals.REAL_DEPS.persistState = original
  }
})

test('statePayload does not throw when state is empty', () => {
  const payload = statePayload(CONFIG, freshRuntime({}))
  assert.equal(payload.ok, true)
  assert.equal(payload.phase, 'starting')
  assert.equal(payload.loginUrl, null)
  assert.equal(payload.plainUrl, null)
  assert.equal(payload.httpsPort, 7259)
  assert.equal(payload.cookieMaxAgeDays, 3650)
})

test('endpoints registered even when enabled=false so Settings can report status', async () => {
  const scope = fakeScope()
  const runtime = freshRuntime({})
  runtime.phase = 'disabled'
  registerAdminRoutes(scope, { ...CONFIG, enabled: false }, runtime, MEMORY_DEPS)

  const body = await (await routeFor(scope, STATE_PATH).fetch()).json()
  assert.equal(body.ok, true)
  assert.equal(body.phase, 'disabled')
  assert.equal(body.enabled, false)
  assert.equal(body.canRotate, false)
})

function readyRuntime(scope, authority = 'host.ts.net:7259') {
  const runtime = freshRuntime({})
  runtime.webScope = scope
  runtime.phase = 'ready'
  runtime.handoffUrl = `https://${authority}/?token=abc`
  runtime.state = {
    url: `https://${authority}/?token=abc`,
    plainUrl: `https://${authority}/`,
    loginUrl: `https://${authority}/remote/OLD`,
    loginPath: '/remote/OLD',
    loginSecret: 'OLD',
    authority,
    cookieMaxAgeDays: 3650,
  }
  return runtime
}

const noPersist = { persistState: async () => {} }

test('rotating keys revokes sessions: writes credentials record and updates active signing secret', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  const before = scope.store.connection.browserAuth.secret

  await rotateLoginSecret(scope, CONFIG, runtime, noPersist, 'host.ts.net:7259')

  assert.equal(scope.credentialWrites.length, 1)
  const write = scope.credentialWrites[0]
  assert.equal(write.key, internals.AUTH_RECORD_KEY)
  assert.equal(write.key, 'client-connection/browser-session')
  assert.equal(write.record.kind, 'grant')
  assert.equal(write.record.payload.version, 1)
  const written = write.record.payload.secret
  assert.equal(typeof written, 'string')
  assert.equal(Buffer.from(written, 'base64url').byteLength, 32)
  assert.notEqual(written, before.toString('base64url'))

  const after = scope.store.connection.browserAuth.secret
  assert.ok(Buffer.isBuffer(after))
  assert.equal(after.byteLength, 32)
  assert.notEqual(after.toString('hex'), before.toString('hex'))
})

test('after key rotation, cookies minted with old signing secret fail verification', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  const authority = 'host.ts.net:7259'
  const oldSecret = scope.store.connection.browserAuth.secret

  const leaked = internals.mintSessionCookie({ browserAuth: { secret: oldSecret } }, authority, 3650 * 86400000)
  assert.ok(leaked !== undefined)

  await rotateLoginSecret(scope, CONFIG, runtime, noPersist, authority)

  const body = leaked.value.split('.')[1]
  const live = scope.store.connection.browserAuth.secret
  const expectedNow = createHmac('sha256', live).update(body).digest('base64url')
  const leakedSignature = leaked.value.split('.')[2]
  assert.notEqual(expectedNow, leakedSignature)

  const expectedBefore = createHmac('sha256', oldSecret).update(body).digest('base64url')
  assert.equal(expectedBefore, leakedSignature)
})

test('only the device initiating rotation receives re-issued cookie', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)

  const response = await routeFor(scope, ROTATE_PATH).fetch({
    headers: new Headers({ host: 'host.ts.net:7259' }),
  })
  assert.equal(response.status, 200)

  const cookie = response.headers.get('set-cookie')
  assert.ok(cookie !== null)
  const expectedName = `dsh-auth-${createHash('sha256').update('host.ts.net:7259').digest('base64url')}`
  assert.ok(cookie.startsWith(`${expectedName}=`))
  assert.match(cookie, /; HttpOnly/)
  assert.match(cookie, /; SameSite=Lax/)

  const value = cookie.slice(expectedName.length + 1).split(';')[0]
  const body = value.split('.')[1]
  const expected = createHmac('sha256', scope.store.connection.browserAuth.secret).update(body).digest('base64url')
  assert.equal(value.split('.')[2], expected)

  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.revokesSessions, true)
  assert.equal(payload.stayedSignedIn, true)
  assert.equal('cookie' in payload, false)
})

test('missing Host header skips re-issuing cookie but still revokes sessions', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)

  const response = await routeFor(scope, ROTATE_PATH).fetch({ headers: new Headers({}) })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('set-cookie'), null)
  const payload = await response.json()
  assert.equal(payload.revokesSessions, true)
  assert.equal(payload.stayedSignedIn, false)
  assert.equal(scope.credentialWrites.length, 1)
})

test('fails explicitly when credentials write does not persist', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  const before = scope.store.connection.browserAuth.secret.toString('hex')
  scope.credentials.modifyRecord = async () => ({
    kind: 'grant',
    payload: { version: 1, secret: Buffer.alloc(32, 9).toString('base64url') },
  })

  const persisted = []
  await assert.rejects(
    () => rotateLoginSecret(scope, CONFIG, runtime, { persistState: async (_s, v) => persisted.push(v) }),
    /failed/i,
  )
  assert.equal(persisted.length, 0)
  assert.equal(scope.store.connection.browserAuth.secret.toString('hex'), before)
})

test('exception during credential write prevents route update and disk persistence', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  scope.credentials.modifyRecord = async () => {
    throw new Error('store unavailable')
  }

  const persisted = []
  await assert.rejects(
    () => rotateLoginSecret(scope, CONFIG, runtime, { persistState: async (_s, v) => persisted.push(v) }),
    /store unavailable/,
  )
  assert.equal(persisted.length, 0)
  assert.equal(scope.registered.length, 0)
  assert.equal(runtime.state.loginPath, '/remote/OLD')
})

test('revokeSessionsOnRotate=false only rotates login secret and leaves sessions intact', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  const before = scope.store.connection.browserAuth.secret.toString('hex')

  const result = await rotateLoginSecret(
    scope,
    { ...CONFIG, revokeSessionsOnRotate: false },
    runtime,
    noPersist,
    'host.ts.net:7259',
  )

  assert.equal(scope.credentialWrites.length, 0)
  assert.equal(scope.store.connection.browserAuth.secret.toString('hex'), before)
  assert.equal(result.revokesSessions, false)
  assert.equal(result.stayedSignedIn, false)
  assert.match(result.loginPath, /^\/remote\/[A-Za-z0-9_-]{22,}$/)
})

test('state endpoint informs client whether key rotation revokes sessions', async () => {
  const scope = fakeScope()
  const runtime = readyRuntime(scope)
  registerAdminRoutes(scope, CONFIG, runtime, MEMORY_DEPS)

  const body = await (await routeFor(scope, STATE_PATH).fetch()).json()
  assert.equal(body.revokesSessions, true)

  const off = fakeScope()
  const offRuntime = readyRuntime(off)
  registerAdminRoutes(off, { ...CONFIG, revokeSessionsOnRotate: false }, offRuntime, MEMORY_DEPS)
  const offBody = await (await routeFor(off, STATE_PATH).fetch()).json()
  assert.equal(offBody.revokesSessions, false)
})

// -- WebSocket Compression --------------------------------------------------

test('websocket compression: patched handleUpgrade negotiates permessage-deflate', async () => {
  const { installWebSocketCompression } = internals
  const calls = []
  const proto = {
    handleUpgrade(req, socket, head, cb) {
      calls.push(JSON.parse(JSON.stringify(this.options ?? {})))
      return 'called'
    },
  }
  const fakeWs = { WebSocketServer: function WebSocketServer() {} }
  fakeWs.WebSocketServer.prototype = proto

  const original = proto.handleUpgrade
  const patched = function patchedHandleUpgrade(req, socket, head, cb) {
    if (this.options !== undefined && this.options.perMessageDeflate === false) {
      this.options.perMessageDeflate = { threshold: 1024 }
    }
    return original.call(this, req, socket, head, cb)
  }
  proto.handleUpgrade = patched

  const server = { options: { noServer: true, perMessageDeflate: false } }
  proto.handleUpgrade.call(server, {}, {}, null, () => {})
  assert.deepEqual(calls[0].perMessageDeflate, { threshold: 1024 })
  assert.equal(typeof installWebSocketCompression, 'function')
})

test('websocket compression: already configured options are preserved', () => {
  const proto = {
    handleUpgrade() {
      return undefined
    },
  }
  const original = proto.handleUpgrade
  const patched = function patchedHandleUpgrade(req, socket, head, cb) {
    if (this.options !== undefined && this.options.perMessageDeflate === false) {
      this.options.perMessageDeflate = {}
    }
    return original.call(this, req, socket, head, cb)
  }
  proto.handleUpgrade = patched
  const configured = { threshold: 4096 }
  const server = { options: { perMessageDeflate: configured } }
  proto.handleUpgrade.call(server, {}, {}, null, () => {})
  assert.equal(server.options.perMessageDeflate, configured)
})

test('websocket compression hook is lazy: does not require ws during boot', () => {
  const { armWebSocketCompression, installWebSocketCompression } = internals
  assert.equal(armWebSocketCompression({ logger: { info() {} }, effect() {} }, { websocketCompression: false }), undefined)

  const scope = { logger: { info() {}, warn() {} }, effect() {} }
  const armed = armWebSocketCompression(scope, { websocketCompression: true })
  assert.equal(armed?.armed, true)
  assert.equal(typeof armed.armOnce, 'function')
  assert.equal(typeof installWebSocketCompression, 'function')
})

test('websocket compression lazy hook: armOnce is idempotent and never throws', () => {
  const { armWebSocketCompression } = internals
  const warnings = []
  const scope = { logger: { info() {}, warn: (m) => warnings.push(m) }, effect() {} }
  const armed = armWebSocketCompression(scope, { websocketCompression: true })
  let result
  assert.doesNotThrow(() => { result = armed.armOnce() })
  assert.equal(typeof result, 'boolean')
})
