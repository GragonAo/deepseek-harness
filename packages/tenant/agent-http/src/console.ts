/**
 * Operator console route served by the agent-http carrier when a `webServer` is
 * present: `GET /console` returns one self-contained page that drives the same
 * bearer-authenticated `/api` surface the carrier exposes, so a deployment can be
 * exercised by hand without writing a client against the wire protocol first.
 *
 * The page is served from the same origin as `/api` because the carrier answers
 * no CORS preflight: a page on another origin could not reach the API at all.
 * It carries no build step and loads no external asset, so it works on a host
 * with no outbound network.
 *
 * Like `/swagger`, this route answers without bearer auth: it is a shell holding
 * no tenant data, and every request it issues carries the operator's own token.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

/**
 * The console page. Rendering builds DOM nodes and assigns `textContent`, so
 * model- and tenant-supplied text can never be interpreted as markup.
 */
const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 多租户控制台</title>
<style>
  :root {
    --bg: #0f1116; --panel: #171a21; --line: #262b36; --fg: #e6e9ef;
    --dim: #8b93a5; --accent: #4c8dff; --ok: #3fb950; --warn: #d29922; --err: #f85149;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 14px;
    background: var(--panel); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  h1 { font-size: 14px; margin: 0; font-weight: 600; white-space: nowrap; }
  .grow { flex: 1; }
  input, select, button, textarea { font: inherit; color: var(--fg);
    background: #10131a; border: 1px solid var(--line); border-radius: 5px; padding: 5px 8px; }
  input:focus, textarea:focus { outline: 1px solid var(--accent); }
  button { cursor: pointer; background: #1e2430; }
  button:hover { background: #2a3242; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover { filter: brightness(1.1); }
  button.danger { color: var(--err); }
  #token { width: 340px; }
  nav { display: flex; gap: 4px; padding: 8px 14px 0; background: var(--panel);
    border-bottom: 1px solid var(--line); }
  nav button { border-bottom-left-radius: 0; border-bottom-right-radius: 0;
    border-bottom-color: transparent; }
  nav button.active { background: var(--bg); border-color: var(--line);
    border-bottom-color: var(--bg); color: var(--accent); }
  main { padding: 14px; }
  .tab { display: none; }
  .tab.active { display: block; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .toolbar { margin-bottom: 10px; }
  .pill { padding: 2px 7px; border-radius: 999px; font-size: 11px;
    border: 1px solid var(--line); color: var(--dim); }
  .pill.ok { color: var(--ok); border-color: #1f4d28; }
  .pill.err { color: var(--err); border-color: #5c2020; }
  .pill.warn { color: var(--warn); border-color: #57431a; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line);
    vertical-align: top; }
  th { color: var(--dim); font-weight: 500; }
  tr.sel td { background: #1b2130; }
  tbody tr:hover td { background: #1a1f2a; cursor: pointer; }
  .muted { color: var(--dim); }
  .empty { color: var(--dim); padding: 18px 4px; }
  .panel { background: var(--panel); border: 1px solid var(--line);
    border-radius: 7px; padding: 10px; }
  form.inline { display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
    padding: 10px; margin-bottom: 10px; background: var(--panel);
    border: 1px solid var(--line); border-radius: 7px; }
  .split { display: grid; grid-template-columns: 320px 1fr; gap: 12px;
    align-items: start; }
  #sessions-pane { max-height: calc(100vh - 220px); overflow: auto; }
  .conv { display: flex; flex-direction: column; height: calc(100vh - 220px); }
  #conv { flex: 1; overflow: auto; padding: 10px; background: var(--panel);
    border: 1px solid var(--line); border-radius: 7px; }
  .msg { margin-bottom: 10px; }
  .msg .who { font-size: 11px; color: var(--dim); margin-bottom: 2px; }
  .msg .body { white-space: pre-wrap; word-break: break-word; }
  .msg.user .body { color: #cfe3ff; }
  .msg.context .body { color: var(--dim); font-style: italic; }
  .msg.tool { border-left: 2px solid var(--warn); padding-left: 8px; }
  .msg.tool.err { border-left-color: var(--err); }
  .msg.tool pre { margin: 2px 0 0; white-space: pre-wrap; word-break: break-word;
    color: var(--dim); max-height: 180px; overflow: auto; }
  .msg.reasoning { border-left: 2px solid #3a3f52; padding-left: 8px; color: var(--dim); }
  .msg.sys { color: var(--dim); font-size: 12px; }
  .msg.sys.err { color: var(--err); }
  .composer { display: flex; gap: 8px; margin-top: 10px; }
  .composer textarea { flex: 1; resize: vertical; min-height: 62px; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font-size: 12px; }
  .kv dt { color: var(--dim); }
  .kv dd { margin: 0; word-break: break-all; }
  #log { margin-top: 12px; max-height: 150px; overflow: auto; font-size: 12px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 7px;
    padding: 8px; }
  #log div { color: var(--dim); }
  #log div.err { color: var(--err); }
  #log div.ok { color: var(--ok); }
  .members { display: flex; gap: 4px; flex-wrap: wrap; }
  .members span { background: #232a38; border-radius: 4px; padding: 1px 6px; }
  .members span button { border: 0; background: none; color: var(--err);
    padding: 0 0 0 4px; }
  .chip { display: inline-flex; align-items: stretch; border: 1px solid var(--line);
    border-radius: 5px; overflow: hidden; }
  .chip-pick { border: 0; background: #232a38; color: var(--fg); padding: 3px 9px; }
  .chip-pick.active { background: var(--accent); color: #fff; }
  .chip-drop { border: 0; background: #1b212c; color: var(--dim); padding: 3px 7px; }
  .chip-drop:hover { color: var(--err); }
</style>
</head>
<body>
<header>
  <h1>DSH 多租户控制台</h1>
  <input id="token" type="password" placeholder="Bearer JWT（粘贴后回车）" autocomplete="off">
  <button id="connect" class="primary">连接</button>
  <button id="forget">清除</button>
  <span id="claims" class="muted"></span>
  <span class="grow"></span>
  <span id="conn" class="pill">未连接</span>
</header>

<nav>
  <button data-tab="sessions" class="active">会话</button>
  <button data-tab="models">模型</button>
  <button data-tab="tenants">租户</button>
  <button data-tab="credentials">凭据</button>
</nav>
<div id="identities" class="row" style="padding:0 16px 10px;gap:6px"></div>

<main>
  <section id="tab-models" class="tab">
    <div class="row toolbar">
      <span class="muted">当前默认模型：</span>
      <span id="m-current" class="pill">—</span>
      <span class="grow"></span>
      <button id="m-reload">重新读取</button>
    </div>

    <div class="panel">
      <div class="muted" style="margin-bottom:6px">已注册的供应商路由（来自 llm.providers）：</div>
      <table>
        <thead><tr><th>路由</th><th>名称</th><th>状态</th><th>模型数</th><th>设为默认</th></tr></thead>
        <tbody id="m-routes"></tbody>
      </table>
      <div id="m-empty" class="empty">连接后自动读取。</div>
    </div>

    <div class="panel" style="margin-top:10px">
      <div class="muted" style="margin-bottom:8px">配置一条 OpenAI 兼容路由（写入 <span class="pill">llm-pi-ai</span> 设置，按租户隔离，立即生效无需重启）：</div>
      <dl class="kv">
        <dt>路由名</dt>
        <dd><input id="m-route" list="m-route-presets" size="26" value="openai">
          <datalist id="m-route-presets">
            <option value="openai"></option>
            <option value="openrouter"></option>
            <option value="deepseek"></option>
            <option value="anthropic"></option>
          </datalist>
          <span class="muted" style="margin-left:6px">内置目录里的名字（如 openai）会自动继承端点与模型目录</span></dd>

        <dt>baseURL</dt>
        <dd><input id="m-baseurl" size="46" placeholder="留空 = 用目录默认端点；自建网关必填，如 http://10.0.0.5:8000/v1"></dd>

        <dt>协议 api</dt>
        <dd><select id="m-api">
          <option value="">（留空 = 由目录决定）</option>
          <option value="openai-completions">openai-completions</option>
          <option value="openai-responses">openai-responses</option>
          <option value="anthropic-messages">anthropic-messages</option>
        </select>
          <span class="muted" style="margin-left:6px">目录里没有的路由必填</span></dd>

        <dt>凭据引用</dt>
        <dd><input id="m-keyref" size="26" value="OPENAI_API_KEY">
          <span class="muted" style="margin-left:6px">存进这个引用名；写入的值不会回显</span></dd>

        <dt>API Key</dt>
        <dd><input id="m-key" type="password" size="46" placeholder="粘贴 key，点「写入凭据」保存" autocomplete="off"></dd>

        <dt>模型列表</dt>
        <dd><textarea id="m-models" rows="5" cols="46" placeholder="每行一个模型 id。留空 = 用目录自带目录（目录里没有的路由必须填）"></textarea></dd>

        <dt>默认模型</dt>
        <dd><select id="m-defaultmodel"></select>
          <button id="m-setdefault" style="margin-left:6px">设为默认</button>
          <span class="muted" style="margin-left:6px">需先「保存路由」，否则新会话无法选择它</span></dd>
      </dl>

      <div class="row" style="margin-top:8px">
        <button id="m-writekey">写入凭据</button>
        <button id="m-discover">探测模型</button>
        <button id="m-save" class="primary">保存路由</button>
        <button id="m-clear" class="danger">删除该路由</button>
      </div>
      <div id="m-hint" class="muted" style="margin-top:8px"></div>
    </div>
  </section>

  <section id="tab-tenants" class="tab">
    <div class="row toolbar">
      <button id="t-refresh">刷新</button>
      <button id="t-new">新建租户</button>
      <span id="t-count" class="muted"></span>
    </div>
    <form id="t-form" class="inline" hidden>
      <input id="t-id" placeholder="id（必填，如 case-1001）" size="20">
      <input id="t-name" placeholder="name（必填）" size="16">
      <input id="t-data" placeholder="dataRoot（必填，宿主绝对路径）" size="28">
      <input id="t-ws" placeholder="workspaceRoot（必填，宿主绝对路径）" size="28">
      <input id="t-tools" placeholder="toolsRoot（可选）" size="22">
      <select id="t-net">
        <option value="">network: 默认</option>
        <option value="none">network: none</option>
        <option value="internal">network: internal</option>
      </select>
      <input id="t-members" placeholder="members（逗号分隔，可选）" size="24">
      <button type="submit" class="primary">创建</button>
      <button type="button" id="t-cancel">取消</button>
    </form>
    <div class="panel">
      <table>
        <thead><tr>
          <th>id</th><th>name</th><th>enabled</th><th>network</th>
          <th>dataRoot</th><th>workspaceRoot</th><th>members</th><th></th>
        </tr></thead>
        <tbody id="t-rows"></tbody>
      </table>
      <div id="t-empty" class="empty">尚未加载。填入 token 后点「连接」。</div>
    </div>
  </section>

  <section id="tab-sessions" class="tab active">
    <div class="split">
      <div>
        <div class="row toolbar">
          <button id="s-refresh">刷新</button>
          <button id="s-new">新建会话</button>
          <span id="s-count" class="muted"></span>
        </div>
        <form id="s-form" class="inline" hidden>
          <input id="s-cwd" placeholder="cwd（可选，容器内路径）" size="24">
          <button type="submit" class="primary">创建</button>
          <button type="button" id="s-cancel">取消</button>
        </form>
        <div class="panel" id="sessions-pane">
          <div id="s-empty" class="empty">尚无会话。</div>
          <div id="s-rows"></div>
        </div>
      </div>
      <div class="conv">
        <div class="panel" id="s-head" style="margin-bottom:10px">
          <div class="muted">未选择会话。</div>
        </div>
        <div id="conv"><div class="empty">选择一个会话，或新建一个。</div></div>
        <div class="composer">
          <textarea id="prompt" placeholder="输入消息…（Enter 发送，Shift+Enter 换行）" disabled></textarea>
          <div style="display:flex;flex-direction:column;gap:6px">
            <button id="send" class="primary" disabled>发送</button>
            <button id="stop" disabled>停止</button>
          </div>
        </div>
      </div>
    </div>
  </section>

  <section id="tab-credentials" class="tab">
    <div class="row toolbar">
      <form id="c-form" class="inline" style="margin:0">
        <input id="c-ref" list="c-presets" placeholder="凭据引用名，如 DEEPSEEK_API_KEY" size="30" value="DEEPSEEK_API_KEY">
        <button type="submit" class="primary">查询</button>
      </form>
      <span id="c-scope" class="muted"></span>
    </div>
    <datalist id="c-presets">
      <option value="DEEPSEEK_API_KEY"></option>
      <option value="OPENAI_API_KEY"></option>
      <option value="ANTHROPIC_API_KEY"></option>
    </datalist>
    <div class="panel">
      <table>
        <thead><tr>
          <th>ref</th><th>configured</th><th>source</th><th>writable</th><th></th>
        </tr></thead>
        <tbody id="c-rows"></tbody>
      </table>
      <div id="c-empty" class="empty">输入引用名后点「查询」。读取永远不回显凭据值。</div>
    </div>
    <form id="c-set" class="inline" hidden>
      <span id="c-set-ref" class="muted"></span>
      <input id="c-value" type="password" placeholder="凭据值（写入后不再回显）" size="46" autocomplete="off">
      <button type="submit" class="primary">写入</button>
      <button type="button" id="c-set-cancel">取消</button>
    </form>
    <div class="panel" id="c-help" style="margin-top:10px">
      <div class="muted" style="margin-bottom:6px">本部署挂载的是 Postgres 凭据提供者：可写的凭据表存放在 <span class="pill">(租户, 用户)</span> 分区下——租户由 token 的 tenant 声明决定，用户由 sub 决定。换租户或换 sub 就是另一份凭据。</div>
      <div class="muted" style="margin-bottom:6px">解析优先级（上层胜出）：</div>
      <dl class="kv">
        <dt><span class="pill">env</span></dt>
        <dd class="muted">继承的进程环境变量 —— <b>只读，永远胜出</b>。source 显示为它时写入会被拒（credential-rejected），只能改启动环境后重启。</dd>
        <dt><span class="pill">postgres</span></dt>
        <dd class="muted">本页写入的 (租户, 用户) 凭据表 —— 可写，立即生效，无需重启。</dd>
        <dt><span class="pill">project-env</span></dt>
        <dd class="muted">&lt;启动 cwd&gt;/.env 回退层。</dd>
        <dt><span class="pill">user-env</span></dt>
        <dd class="muted">$DSH_HOME/.env 回退层。source 显示为它时仍可写：存入的值会取代它成为生效来源。</dd>
      </dl>
      <div class="muted" style="margin-top:6px">读取永远不回显值；写入后只能靠「查询」确认 configured 状态与生效来源。</div>
    </div>
  </section>
</main>

<div id="log" style="margin:0 14px 14px"></div>

<script>
(function () {
  'use strict'

  var TOKEN_KEY = 'dsh.console.token'
  var state = {
    token: '', tenants: [], sessions: [], selected: null,
    items: [], cursor: { assistant: null, reasoning: null },
    models: null, running: false, mux: null, raf: 0,
    routes: [], catalog: [], defaultModel: null, defaultRevision: 0
  }

  function $(id) { return document.getElementById(id) }
  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild) }
  function show(node, visible) { node.hidden = !visible }

  function log(text, kind) {
    var box = $('log')
    var line = el('div', kind || '', new Date().toLocaleTimeString() + '  ' + text)
    box.insertBefore(line, box.firstChild)
    while (box.childNodes.length > 200) box.removeChild(box.lastChild)
  }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID()
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
    })
  }

  function rpc(method, payload) {
    var body = JSON.stringify({
      type: 'client-request', rpcId: uuid(), method: method, payload: payload || {}
    })
    return fetch('/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.token },
      body: body
    }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 300))
        var parsed
        try { parsed = JSON.parse(text) } catch (e) { throw new Error('响应不是 JSON：' + text.slice(0, 200)) }
        if (!parsed.result) throw new Error('响应缺少 result：' + text.slice(0, 200))
        if (parsed.result.ok !== true) {
          var err = parsed.result.error || {}
          var failure = new Error((err.code || 'error') + '：' + (err.message || ''))
          failure.code = err.code
          failure.details = err.details
          throw failure
        }
        return parsed.result.value
      })
    })
  }

  function b64url(text) {
    var pad = text.replace(/-/g, '+').replace(/_/g, '/')
    while (pad.length % 4) pad += '='
    var bin = atob(pad)
    var bytes = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  }

  function describeToken(token) {
    var parts = token.split('.')
    if (parts.length < 2) return null
    try { return JSON.parse(b64url(parts[1])) } catch (e) { return null }
  }

  function setConn(text, kind) {
    var node = $('conn')
    node.textContent = text
    node.className = 'pill' + (kind ? ' ' + kind : '')
  }

  // ---------- tabs ----------
  var navButtons = document.querySelectorAll('nav button')
  Array.prototype.forEach.call(navButtons, function (button) {
    button.addEventListener('click', function () {
      Array.prototype.forEach.call(navButtons, function (other) {
        other.classList.toggle('active', other === button)
      })
      var name = button.getAttribute('data-tab')
      $('tab-sessions').classList.toggle('active', name === 'sessions')
      $('tab-models').classList.toggle('active', name === 'models')
      $('tab-tenants').classList.toggle('active', name === 'tenants')
      $('tab-credentials').classList.toggle('active', name === 'credentials')
    })
  })

  // ---------- connection ----------
  function connect() {
    var token = $('token').value.trim()
    if (!token) { log('请先填入 token', 'err'); return }
    state.token = token
    try { window.localStorage.setItem(TOKEN_KEY, token) } catch (e) { /* private mode: token stays in memory */ }
    // Sessions and credentials are tenant-scoped: a new identity starts from a clean view.
    closeMux()
    state.selected = null
    state.items = []
    state.models = null
    state.running = false
    renderConversation()
    var claims = describeToken(token)
    var tenant = claims ? (claims.tenantId || claims.tenant_id || claims.tenant || '?') : '?'
    $('claims').textContent = claims
      ? 'sub=' + (claims.sub || '?') + ' tenant=' + tenant +
        ' scope=' + (claims.scope || '-') + ' exp=' + (claims.exp ? new Date(claims.exp * 1000).toLocaleString() : '-')
      : 'token 不是 JWT（无法解析声明）'
    $('c-scope').textContent = '当前租户：' + tenant
    rememberIdentity(token)
    setConn('连接中…')
    rpc('host.describe', {}).then(function (value) {
      setConn('已连接', 'ok')
      log('连接成功 host.describe → ' + JSON.stringify(value).slice(0, 160), 'ok')
      loadTenants()
      loadSessions()
      loadModels()
      openMux()
    }).catch(function (error) {
      setConn('失败', 'err')
      log('连接失败：' + error.message, 'err')
    })
  }

  $('connect').addEventListener('click', connect)
  $('token').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') connect()
  })
  $('forget').addEventListener('click', function () {
    try { window.localStorage.removeItem(TOKEN_KEY) } catch (e) { /* nothing persisted */ }
    writeIdentities([])
    renderIdentities()
    $('token').value = ''
    state.token = ''
    state.selected = null
    state.items = []
    renderConversation()
    $('claims').textContent = ''
    $('c-scope').textContent = ''
    setConn('未连接')
    closeMux()
    log('已清除 token')
  })

  // ---------- saved identities ----------
  var IDENTITIES_KEY = 'dsh.console.identities'

  function readIdentities() {
    try {
      var parsed = JSON.parse(window.localStorage.getItem(IDENTITIES_KEY) || '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch (e) { return [] }
  }

  function writeIdentities(list) {
    try { window.localStorage.setItem(IDENTITIES_KEY, JSON.stringify(list)) } catch (e) { /* private mode: chips live for this page only */ }
  }

  function identityLabel(token) {
    var claims = describeToken(token)
    if (!claims) return 'token'
    var tenant = claims.tenantId || claims.tenant_id || claims.tenant || '?'
    return tenant + ' / ' + (claims.sub || '?')
  }

  function rememberIdentity(token) {
    var label = identityLabel(token)
    var list = readIdentities().filter(function (entry) { return entry.label !== label })
    list.unshift({ label: label, token: token })
    writeIdentities(list.slice(0, 8))
    renderIdentities()
  }

  function renderIdentities() {
    var box = $('identities')
    clear(box)
    var list = readIdentities()
    if (!list.length) return
    box.appendChild(el('span', 'muted', '已保存身份（点一下即切换租户）：'))
    list.forEach(function (entry) {
      var chip = el('span', 'chip')
      var pick = el('button', 'chip-pick', entry.label)
      if (entry.token === state.token) pick.classList.add('active')
      pick.addEventListener('click', function () {
        $('token').value = entry.token
        connect()
      })
      chip.appendChild(pick)
      var drop = el('button', 'chip-drop', '×')
      drop.title = '移除这个已保存身份'
      drop.addEventListener('click', function () {
        writeIdentities(readIdentities().filter(function (other) { return other.label !== entry.label }))
        renderIdentities()
      })
      chip.appendChild(drop)
      box.appendChild(chip)
    })
  }

  // ---------- models / providers ----------
  function loadModels() {
    return rpc('llm.providers', {}).then(function (value) {
      state.routes = value.providers || []
      return rpc('llm.models', {})
    }).then(function (value) {
      state.catalog = value.ok ? value.groups : []
      return loadDefaultModel()
    }).then(function () {
      renderRoutes()
      log('已读取 ' + state.routes.length + ' 条供应商路由')
    }).catch(function (error) {
      log('读取供应商失败：' + error.message, 'err')
    })
  }

  function loadDefaultModel() {
    return rpc('settings.describe', {}).then(function (value) {
      if (!value.ok) return
      var ns = (value.namespaces || []).filter(function (n) { return n.ns === 'agent-default-model' })[0]
      if (!ns) return
      state.defaultModel = ns.value || null
      state.defaultRevision = ns.revision
      $('m-current').textContent = ns.value
        ? ns.value.provider + ' / ' + ns.value.model
        : '（未设置）'
    }).catch(function (error) {
      log('读取默认模型失败：' + error.message, 'err')
    })
  }

  function renderRoutes() {
    var body = $('m-routes')
    clear(body)
    var rows = state.routes || []
    show($('m-empty'), rows.length === 0)
    rows.forEach(function (route) {
      var tr = el('tr')
      tr.appendChild(el('td', '', route.provider))

      var name = el('td')
      name.appendChild(el('span', 'muted', route.displayName || ''))
      if (route.declared) name.appendChild(el('span', 'pill', '自建'))
      tr.appendChild(name)

      var status = el('td')
      status.appendChild(el('span', 'pill ' + (route.active ? 'ok' : 'warn'),
        route.active ? '已启用' : '未启用'))
      tr.appendChild(status)

      var group = (state.catalog || []).filter(function (g) { return g.id === route.provider })[0]
      tr.appendChild(el('td', 'muted', group ? String((group.models || []).length) : '—'))

      var actions = el('td')
      var row = el('div', 'row')
      var edit = el('button', '', '编辑')
      edit.addEventListener('click', function () { fillRouteForm(route) })
      row.appendChild(edit)
      var pick = el('button', '', '设为默认')
      pick.disabled = !route.active
      pick.title = route.active ? '' : '该路由尚未启用：先在下方「保存路由」写入 llm-pi-ai'
      pick.addEventListener('click', function () {
        var ids = group ? (group.models || []).map(function (m) { return m.id }) : []
        fillDefaultModelOptions(ids, state.defaultModel && state.defaultModel.provider === route.provider
          ? state.defaultModel.model : null)
        setDefaultModel(route.provider, $('m-defaultmodel').value)
      })
      row.appendChild(pick)
      actions.appendChild(row)
      tr.appendChild(actions)

      body.appendChild(tr)
    })
  }

  function routeHint(route) {
    var known = (state.routes || []).filter(function (r) { return r.provider === route })[0]
    if (!known) {
      $('m-hint').textContent = '“' + route + '”不在内置目录里，属于自建路由：必须填 baseURL、协议 api 和非空模型列表，'
        + '否则保存会被拒。建议先点「探测模型」自动填列表。'
      return
    }
    $('m-hint').textContent = known.active
      ? '路由已启用（settingsNs=' + known.settingsNs + '）。改完点「保存路由」立即生效。'
      : '路由尚未启用：填好 baseURL/凭据后点「保存路由」，它才会出现在会话可选的模型里。'
  }

  function fillRouteForm(route) {
    $('m-route').value = route.provider
    routeHint(route.provider)
    rpc('settings.describe', {}).then(function (value) {
      if (!value.ok) return
      var ns = (value.namespaces || []).filter(function (n) { return n.ns === 'llm-pi-ai' })[0]
      var stored = ns && ns.user && ns.user.providers ? ns.user.providers[route.provider] : null
      if (!stored) { log('路由 ' + route.provider + ' 尚无已保存的配置'); return }
      if (stored.apiKeyEnv) $('m-keyref').value = stored.apiKeyEnv
      if (stored.baseURL) $('m-baseurl').value = stored.baseURL
      $('m-api').value = stored.api || ''
      if (stored.models && stored.models.length) {
        $('m-models').value = stored.models.map(function (m) { return m.id }).join('\\n')
        fillDefaultModelOptions(stored.models.map(function (m) { return m.id }), null)
      }
      log('已载入路由 ' + route.provider + ' 的已保存配置')
    }).catch(function (error) {
      log('读取已保存配置失败：' + error.message, 'err')
    })
  }

  function routeProfileFromForm() {
    var profile = { apiKeyEnv: $('m-keyref').value.trim() }
    var baseURL = $('m-baseurl').value.trim()
    var api = $('m-api').value
    var models = $('m-models').value.split('\\n').map(function (line) { return line.trim() })
      .filter(function (line) { return line !== '' })
      .map(function (id) { return { id: id } })
    if (baseURL) profile.baseURL = baseURL
    if (api) profile.api = api
    if (models.length) profile.models = models
    return profile
  }

  function settingsRevision(ns) {
    return rpc('settings.describe', {}).then(function (value) {
      if (!value.ok) return undefined
      var found = (value.namespaces || []).filter(function (n) { return n.ns === ns })[0]
      return found ? found.revision : undefined
    })
  }

  $('m-reload').addEventListener('click', loadModels)

  $('m-route').addEventListener('change', function () { routeHint($('m-route').value.trim()) })

  $('m-writekey').addEventListener('click', function () {
    var ref = $('m-keyref').value.trim()
    var key = $('m-key').value
    if (!ref) { log('请填写凭据引用名', 'err'); return }
    if (!key) { log('请填写 API Key', 'err'); return }
    rpc('credentials.set', { ref: ref, value: key }).then(function () {
      $('m-key').value = ''
      log('凭据 ' + ref + ' 已写入', 'ok')
      return rpc('credentials.describe', { refs: [ref] })
    }).then(function (value) {
      var view = value.ok ? (value.credentials || {})[ref] : null
      log('凭据状态：' + JSON.stringify(view), 'ok')
    }).catch(function (error) {
      log('写入凭据失败：' + error.message, 'err')
      if (error.code === 'credential-rejected') {
        log('该引用被只读层遮蔽（source=env）：改启动环境后重启，页面无法覆盖。', 'err')
      }
    })
  })

  $('m-discover').addEventListener('click', function () {
    var route = $('m-route').value.trim()
    if (!route) { log('请填写路由名', 'err'); return }
    var payload = { settingsNs: 'llm-pi-ai', provider: route }
    var baseURL = $('m-baseurl').value.trim()
    var api = $('m-api').value
    var key = $('m-key').value
    if (baseURL) payload.baseURL = baseURL
    if (api) payload.api = api
    if (key) payload.apiKey = key
    $('m-hint').textContent = '探测中…'
    rpc('llm.discoverModels', payload).then(function (value) {
      var models = value.models || []
      $('m-models').value = models.map(function (m) { return m.id }).join('\\n')
      fillDefaultModelOptions(models.map(function (m) { return m.id }), null)
      $('m-hint').textContent = '探测到 ' + models.length + ' 个模型，已填入列表和默认模型选择框。'
        + '确认后点「保存路由」——保存后这条路由才启用，新会话也才能选它。'
      log('探测到 ' + models.length + ' 个模型', 'ok')
    }).catch(function (error) {
      $('m-hint').textContent = '探测失败：' + error.message
      log('探测失败：' + error.message, 'err')
    })
  })

  $('m-save').addEventListener('click', function () {
    var route = $('m-route').value.trim()
    if (!route) { log('请填写路由名', 'err'); return }
    var profile = routeProfileFromForm()
    if (!profile.apiKeyEnv) { log('请填写凭据引用名', 'err'); return }
    var patch = { providers: {} }
    patch.providers[route] = profile
    settingsRevision('llm-pi-ai').then(function (revision) {
      return rpc('settings.update', { ns: 'llm-pi-ai', patch: patch, expectedRevision: revision })
    }).then(function () {
      log('路由 ' + route + ' 已保存并启用', 'ok')
      return loadModels()
    }).then(function () {
      var group = (state.catalog || []).filter(function (g) { return g.id === route })[0]
      fillDefaultModelOptions(group ? (group.models || []).map(function (m) { return m.id }) : [], null)
      $('m-hint').textContent = '路由已保存并启用。现在可以点上面的「设为默认」让新会话使用它。'
    }).catch(function (error) {
      log('保存路由失败：' + error.message, 'err')
      if (error.code === 'settings-rejected') {
        log('设置被拒：该路由不在内置目录里，必须同时给出「协议 api」「baseURL」和非空模型列表。', 'err')
        $('m-hint').textContent = '保存被拒：' + error.message
      }
    })
  })

  $('m-clear').addEventListener('click', function () {
    var route = $('m-route').value.trim()
    if (!route) { log('请填写路由名', 'err'); return }
    settingsRevision('llm-pi-ai').then(function (revision) {
      return rpc('settings.mutate', {
        ns: 'llm-pi-ai',
        ops: [{ op: 'unset', path: ['providers', route] }],
        expectedRevision: revision,
      })
    }).then(function () {
      log('路由 ' + route + ' 已从用户层删除', 'ok')
      return loadModels()
    }).catch(function (error) {
      log('删除路由失败：' + error.message, 'err')
    })
  })

  function fillDefaultModelOptions(ids, preferred) {
    var select = $('m-defaultmodel')
    clear(select)
    if (!ids.length) {
      select.appendChild(el('option', '', '（还没有模型，先探测或保存路由）'))
      return
    }
    ids.forEach(function (id) {
      var option = el('option', '', id)
      option.value = id
      select.appendChild(option)
    })
    if (preferred && ids.indexOf(preferred) !== -1) select.value = preferred
  }

  function setDefaultModel(provider, model) {
    if (!provider) { log('请填写路由名', 'err'); return }
    if (!model) { log('请先选择一个模型', 'err'); return }
    settingsRevision('agent-default-model').then(function (revision) {
      return rpc('settings.update', {
        ns: 'agent-default-model',
        patch: { provider: provider, model: model },
        expectedRevision: revision,
      })
    }).then(function () {
      log('默认模型已设为 ' + provider + ' / ' + model, 'ok')
      return loadDefaultModel()
    }).catch(function (error) {
      log('设置默认模型失败：' + error.message, 'err')
    })
  }

  $('m-setdefault').addEventListener('click', function () {
    var route = $('m-route').value.trim()
    var active = (state.routes || []).filter(function (r) { return r.provider === route && r.active })[0]
    if (!active) {
      log('路由 ' + route + ' 尚未启用：先点「保存路由」把它写进 llm-pi-ai，再设为默认。', 'err')
      return
    }
    setDefaultModel(route, $('m-defaultmodel').value)
  })

  // ---------- tenants ----------
  function loadTenants() {
    return rpc('tenant.admin.list', {}).then(function (value) {
      state.tenants = value.items || []
      renderTenants()
      $('t-count').textContent = state.tenants.length + ' 个租户'
      show($('t-empty'), state.tenants.length === 0)
      log('tenant.admin.list → ' + state.tenants.length + ' 条')
    }).catch(function (error) {
      show($('t-empty'), true)
      $('t-empty').textContent = '读取租户失败：' + error.message
      log('tenant.admin.list 失败：' + error.message, 'err')
    })
  }

  function tenantAction(label, promise) {
    return promise.then(function () {
      log(label + ' 成功', 'ok')
      return loadTenants()
    }).catch(function (error) {
      log(label + ' 失败：' + error.message, 'err')
    })
  }

  function renderTenants() {
    var body = $('t-rows')
    clear(body)
    state.tenants.forEach(function (tenant) {
      var tr = el('tr')

      tr.appendChild(el('td', '', tenant.id))
      tr.appendChild(el('td', '', tenant.name))

      var enabled = el('td')
      enabled.appendChild(el('span', 'pill ' + (tenant.enabled ? 'ok' : 'warn'),
        tenant.enabled ? 'enabled' : 'disabled'))
      tr.appendChild(enabled)

      tr.appendChild(el('td', 'muted', tenant.network || '-'))
      tr.appendChild(el('td', 'muted', tenant.dataRoot))
      tr.appendChild(el('td', 'muted', tenant.workspaceRoot))

      var members = el('td')
      var list = el('div', 'members')
      var names = tenant.members || []
      if (names.length === 0) list.appendChild(el('span', 'muted', '—'))
      names.forEach(function (subject) {
        var chip = el('span', '', subject)
        var remove = el('button', '', '×')
        remove.title = '移除成员 ' + subject
        remove.addEventListener('click', function (event) {
          event.stopPropagation()
          tenantAction('移除成员 ' + subject,
            rpc('tenant.admin.members.remove', { id: tenant.id, subject: subject }))
        })
        chip.appendChild(remove)
        list.appendChild(chip)
      })
      var addSubject = el('input')
      addSubject.placeholder = '加成员'
      addSubject.size = 10
      addSubject.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return
        event.preventDefault()
        var subject = addSubject.value.trim()
        if (!subject) return
        tenantAction('添加成员 ' + subject,
          rpc('tenant.admin.members.add', { id: tenant.id, subject: subject }))
      })
      list.appendChild(addSubject)
      members.appendChild(list)
      tr.appendChild(members)

      var actions = el('td')
      var row = el('div', 'row')
      var toggle = el('button', '', tenant.enabled ? '禁用' : '启用')
      toggle.addEventListener('click', function (event) {
        event.stopPropagation()
        tenantAction((tenant.enabled ? '禁用 ' : '启用 ') + tenant.id,
          rpc(tenant.enabled ? 'tenant.admin.disable' : 'tenant.admin.enable', { id: tenant.id }))
      })
      row.appendChild(toggle)

      var ensure = el('button', '', '建目录')
      ensure.title = 'users.ensure：预建该 subject 的 /global 目录'
      ensure.addEventListener('click', function (event) {
        event.stopPropagation()
        var subject = window.prompt('为哪个 subject 预建 /global 目录？')
        if (!subject) return
        rpc('tenant.admin.users.ensure', { subject: subject })
          .then(function (value) { log('users.ensure ' + subject + ' → ' + value.root, 'ok') })
          .catch(function (error) { log('users.ensure 失败：' + error.message, 'err') })
      })
      row.appendChild(ensure)

      var remove = el('button', 'danger', '删除')
      remove.addEventListener('click', function (event) {
        event.stopPropagation()
        var purge = window.confirm('删除 ' + tenant.id + '？\\n\\n确定 = 同时清除分区（purge）\\n取消 = 仅删除注册记录')
        tenantAction('删除 ' + tenant.id,
          rpc('tenant.admin.remove', { id: tenant.id, purge: purge }))
      })
      row.appendChild(remove)
      actions.appendChild(row)
      tr.appendChild(actions)

      body.appendChild(tr)
    })
  }

  $('t-refresh').addEventListener('click', loadTenants)
  $('t-new').addEventListener('click', function () { show($('t-form'), $('t-form').hidden) })
  $('t-cancel').addEventListener('click', function () { show($('t-form'), false) })
  $('t-form').addEventListener('submit', function (event) {
    event.preventDefault()
    var payload = {
      id: $('t-id').value.trim(),
      name: $('t-name').value.trim(),
      dataRoot: $('t-data').value.trim(),
      workspaceRoot: $('t-ws').value.trim()
    }
    var tools = $('t-tools').value.trim()
    if (tools) payload.toolsRoot = tools
    var network = $('t-net').value
    if (network) payload.network = network
    var members = $('t-members').value.split(',').map(function (s) { return s.trim() }).filter(Boolean)
    if (members.length) payload.members = members
    if (!payload.id || !payload.name || !payload.dataRoot || !payload.workspaceRoot) {
      log('id / name / dataRoot / workspaceRoot 都是必填', 'err')
      return
    }
    tenantAction('创建租户 ' + payload.id, rpc('tenant.admin.create', payload)).then(function () {
      show($('t-form'), false)
      $('t-form').reset()
    })
  })

  // ---------- sessions ----------
  function loadSessions() {
    return rpc('session.list', {}).then(function (value) {
      state.sessions = value.items || []
      renderSessions()
      $('s-count').textContent = state.sessions.length + ' 个会话'
      show($('s-empty'), state.sessions.length === 0)
      log('session.list → ' + state.sessions.length + ' 条')
    }).catch(function (error) {
      show($('s-empty'), true)
      $('s-empty').textContent = '读取会话失败：' + error.message
      log('session.list 失败：' + error.message, 'err')
    })
  }

  function titleOf(summary) {
    var values = summary.projections && summary.projections.values
    var title = values && values.title
    return typeof title === 'string' && title.length > 0 ? title : '(无标题)'
  }

  function renderSessions() {
    var box = $('s-rows')
    clear(box)
    state.sessions.forEach(function (summary) {
      var card = el('div')
      card.style.cssText = 'padding:6px 8px;border-bottom:1px solid var(--line);cursor:pointer'
      if (summary.sessionId === state.selected) card.style.background = '#1b2130'
      card.appendChild(el('div', '', titleOf(summary)))
      var meta = el('div', 'muted')
      meta.style.fontSize = '11px'
      meta.textContent = summary.sessionId.slice(0, 8) + ' · ' +
        new Date(summary.updatedAt).toLocaleString() +
        (summary.running ? ' · 运行中' : '') +
        (summary.blank ? ' · 空' : '')
      card.appendChild(meta)
      card.addEventListener('click', function () { openSession(summary.sessionId) })
      box.appendChild(card)
    })
  }

  function openSession(sessionId) {
    state.selected = sessionId
    state.items = []
    state.cursor = { assistant: null, reasoning: null }
    state.models = null
    state.running = false
    renderSessions()
    renderConversation()
    $('prompt').disabled = false
    $('send').disabled = false
    renderHead()
    rpc('session.models', { sessionId: sessionId }).then(function (models) {
      state.models = models
      renderHead()
      log('session.models → ' + models.current.provider + '/' + models.current.model +
        ' routable=' + models.routable + (models.routable ? '' : '（不可路由，发送会失败）'),
        models.routable ? 'ok' : 'err')
    }).catch(function (error) {
      log('session.models 失败：' + error.message, 'err')
    })
    rpc('session.history', { sessionId: sessionId }).then(function (value) {
      (value.events || []).forEach(function (entry) { applyEvent(entry.event) })
      if (value.projections && value.projections.values && value.projections.values.title) {
        state.title = value.projections.values.title
        renderHead()
      }
      renderConversation()
      log('session.history → ' + (value.events || []).length + ' 个事件，hasMore=' + value.hasMore)
    }).catch(function (error) {
      log('session.history 失败：' + error.message, 'err')
    })
  }

  function renderHead() {
    var head = $('s-head')
    clear(head)
    if (!state.selected) { head.appendChild(el('div', 'muted', '未选择会话。')); return }
    var title = el('div', '', state.title || '(无标题)')
    title.style.fontWeight = '600'
    head.appendChild(title)
    var grid = el('dl', 'kv')
    grid.style.marginTop = '6px'
    grid.appendChild(el('dt', '', 'sessionId'))
    grid.appendChild(el('dd', 'muted', state.selected))
    if (state.models) {
      grid.appendChild(el('dt', '', '模型'))
      grid.appendChild(el('dd', 'muted',
        state.models.current.provider + ' / ' + state.models.current.model))
      grid.appendChild(el('dt', '', 'routable'))
      var ok = el('dd', state.models.routable ? 'pill ok' : 'pill err',
        String(state.models.routable))
      grid.appendChild(ok)
      if (state.models.failures && state.models.failures.length) {
        grid.appendChild(el('dt', '', 'provider 失败'))
        grid.appendChild(el('dd', 'muted', state.models.failures.map(function (f) {
          return f.id + ': ' + f.message
        }).join(' | ')))
      }
    }
    head.appendChild(grid)
    var row = el('div', 'row')
    row.style.marginTop = '8px'
    var rename = el('button', '', '重命名')
    rename.addEventListener('click', function () {
      var next = window.prompt('新标题', state.title || '')
      if (next === null) return
      rpc('session.rename', { sessionId: state.selected, title: next }).then(function (value) {
        state.title = value.title
        renderHead()
        loadSessions()
        log('session.rename → ' + value.title, 'ok')
      }).catch(function (error) { log('session.rename 失败：' + error.message, 'err') })
    })
    row.appendChild(rename)
    head.appendChild(row)
  }

  $('s-refresh').addEventListener('click', loadSessions)
  $('s-new').addEventListener('click', function () { show($('s-form'), $('s-form').hidden) })
  $('s-cancel').addEventListener('click', function () { show($('s-form'), false) })
  $('s-form').addEventListener('submit', function (event) {
    event.preventDefault()
    var payload = {}
    var cwd = $('s-cwd').value.trim()
    if (cwd) payload.cwd = cwd
    rpc('session.create', payload).then(function (value) {
      log('session.create → ' + value.sessionId, 'ok')
      show($('s-form'), false)
      $('s-form').reset()
      return loadSessions().then(function () { openSession(value.sessionId) })
    }).catch(function (error) {
      log('session.create 失败：' + error.message, 'err')
    })
  })

  // ---------- conversation ----------
  function textOf(blocks) {
    if (!Array.isArray(blocks)) return ''
    var out = []
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i]
      if (block && block.type === 'text') out.push(block.text)
    }
    return out.join('')
  }

  function pushItem(item) {
    state.items.push(item)
    return item
  }

  function ensureAssistant() {
    if (!state.cursor.assistant) state.cursor.assistant = pushItem({ kind: 'assistant', text: '' })
    return state.cursor.assistant
  }

  function ensureReasoning() {
    if (!state.cursor.reasoning) state.cursor.reasoning = pushItem({ kind: 'reasoning', text: '' })
    return state.cursor.reasoning
  }

  function findTool(callId) {
    for (var i = state.items.length - 1; i >= 0; i--) {
      if (state.items[i].kind === 'tool' && state.items[i].callId === callId) return state.items[i]
    }
    return null
  }

  function applyEvent(event) {
    if (!event || !event.type) return
    var data = event.data || {}
    switch (event.type) {
      case 'turn/start':
        state.running = true
        state.cursor = { assistant: null, reasoning: null }
        pushItem({ kind: 'sys', text: '── turn ' + data.turn + ' 开始 ──' })
        break
      case 'turn/end': {
        state.running = false
        state.cursor = { assistant: null, reasoning: null }
        var reason = data.reason || {}
        var failed = reason.kind === 'error'
        var detail = ''
        if (failed && reason.error) detail = '：' + reason.error.message
        pushItem({
          kind: 'sys' + (failed ? ' err' : ''),
          text: '── turn ' + data.turn + ' 结束（' + reason.kind + '）' + detail + ' ──'
        })
        break
      }
      case 'step/start':
        state.cursor = { assistant: null, reasoning: null }
        break
      case 'user/message': {
        var text = textOf(data.content)
        if (!text) break
        var source = data.source || {}
        pushItem({ kind: source.kind === 'user' ? 'user' : 'context', text: text })
        break
      }
      case 'assistant/chunk': {
        var chunk = data.chunk || {}
        if (chunk.type === 'text-delta') ensureAssistant().text += chunk.text
        else if (chunk.type === 'reasoning-delta') ensureReasoning().text += chunk.text
        break
      }
      case 'assistant/message': {
        var item = ensureAssistant()
        var final = textOf((data.message || {}).content)
        if (final) item.text = final
        item.done = true
        if (data.usage) item.usage = data.usage
        state.cursor = { assistant: null, reasoning: null }
        break
      }
      case 'tool/call': {
        pushItem({
          kind: 'tool', callId: data.callId, name: data.name,
          args: data.arguments, status: 'running'
        })
        state.cursor = { assistant: null, reasoning: null }
        break
      }
      case 'tool/result': {
        var message = data.message || {}
        var block = (message.content || [])[0] || {}
        var target = findTool(block.toolCallId)
        if (!target) target = pushItem({ kind: 'tool', callId: block.toolCallId, name: '(未知工具)' })
        target.result = textOf(block.content)
        target.status = data.error ? 'error' : 'done'
        if (data.error) target.errorText = data.error.name + '/' + data.error.code
        state.cursor = { assistant: null, reasoning: null }
        break
      }
      case 'session/title':
        state.title = data.title
        renderHead()
        break
      default:
        break
    }
    scheduleRender()
  }

  function scheduleRender() {
    if (state.raf) return
    state.raf = window.requestAnimationFrame(function () {
      state.raf = 0
      renderConversation()
      $('stop').disabled = !state.running
    })
  }

  function renderConversation() {
    var box = $('conv')
    clear(box)
    if (state.items.length === 0) {
      box.appendChild(el('div', 'empty', '暂无消息。'))
      return
    }
    var stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40
    state.items.forEach(function (item) {
      if (item.kind === 'user' || item.kind === 'context') {
        var wrapper = el('div', 'msg ' + item.kind)
        wrapper.appendChild(el('div', 'who', item.kind === 'user' ? '用户' : '上下文注入'))
        wrapper.appendChild(el('div', 'body', item.text))
        box.appendChild(wrapper)
        return
      }
      if (item.kind === 'reasoning') {
        var reasoning = el('div', 'msg reasoning')
        reasoning.appendChild(el('div', 'who', '推理'))
        reasoning.appendChild(el('div', 'body', item.text))
        box.appendChild(reasoning)
        return
      }
      if (item.kind === 'assistant') {
        var assistant = el('div', 'msg')
        assistant.appendChild(el('div', 'who', '助手' +
          (item.done ? '' : '（流式中…）') +
          (item.usage ? ' · in ' + item.usage.inputTokens + ' / out ' + item.usage.outputTokens : '')))
        assistant.appendChild(el('div', 'body', item.text))
        box.appendChild(assistant)
        return
      }
      if (item.kind === 'tool') {
        var tool = el('div', 'msg tool' + (item.status === 'error' ? ' err' : ''))
        tool.appendChild(el('div', 'who', '工具 ' + item.name + ' · ' +
          (item.status === 'running' ? '执行中…' : item.status === 'error' ? '失败' : '完成') +
          (item.errorText ? ' · ' + item.errorText : '')))
        if (item.args) tool.appendChild(el('pre', '', item.args))
        if (item.result) tool.appendChild(el('pre', '', item.result))
        box.appendChild(tool)
        return
      }
      box.appendChild(el('div', 'msg ' + item.kind, item.text))
    })
    if (stick) box.scrollTop = box.scrollHeight
  }

  function sendPrompt() {
    var text = $('prompt').value
    if (!text.trim() || !state.selected) return
    $('prompt').value = ''
    state.running = true
    scheduleRender()
    rpc('session.prompt', {
      sessionId: state.selected,
      mode: 'queue',
      content: [{ type: 'text', text: text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }).then(function (value) {
      log('session.prompt accepted' + (value.command ? ' command=' + JSON.stringify(value.command) : ''), 'ok')
      if (value.command && value.command.text) pushItem({ kind: 'sys', text: value.command.text })
      scheduleRender()
    }).catch(function (error) {
      state.running = false
      scheduleRender()
      log('session.prompt 失败：' + error.message, 'err')
      pushItem({ kind: 'sys err', text: '发送失败：' + error.message })
      scheduleRender()
    })
  }

  $('send').addEventListener('click', sendPrompt)
  $('prompt').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendPrompt() }
  })
  $('stop').addEventListener('click', function () {
    if (!state.selected) return
    rpc('session.cancel', { sessionId: state.selected }).then(function () {
      log('session.cancel accepted', 'ok')
    }).catch(function (error) { log('session.cancel 失败：' + error.message, 'err') })
  })

  // ---------- mux stream ----------
  function closeMux() {
    if (state.mux) { state.mux.abort(); state.mux = null }
  }

  function openMux() {
    closeMux()
    var controller = new AbortController()
    state.mux = controller
    fetch('/api/events.mux', {
      headers: { authorization: 'Bearer ' + state.token },
      signal: controller.signal
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      log('events.mux 已打开', 'ok')
      var reader = res.body.getReader()
      var decoder = new TextDecoder()
      var buffer = ''
      function pump() {
        return reader.read().then(function (result) {
          if (result.done) { log('events.mux 已关闭'); return }
          buffer += decoder.decode(result.value, { stream: true })
          var index
          while ((index = buffer.indexOf('\\n\\n')) >= 0) {
            var unit = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            var line = null
            var lines = unit.split('\\n')
            for (var i = 0; i < lines.length; i++) {
              if (lines[i].indexOf('data: ') === 0) line = lines[i].slice(6)
            }
            if (line === null) continue
            try { handleFrame(JSON.parse(line)) } catch (e) { log('帧解析失败：' + e.message, 'err') }
          }
          return pump()
        })
      }
      return pump()
    }).catch(function (error) {
      if (controller.signal.aborted) return
      log('events.mux 失败：' + error.message, 'err')
    })
  }

  function handleFrame(frame) {
    if (!frame || !frame.payload) return
    var payload = frame.payload
    switch (payload.type) {
      case 'session/event':
        if (payload.sessionId === state.selected) applyEvent(payload.event)
        if (payload.event && payload.event.type === 'session/title' && payload.sessionId === state.selected) {
          state.title = payload.event.data.title
          renderHead()
        }
        break
      case 'session/projection':
        if (payload.sessionId === state.selected && payload.key === 'title') {
          state.title = payload.value
          renderHead()
        }
        break
      case 'session/subscribed':
        log('订阅会话 ' + String(payload.sessionId).slice(0, 8) + ' lastSeq=' + payload.lastSeq)
        break
      case 'stream/error':
        log('流错误：' + JSON.stringify(payload.error), 'err')
        break
      default:
        break
    }
  }

  // ---------- credentials ----------
  var credentialRef = ''

  function describeCredentials(ref) {
    credentialRef = ref
    return rpc('credentials.describe', { refs: [ref] }).then(function (value) {
      var view = (value.credentials || {})[ref] || {}
      renderCredential(ref, view)
      log('credentials.describe ' + ref + ' → configured=' + view.configured +
        ' source=' + (view.source || '-') + ' writable=' + view.writable)
    }).catch(function (error) {
      show($('c-empty'), true)
      $('c-empty').textContent = '查询失败：' + error.message
      log('credentials.describe 失败：' + error.message, 'err')
    })
  }

  function renderCredential(ref, view) {
    var body = $('c-rows')
    clear(body)
    show($('c-empty'), false)
    var tr = el('tr')

    tr.appendChild(el('td', '', ref))

    var configured = el('td')
    configured.appendChild(el('span', 'pill ' + (view.configured ? 'ok' : 'warn'),
      view.configured ? '已配置' : '未配置'))
    tr.appendChild(configured)

    var source = el('td')
    if (view.source) source.appendChild(el('span', 'pill', view.source))
    else source.appendChild(el('span', 'muted', '—'))
    tr.appendChild(source)

    var writable = el('td')
    writable.appendChild(el('span', 'pill ' + (view.writable ? 'ok' : 'err'),
      view.writable ? '可写' : '只读'))
    tr.appendChild(writable)

    var actions = el('td')
    var row = el('div', 'row')
    var write = el('button', '', '写入')
    write.disabled = !view.writable
    write.addEventListener('click', function () { openSetForm(ref) })
    row.appendChild(write)

    var clearButton = el('button', 'danger', '清除')
    clearButton.disabled = !view.writable
    clearButton.addEventListener('click', function () {
      rpc('credentials.unset', { ref: ref }).then(function () {
        log('credentials.unset ' + ref + ' 成功', 'ok')
        return describeCredentials(ref)
      }).catch(function (error) {
        log('credentials.unset 失败：' + error.message, 'err')
      })
    })
    row.appendChild(clearButton)
    actions.appendChild(row)
    tr.appendChild(actions)

    body.appendChild(tr)
  }

  function openSetForm(ref) {
    $('c-set-ref').textContent = ref + ' ='
    $('c-value').value = ''
    show($('c-set'), true)
    $('c-value').focus()
  }

  $('c-form').addEventListener('submit', function (event) {
    event.preventDefault()
    var ref = $('c-ref').value.trim()
    if (!ref) { log('请填写凭据引用名', 'err'); return }
    describeCredentials(ref)
  })

  $('c-set-cancel').addEventListener('click', function () {
    show($('c-set'), false)
    $('c-value').value = ''
  })

  $('c-set').addEventListener('submit', function (event) {
    event.preventDefault()
    var value = $('c-value').value
    if (!value) { log('凭据值不能为空（清空请用「清除」）', 'err'); return }
    rpc('credentials.set', { ref: credentialRef, value: value }).then(function () {
      $('c-value').value = ''
      show($('c-set'), false)
      log('credentials.set ' + credentialRef + ' 成功', 'ok')
      return describeCredentials(credentialRef)
    }).catch(function (error) {
      log('credentials.set 失败：' + error.message, 'err')
      if (error.code === 'credential-rejected') {
        log('该引用被只读层遮蔽（source=env）：改启动环境后重启，页面无法覆盖。', 'err')
      }
    })
  })

  // ---------- boot ----------
  var stored = ''
  try { stored = window.localStorage.getItem(TOKEN_KEY) || '' } catch (e) { stored = '' }
  if (stored) {
    $('token').value = stored
    log('已载入上次的 token，点「连接」继续')
  } else {
    log('填入 bearer token 后点「连接」。token 需要 tenant.admin 作用域才能管租户。')
  }
})()
</script>
</body>
</html>
`

/** Serve the operator console shell. */
function consoleHandler(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' })
    response.end()
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(request.method === 'HEAD' ? undefined : CONSOLE_HTML)
}

/**
 * The operator console route this carrier contributes.
 * @returns the `/console` prefix route serving the self-contained page.
 */
export function consoleRoutes(): WebRoute[] {
  return [{ kind: 'prefix', path: '/console', handler: consoleHandler }]
}
