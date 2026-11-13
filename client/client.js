// dsh-tailscale client half: adds a "Phone access" row in "Settings → General",
// displays the mobile login URL, and allows rotating keys.
//
// Hand-written without a build step: elements are constructed with React.createElement,
// styles are fully inline, colors use DSH theme CSS variables (prefixed with --dsw-alias-,
// automatically following light/dark mode) with light fallback values, keeping the UI readable
// even if CSS variables are missing.
//
// Data comes from two same-origin /api routes (host-side index.js registered on connection.fetch,
// thereby inheriting DSH's own Host/Origin fence and cookie authentication):
//   GET  /api/dsh-tailscale/state   → { ok, phase, error, plainUrl, loginUrl, ... }
//   POST /api/dsh-tailscale/rotate  → { ok, loginUrl } | { ok:false, error }
// Note: on failure, the status code is non-200 but the response body is still JSON containing
// the actual error message. We parse the body first before checking body.ok, avoiding overwriting
// the original error with a generic status code.
//
// This row does NOT poll or run background timers: it fetches once on mount and refreshes on
// window focus. When the Settings page closes, nothing remains running.

window.__ModuleLoader__.load({
	id: 'dsh-tailscale',
	factory: (require) => {
		// Loader only passes require, not module, so each bundle declares this pair,
		// matching the host's own bundle conventions.
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const h = React.createElement
		const useState = React.useState
		const useEffect = React.useEffect
		const useCallback = React.useCallback
		const useRef = React.useRef

		/** Slot ID for this row; also the locator key in the Settings page. */
		const ROW_ID = 'dsh-tailscale'

		const STATE_PATH = '/api/dsh-tailscale/state'
		const ROTATE_PATH = '/api/dsh-tailscale/rotate'

		/**
		 * Inline dictionary.
		 *
		 * When the host provides a locale service, it takes priority (see pickLanguage).
		 * This dictionary serves as fallback: when the locale service is unavailable
		 * (browser harness, web renderer), the UI still displays proper English/Chinese
		 * instead of raw literal keys.
		 */
		const ZH = {
			title: '手机连接',
			description: '开 DSH 时把网页发布到你的 Tailscale 网络（tailnet），手机在任何网络下打开下面的链接就能连上；关掉 DSH 会自动撤掉这条路由。',
			loading: '正在读取…',
			urlLabel: '手机登录链接',
			plainLabel: '直连地址',
			copy: '复制',
			copied: '已复制',
			copyFailed: '复制失败，请手动选中输入框里的内容复制',
			rotate: '更换密钥',
			rotateConfirm: '确认更换',
			rotateCancel: '取消',
			rotateWarningRevoke: '换完之后旧链接立刻失效，所有已登录的设备都会退出（包括你的手机），需要用新链接重新登录一次。这台设备会被自动保留登录状态。',
			rotateWarningLinkOnly: '换完之后旧链接立刻失效，需要把新链接重新存一次书签。已经登录过的设备不受影响。',
			rotateDoneRevoke: '已更换。旧密钥与所有旧登录都已失效，请把新链接重新存一次书签。',
			rotateDoneLinkOnly: '已更换。请重新保存下面的链接。',
			rotateFailed: '更换失败',
			noLogin: '登录入口已关闭（loginRoute=false），下面的直连地址需要先在本机用一次性令牌登录。',
			keepBookmark: '存一次书签即可，跨重启不变。',
			cookieHint: (days) => `登录状态有效期 ${days} 天。`,
			retry: '重试',
			phaseStarting: '还在启动中（拉起 Tailscale / 建立 Serve 路由）。',
			phaseUnavailable: 'Tailscale 没在运行，远程访问暂时不可用。',
			phaseError: '远程访问没能建起来。',
		}

		const EN = {
			title: 'Phone access',
			description: 'While DSH runs, its Web GUI is published to your Tailscale network (tailnet), so a phone anywhere can open the link below. Quitting DSH removes the route.',
			loading: 'Loading…',
			urlLabel: 'Phone login link',
			plainLabel: 'Direct address',
			copy: 'Copy',
			copied: 'Copied',
			copyFailed: 'Copy failed — select the field and copy manually',
			rotate: 'Change key',
			rotateConfirm: 'Confirm change',
			rotateCancel: 'Cancel',
			rotateWarningRevoke: 'The old link stops working immediately and every signed-in device is signed out, including your phone — sign in again with the new link. This device stays signed in.',
			rotateWarningLinkOnly: 'The old link stops working immediately; bookmark the new one. Devices already signed in are unaffected.',
			rotateDoneRevoke: 'Changed. The old key and every old session are now invalid; save the new link again.',
			rotateDoneLinkOnly: 'Changed. Save the link below again.',
			rotateFailed: 'Change failed',
			noLogin: 'The login entry is off (loginRoute=false); the direct address needs a one-time token login from this machine first.',
			keepBookmark: 'Bookmark it once — it survives restarts.',
			cookieHint: (days) => `Sign-in stays valid for ${days} days.`,
			retry: 'Retry',
			phaseStarting: 'Still starting up (bringing up Tailscale / the Serve route).',
			phaseUnavailable: 'Tailscale is not running, so remote access is unavailable.',
			phaseError: 'Remote access could not be established.',
		}

		/**
		 * Determines whether to display Chinese or English.
		 *
		 * Reads `ctx.get('locale')` (optional service, NOT declared in inject:
		 * putting it in inject would park the entire bundle when locale is absent).
		 * Falls back to browser language if unavailable.
		 * @param ctx - Client root context.
		 * @returns 'zh' or 'en'.
		 */
		function pickLanguage(ctx) {
			let active
			try {
				active = ctx.get('locale')?.getSnapshot?.().active
			} catch {
				active = undefined
			}
			if (typeof active === 'string' && active !== '') {
				return active.toLowerCase().startsWith('zh') ? 'zh' : 'en'
			}
			const nav = typeof navigator === 'undefined' ? '' : navigator.language
			return String(nav).toLowerCase().startsWith('zh') ? 'zh' : 'en'
		}

		/** Inline styles. CSS variable token names match DSH host with light fallbacks. */
		const styles = {
			row: {
				display: 'flex',
				flexDirection: 'column',
				gap: '10px',
				padding: '16px 0',
				borderBottom: '.5px solid var(--dsw-alias-border-l2,#e5e7eb)',
			},
			head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '24px' },
			title: { fontSize: 14, lineHeight: '20px', color: 'var(--dsw-alias-label-primary,#111827)' },
			description: {
				marginTop: 4,
				fontSize: 12,
				lineHeight: '18px',
				color: 'var(--dsw-alias-label-secondary,#6b7280)',
			},
			actions: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' },
			field: { display: 'flex', alignItems: 'center', gap: 8 },
			label: {
				fontSize: 12,
				lineHeight: '18px',
				color: 'var(--dsw-alias-label-secondary,#6b7280)',
				flex: 'none',
			},
			input: {
				flex: '1 1 auto',
				minWidth: 0,
				font: 'inherit',
				fontSize: 12,
				lineHeight: '18px',
				padding: '5px 8px',
				borderRadius: 'var(--dsw-radius-sm,8px)',
				border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
				background: 'var(--dsw-alias-bg-base,#fff)',
				color: 'var(--dsw-alias-label-primary,#111827)',
			},
			button: {
				font: 'inherit',
				fontSize: 12,
				lineHeight: '18px',
				padding: '5px 10px',
				borderRadius: 'var(--dsw-radius-sm,8px)',
				border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
				background: 'transparent',
				color: 'var(--dsw-alias-label-primary,#111827)',
				cursor: 'pointer',
				whiteSpace: 'nowrap',
				flex: 'none',
			},
			buttonPrimary: {
				borderColor: 'transparent',
				background: 'var(--dsw-alias-state-warn-primary,#b45309)',
				color: '#fff',
			},
			hint: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary,#6b7280)' },
			warn: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-warn-primary,#b45309)' },
			error: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary,#dc2626)' },
			ok: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-success-primary,#16a34a)' },
		}

		/**
		 * Fetches a JSON endpoint.
		 * On failure, parses JSON body first to retain specific error details before checking `ok`.
		 * @param path - Same-origin path.
		 * @param options - Fetch options.
		 * @returns `{ ok: true, data }` or `{ ok: false, error }`.
		 */
		async function readJson(path, options) {
			let response
			try {
				response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options })
			} catch (error) {
				return { ok: false, error: String((error && error.message) || error) }
			}
			let body
			try {
				body = await response.json()
			} catch {
				return { ok: false, error: `HTTP ${response.status}` }
			}
			if (body === null || typeof body !== 'object') return { ok: false, error: `HTTP ${response.status}` }
			if (body.ok !== true) {
				return { ok: false, error: typeof body.error === 'string' ? body.error : `HTTP ${response.status}` }
			}
			return { ok: true, data: body }
		}

		/** Translates phase/error status into human-readable description. */
		function describePhase(t, state) {
			if (state === null) return t.loading
			if (state.phase === 'starting') return t.phaseStarting
			if (state.phase === 'unavailable') return t.phaseUnavailable
			if (state.phase === 'error') return t.phaseError
			return undefined
		}

		/**
		 * Remote connection row in "Settings → General".
		 * Fetches status once on mount and refreshes on window focus.
		 * @param props - Injected props containing `ctx`.
		 */
		function RemoteRow(props) {
			const ctx = props.ctx
			// Force re-render on locale change; dictionary is an inline constant.
			const [, setTick] = useState(0)
			const [state, setState] = useState(null)
			const [error, setError] = useState(null)
			const [busy, setBusy] = useState(false)
			const [copied, setCopied] = useState(false)
			const [confirming, setConfirming] = useState(false)
			const [notice, setNotice] = useState(null)
			const inputRef = useRef(null)

			const t = pickLanguage(ctx) === 'zh' ? ZH : EN

			const load = useCallback(async () => {
				const result = await readJson(STATE_PATH)
				if (result.ok) {
					setState(result.data)
					setError(null)
				} else {
					setError(result.error)
				}
			}, [])

			useEffect(() => {
				void load()
			}, [load])

			useEffect(() => {
				const locale = (() => {
					try {
						return ctx.get('locale')
					} catch {
						return undefined
					}
				})()
				if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
				return locale.subscribe(() => setTick((n) => n + 1))
			}, [ctx])

			useEffect(() => {
				const onFocus = () => {
					void load()
				}
				window.addEventListener('focus', onFocus)
				return () => window.removeEventListener('focus', onFocus)
			}, [load])

			const url = state === null ? null : state.loginUrl || state.plainUrl
			const usesLoginUrl = state !== null && state.loginUrl !== null && state.loginUrl !== undefined

			const copy = useCallback(async () => {
				if (url === null || url === undefined) return
				let done = false
				try {
					if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
						await navigator.clipboard.writeText(url)
						done = true
					}
				} catch {
					done = false
				}
				if (!done) {
					// Fallback to selecting input when clipboard API is unavailable in non-secure contexts.
					try {
						inputRef.current?.select?.()
						done = document.execCommand('copy')
					} catch {
						done = false
					}
				}
				setNotice(done ? null : t.copyFailed)
				setCopied(done)
				if (done) setTimeout(() => setCopied(false), 1600)
			}, [url, t])

			const rotate = useCallback(async () => {
				setBusy(true)
				setNotice(null)
				const result = await readJson(ROTATE_PATH, { method: 'POST' })
				setBusy(false)
				setConfirming(false)
				if (!result.ok) {
					setNotice(`${t.rotateFailed}：${result.error}`)
					return
				}
				setState((previous) => ({ ...(previous ?? {}), ...result.data }))
				setNotice(result.data.revokesSessions === false ? t.rotateDoneLinkOnly : t.rotateDoneRevoke)
			}, [t])

			const canRotate = state !== null && state.canRotate === true && !busy

			// Warning text must follow actual revocation behavior: clearly explain that all devices are signed out.
			const revokes = state !== null && state.revokesSessions === true
			const warningText = revokes ? t.rotateWarningRevoke : t.rotateWarningLinkOnly

			// Initial frame: show loading indicator while fetching status
			if (state === null && error === null) {
				return h(
					'div',
					{ style: styles.row, 'data-dsh-tailscale-row': '' },
					h('div', { style: styles.title }, t.title),
					h('div', { style: styles.description }, t.description),
					h('div', { style: styles.hint }, t.loading),
				)
			}

			const hint = describePhase(t, state)

			return h(
				'div',
				{ style: styles.row, 'data-dsh-tailscale-row': '' },
				h(
					'div',
					{ style: styles.head },
					h(
						'div',
						null,
						h('div', { style: styles.title }, t.title),
						h('div', { style: styles.description }, t.description),
					),
					h(
						'div',
						{ style: styles.actions },
						confirming
							? [
									h(
										'button',
										{
											key: 'go',
											type: 'button',
											style: { ...styles.button, ...styles.buttonPrimary },
											disabled: busy,
											onClick: () => void rotate(),
										},
										t.rotateConfirm,
									),
									h(
										'button',
										{ key: 'no', type: 'button', style: styles.button, disabled: busy, onClick: () => setConfirming(false) },
										t.rotateCancel,
									),
								]
							: h(
									'button',
									{
										type: 'button',
										style: styles.button,
										disabled: !canRotate,
										onClick: () => {
											setNotice(null)
											setConfirming(true)
										},
									},
									t.rotate,
								),
					),
				),
				h(
					'div',
					{ style: styles.field },
					h('span', { style: styles.label }, usesLoginUrl ? t.urlLabel : t.plainLabel),
					h('input', {
						ref: inputRef,
						readOnly: true,
						spellCheck: false,
						value: url ?? '',
						'aria-label': usesLoginUrl ? t.urlLabel : t.plainLabel,
						style: styles.input,
						onFocus: (event) => {
							try {
								event.target.select()
							} catch {
								/* ignore select failure */
							}
						},
					}),
					h(
						'button',
						{ type: 'button', style: styles.button, disabled: url === null || url === undefined, onClick: () => void copy() },
						copied ? t.copied : t.copy,
					),
				),
				confirming ? h('div', { style: styles.warn }, warningText) : null,
				notice === null ? null : h('div', { style: styles.warn }, notice),
				error !== null
					? h(
							'div',
							{ style: styles.error, role: 'alert' },
							`${error} `,
							h(
								'button',
								{ type: 'button', style: styles.button, onClick: () => void load() },
								t.retry,
							),
						)
					: null,
				state === null || state.phase === 'ready'
					? h(
							'div',
							{ style: styles.hint },
							usesLoginUrl ? `${t.keepBookmark}${t.cookieHint(state?.cookieMaxAgeDays ?? 0)}` : t.noLogin,
						)
					: h('div', { style: styles.hint }, hint),
			)
		}

		/**
		 * Checks whether this execution context is an Electron Desktop App window.
		 * Detected by `dshDesktopBoot`, exposed exclusively in the desktop main world via preload.
		 * @returns boolean indicating whether the plugin runs inside the desktop app.
		 */
		function isDesktopWindow() {
			return typeof globalThis !== 'undefined' && 'dshDesktopBoot' in globalThis
		}

		/**
		 * Mobile sidebar toggle button (top-left).
		 *
		 * The host's mobile layout hides the chat list behind a drawer; this button toggles
		 * the sidebar's visibility so the conversation stays reachable on a phone.
		 * It is never registered in desktop windows (see `apply`).
		 */
		function MobileSidebarToggle() {
			return h(
				'button',
				{
					type: 'button',
					style: {
						position: 'fixed',
						top: '10px',
						left: '10px',
						zIndex: 9999,
						padding: '8px',
						borderRadius: 'var(--dsw-radius-sm,8px)',
						background: 'var(--dsw-alias-bg-base,#fff)',
						border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)',
						cursor: 'pointer',
					},
					onClick: () => {
						const sidebar = document.querySelector('[class*="_sidebarContainer"]')
						if (sidebar) {
							sidebar.style.display = sidebar.style.display === 'none' ? 'block' : 'none'
						}
					},
				},
				'Chats',
			)
		}

		/**
		 * Registers the plugin's UI components:
		 *   1. Settings row in "Settings → General" (`settings.general.item`), in every window.
		 *   2. Mobile sidebar toggle (`layout.header.left`), in the web client only.
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject('settings.general.item', () =>
				ctx.slots.register(
					{
						name: 'settings.general.item',
						id: ROW_ID,
						order: 95,
						inject: () => ({ ctx }),
					},
					RemoteRow,
				),
			)

			// The desktop app owns its own header; only the web client gets the phone toggle.
			if (!isDesktopWindow()) {
				ctx.slots.inject('layout.header.left', () =>
					ctx.slots.register(
						{
							name: 'layout.header.left',
							id: `${ROW_ID}-toggle`,
							order: 10,
							inject: () => ({ ctx }),
						},
						MobileSidebarToggle,
					),
				)
			}
		}

		exports.name = 'dsh-tailscale'
		// Only requires slots; locale is read optionally via ctx.get
		exports.inject = ['slots']
		exports.apply = apply
		return module.exports
	},
})
