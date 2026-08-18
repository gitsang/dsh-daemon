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
```

Defaults: `127.0.0.1:3080`, working directory `$HOME`, shared `~/.dsh`.
`--host 0.0.0.0` is rejected (remote code execution risk); use `--trusted-host`
for LAN access.

For the daemon to survive logout, enable lingering once:

```bash
loginctl enable-linger
```

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
