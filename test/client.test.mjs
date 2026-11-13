/**
 * Tests for the browser half: loads the bundle in a stub environment
 * (stub module table + stub cordis context) and asserts that components
 * register onto slots owned by the host.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { internals } from '../index.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = readFileSync(join(root, 'client', 'client.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** React stub: sufficient to run createElement and module body without full render during registration. */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

/**
 * Minimal test renderer implementing a subset of React hooks:
 * useState with real setter, useEffect respecting dependency arrays,
 * and useCallback/useRef/useMemo maintaining references.
 */
function createRenderer() {
  let hooks = []
  let cursor = 0
  let scheduled = false
  let renderFn = null

  /** Deep-compares dependency arrays (length and every element). */
  function sameDeps(a, b) {
    if (a === undefined || b === undefined) return false
    if (a.length !== b.length) return false
    return a.every((value, index) => Object.is(value, b[index]))
  }

  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: (value) => {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { current: value }
      return hooks[index]
    },
    useState: (initial) => {
      const index = cursor++
      if (hooks[index] === undefined) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const hook = hooks[index]
      const setter = (next) => {
        const value = typeof next === 'function' ? next(hook.value) : next
        if (Object.is(value, hook.value)) return
        hook.value = value
        if (!scheduled) {
          scheduled = true
          // Synchronous re-render; the component has no cross-await race worth simulating.
          queueMicrotask(() => {
            scheduled = false
            if (renderFn !== null) renderFn()
          })
        }
      }
      return [hook.value, setter]
    },
    useCallback: (fn, deps) => {
      const index = cursor++
      const previous = hooks[index]
      if (previous === undefined || !sameDeps(previous.deps, deps)) hooks[index] = { fn, deps }
      return hooks[index].fn
    },
    useMemo: (fn, deps) => {
      const index = cursor++
      const previous = hooks[index]
      if (previous === undefined || !sameDeps(previous.deps, deps)) hooks[index] = { value: fn(), deps }
      return hooks[index].value
    },
    useEffect: (effect, deps) => {
      const index = cursor++
      const previous = hooks[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return
      previous?.cleanup?.()
      // Effects run synchronously. React runs them "after render"; here they run during render —
      // irrelevant for this component (its effects only start an async fetch and attach a listener, no setState).
      hooks[index] = { deps, cleanup: effect() }
    },
  }

  return {
    React,
    /**
     * Renders a component once.
     * @param component - Function component to render.
     * @param props - Props passed to the component.
     * @returns Render result (React element tree).
     */
    render(component, props) {
      cursor = 0
      renderFn = () => this.render(component, props)
      return component(props)
    },
    /** Flushes every queued microtask (including re-renders triggered by setState). */
    async flush() {
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      for (let i = 0; i < 12; i += 1) await Promise.resolve()
    },
    /** Unmounts: runs every cleanup. */
    unmount() {
      for (const hook of hooks) hook?.cleanup?.()
      hooks = []
      cursor = 0
    },
  }
}

/**
 * Loads the bundle into a stub environment.
 * @param overrides - Extra/overriding `window`, `document`, `navigator`, `locale`, `fetch`.
 * @returns `{ loaded, registrations, ctx, exports, renderer, calls }`。
 */
function loadBundle(overrides = {}) {
  const registrations = []
  const calls = []
  let loaded = null
  const document = {
    querySelector: () => null,
    createElement: () => ({ setAttribute: () => {}, textContent: '', style: {} }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    execCommand: () => true,
    ...(overrides.document ?? {}),
  }
  const window = {
    __ModuleLoader__: {
      load: (entry) => {
        loaded = entry
      },
    },
    location: { origin: 'http://127.0.0.1:19387' },
    addEventListener: () => {},
    removeEventListener: () => {},
    ...(overrides.window ?? {}),
  }
  const renderer = createRenderer()
  const require = (id) => {
    if (id === 'react') return renderer.React
    throw new Error(`unexpected module request: ${id}`)
  }
  const fetchImpl =
    overrides.fetch === undefined
      ? async (path, options) => {
          calls.push({ path, options })
          return {
            status: 200,
            json: async () => ({
              ok: true,
              phase: 'ready',
              canRotate: true,
              loginUrl: 'https://host.ts.net:7259/remote/SECRET',
              plainUrl: 'https://host.ts.net:7259/',
              cookieMaxAgeDays: 3650,
            }),
          }
        }
      : // 自定义 fetch 也照样记一遍：不记的话「点按钮有没有打到端点」就测不出来了。
        async (path, options) => {
          calls.push({ path, options })
          return overrides.fetch(path, options)
        }
  const run = new Function('window', 'document', 'navigator', 'globalThis', 'fetch', bundle)
  run(
    window,
    document,
    overrides.navigator ?? {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      language: 'zh-CN',
    },
    window,
    fetchImpl,
  )
  assert.notEqual(loaded, null, 'bundle must call window.__ModuleLoader__.load')

  const moduleExports = loaded.factory(require)
  assert.equal(typeof moduleExports, 'object')

  const slots = {
    inject: (name, register) => {
      registrations.push({ kind: 'slots.inject', name, register })
    },
    register: (definition, component) => {
      registrations.push({ kind: 'slots.register', definition, component })
    },
  }
  const store = { slots }
  if (overrides.locale !== null) {
    store.locale = overrides.locale ?? {
      getSnapshot: () => ({ active: 'zh', locales: [], revision: 1 }),
      subscribe: () => () => {},
    }
  }
  const ctx = {
    ...store,
    // The dynamic bundle ctx is a Proxy: reading services directly is gated by inject, `get` is not. Mirrored here.
    get: (name) => store[name],
    effect: (fn) => {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
  }
  return { loaded, registrations, ctx, exports: moduleExports, renderer, calls }
}

/** Runs `apply` once and returns the registrations it produced. */
function applyAndCollect(overrides = {}) {
  const env = loadBundle(overrides)
  env.exports.apply(env.ctx)
  return env
}

/**
 * Renders the row into its "loaded" state.
 *
 * Walks the real path: apply → inject callback → register → render first frame → wait for fetch →
 * re-render. The returned element tree is the frame the user sees.
 * @param overrides - Same as loadBundle.
 */
async function renderRow(overrides = {}) {
  const env = applyAndCollect(overrides)
  const inject = env.registrations.find((r) => r.kind === 'slots.inject')
  // The inject callback returns a disposer; trigger it once so register lands.
  inject.register()
  const registration = env.registrations.find((r) => r.kind === 'slots.register')
  const props = typeof registration.definition.inject === 'function' ? registration.definition.inject() : {}
  env.renderer.render(registration.component, props)
  await env.renderer.flush()
  const tree = env.renderer.render(registration.component, props)
  await env.renderer.flush()
  return { ...env, tree, registration, props }
}

describe('browser bundle', () => {
  it('registers under the manifest name', () => {
    const { loaded } = loadBundle()
    assert.equal(loaded.id, manifest.name)
    assert.equal(typeof loaded.factory, 'function')
  })

  it('exports apply and inject and returns exports', () => {
    const { exports } = loadBundle()
    assert.equal(typeof exports.apply, 'function')
    assert.ok(Array.isArray(exports.inject))
    assert.equal(typeof exports, 'object')
  })

  it('only hard-depends on slots, reads locale optionally via ctx.get', () => {
    const { exports } = loadBundle()
    assert.deepEqual(exports.inject, ['slots'])
    assert.equal(manifest.dsh.client.inject, undefined)
    assert.equal(manifest.dsh.client.platform, 'web')
  })

  it('is valid JavaScript and valid UTF-8', () => {
    const source = readFileSync(join(root, 'client', 'client.js'), 'utf8')
    assert.equal(source.includes('\uFFFD'), false)
    assert.equal(/鐗|缃戦|鈥|锛|鍜|浣|绋/.test(source), false)
    assert.ok((source.match(/[\u4e00-\u9fff]/g) ?? []).length > 100)
    assert.doesNotThrow(() => new Function(source))
  })
})

describe('registration', () => {
  it('registers row under Settings -> General with own ID', () => {
    const { registrations } = applyAndCollect()
    const inject = registrations.filter((r) => r.kind === 'slots.inject')
    assert.equal(inject.length, 2)
    assert.deepEqual(inject.map((r) => r.name).sort(), ['layout.header.left', 'settings.general.item'])
    assert.equal(inject[0].name, 'settings.general.item')

    assert.equal(registrations.filter((r) => r.kind === 'slots.register').length, 0)

    inject[0].register()
    const registers = registrations.filter((r) => r.kind === 'slots.register')
    assert.equal(registers.length, 1)
    const definition = registers[0].definition
    assert.equal(definition.name, 'settings.general.item')
    assert.equal(definition.id, 'dsh-tailscale')
    assert.equal(typeof definition.order, 'number')
    assert.ok(definition.order < 100)
    assert.ok(definition.order > 30)
  })

  it('registers mobile sidebar toggle to layout.header.left', () => {
    const { registrations } = applyAndCollect()
    const toggle = registrations.filter((r) => r.kind === 'slots.inject').find((r) => r.name === 'layout.header.left')
    assert.ok(toggle !== undefined)

    toggle.register()
    const registration = registrations.find(
      (r) => r.kind === 'slots.register' && r.definition.name === 'layout.header.left',
    )
    assert.ok(registration !== undefined)
    assert.equal(registration.definition.id, 'dsh-tailscale-toggle')
    assert.equal(typeof registration.component, 'function')
    assert.equal(typeof registration.definition.inject, 'function')
  })

  it('does not collide with host-reserved slot IDs', () => {
    const { registrations } = applyAndCollect()
    registrations.find((r) => r.kind === 'slots.inject').register()
    const id = registrations.find((r) => r.kind === 'slots.register').definition.id
    for (const taken of ['developer-tools', 'current-version', 'appearance', 'font-size', 'permission', 'language']) {
      assert.notEqual(id, taken, `id ${taken} is reserved by host`)
    }
  })

  it('component is a function receiving ctx through inject interface', () => {
    const { registrations } = applyAndCollect()
    registrations.find((r) => r.kind === 'slots.inject').register()
    const registration = registrations.find((r) => r.kind === 'slots.register')
    assert.equal(typeof registration.component, 'function')
    assert.equal(typeof registration.definition.inject, 'function')
    const props = registration.definition.inject()
    assert.equal(typeof props.ctx, 'object')
    assert.equal(typeof props.ctx.get, 'function')
  })
})

describe('rendered Settings row', () => {
  function stringsOf(node, out = []) {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (typeof node === 'string') {
      out.push(node)
      return out
    }
    if (Array.isArray(node)) {
      for (const child of node) stringsOf(child, out)
      return out
    }
    if (typeof node === 'object' && node.children !== undefined) {
      stringsOf(node.children, out)
      return out
    }
    return out
  }

  function find(node, predicate, out = []) {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (Array.isArray(node)) {
      for (const child of node) find(child, predicate, out)
      return out
    }
    if (typeof node !== 'object') return out
    if (predicate(node)) out.push(node)
    if (node.children !== undefined) find(node.children, predicate, out)
    return out
  }

  const ZH_LOCALE = { getSnapshot: () => ({ active: 'zh', locales: [], revision: 1 }), subscribe: () => () => {} }
  const EN_LOCALE = { getSnapshot: () => ({ active: 'en', locales: [], revision: 1 }), subscribe: () => () => {} }

  it('displays mobile login URL in read-only input after state load', async () => {
    const { tree } = await renderRow({ locale: ZH_LOCALE })
    const inputs = find(tree, (node) => node.type === 'input')
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0].props.readOnly, true)
    assert.equal(inputs[0].props.value, 'https://host.ts.net:7259/remote/SECRET')
  })

  it('queries only the single state endpoint with same-origin credentials', async () => {
    const { calls } = await renderRow({ locale: ZH_LOCALE })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, '/api/dsh-tailscale/state')
    assert.equal(calls[0].options.credentials, 'same-origin')
  })

  it('renders Chinese text under Chinese locale without literal keys', async () => {
    const { tree } = await renderRow({ locale: ZH_LOCALE })
    const text = stringsOf(tree).join('\n')
    assert.ok(text.includes('手机连接'))
    assert.ok(text.includes('手机登录链接'))
    assert.ok(text.includes('更换密钥'))
    assert.equal(/\b(row|label|title|description|copy|rotate)\.[a-zA-Z]/.test(text), false)
    assert.equal(text.includes('undefined'), false)
  })

  it('renders English text under English locale', async () => {
    const { tree } = await renderRow({ locale: EN_LOCALE })
    const text = stringsOf(tree).join('\n')
    assert.ok(text.includes('Phone access'))
    assert.ok(text.includes('Change key'))
    assert.equal(/[\u4e00-\u9fff]/.test(text), false)
  })

  it('falls back to browser language when locale service is missing', async () => {
    const { tree } = await renderRow({ locale: null, navigator: { language: 'zh-CN', userAgent: 'x' } })
    const text = stringsOf(tree).join('\n')
    assert.ok(text.includes('手机连接'))
    assert.equal(text.includes('undefined'), false)
  })

  it('renders English when locale service is missing and browser language is English', async () => {
    const { tree } = await renderRow({ locale: null, navigator: { language: 'en-US', userAgent: 'x' } })
    assert.ok(stringsOf(tree).join('\n').includes('Phone access'))
  })

  it('does not render a Lite/Full switch in the Settings row', async () => {
    const { tree } = await renderRow({ locale: ZH_LOCALE })
    const text = stringsOf(tree).join('\n')
    assert.equal(text.includes('精简模式'), false)
    assert.equal(text.includes('完整模式'), false)
    assert.ok(text.includes('手机连接'))
    assert.ok(text.includes('更换密钥'))
  })

  it('does not use emoji in icons', () => {
    const source = readFileSync(join(root, 'client', 'client.js'), 'utf8')
    assert.equal(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(source),
      false,
    )
  })

  it('client paths match host routes verbatim', () => {
    assert.ok(bundle.includes(`'${internals.STATE_PATH}'`))
    assert.ok(bundle.includes(`'${internals.ROTATE_PATH}'`))
    assert.equal(bundle.includes('/lite'), false)
  })

  it('all paths prefixed with /api', () => {
    for (const path of [internals.STATE_PATH, internals.ROTATE_PATH]) {
      assert.ok(path.startsWith('/api/'))
      const endpoint = path.slice('/api/'.length)
      assert.notEqual(endpoint, '')
      for (const segment of endpoint.split('/')) {
        assert.equal(['', '.', '..'].includes(segment), false)
        assert.match(segment, /^[A-Za-z0-9_$.-]+$/)
      }
    }
  })
})

describe('key rotation', () => {
  const ZH_LOCALE = { getSnapshot: () => ({ active: 'zh', locales: [], revision: 1 }), subscribe: () => () => {} }

  function find(node, predicate, out = []) {
    if (node === null || node === undefined || typeof node === 'boolean') return out
    if (Array.isArray(node)) {
      for (const child of node) find(child, predicate, out)
      return out
    }
    if (typeof node !== 'object') return out
    if (predicate(node)) out.push(node)
    if (node.children !== undefined) find(node.children, predicate, out)
    return out
  }

  /** Finds button by visible text. */
  function buttonWith(tree, label) {
    return find(tree, (node) => node.type === 'button' && node.children.includes(label))[0]
  }

  it('requires confirmation before issuing POST to rotate key', async () => {
    const { tree, renderer, registration, props, calls } = await renderRow({ locale: ZH_LOCALE })

    const trigger = buttonWith(tree, '更换密钥')
    assert.ok(trigger !== undefined)
    assert.equal(trigger.props.disabled, false)
    trigger.props.onClick()
    await renderer.flush()

    assert.equal(calls.length, 1)

    const afterConfirm = renderer.render(registration.component, props)
    await renderer.flush()
    assert.ok(buttonWith(afterConfirm, '确认更换') !== undefined)
    assert.ok(buttonWith(afterConfirm, '取消') !== undefined)

    buttonWith(afterConfirm, '确认更换').props.onClick()
    await renderer.flush()

    const rotateCall = calls.find((c) => c.path === '/api/dsh-tailscale/rotate')
    assert.ok(rotateCall !== undefined)
    assert.equal(rotateCall.options.method, 'POST')
  })

  it('cancel does not send request', async () => {
    const { tree, renderer, registration, props, calls } = await renderRow({ locale: ZH_LOCALE })
    buttonWith(tree, '更换密钥').props.onClick()
    await renderer.flush()
    const afterConfirm = renderer.render(registration.component, props)
    await renderer.flush()
    buttonWith(afterConfirm, '取消').props.onClick()
    await renderer.flush()
    assert.equal(calls.filter((c) => c.path.endsWith('/rotate')).length, 0)
  })

  it('button is disabled when canRotate=false', async () => {
    const { tree } = await renderRow({
      locale: ZH_LOCALE,
      fetch: async () => ({
        status: 200,
        json: async () => ({
          ok: true,
          phase: 'starting',
          canRotate: false,
          loginUrl: null,
          plainUrl: null,
          cookieMaxAgeDays: 3650,
        }),
      }),
    })
    const trigger = buttonWith(tree, '更换密钥')
    assert.ok(trigger !== undefined)
    assert.equal(trigger.props.disabled, true)
    const inputs = find(tree, (node) => node.type === 'input')
    assert.equal(inputs[0].props.value, '')
  })

  it('displays error message on key rotation failure', async () => {
    let rotated = false
    const { tree, renderer, registration, props } = await renderRow({
      locale: ZH_LOCALE,
      fetch: async (path) => {
        if (path.endsWith('/rotate')) {
          rotated = true
          return { status: 409, json: async () => ({ ok: false, error: '远程访问还没就绪，稍后再试' }) }
        }
        return {
          status: 200,
          json: async () => ({
            ok: true,
            phase: 'ready',
            canRotate: true,
            loginUrl: 'https://host.ts.net:7259/remote/OLD',
            plainUrl: 'https://host.ts.net:7259/',
            cookieMaxAgeDays: 3650,
          }),
        }
      },
    })
    buttonWith(tree, '更换密钥').props.onClick()
    await renderer.flush()
    buttonWith(renderer.render(registration.component, props), '确认更换').props.onClick()
    await renderer.flush()
    assert.equal(rotated, true)

    const text = (function collect(node, out = []) {
      if (typeof node === 'string') out.push(node)
      else if (Array.isArray(node)) node.forEach((c) => collect(c, out))
      else if (node !== null && typeof node === 'object' && node.children !== undefined) collect(node.children, out)
      return out
    })(renderer.render(registration.component, props)).join('\n')
    assert.ok(text.includes('远程访问还没就绪'))
  })

  it('displays error and retry button when state endpoint fails', async () => {
    const { tree } = await renderRow({
      locale: ZH_LOCALE,
      fetch: async () => ({ status: 500, json: async () => ({ ok: false, error: 'boom' }) }),
    })
    const alerts = find(tree, (node) => node.props?.role === 'alert')
    assert.equal(alerts.length, 1)
    const text = (function collect(node, out = []) {
      if (typeof node === 'string') out.push(node)
      else if (Array.isArray(node)) node.forEach((c) => collect(c, out))
      else if (node !== null && typeof node === 'object' && node.children !== undefined) collect(node.children, out)
      return out
    })(alerts[0]).join(' ')
    assert.ok(text.includes('boom'))
    assert.ok(text.includes('重试'))
  })

  it('surfaces error message from json body on non-200 responses', async () => {
    const { tree } = await renderRow({
      locale: ZH_LOCALE,
      fetch: async () => ({ status: 503, json: async () => ({ ok: false, error: '还没起来' }) }),
    })
    const alerts = find(tree, (node) => node.props?.role === 'alert')
    const text = (function collect(node, out = []) {
      if (typeof node === 'string') out.push(node)
      else if (Array.isArray(node)) node.forEach((c) => collect(c, out))
      else if (node !== null && typeof node === 'object' && node.children !== undefined) collect(node.children, out)
      return out
    })(alerts[0]).join(' ')
    assert.ok(text.includes('还没起来'))
    assert.equal(text.includes('503'), false)
  })

  it('warning explains all devices will be signed out when revokesSessions=true', async () => {
    const { tree, renderer, registration, props } = await renderRow({
      locale: ZH_LOCALE,
      fetch: async () => ({
        status: 200,
        json: async () => ({
          ok: true,
          phase: 'ready',
          canRotate: true,
          revokesSessions: true,
          loginUrl: 'https://host.ts.net:7259/remote/OLD',
          plainUrl: 'https://host.ts.net:7259/',
          cookieMaxAgeDays: 3650,
        }),
      }),
    })
    buttonWith(tree, '更换密钥').props.onClick()
    await renderer.flush()
    const text = (function collect(node, out = []) {
      if (typeof node === 'string') out.push(node)
      else if (Array.isArray(node)) node.forEach((c) => collect(c, out))
      else if (node !== null && typeof node === 'object' && node.children !== undefined) collect(node.children, out)
      return out
    })(renderer.render(registration.component, props)).join('\n')
    assert.ok(text.includes('所有已登录的设备都会退出'))
    assert.equal(text.includes('不受影响'), false)
  })

  it('explains active devices unaffected when revokesSessions=false', async () => {
    const { tree, renderer, registration, props } = await renderRow({
      locale: ZH_LOCALE,
      fetch: async () => ({
        status: 200,
        json: async () => ({
          ok: true,
          phase: 'ready',
          canRotate: true,
          revokesSessions: false,
          loginUrl: 'https://host.ts.net:7259/remote/OLD',
          plainUrl: 'https://host.ts.net:7259/',
          cookieMaxAgeDays: 3650,
        }),
      }),
    })
    buttonWith(tree, '更换密钥').props.onClick()
    await renderer.flush()
    const text = (function collect(node, out = []) {
      if (typeof node === 'string') out.push(node)
      else if (Array.isArray(node)) node.forEach((c) => collect(c, out))
      else if (node !== null && typeof node === 'object' && node.children !== undefined) collect(node.children, out)
      return out
    })(renderer.render(registration.component, props)).join('\n')
    assert.ok(text.includes('不受影响'))
    assert.equal(text.includes('所有已登录的设备都会退出'), false)
  })
})

describe('desktop window immutability', () => {
  it('registers existing settings row in desktop window (dshDesktopBoot)', () => {
    const { registrations } = applyAndCollect({ window: { dshDesktopBoot: { ready: async () => ({}) } } })
    const injects = registrations.filter((r) => r.kind === 'slots.inject')
    assert.equal(injects.length, 1)
    assert.equal(injects[0].name, 'settings.general.item')
  })

  it('does not register the mobile sidebar toggle in desktop window', () => {
    const { registrations } = applyAndCollect({ window: { dshDesktopBoot: { ready: async () => ({}) } } })
    const toggle = registrations.filter((r) => r.kind === 'slots.inject').find((r) => r.name === 'layout.header.left')
    assert.equal(toggle, undefined)
  })

  it('registers both settings row and mobile sidebar toggle on remote browser', () => {
    const { registrations } = applyAndCollect({ window: {} })
    const injects = registrations.filter((r) => r.kind === 'slots.inject')
    assert.equal(injects.length, 2)
  })
})
