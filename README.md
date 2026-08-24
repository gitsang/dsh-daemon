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

## Options

### `dsh --profile daemon install`

| Option | Description |
| --- | --- |
| `--host <host>` | Bind host for the served web app. Default: `127.0.0.1`. `0.0.0.0` is rejected. |
| `--port <port>` | Listen port for the served web app. Default: `3080`. Must be an integer in `1..65535`. |
| `--trusted-host <authority...>` | Extra authority the `/api` browser-trust fence accepts (`host` or `host:port`). Repeatable. |
| `--cwd <dir>` | Working directory of the daemon. Default: `$HOME`. |
| `--resume-prompt <text>` | Prompt sent to each previously-running session after restart to continue it. Default: `continue`. |
| `--no-resume-prompt` | Do not send an automatic continuation prompt; only reattach sessions after restart. |

### `dsh --profile daemon logs`

| Option | Description |
| --- | --- |
| `-f, --follow` | Follow new journal output. |

## Manage

```bash
dsh --profile daemon status
dsh --profile daemon logs            # recent journal entries
dsh --profile daemon logs -f         # follow
dsh --profile daemon restart
dsh --profile daemon stop
dsh --profile daemon start
dsh --profile daemon uninstall
```

Everything is a thin wrapper over `systemctl --user` / `journalctl --user`,
so plain systemctl commands work too.
