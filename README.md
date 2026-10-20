# dsh-daemon

Run the DeepSeek Harness web UI (`dsh web`) as a **systemd `--user`** daemon.

The `web` profile is left untouched — the unit's `ExecStart` is
`dsh web --no-open`, so starting the daemon does not launch a browser. A
separate, management-only `daemon` profile hosts this plugin and
owns `install` / `start` / `stop` / `restart` / `status` / `logs` / `uninstall`.

## Install

```bash
# one-time: create the daemon profile and install this plugin into it
dsh plugin --profile daemon add @gitsang/dsh-daemon

# write ~/.config/systemd/user/dsh-daemon.service and enable --now
dsh --profile daemon install
```

For more installation options, see the [Commands/install](#dsh---profile-daemon-install) section.

## Commands

### `dsh --profile daemon install`

Write the systemd unit and enable `--now`. Re-running `install` applies the updated unit and proxy drop-in.

| Option | Description |
| --- | --- |
| `--host <host>` | Bind host for the served web app. Default: `127.0.0.1`. `0.0.0.0` is rejected. |
| `--port <port>` | Listen port for the served web app. Default: `3080`. Must be an integer in `1..65535`. |
| `--trusted-host <authority...>` | Extra authority the `/api` browser-trust fence accepts (`host` or `host:port`). Repeatable. |
| `--cwd <dir>` | Working directory of the daemon. Default: `$HOME`. |
| `--proxy <url>` | Outbound HTTP(S) proxy. Writes `~/.config/systemd/user/dsh-daemon.service.d/proxy.conf` with `NODE_USE_ENV_PROXY=1`, `HTTP_PROXY`, and `HTTPS_PROXY`. |
| `--no-proxy <hosts>` | Comma-separated `NO_PROXY` list written to the same proxy drop-in. Default: `localhost,127.0.0.1,::1,*.internal.example.com`. Requires `--proxy`. |
| `--resume-prompt <text>` | Prompt sent to each previously-running session after restart to continue it. Default: `continue`. |
| `--no-resume-prompt` | Do not send an automatic continuation prompt; only reattach sessions after restart. |

Reinstalling without `--proxy` removes the generated proxy drop-in. For example:

```bash
dsh --profile daemon install \
  --proxy http://proxy.example.com:7890 \
  --no-proxy localhost,127.0.0.1,::1,*.corp.example.com
```

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

Disable and remove the systemd unit and generated proxy drop-in.

No options.

Everything is a thin wrapper over `systemctl --user` / `journalctl --user`,
so plain systemctl commands work too.
