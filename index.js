/**
 * dsh-token-plan: Qwen Token Plan credits plugin with auto-renewal.
 *
 * - token_plan tool: query plan status
 * - /tokenplan command: show status; /tokenplan login triggers re-auth
 * - dsh-pet balance providers (optional, via ctx.inject)
 * - Auto-renewal via Edge + CDP when the token expires
 * - Snapshot-based fetching so the pet's 20s window never blocks
 */

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Timing constants ───
const WARMUP_MS = 5 * 60_000;
const READ_REVALIDATE_MS = 60_000;
const READ_FRESH_MS = 30_000;
const COLD_START_WAIT_MS = 15_000;
const STALE_LIMIT_MS = 10 * 60_000;
const CLI_TIMEOUT_MS = 75_000;
const AUTO_LOGIN_BACKOFF_BASE_MS = 90_000;
const AUTO_LOGIN_BACKOFF_MAX_MS = 30 * 60_000;

// ─── State ───
let log = null;
let snapshot = null;
let snapshotAt = 0;
let lastFailure = null;
let refreshing = false;
let autoLoginInProgress = false;
let autoLoginBackoffMs = AUTO_LOGIN_BACKOFF_BASE_MS;
let lastAutoLoginAttempt = 0;

// ─── CLI resolution ───
function cliCandidates() {
  const candidates = [];
  if (process.env.QIANWEN_CLI_PATH) candidates.push(process.env.QIANWEN_CLI_PATH);
  const pnpmGlobal = join(homedir(), 'AppData', 'Local', 'pnpm', 'global');

  // Collect @qianwenai/qianwen-cli entry points under a node_modules directory.
  const scanNodeModules = (nm) => {
    try {
      for (const d of readdirSync(nm, { withFileTypes: true })) {
        if (d.name === '@qianwenai') {
          try {
            for (const s of readdirSync(join(nm, d.name), { withFileTypes: true })) {
              if (s.name === 'qianwen-cli') candidates.push(join(nm, d.name, s.name, 'dist', 'bin', 'qianwen.js'));
            }
          } catch { /* ignore */ }
        } else if (d.name === 'qianwen-cli') {
          candidates.push(join(nm, d.name, 'dist', 'bin', 'qianwen.js'));
        }
      }
    } catch { /* ignore */ }
  };

  if (existsSync(pnpmGlobal)) {
    // Legacy layout: global/node_modules/...
    scanNodeModules(join(pnpmGlobal, 'node_modules'));
    // pnpm v11 layout: global/v11/<hash>/node_modules/... (hash changes on upgrade).
    const v11 = join(pnpmGlobal, 'v11');
    if (existsSync(v11)) {
      try {
        for (const h of readdirSync(v11, { withFileTypes: true })) {
          if (h.isDirectory()) scanNodeModules(join(v11, h.name, 'node_modules'));
        }
      } catch { /* ignore */ }
    }
  }
  return candidates.filter(existsSync);
}

function resolveCli() {
  return cliCandidates()[0] ?? null;
}

// ─── CLI execution ───
function runCli(cliPath, args, timeoutMs = CLI_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: timeoutMs,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `exit ${code}`));
        return;
      }
      try { resolve(JSON.parse(stdout.trim())); }
      catch { reject(new Error(`Invalid JSON: ${stdout.slice(0, 200)}`)); }
    });
  });
}

function parsePlan(data) {
  const ind = data?.individual;
  if (!ind?.monthlyCredits) return null;
  const mc = ind.monthlyCredits;
  const total = Number(mc.total) || 0;
  const usedPct = Number(mc.usedPct) || 0;
  return {
    planType: ind.name ?? ind.type ?? ind.planType ?? 'unknown',
    total,
    usedPct,
    remaining: Math.round(total * (1 - usedPct / 100) * 10) / 10,
    resetAt: mc.resetTime ?? ind.resetAt ?? ind.period?.end ?? null,
    daysRemaining: ind.remainingDays ?? ind.period?.remainingDays ?? null,
    fetchedAt: Date.now(),
  };
}

// ─── Refresh ───
async function startRefresh() {
  if (refreshing) return snapshot;
  refreshing = true;
  try {
    const cliPath = resolveCli();
    if (!cliPath) {
      lastFailure = { error: 'no-cli', message: 'Qwen CLI not found' };
      log?.warn?.('[dsh-token-plan] 未找到千问 CLI');
      return snapshot;
    }
    const data = await runCli(cliPath, ['subscription', 'status', '--plan', 'token', '--format', 'json']);
    const plan = parsePlan(data);
    if (!plan) {
      lastFailure = { error: 'parse-error', message: 'Could not parse plan data' };
      return snapshot;
    }
    snapshot = plan;
    snapshotAt = Date.now();
    lastFailure = null;
    autoLoginBackoffMs = AUTO_LOGIN_BACKOFF_BASE_MS;
    log?.info?.(`[dsh-token-plan] 额度刷新成功：剩余 ${plan.remaining} / ${plan.total} Credits（${plan.usedPct}% 已用）`);
    return plan;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuth = /login|expired|未登录|TOKEN_EXPIRED|UNAUTHENTICATED/i.test(msg);
    if (isAuth) {
      lastFailure = { error: 'not-authenticated', message: msg };
      log?.warn?.(`[dsh-token-plan] 登录过期，触发自动续期：${msg}`);
      autoLogin().catch(() => {});
    } else {
      lastFailure = { error: 'cli-error', message: msg };
      log?.warn?.(`[dsh-token-plan] 额度查询失败：${msg}`);
    }
    return snapshot;
  } finally {
    refreshing = false;
  }
}

// ─── Auto-login via Edge + CDP ───
/** Run the browser helper; resolves its JSON result (or null when it failed). */
function runLoginBrowser(authUrl, profileDir, headless, extraArgs = []) {
  return new Promise((resolve) => {
    const loginScript = join(__dirname, 'login-browser.mjs');
    const child = spawn(process.execPath, [
      loginScript,
      authUrl,
      ...(headless ? ['--headless'] : []),
      `--user-data-dir=${profileDir}`,
      ...extraArgs,
    ], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: headless,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      try { resolve(JSON.parse(line)); } catch {
        log?.warn?.(`[dsh-token-plan] 登录助手无有效输出：${(stderr || stdout).slice(0, 200)}`);
        resolve(null);
      }
    });
  });
}

async function autoLogin() {
  if (autoLoginInProgress) return;
  const now = Date.now();
  if (now - lastAutoLoginAttempt < autoLoginBackoffMs) return;
  autoLoginInProgress = true;
  lastAutoLoginAttempt = now;
  try {
    const cliPath = resolveCli();
    if (!cliPath) return;
    const initData = await runCli(cliPath, ['auth', 'login', '--init-only', '--format', 'json'], 60_000);
    const events = Array.isArray(initData?.events) ? initData.events : [];
    if (events.some((e) => e?.event === 'already_authenticated')) return;
    const authUrl = events.find((e) => e?.event === 'device_code')?.verification_url;
    if (!authUrl) {
      lastFailure = { error: 'no-auth-url', message: 'Could not get auth URL' };
      log?.warn?.('[dsh-token-plan] 拿不到授权链接');
      return;
    }
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const browserProfile = join(dshHome, 'dsh-token-plan', 'browser-profile');
    const hasProfile = existsSync(browserProfile);

    // Warm profile: try silent renewal first.
    let browserResult = null;
    if (hasProfile) {
      browserResult = await runLoginBrowser(authUrl, browserProfile, true);
      log?.info?.(`[dsh-token-plan] 静默续期结果：${browserResult?.stage ?? 'no-result'}`);
    }
    // Cold profile, or the sign-in screen appeared: open a visible window.
    if (browserResult?.ok !== true) {
      browserResult = await runLoginBrowser(authUrl, browserProfile, false, ['--login-ms=240000']);
      log?.info?.(`[dsh-token-plan] 可见登录结果：${browserResult?.stage ?? 'no-result'}${browserResult?.clicked ? `（已点「${browserResult.clicked}」）` : ''}`);
    }
    if (browserResult?.ok !== true) {
      lastFailure = { error: 'auto-login-failed', message: browserResult?.stage ?? 'browser-failed' };
      autoLoginBackoffMs = Math.min(autoLoginBackoffMs * 2, AUTO_LOGIN_BACKOFF_MAX_MS);
      return;
    }
    await runCli(cliPath, ['auth', 'login', '--complete', '--format', 'json'], 120_000);
    await startRefresh();
    autoLoginBackoffMs = AUTO_LOGIN_BACKOFF_BASE_MS;
    log?.info?.('[dsh-token-plan] 自动登录完成，已刷新额度');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastFailure = { error: 'auto-login-failed', message: msg };
    autoLoginBackoffMs = Math.min(autoLoginBackoffMs * 2, AUTO_LOGIN_BACKOFF_MAX_MS);
    log?.warn?.(`[dsh-token-plan] 自动登录失败：${msg}`);
  } finally {
    autoLoginInProgress = false;
  }
}

// ─── Bubble rendering (dsh-pet custom shape) ───
// Colours match the pet's own white bubble, so the nodes need no theme hook.
const BUBBLE_MUTED = 'rgba(43,43,43,.62)';
const BUBBLE_TRACK = 'rgba(43,43,43,.12)';
const BUBBLE_FILL = '#18A999';

/** Group the integer part with commas without depending on the host locale. */
function formatNumber(value, digits = 0) {
  const rounded = Number(Number(value).toFixed(digits));
  const [whole, fraction] = String(rounded).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Local HH:mm for one epoch-ms timestamp. */
function formatClock(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '--:--';
  const pad = (part) => String(part).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * One-page pet bubble: remaining Credits, a bar of the remaining share, and the
 * share/used percentages. `percent` is the used share, which drives the pet's
 * quota-tier animation.
 * @param plan - parsed reading.
 * @param provider - provider id the pet asked for.
 */
function bubbleFrom(plan, provider) {
  const usedPct = Math.min(100, Math.max(0, plan.usedPct));
  const sharePct = Math.round((100 - usedPct) * 10) / 10;
  const shareText = `${formatNumber(sharePct, 1)}%`;
  return {
    ok: true,
    provider,
    shape: 'custom',
    data: {
      percent: usedPct,
      views: [{
        tag: 'div',
        style: { display: 'flex', flexDirection: 'column', gap: '0.22em', textAlign: 'center' },
        children: [
          { tag: 'div', text: `Token Plan · ${plan.planType}`, style: { fontSize: '0.8em', color: BUBBLE_MUTED } },
          { tag: 'div', text: `剩余 ${formatNumber(plan.remaining, 1)} Credits`, style: { fontSize: '1.12em', fontWeight: '700', lineHeight: '1.35' } },
          {
            tag: 'div',
            style: { height: '0.34em', marginTop: '0.08em', background: BUBBLE_TRACK, borderRadius: '1em', overflow: 'hidden' },
            children: [
              { tag: 'div', style: { width: shareText, height: '100%', background: BUBBLE_FILL, borderRadius: '1em' } },
            ],
          },
          { tag: 'div', text: `占套餐 ${shareText}（已用 ${formatNumber(usedPct, 1)}%）`, style: { fontSize: '0.82em', color: BUBBLE_MUTED } },
          { tag: 'div', text: `更新于 ${formatClock(plan.fetchedAt)}`, style: { fontSize: '0.7em', color: 'rgba(43,43,43,.45)' } },
        ],
      }],
    },
  };
}

// ─── Reading paths ───
function readingForPet(provider) {
  const now = Date.now();
  const age = now - snapshotAt;
  if (snapshot && age < STALE_LIMIT_MS) {
    if (age > READ_REVALIDATE_MS && !refreshing) startRefresh().catch(() => {});
    return bubbleFrom(snapshot, provider);
  }
  if (!refreshing) startRefresh().catch(() => {});
  if (snapshot) return bubbleFrom(snapshot, provider);
  return { ok: false, provider, reason: 'fetch-error', message: 'Warming up… about 20-40s, please try again shortly' };
}

async function readingForTool(force = false) {
  const now = Date.now();
  const age = now - snapshotAt;
  if (!force && snapshot && age < READ_FRESH_MS) return snapshot;
  if (force || !snapshot || age > READ_REVALIDATE_MS) {
    if (!snapshot) {
      await Promise.race([
        startRefresh(),
        new Promise((r) => setTimeout(r, COLD_START_WAIT_MS)),
      ]);
    } else {
      await startRefresh();
    }
  }
  if (snapshot) return snapshot;
  if (lastFailure) return lastFailure;
  return { error: 'warming-up', message: 'Warming up… try again shortly' };
}

function formatPlan(p) {
  const resetStr = p.resetAt ? new Date(p.resetAt).toLocaleString() : 'unknown';
  const days = p.daysRemaining != null ? `, ${p.daysRemaining} days left` : '';
  const remaining = Math.round(p.remaining * 10) / 10;
  const used = Math.round(p.usedPct * 10) / 10;
  const share = Math.round((100 - used) * 10) / 10;
  return `Qwen Token Plan · ${p.planType}: ${remaining} / ${p.total} Credits remaining (${share}% of plan, ${used}% used), resets ${resetStr}${days}`;
}

function formatError(result) {
  if (result.error === 'not-authenticated') {
    return 'Qwen login expired, auto-renewing… (first time opens a browser login page; after one login it becomes fully automatic)';
  }
  if (result.error === 'no-cli') {
    return 'Qwen CLI not found — install with: pnpm add -g @qianwenai/qianwen-cli';
  }
  if (result.error === 'warming-up') {
    return 'Warming up… takes about 20-40 seconds, please try again shortly';
  }
  return `Error: ${result.message ?? result.error}`;
}

// ─── Plugin entry ───
export const name = 'dsh-token-plan';
export const inject = ['tools', 'commands'];

export function apply(ctx) {
  log = ctx.logger ?? null;
  // Warmup + periodic refresh.
  ctx.effect(() => {
    startRefresh().catch(() => {});
    const timer = setInterval(() => { startRefresh().catch(() => {}); }, WARMUP_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  });

  // token_plan tool.
  ctx.effect(() => ctx.tools.register({
    name: 'token_plan',
    description: 'Query Qwen Token Plan credits: plan type, total/used/remaining Credits, usage percentage, reset time, and days remaining.',
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Force refresh, bypassing the cache.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute: async (args) => {
      const result = await readingForTool(args?.refresh === true);
      if (result.error) return { text: formatError(result), error: result.error };
      return { text: formatPlan(result), ...result };
    },
  }), 'dsh-token-plan: token_plan tool');

  // /tokenplan command.
  ctx.effect(() => ctx.commands.register({
    name: 'tokenplan',
    description: 'Show Qwen Token Plan status. Use /tokenplan login to trigger manual re-authentication.',
    input: { hint: '[login]' },
    handler: async ({ rawInput }) => {
      const arg = (rawInput ?? '').trim();
      if (arg === 'login') {
        autoLogin().catch(() => {});
        return { kind: 'success', text: 'Triggering manual re-authentication…' };
      }
      const result = await readingForTool(false);
      if (result.error) return { kind: 'error', text: formatError(result) };
      return { kind: 'success', text: formatPlan(result) };
    },
  }), 'dsh-token-plan: /tokenplan command');

  // dsh-pet balance providers (optional child fiber; waits for petApi7340).
  // The pet queries the currently selected LLM provider id, so cover both
  // "qwen" and "qianwen" spellings and the -cn / -individual variants.
  ctx.inject(['petApi7340'], (petCtx) => {
    const providers = [
      'qianwen-token-plan', 'qianwen-token-plan-cn', 'qianwen-token-plan-individual',
      'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual',
    ];
    for (const id of providers) {
      petCtx.effect(() => petCtx.petApi7340.balance.register({
        id,
        fetch: async ({ provider }) => readingForPet(provider ?? id),
      }), `dsh-token-plan: balance provider ${id}`);
    }
  });
}
