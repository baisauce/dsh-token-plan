# dsh-token-plan

Qianwen Token Plan credits for **DeepSeek Harness**: check the remaining Credits
from a session, see them in the **dsh-pet** bubble with a usage bar, and let the
plugin renew the Qwen CLI login by itself.

千问 Token Plan 额度插件：在 DSH 会话里查询剩余额度，在桌宠（dsh-pet）气泡里显示
「剩余 N Credits + 占套餐百分比 + 用量条」，并自动续期千问 CLI 登录。

```text
Token Plan · Essential
剩余 39,526.5 Credits
█████████████████████░░   ← usage bar (87.8% of plan)
占套餐 87.8%（已用 12.2%）
更新于 17:08
```

## Features

- **`token_plan` tool** — returns plan name, total / used / remaining Credits,
  remaining share, used percentage, reset time, and days left.
- **`/tokenplan` command** — same reading in the command palette;
  `/tokenplan login` re-authorizes immediately.
- **dsh-pet bubble** — a custom one-page balance bubble: remaining Credits, a bar
  of the remaining share, the share/used percentages, and the reading time.
  The used share also drives the pet's quota-tier animation.
- **Silent login renewal** — the Qwen token lives ~2 days and has no refresh
  token, so an expired login is renewed through the CLI device flow: the plugin
  opens Edge with a dedicated profile, clicks the authorize button, and
  exchanges the code. A warm profile runs headless; a cold one shows a window
  once.
- **Snapshot-based reads** — one CLI query takes 20–40 s while dsh-pet aborts a
  balance fetch after 20 s, so the pet always answers instantly from the last
  snapshot while a background refresh keeps it current.

## Requirements

- DeepSeek Harness with plugin/bundle support (tested on DSH NEXT 0.2.x, Windows).
- [`qianwen` CLI](https://www.qianwenai.com) ≥ 1.8 (tested 1.10.0) on the machine.
- Microsoft Edge (used only for the authorization page).
- Optional: `dsh-pet` for the balance bubble.

```bash
npm install -g @qianwenai/qianwen-cli@latest
qianwen auth login     # once; afterwards the plugin renews it itself
```

## Install

Copy this folder anywhere (for example `%USERPROFILE%\dsh-plugins\dsh-token-plan`),
then in DSH open **Plugins → Add plugin** and pick the folder, or install it
through the plugin manager with the absolute directory as the target. DSH links
the package into the active profile; no build step and no dependencies are
required.

The plugin is a bundle: `cordis.patch.yml` inserts the `dsh-token-plan` row.

## Usage

| Action | Where |
|---|---|
| Query credits | ask the agent, or call the `token_plan` tool (`refresh: true` forces a new reading) |
| Query credits | `/tokenplan` |
| Renew the login now | `/tokenplan login` |
| Pet bubble | right-click the pet → 查看余额 |

## How it works

**Data source**

```bash
qianwen subscription status --plan token --format json
# → individual.monthlyCredits { total, usedPct }
# remaining = total × (1 − usedPct / 100)
```

The CLI is executed through DSH's own runtime (`ELECTRON_RUN_AS_NODE`), so the
`qianwen` shim and `node` do not have to be on `PATH`. Resolution order:
`QIANWEN_CLI_PATH`, the pnpm global layout under `%LOCALAPPDATA%\pnpm\global`,
then the npm global layout under `%APPDATA%\npm`.

**Refresh policy**

| Constant | Value | Meaning |
|---|---|---|
| `WARMUP_MS` | 5 min | background refresh interval |
| `READ_REVALIDATE_MS` | 60 s | a pet read older than this also starts a refresh |
| `READ_FRESH_MS` | 30 s | the tool reuses the snapshot within this window |
| `STALE_LIMIT_MS` | 10 min | snapshot age the pet still accepts |
| `CLI_TIMEOUT_MS` | 75 s | hard limit for one CLI run |

**Automatic login**

1. `qianwen auth login --init-only` → verification URL.
2. `login-browser.mjs` drives Edge over the DevTools protocol with the profile in
   `<DSH_HOME>/dsh-token-plan/browser-profile`, signs in if needed, and clicks
   `授权` / `确认登录`.
3. `qianwen auth login --complete` exchanges the code for a token.
4. The snapshot refreshes; the bubble and the tool show the new numbers.

Failures back off exponentially (90 s → 30 min). Delete the profile directory to
force a fresh sign-in.

## Configuration

Constants at the top of `index.js` and `login-browser.mjs` cover timing and the
Edge profile path. `QIANWEN_CLI_PATH` and `EDGE_PATH` override binary discovery.

## Limitations

- Personal (individual) Token Plan only; team seats are not aggregated.
- The platform reports a used percentage, so remaining Credits are derived as
  `total × (1 − usedPct / 100)`, rounded to one decimal.
- Windows-first: the login helper looks for Microsoft Edge.
- The Qwen token expires after ~2 days; renewal needs the dedicated profile to
  stay signed in to Aliyun SSO, otherwise one sign-in window appears.
- The package is marked `private` to prevent accidental npm publishing; remove
  that field if you want to publish it.

## Privacy

The plugin reads the local `qianwen` CLI output. It has no telemetry, sends no
data anywhere except the CLI's own requests, and stores nothing but an in-memory
snapshot. Credentials stay in `~/.qianwen`; the Edge profile holds only browser
cookies.

## License

[MIT](LICENSE)