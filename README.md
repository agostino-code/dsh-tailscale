# dsh-tailscale

Expose the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web GUI on your **Tailscale tailnet** with **Tailscale Serve**, so a phone or a second machine can open it from any network. The route is removed when DSH exits.

The phone link lives in **Settings → General → Phone access**, with one-click copy and key rotation. Links survive DSH restarts, so one bookmark is enough.

## Features

- **One persistent link.** Publish `https://<device>.<tailnet>.ts.net:7259` and keep a bookmarkable login URL that survives restarts.
- **Zero third-party relays.** Traffic goes from the browser to your tailnet through Tailscale Serve; nothing is exposed publicly (Funnel is never used).
- **Automatic cleanup.** Quitting DSH removes the Serve route and the trusted-host entry, and only stops Tailscale if this plugin started it.
- **Key rotation.** Rotate the login secret from Settings; optionally revoke every signed-in session at the same time.
- **Lazy WebSocket compression.** `permessage-deflate` is enabled on DSH's `/api/remote.mux` on first handshake, so startup pays nothing.
- **No lite mode.** The Web UI is always served in full; no page is pruned or rewritten.

## Requirements

- Tailscale installed, logged in, and running on the host machine.
- **HTTPS Certificates** enabled in the tailnet (Tailscale Admin Console → DNS → HTTPS Certificates). Without them `tailscale serve` fails and the plugin logs a warning.
- DSH with a Web server (`webServer` service). The plugin is inert when `enabled` is `false`.

## Installation

Install from a local checkout:

```sh
git clone https://github.com/agostino-code/dsh-tailscale.git
dsh plugin --profile <your-profile> add -w /path/to/dsh-tailscale
```

Once the npm package is published:

```sh
dsh plugin --profile <your-profile> add dsh-tailscale
```

After installing, **restart DSH** so the new package is loaded. It runs automatically on subsequent launches. `cordis.patch.yml` inserts one host-only plugin row, enabled by default.

## Getting the Phone Link

The quickest way is the **Settings → General → Phone access** row:

1. Open DSH, go to Settings, scroll to **Phone access**.
2. Copy the **Phone login link** with the **Copy** button.
3. Open it once on the phone; the browser is redirected, signed in, and a cookie is set.
4. Save the page as a bookmark or add it to the home screen. The link does not change across restarts.

You can also read the link without opening the GUI:

```sh
cat ~/.dsh/dsh-tailscale.json
```

The `loginUrl` field is the persistent entry point:

```
https://<your-device>.<tailnet>.ts.net:7259/remote/<persistent-secret>
```

On Windows PowerShell:

```powershell
Get-Content "$env:USERPROFILE\.dsh\dsh-tailscale.json"
```

Other fields in the status file: `url` (one-time tokenized URL), `plainUrl` (clean root address), `authority`, `dnsName`, and `cookieMaxAgeDays`.

> DSH's Web GUI requires a login token; without one it prints `dsh web authentication required; ...`. The desktop app never prints that URL (it uses IPC instead of `dsh web`), and tokens change on every restart, so this plugin adds a persistent login route instead.

## What It Does

On startup:

1. Verifies that Tailscale is running by checking `BackendState` in `tailscale status --json` (not just `tailscale up` exit codes).
2. Publishes `https://<device>.<tailnet>.ts.net:<httpsPort>` with `tailscale serve`, proxying to DSH's internal Web port (read from the `webServer` service, never hard-coded).
3. Adds `<device>.<tailnet>.ts.net:<httpsPort>` to DSH's `/api` trusted hosts (`connection.trustedHosts`).
4. Persists a login secret, registers `/remote/<secret>`, prints the mobile URLs, and writes them to the status file.
5. Registers the Settings row and, in the web client only, a top-left mobile sidebar toggle.

On exit:

- Removes the Serve route on the configured port and unregisters the trusted authority.
- Reclaims a matching stale route on the same port left by a previous crash, so shutdown after recovery still works.
- Runs `tailscale down` only when Tailscale was originally down and this plugin started it.

## Why the Trust List Must Be Modified

`tailscale serve` preserves the client `Host` header, so requests reaching DSH carry `host: <device>.ts.net:<port>`. DSH's `/api` fence requires the Host to be loopback or listed in `trustedHosts`; otherwise it answers `403` and the page loads but every action fails. The plugin pushes the authority into `connection.trustedHosts` at runtime (a mutable array checked on each request), so no `cordis.yml` edit is needed.

## Configuration

```yaml
- id: dsh-tailscale
  config:
    enabled: true
    httpsPort: 7259
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | When `false`, the plugin stays inactive and only reports status. |
| `httpsPort` | `7259` | HTTPS port exposed on the tailnet. |
| `connectOnStart` | `true` | Start Tailscale when it is not running. |
| `serveOnStart` | `true` | Configure the Tailscale Serve route. |
| `teardownOnExit` | `true` | Roll back routes and trust-list changes on DSH exit. |
| `trustedHosts` | `true` | Register the authority in the `/api` trust list. |
| `loginRoute` | `true` | Register `/remote/<secret>` for persistent logins. |
| `revokeSessionsOnRotate` | `true` | Rotate the session signing key too, signing out every device. |
| `cookieMaxAgeDays` | `3650` | Session cookie lifetime in days (`0` keeps DSH's 30-day default). |
| `binaryPath` | auto-detected | Path to the `tailscale` CLI. |
| `guiPath` | auto-detected | Path to the Tailscale desktop client (`tailscale-ipn.exe` on Windows). |
| `readyTimeoutMs` | `8000` | Wait budget for `tailscale up` readiness. |
| `guiReadyTimeoutMs` | `25000` | Wait budget for desktop-client backend startup. |
| `stateFile` | `$DSH_HOME/dsh-tailscale.json` | Where the status snapshot is written. |
| `websocketCompression` | `true` | Enable `permessage-deflate` on `/api/remote.mux`. |

### Key Rotation

The **Change key** button (with confirmation) rotates the persistent login secret. If `revokeSessionsOnRotate` is `true` (default), the browser-session signing key is rotated as well, so every existing signed-in cookie becomes invalid — including the one on the phone. The device that performs the rotation immediately receives a fresh cookie and stays signed in. Set `revokeSessionsOnRotate: false` to change only the link and leave signed-in devices alone.

### Persistent Login Route

`/remote/<secret>` responds with a `302` to the GUI and sets a session cookie. The secret is stable across restarts, which is what makes the link bookmarkable. The cookie lifetime is 10 years by default (`cookieMaxAgeDays: 3650`).

## Status Endpoints

The client half calls two same-origin routes registered on `connection.fetch`:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/dsh-tailscale/state` | Setup phase, error, URLs, rotation flags. |
| `POST` | `/api/dsh-tailscale/rotate` | Rotate the login secret (and optionally revoke sessions). |

Both inherit DSH's Host/Origin fence and cookie authentication.

## Windows Backend Startup

Exiting Tailscale from the Windows tray leaves `tailscaled` running while the backend reports `NoState`. In that state `tailscale up` exits `0` immediately without connecting. The plugin checks `BackendState`; when it is not `Running` it launches the desktop client (`tailscale-ipn.exe`), which initializes the backend reliably.

## Security

- **Tailnet-only.** The route is reachable only from your private tailnet; Funnel is never used.
- **Layered auth.** DSH's session cookie and Host/Origin fence stay in force; the plugin adds a route, it does not bypass DSH authentication.
- **Treat the status file as a secret.** It contains the login URL (equivalent to a password); rotating the key invalidates a leaked link and every session created from it.

## Development

```sh
npm test
```

The suite runs with Node's built-in test runner and covers the Tailscale classification/teardown logic, management routes, key rotation, the Settings client bundle, and the lazy WebSocket patch.

## License

MIT — see [LICENSE](LICENSE).

Derived from [`Ckarefulon/dsh-tailscale-remote`](https://github.com/Ckarefulon/dsh-tailscale-remote). This repository continues the Tailscale remote-access plugin as **dsh-tailscale** and drops the upstream lite/mobile-pruned page mode.
