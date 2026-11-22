/**
 * login-browser.mjs — Edge + CDP helper for the Qwen device-code login.
 *
 * Opens the verification URL in a dedicated Edge profile, detects an Aliyun
 * sign-in page, waits for the user to sign in (visible mode only), clicks the
 * "授权 / 确认登录" button, and reports one JSON document on stdout.
 *
 * Usage:
 *   node login-browser.mjs <auth-url> [--headless] [--user-data-dir=<path>]
 *                          [--login-ms=<ms>] [--wait-ms=<ms>] [--result=<file>]
 *
 * Result JSON: { ok, stage, clicked, loginRequired, success, url, browser }
 * Exit code: 0 when the authorize button was clicked, 2 when sign-in is
 * required in headless mode, 1 on any other failure.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── Arguments ───
const argv = process.argv.slice(2)
const authUrl = argv.find((a) => /^https?:\/\//i.test(a)) ?? ''
const headless = argv.includes('--headless')
const dirArg = argv.find((a) => a.startsWith('--user-data-dir='))
const userDataDir = dirArg
  ? dirArg.slice('--user-data-dir='.length)
  : join(homedir(), '.dsh-token-plan', 'browser-profile')
const loginMsArg = argv.find((a) => a.startsWith('--login-ms='))
const loginMs = loginMsArg ? Number(loginMsArg.slice('--login-ms='.length)) : 240_000
const waitMsArg = argv.find((a) => a.startsWith('--wait-ms='))
const waitMs = waitMsArg ? Number(waitMsArg.slice('--wait-ms='.length)) : 45_000
const resultArg = argv.find((a) => a.startsWith('--result='))
const resultPath = resultArg ? resultArg.slice('--result='.length) : ''

const result = { ok: false, stage: 'start', clicked: null, loginRequired: false, success: false, url: '', browser: '' }

/** Persist the result for post-mortem inspection; harmless when unused. */
function writeResult() {
  if (resultPath === '') return
  try {
    mkdirSync(join(resultPath, '..'), { recursive: true })
    writeFileSync(resultPath, JSON.stringify(result, null, 2))
  } catch {
    // Reporting is best effort.
  }
}

/** Resolve after one delay. */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** First existing Edge executable. */
function findEdge() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter((value) => typeof value === 'string' && value.length > 0)
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** A free TCP port chosen by the OS. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** Wait until the DevTools endpoint answers. */
async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return await response.json()
    } catch {
      // Not up yet.
    }
    await delay(250)
  }
  return null
}

/** Minimal CDP client over one WebSocket. */
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.nextId = 1
    this.pending = new Map()
    this.contexts = new Set()
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && this.pending.has(message.id)) {
        const settle = this.pending.get(message.id)
        this.pending.delete(message.id)
        settle(message)
        return
      }
      if (message.method === 'Runtime.executionContextCreated') {
        const id = message.params?.context?.id
        if (id !== undefined) this.contexts.add(id)
      }
      if (message.method === 'Runtime.executionContextDestroyed') {
        this.contexts.delete(message.params?.executionContextId)
      }
      if (message.method === 'Runtime.executionContextsCleared') this.contexts.clear()
    }
  }

  ready() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve(this)
      this.ws.onerror = () => reject(new Error('CDP websocket connection failed'))
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, (message) => {
        if (message.error !== undefined) reject(new Error(`${method}: ${message.error.message}`))
        else resolve(message.result)
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try { this.ws.close() } catch { /* ignore */ }
  }
}

/*
 * Runs inside the page: reports whether this is a sign-in screen, clicks an
 * authorize button when present, and detects a success screen.
 * Serialized with toString(), so it must stay standalone.
 */
function scanFrame() {
  const CONFIRM = ['授权', '确认登录', '确认', '同意', '允许', '继续']
  const body = String(document.body?.innerText ?? '').slice(0, 6000)
  const href = String(location.href)
  const loginRequired = /扫码|二维码|账号登录|密码登录|手机号|密码/.test(body)
    || /^(https:\/\/)?(account|passport|signin)\.(aliyun|qianwenai|qianwen)\.(com|ai)/.test(href)
    || /\/(login|signin)(\.htm|\.html|\/|$|\?)/.test(href)
  const interactive = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')]
  const pointer = [...document.querySelectorAll('div, span')].filter((el) => getComputedStyle(el).cursor === 'pointer')
  const pick = (candidates) => {
    const hits = []
    for (const el of candidates) {
      const label = String(el.innerText ?? el.value ?? '').trim()
      if (label === '' || label.length > 14) continue
      if (!CONFIRM.some((word) => label.includes(word))) continue
      const rect = el.getBoundingClientRect()
      if (rect.width < 8 || rect.height < 8) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue
      hits.push({ el, label, area: rect.width * rect.height })
    }
    hits.sort((a, b) => b.area - a.area)
    return hits[0]
  }
  const best = pick(interactive) ?? pick(pointer)
  const success = /授权成功|登录成功|已授权|已完成/.test(body)
  if (best === undefined) return { clicked: null, loginRequired, success, url: href }
  best.el.click()
  return { clicked: best.label, loginRequired, success: false, url: href }
}

/** Evaluate the frame scan in the main frame and every sub-frame. */
async function scan(cdp) {
  const state = { loginRequired: false, success: false, clicked: null, url: '' }
  const contextIds = [undefined, ...cdp.contexts]
  for (const contextId of contextIds) {
    try {
      const reply = await cdp.send('Runtime.evaluate', {
        expression: `(${scanFrame.toString()})()`,
        returnByValue: true,
        awaitPromise: false,
        ...(contextId === undefined ? {} : { contextId }),
      })
      const hit = reply?.result?.value
      if (!hit || typeof hit !== 'object') continue
      if (typeof hit.url === 'string' && /^https?:/i.test(hit.url)) state.url = hit.url
      if (hit.loginRequired === true) state.loginRequired = true
      if (hit.success === true) state.success = true
      if (typeof hit.clicked === 'string' && state.clicked === null) {
        state.clicked = hit.clicked
        break
      }
    } catch {
      // A frame may be cross-origin or gone.
    }
  }
  return state
}

/** Close the browser through the DevTools endpoint; fall back to killing it. */
async function closeBrowser(port, child) {
  try {
    const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json())
    if (typeof version?.webSocketDebuggerUrl === 'string') {
      const browser = await new Cdp(version.webSocketDebuggerUrl).ready()
      await browser.send('Browser.close')
      browser.close()
    }
  } catch {
    // It may already be gone.
  }
  try { child.kill() } catch { /* ignore */ }
}

async function main() {
  if (authUrl === '') {
    result.stage = 'no-url'
    writeResult()
    return 1
  }
  const edgePath = findEdge()
  if (edgePath === null) {
    result.stage = 'no-edge'
    writeResult()
    return 1
  }
  mkdirSync(userDataDir, { recursive: true })
  const port = await freePort()
  const edgeArgs = [
    headless ? '--headless=new' : '--start-maximized',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeFirstRunExperience',
    'about:blank',
  ]
  const child = spawn(edgePath, edgeArgs, { stdio: 'ignore', windowsHide: headless })
  const version = await waitForCdp(port, 20_000)
  if (version === null) {
    result.stage = 'no-cdp'
    writeResult()
    try { child.kill() } catch { /* ignore */ }
    return 1
  }
  result.browser = String(version.Browser ?? '')

  let cdp = null
  try {
    const created = await fetch(`http://127.0.0.1:${port}/json/new`, { method: 'PUT' }).then((r) => r.json())
    cdp = await new Cdp(created.webSocketDebuggerUrl).ready()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.navigate', { url: authUrl })
    try { await cdp.send('Page.bringToFront') } catch { /* headless */ }

    // Wait for a settled document; redirect chains may keep firing.
    const readyDeadline = Date.now() + 25_000
    while (Date.now() < readyDeadline) {
      try {
        const reply = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })
        if (reply?.result?.value === 'complete') break
      } catch {
        // Navigation in flight.
      }
      await delay(400)
    }
    await delay(1500)

    // Headless cannot sign in: report and let the caller escalate.
    // A cold profile (no cookie) therefore exits quickly with stage=login-required.
    const deadline = Date.now() + (headless ? Math.min(waitMs, 10_000) : loginMs)
    let settledSuccess = false
    while (Date.now() < deadline) {
      const state = await scan(cdp)
      if (state.url !== '') result.url = state.url
      result.loginRequired = state.loginRequired
      if (state.success) settledSuccess = true
      if (state.clicked !== null) {
        result.clicked = state.clicked
        result.stage = 'clicked'
        writeResult()
        // Let the confirm request reach the CLI before the browser closes.
        await delay(2500)
        const after = await scan(cdp)
        if (after.success) settledSuccess = true
        if (after.url !== '') result.url = after.url
        result.success = settledSuccess
        result.ok = true
        result.stage = 'done'
        writeResult()
        return 0
      }
      if (headless && state.loginRequired) {
        result.stage = 'login-required'
        writeResult()
        return 2
      }
      await delay(1200)
    }
    result.stage = headless ? 'headless-no-button' : 'no-button'
    writeResult()
    return 1
  } catch (error) {
    result.stage = 'error'
    result.error = error instanceof Error ? error.message : String(error)
    writeResult()
    return 1
  } finally {
    cdp?.close()
    await closeBrowser(port, child)
  }
}

main().then((code) => {
  console.log(JSON.stringify(result))
  process.exit(code)
}).catch((error) => {
  result.stage = 'fatal'
  result.error = error instanceof Error ? error.message : String(error)
  writeResult()
  console.log(JSON.stringify(result))
  process.exit(1)
})