# dsh-daemon

Run the DeepSeek Harness web UI (`dsh web`) as a **systemd `--user`** daemon.

The `web` profile is left untouched — the unit's `ExecStart` is a plain
`dsh web`. A separate, management-only `daemon` profile hosts this plugin and
owns `install` / `start` / `stop` / `restart` / `status` / `logs` / `uninstall`.

## Install

```bash
# one-time: create the daemon profile and install this plugin into it
dsh plugin --profile daemon add @gitsang/dsh-daemon

# write ~/.config/systemd/user/dsh-daemon.service and enable --now
dsh --profile daemon install
```

Optional overrides, baked into the unit:

```bash
dsh --profile daemon install --host 127.0.0.1 --port 8080 --cwd /path/to/work
# optional: customize the auto-continue prompt (default is "continue")
dsh --profile daemon install --resume-prompt "继续"
```

Defaults: `127.0.0.1:3080`, working directory `$HOME`, shared `~/.dsh`.
`--host 0.0.0.0` is rejected (remote code execution risk).

### Behind a reverse proxy

The `/api` endpoints are guarded by dsh web's browser-trust fence: every
request's `Host` header must be loopback or a declared `--trusted-host`
authority. A reverse proxy (Traefik, nginx, Caddy) forwards the external
`Host`, so install with that hostname:

```bash
dsh --profile daemon install --trusted-host dsh-web.example.com
# or with an explicit port: --trusted-host dsh-web.example.com:8443
```

Repeatable, and baked into the unit like `--host`/`--port`.

### Using with dsh-web-auth

[dsh-web-auth](https://github.com/gitsang/dsh-web-auth) is a `web`-profile
plugin that starts a password auth reverse proxy beside `dsh web`. Since
dsh-daemon's systemd unit runs the normal `web` profile via `dsh web`, the
auth proxy automatically runs inside the same `dsh-daemon` service.

Add it to the `web` profile:

```bash
dsh plugin --profile web add github:gitsang/dsh-web-auth
```

If dsh-daemon is already installed, restart it to load the updated `web`
profile:

```bash
dsh --profile daemon restart
```

If this is a fresh dsh-daemon setup, follow the `dsh --profile daemon install`
commands at the top of the Install section instead.

Then use the auth proxy port instead of the raw web port:

```text
http://127.0.0.1:3081   # default raw web port 3080 + 1
```

If you installed the daemon with `--port 8080`, the auth proxy defaults to
`8081` (unless you set `DSH_WEB_AUTH_PORT`).

Keep the daemon's `--host`/`--port` pointing at the raw `dsh web` listener
(the default `127.0.0.1:3080`). dsh-web-auth forwards to
`127.0.0.1:<dsh web port>`, and dsh-daemon's graceful restart/resume helper
talks to that raw listener directly — it does not go through the password
proxy.

For LAN access through dsh-web-auth, keep the raw web server loopback-only and
let the auth proxy do the listening. First install the daemon with the
authority browsers will use:

```bash
dsh --profile daemon install --trusted-host 192.168.1.20:3081
# or with a hostname / a different auth proxy port:
dsh --profile daemon install --trusted-host dsh-web.example.com:3081
```

Then make the auth proxy listen on a non-loopback address:

```bash
systemctl --user edit dsh-daemon
```

Add:

```ini
[Service]
Environment=DSH_WEB_AUTH_HOST=0.0.0.0
# optional, if you do not want the default "dsh web port + 1":
# Environment=DSH_WEB_AUTH_PORT=3081
```

Apply the override:

```bash
systemctl --user daemon-reload
systemctl --user restart dsh-daemon
```

Now open `http://192.168.1.20:3081` (or your chosen name/port) and complete
the password setup. See the [dsh-web-auth README](https://github.com/gitsang/dsh-web-auth)
for more details on configuration, PWA, and security.

### Graceful restart / resume

The generated unit hooks `ExecStop` and `ExecStartPost` so a restart (via
`dsh --profile daemon restart` or plain `systemctl --user restart
dsh-daemon`) does not just SIGKILL the web process. Re-run
`dsh --profile daemon install` after upgrading to regenerate the unit with
these hooks:

1. Before stopping, the daemon asks the running `dsh web` to list sessions,
   cancels every currently-running turn (keeping queued work), waits for it
   to drain/flush, and records those session ids in `~/.dsh/daemon-resume.json`.
2. After starting, it waits for the web API to come back and reattaches each
   saved session by calling `session.create({ sessionId, cwd })`.
3. After reattaching, the daemon sends `continue` to each resumed session so
   the work keeps going automatically. You can customize that prompt:

```bash
dsh --profile daemon install --resume-prompt "继续"
```

If you only want to restore the sessions and then start them again manually
from the UI/TUI, install with `--no-resume-prompt`:

```bash
dsh --profile daemon install --no-resume-prompt
```

This is a clean pause/resume workflow: dsh's persistence does not support
resuming an interrupted turn in the middle, so the graceful stop closes the
active turn first (no crash-repair synthetic closers) and the saved session
can continue with a new prompt.

For the daemon to survive logout, enable lingering once:

```bash
loginctl enable-linger
```

## Commands

### `dsh --profile daemon install`

Write the systemd unit and enable `--now`.

| Option | Description |
| --- | --- |
| `--host <host>` | Bind host for the served web app. Default: `127.0.0.1`. `0.0.0.0` is rejected. |
| `--port <port>` | Listen port for the served web app. Default: `3080`. Must be an integer in `1..65535`. |
| `--trusted-host <authority...>` | Extra authority the `/api` browser-trust fence accepts (`host` or `host:port`). Repeatable. |
| `--cwd <dir>` | Working directory of the daemon. Default: `$HOME`. |
| `--resume-prompt <text>` | Prompt sent to each previously-running session after restart to continue it. Default: `continue`. |
| `--no-resume-prompt` | Do not send an automatic continuation prompt; only reattach sessions after restart. |

### `dsh --profile daemon start`

Start the daemon.

No options.

### `dsh --profile daemon stop`

Stop the daemon gracefully.

No options.

### `dsh --profile daemon restart`

Restart the daemon gracefully and resume previously-running sessions.

No options.

### `dsh --profile daemon status`

Show the daemon status.

No options.

### `dsh --profile daemon logs`

Show the daemon journal.

| Option | Description |
| --- | --- |
| `-f, --follow` | Follow new journal output. |

### `dsh --profile daemon uninstall`

Disable and remove the systemd unit.

No options.

Everything is a thin wrapper over `systemctl --user` / `journalctl --user`,
so plain systemctl commands work too.
