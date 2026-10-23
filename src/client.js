/**
 * Browser half of dsh-daemon.
 *
 * The daemon's page lives on its own Plugins row, not in Settings: it reads
 * the systemd user unit and submits the same lifecycle verbs the CLI exposes.
 * All writes go through the authenticated /api/dsh-daemon routes registered by
 * the Host half; this module never talks to systemd directly.
 *
 * The page draws only its own sections (status, actions, logs) because the
 * Plugins page already draws the row title and package description. Controls
 * use the shared counter primitives so the page matches the official plugin
 * configuration pages.
 */
window.__ModuleLoader__.load({
  id: '@gitsang/dsh-daemon',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button } = primitives
    const module = { exports: {} }
    const exports = module.exports
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const NS = 'daemon'
    const API_ROOT = 'api/dsh-daemon'
    const POLL_MS = 5_000
    const LINES = [100, 200, 500, 1000, 2000]

    const zh = {
      nav: '守护进程',
      title: '守护进程',
      intro: '查看并控制运行 dsh Web UI 的 systemd --user 服务。',
      summary: '查看和控制运行 dsh Web UI 的 systemd --user 服务',
      refresh: '刷新',
      start: '启动',
      stop: '停止',
      restart: '重启',
      working: '执行中…',
      refreshStatus: '刷新状态',
      refreshLogs: '刷新日志',
      logsTitle: '服务日志',
      logsHint: '最近 {lines} 行 journalctl 输出。',
      linesLabel: '行数',
      noLogs: '暂无日志。',
      logsTruncated: '日志过长，仅显示前 {bytes}。',
      statusTitle: '服务状态',
      statusUnavailable: '无法读取 systemd 状态',
      statusUnavailableHint: '确认当前 dsh 进程运行在 systemd --user 会话中，并且可以访问 user bus。',
      unitMissing: '尚未安装 dsh-daemon.service。',
      unitMissingHint: '在终端运行 `dsh --profile daemon install` 创建服务。',
      fieldState: '运行状态',
      fieldSubState: '子状态',
      fieldPid: '主进程 PID',
      fieldSince: '启动时间',
      fieldMemory: '内存',
      fieldFileState: '开机启动',
      fieldResult: '结果',
      fieldUnit: 'Unit 文件',
      fieldProxy: '出站代理',
      fieldNeedReload: '需要 daemon-reload',
      notAvailable: '—',
      enabled: '已启用',
      disabled: '未启用',
      proxyConfigured: '已配置',
      proxyNotConfigured: '未配置',
      needReloadYes: '是',
      needReloadNo: '否',
      stateActive: '运行中',
      stateInactive: '已停止',
      stateFailed: '失败',
      stateActivating: '启动中',
      stateDeactivating: '停止中',
      stateReloading: '重载中',
      stateMaintenance: '维护中',
      stateUnknown: '未知',
      submitted: '已提交 {action} 请求，正在刷新状态。',
      actionFailed: '操作失败',
      actionLost: '请求未收到响应，服务可能正在重启；连接恢复后请刷新页面。',
      confirmStop: '确定停止 dsh-daemon 服务吗？如果当前页面由它提供，连接会中断。',
      confirmRestart: '确定重启 dsh-daemon 服务吗？如果当前页面由它提供，连接会中断。',
      loadStatusFailed: '无法刷新服务状态',
      loadLogsFailed: '无法读取服务日志',
      interruptWarning: '停止或重启会中断当前连接（当此页面由 dsh-daemon 服务提供时）。',
      autoRefreshHint: '状态每 5 秒自动刷新。',
    }

    const en = {
      nav: 'Daemon',
      title: 'Daemon',
      intro: 'Inspect and control the systemd --user service that runs the dsh Web UI.',
      summary: 'Inspect and control the systemd --user service that runs the dsh Web UI',
      refresh: 'Refresh',
      start: 'Start',
      stop: 'Stop',
      restart: 'Restart',
      working: 'Working…',
      refreshStatus: 'Refresh status',
      refreshLogs: 'Refresh logs',
      logsTitle: 'Service log',
      logsHint: 'The latest {lines} lines from journalctl.',
      linesLabel: 'Lines',
      noLogs: 'No log output.',
      logsTruncated: 'Log output was truncated to the first {bytes}.',
      statusTitle: 'Service status',
      statusUnavailable: 'Could not read systemd status',
      statusUnavailableHint: 'Check that this dsh process runs in a systemd --user session and can reach the user bus.',
      unitMissing: 'dsh-daemon.service is not installed.',
      unitMissingHint: 'Run `dsh --profile daemon install` in a terminal to create it.',
      fieldState: 'State',
      fieldSubState: 'Sub-state',
      fieldPid: 'Main PID',
      fieldSince: 'Started',
      fieldMemory: 'Memory',
      fieldFileState: 'Boot start',
      fieldResult: 'Result',
      fieldUnit: 'Unit file',
      fieldProxy: 'Outbound proxy',
      fieldNeedReload: 'Needs daemon-reload',
      notAvailable: '—',
      enabled: 'Enabled',
      disabled: 'Disabled',
      proxyConfigured: 'Configured',
      proxyNotConfigured: 'Not configured',
      needReloadYes: 'Yes',
      needReloadNo: 'No',
      stateActive: 'Running',
      stateInactive: 'Stopped',
      stateFailed: 'Failed',
      stateActivating: 'Starting',
      stateDeactivating: 'Stopping',
      stateReloading: 'Reloading',
      stateMaintenance: 'Maintenance',
      stateUnknown: 'Unknown',
      submitted: 'Submitted the {action} request; refreshing status.',
      actionFailed: 'Action failed',
      actionLost: 'No response arrived; the service may be restarting. Refresh the page after the connection recovers.',
      confirmStop: 'Stop dsh-daemon? If this page is served by it, the connection will drop.',
      confirmRestart: 'Restart dsh-daemon? If this page is served by it, the connection will drop.',
      loadStatusFailed: 'Could not refresh service status',
      loadLogsFailed: 'Could not read the service log',
      interruptWarning: 'Stopping or restarting drops the current connection when this page is served by dsh-daemon.',
      autoRefreshHint: 'Status refreshes every 5 seconds.',
    }

    const CSS_ID = '@gitsang/dsh-daemon/DaemonConfig.css'
    const CSS = [
      '.dshDaemon_page{display:flex;flex-direction:column;gap:0;max-width:760px;color:var(--dsw-alias-label-primary)}',
      '.dshDaemon_section{display:flex;flex-direction:column;gap:10px;padding:16px 0}',
      '.dshDaemon_section+.dshDaemon_section{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dshDaemon_sectionHead{display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap}',
      '.dshDaemon_heading{margin:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.dshDaemon_meta{margin-left:auto;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dshDaemon_toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px}',
      '.dshDaemon_toolbarSpacer{flex:1;min-width:8px}',
      '.dshDaemon_warning{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dshDaemon_notice{margin:0;font-size:12px;line-height:1.5}',
      '.dshDaemon_notice[data-tone="success"]{color:var(--dsw-alias-state-success-primary)}',
      '.dshDaemon_notice[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.dshDaemon_state{display:inline-flex;align-items:center;gap:6px;min-width:0}',
      '.dshDaemon_dot{flex:none;width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-label-quaternary)}',
      '.dshDaemon_dot[data-state="active"]{background:var(--dsw-alias-state-success-primary)}',
      '.dshDaemon_dot[data-state="failed"]{background:var(--dsw-alias-state-error-primary)}',
      '.dshDaemon_dot[data-state="activating"],.dshDaemon_dot[data-state="deactivating"],.dshDaemon_dot[data-state="reloading"]{background:var(--dsw-alias-state-warning-primary)}',
      '.dshDaemon_grid{display:grid;grid-template-columns:minmax(110px,auto) minmax(0,1fr);gap:7px 18px;margin:0;font-size:12px;line-height:1.5}',
      '.dshDaemon_grid dt{color:var(--dsw-alias-label-tertiary)}',
      '.dshDaemon_grid dd{min-width:0;margin:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}',
      '.dshDaemon_error{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}',
      '.dshDaemon_logsHead{display:flex;align-items:center;flex-wrap:wrap;gap:8px}',
      '.dshDaemon_select{box-sizing:border-box;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.dshDaemon_logs{margin:0;padding:12px;max-height:360px;overflow:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dshDaemon_empty{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '@media (max-width:560px){.dshDaemon_grid{grid-template-columns:1fr}.dshDaemon_grid dt{margin-top:4px}}',
    ].join('')

    /** Install the page stylesheet and return its disposer. */
    function installStyles() {
      if (typeof document === 'undefined' || document.head === undefined) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = '@gitsang/dsh-daemon'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    function apiUrl(path) {
      return `${API_ROOT}/${path}`
    }

    async function api(path, init) {
      const response = await fetch(apiUrl(path), {
        credentials: 'same-origin',
        ...init,
        headers: {
          ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init?.headers ?? {}),
        },
      })
      const text = await response.text()
      let body
      try {
        body = text === '' ? {} : JSON.parse(text)
      } catch {
        body = { error: text }
      }
      if (!response.ok || body?.ok === false) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      let amount = value
      let unit = 0
      while (amount >= 1024 && unit < units.length - 1) {
        amount /= 1024
        unit += 1
      }
      return `${amount >= 100 || unit === 0 ? Math.round(amount) : Math.round(amount * 10) / 10} ${units[unit]}`
    }

    function formatTimestamp(value) {
      if (typeof value !== 'string' || value === '' || value === 'n/a') return null
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString(undefined, {
        year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    }

    function stateKey(state) {
      switch (state) {
        case 'active': return 'stateActive'
        case 'inactive': return 'stateInactive'
        case 'failed': return 'stateFailed'
        case 'activating': return 'stateActivating'
        case 'deactivating': return 'stateDeactivating'
        case 'reloading': return 'stateReloading'
        case 'maintenance': return 'stateMaintenance'
        default: return 'stateUnknown'
      }
    }

    function StateText({ state, t }) {
      return h('span', { className: 'dshDaemon_state' },
        h('span', { className: 'dshDaemon_dot', 'data-state': state, 'aria-hidden': 'true' }),
        h('span', null, t(stateKey(state))),
      )
    }

    function Fact({ label, children }) {
      return h(React.Fragment, null,
        h('dt', null, label),
        h('dd', null, children),
      )
    }

    /** Configuration page that reads and controls the dsh-daemon user unit. */
    function DaemonSection({ view, t }) {
      const [status, setStatus] = useState(null)
      const [statusError, setStatusError] = useState(null)
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [logs, setLogs] = useState(null)
      const [logsLoading, setLogsLoading] = useState(true)
      const [logsError, setLogsError] = useState(null)
      const [lines, setLines] = useState(200)
      const alive = useRef(true)

      const loadStatus = useCallback(async () => {
        try {
          const body = await api('status')
          if (!alive.current) return
          setStatus(body.status)
          setStatusError(body.status?.error ?? null)
        } catch (error) {
          if (!alive.current) return
          setStatusError(messageOf(error))
        }
      }, [])

      const loadLogs = useCallback(async (count) => {
        setLogsLoading(true)
        setLogsError(null)
        try {
          const body = await api(`logs?lines=${encodeURIComponent(String(count))}`)
          if (!alive.current) return
          setLogs(body.logs)
        } catch (error) {
          if (!alive.current) return
          setLogsError(messageOf(error))
        } finally {
          if (alive.current) setLogsLoading(false)
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void loadStatus()
        const timer = setInterval(() => { void loadStatus() }, POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [loadStatus])

      useEffect(() => {
        void loadLogs(lines)
      }, [lines, loadLogs])

      const runAction = useCallback(async (action) => {
        if ((action === 'stop' || action === 'restart')
          && !window.confirm(action === 'stop' ? t('confirmStop') : t('confirmRestart'))) return
        setBusy(action)
        setNotice(null)
        try {
          await api('action', { method: 'POST', body: JSON.stringify({ action }) })
          setNotice({ tone: 'success', text: t('submitted', { action: t(action) }) })
        } catch (error) {
          const message = messageOf(error)
          setNotice({
            tone: 'error',
            text: /failed to fetch|networkerror|load failed/iu.test(message)
              ? t('actionLost')
              : `${t('actionFailed')}: ${message}`,
          })
        } finally {
          if (alive.current) {
            setBusy(null)
            window.setTimeout(() => {
              if (!alive.current) return
              void loadStatus()
              void loadLogs(lines)
            }, 800)
          }
        }
      }, [lines, loadLogs, loadStatus, t])

      if (view === 'summary') return t('summary')

      const installed = status?.installed === true
      const active = status?.activeState === 'active'
      const canControl = installed && status?.available !== false
      const memory = formatBytes(status?.memoryBytes)
      const since = formatTimestamp(status?.activeEnterTimestamp)

      return h('div', { className: 'dshDaemon_page' },
        h('section', { className: 'dshDaemon_section', 'aria-labelledby': 'dsh-daemon-status-title' },
          h('div', { className: 'dshDaemon_sectionHead' },
            h('h3', { className: 'dshDaemon_heading', id: 'dsh-daemon-status-title' }, t('statusTitle')),
            status === null ? null : h('span', { className: 'dshDaemon_meta' },
              installed ? h(StateText, { state: status.activeState, t }) : t('stateUnknown')),
            h('span', { className: 'dshDaemon_toolbarSpacer' }),
            h(Button, {
              size: 'sm', variant: 'outline',
              disabled: busy !== null, onClick: () => { void loadStatus() },
            }, t('refresh')),
          ),
          h('div', { className: 'dshDaemon_toolbar', role: 'group', 'aria-label': t('statusTitle') },
            h(Button, {
              size: 'sm', variant: 'primary',
              disabled: busy !== null || !canControl || active,
              onClick: () => { void runAction('start') },
            }, busy === 'start' ? t('working') : t('start')),
            h(Button, {
              size: 'sm', variant: 'outline',
              disabled: busy !== null || !canControl || !active,
              onClick: () => { void runAction('stop') },
            }, busy === 'stop' ? t('working') : t('stop')),
            h(Button, {
              size: 'sm', variant: 'outline',
              disabled: busy !== null || !canControl,
              onClick: () => { void runAction('restart') },
            }, busy === 'restart' ? t('working') : t('restart')),
            h('span', { className: 'dshDaemon_toolbarSpacer' }),
            h('span', { className: 'dshDaemon_meta' }, t('autoRefreshHint')),
          ),
          h('p', { className: 'dshDaemon_warning' }, t('interruptWarning')),

          statusError === null ? null : h('p', { className: 'dshDaemon_error', role: 'alert' },
            `${t('loadStatusFailed')}: ${statusError}`,
          ),
          notice === null ? null : h('p', { className: 'dshDaemon_notice', 'data-tone': notice.tone, role: 'status' }, notice.text),

          status === null ? null : !status.available ? h(React.Fragment, null,
            h('p', { className: 'dshDaemon_empty' }, t('statusUnavailable')),
            h('p', { className: 'dshDaemon_empty' }, t('statusUnavailableHint')),
          ) : !installed ? h(React.Fragment, null,
            h('p', { className: 'dshDaemon_empty' }, t('unitMissing')),
            h('p', { className: 'dshDaemon_empty' }, t('unitMissingHint')),
          ) : h('dl', { className: 'dshDaemon_grid' },
            h(Fact, { label: t('fieldState') }, h(StateText, { state: status.activeState, t })),
            h(Fact, { label: t('fieldSubState') }, status.subState),
            h(Fact, { label: t('fieldPid') }, status.mainPid === null ? t('notAvailable') : String(status.mainPid)),
            h(Fact, { label: t('fieldSince') }, since ?? t('notAvailable')),
            h(Fact, { label: t('fieldMemory') }, memory ?? t('notAvailable')),
            h(Fact, { label: t('fieldFileState') }, status.unitFileState === 'enabled' ? t('enabled') : status.unitFileState === 'disabled' ? t('disabled') : (status.unitFileState || t('notAvailable'))),
            h(Fact, { label: t('fieldResult') }, status.result || t('notAvailable')),
            h(Fact, { label: t('fieldUnit') }, status.fragmentPath || status.unitPath || t('notAvailable')),
            h(Fact, { label: t('fieldProxy') }, status.proxyConfigured ? t('proxyConfigured') : t('proxyNotConfigured')),
            h(Fact, { label: t('fieldNeedReload') }, status.needDaemonReload ? t('needReloadYes') : t('needReloadNo')),
          ),
        ),

        h('section', { className: 'dshDaemon_section', 'aria-labelledby': 'dsh-daemon-logs-title' },
          h('div', { className: 'dshDaemon_logsHead' },
            h('h3', { className: 'dshDaemon_heading', id: 'dsh-daemon-logs-title' }, t('logsTitle')),
            h('span', { className: 'dshDaemon_meta' }, t('logsHint', { lines })),
            h('span', { className: 'dshDaemon_toolbarSpacer' }),
            h('label', { className: 'dshDaemon_empty', htmlFor: 'dsh-daemon-lines' }, t('linesLabel')),
            h('select', {
              id: 'dsh-daemon-lines', className: 'dshDaemon_select', value: String(lines),
              disabled: logsLoading,
              onChange: (event) => { setLines(Number(event.target.value)) },
            }, ...LINES.map(value => h('option', { key: value, value: String(value) }, String(value)))),
            h(Button, {
              size: 'sm', variant: 'outline', disabled: logsLoading,
              onClick: () => { void loadLogs(lines) },
            }, logsLoading ? t('working') : t('refreshLogs')),
          ),
          logsError === null ? null : h('p', { className: 'dshDaemon_error', role: 'alert' },
            `${t('loadLogsFailed')}: ${logsError}`,
          ),
          logs?.truncated ? h('p', { className: 'dshDaemon_empty' }, t('logsTruncated', { bytes: formatBytes(512 * 1024) })) : null,
          logs === null || logs.text.trim() === ''
            ? h('p', { className: 'dshDaemon_empty' }, logsLoading ? t('working') : t('noLogs'))
            : h('pre', { className: 'dshDaemon_logs', tabIndex: 0 }, logs.text),
        ),
      )
    }

    const inject = ['slots', 'locale']
    const ROW_KEY = '@gitsang/dsh-daemon#daemon'

    function apply(ctx) {
      ctx.effect(installStyles, 'daemon: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'daemon: dictionaries')
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: ROW_KEY,
        locale: NS,
      }, DaemonSection))
    }

    exports.apply = apply
    exports.inject = inject
    exports.__test = { apiUrl, formatBytes, formatTimestamp, stateKey, DaemonSection, ROW_KEY }
    return module.exports
  },
})
