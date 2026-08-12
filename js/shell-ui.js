/* NetTopo Web Shell 窗口 —— 多标签 SSH/Telnet 终端管理 */
'use strict';
(function () {
  if (!window.topoShell) return; // 非 Electron 环境直接退出
  const $ = (s, r) => (r || document).querySelector(s);
  const escAttr = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tabsEl = $('#shTabs'), termsEl = $('#shTerms'), emptyEl = $('#shEmpty');
  const sessions = new Map(); // sid -> { tabEl, wrapEl, term, fit, dotEl, ended, buf }

  function applyStatus(s, info) {
    const state = info && info.state;
    s.dotEl.className = 'dot' + (state === 'error' ? ' err' : state === 'connected' ? ' ok' : '');
    s.tabEl.title = (info && info.text) || s.tabEl.title;
    // info 类状态（如 SSH 主机密钥指纹）写入终端，便于人工核对
    if (state === 'info' && info.text && s.term && !s._fpShown) {
      s._fpShown = true;
      s.term.write('\r\n\x1b[90m' + info.text + '\x1b[0m\r\n');
    }
  }
  function applyEnd(s, reason) {
    s.ended = true;
    s.dotEl.className = 'dot err';
    s.tabEl.title = reason || '连接已关闭';
    if (s.term) s.term.write('\r\n\x1b[33m[会话已结束] ' + (reason || '连接已关闭') + '\x1b[0m\r\n');
  }
  function bindListeners() {
    window.topoShell.onOutput((sid, data) => {
      const s = sessions.get(sid);
      if (!s) return;
      if (s.term) s.term.write(data); else s.buf.push(['out', data]);
    });
    window.topoShell.onStatus((sid, info) => {
      const s = sessions.get(sid);
      if (!s) return;
      if (s.term) applyStatus(s, info); else s.buf.push(['status', info]);
    });
    window.topoShell.onEnd((sid, reason) => {
      const s = sessions.get(sid);
      if (!s) return;
      if (s.term) applyEnd(s, reason); else s.buf.push(['end', reason]);
    });
    window.topoShell.onNewTab((info) => addTab(info));
  }

  function addTab(info) {
    info = info || {};
    if (sessions.has(info.sid)) { activate(info.sid); return; }
    const sid = info.sid;
    emptyEl.classList.add('hidden');
    const tabEl = document.createElement('div');
    tabEl.className = 'sh-tab';
    tabEl.innerHTML = '<span class="dot"></span><span class="tt"></span><span class="x" title="关闭连接">×</span>';
    tabEl.querySelector('.tt').textContent = info.title || sid;
    tabEl.title = info.title || sid;
    const wrapEl = document.createElement('div');
    wrapEl.className = 'sh-term-wrap';
    const termEl = document.createElement('div');
    wrapEl.appendChild(termEl);
    termsEl.appendChild(wrapEl);
    tabsEl.appendChild(tabEl);
    const term = new Terminal({
      cursorBlink: true, fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Mono", "Microsoft YaHei", monospace',
      theme: { background: '#0b1220', foreground: '#e2e8f0' },
      scrollback: 3000
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(termEl);
    const rec = { tabEl, wrapEl, term, fit, dotEl: tabEl.querySelector('.dot'), ended: false, buf: [] };
    sessions.set(sid, rec);
    term.write('\x1b[33m正在连接 ' + (info.title || sid) + ' …\r\n\x1b[0m');
    for (const item of rec.buf.splice(0)) {
      if (item[0] === 'out') term.write(item[1]);
      else if (item[0] === 'status') applyStatus(rec, item[1]);
      else if (item[0] === 'end') applyEnd(rec, item[1]);
    }
    term.onData((d) => { if (!rec.ended) window.topoShell.sendData(sid, d); });
    const fitResize = () => {
      try { fit.fit(); } catch (e) { /* 容器不可见时忽略 */ }
      window.topoShell.resize(sid, term.cols, term.rows);
    };
    tabEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.target.classList.contains('x')) { closeTab(sid); return; }
      activate(sid);
    });
    activate(sid);
    requestAnimationFrame(fitResize);
    return rec;
  }

  function activate(sid) {
    for (const [id, s] of sessions) {
      const on = id === sid;
      s.tabEl.classList.toggle('active', on);
      s.wrapEl.classList.toggle('active', on);
      if (on) {
        requestAnimationFrame(() => {
          try { s.fit.fit(); } catch (e) { /* ignore */ }
          window.topoShell.resize(id, s.term.cols, s.term.rows);
          s.term.focus();
        });
      }
    }
  }

  function closeTab(sid) {
    const s = sessions.get(sid);
    if (!s) return;
    if (!s.ended) window.topoShell.close(sid);
    s.tabEl.remove();
    s.wrapEl.remove();
    try { if (s.fit && s.fit.dispose) s.fit.dispose(); } catch (e) { /* ignore */ }
    try { s.term && s.term.dispose(); } catch (e) { /* ignore */ }
    sessions.delete(sid);
    if (sessions.size === 0) emptyEl.classList.remove('hidden');
    else activate([...sessions.keys()][0]);
  }

  /* ---- 新建连接对话框（窗口内直接发起连接） ---- */
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('topoShellCfg') || 'null'); } catch (e) { saved = null; }
  saved = saved || {};
  function openConnectDialog() {
    const root = $('#modalRoot');
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal sh-dialog" role="dialog">
        <h3>新建 Web Shell 连接</h3>
        <div class="m-sub">通过 SSH 或 Telnet 连接设备的管理口地址。</div>
        <div class="frow">
          <label>连接协议</label>
          <select id="wsProto">
            <option value="ssh"${(saved.protocol || 'ssh') === 'ssh' ? ' selected' : ''}>SSH（默认端口 22）</option>
            <option value="telnet"${saved.protocol === 'telnet' ? ' selected' : ''}>Telnet（默认端口 23）</option>
          </select>
        </div>
        <div class="frow">
          <label>主机 / 管理口</label>
          <input id="wsHost" type="text" placeholder="例如 10.255.0.1" autocomplete="off"/>
        </div>
        <div class="frow"><div class="frow-inline">
          <div class="frow"><label>端口</label><input id="wsPort" type="number" min="1" max="65535"/></div>
          <div class="frow"><label>用户名</label><input id="wsUser" type="text" placeholder="admin" value="${escAttr(saved.username || 'admin')}" autocomplete="off"/></div>
        </div></div>
        <div class="frow">
          <label>密码</label>
          <input id="wsPass" type="password" placeholder="SSH 密码；Telnet 通常可留空" autocomplete="new-password"/>
        </div>
        <div class="m-actions">
          <button type="button" class="tb" data-act="cancel">取消</button>
          <button type="button" class="tb primary" data-act="connect">连接</button>
        </div>
      </div>`;
    root.appendChild(ov);
    ov.tabIndex = -1; ov.focus();
    const close = () => ov.remove();
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
    ov.querySelector('[data-act=cancel]').onclick = close;
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    const protoEl = ov.querySelector('#wsProto');
    const portEl = ov.querySelector('#wsPort');
    const autoPort = () => protoEl.value === 'telnet' ? '23' : '22';
    protoEl.addEventListener('change', () => {
      const cur = portEl.value.trim();
      const otherDefault = autoPort() === '23' ? '22' : '23';
      if (!cur || cur === otherDefault) portEl.value = autoPort();
    });
    if (!portEl.value.trim()) portEl.value = autoPort();
    const doConnect = async () => {
      const cfg = {
        protocol: protoEl.value,
        host: ov.querySelector('#wsHost').value.trim(),
        port: ov.querySelector('#wsPort').value.trim(),
        username: ov.querySelector('#wsUser').value.trim(),
        password: ov.querySelector('#wsPass').value,
        title: ov.querySelector('#wsHost').value.trim() || '连接'
      };
      if (!cfg.host) { toast('请填写主机地址（管理口 IP）'); return; }
      try { localStorage.setItem('topoShellCfg', JSON.stringify({ protocol: cfg.protocol, port: cfg.port, username: cfg.username })); } catch (e) {}
      const btn = ov.querySelector('[data-act=connect]');
      btn.disabled = true; btn.textContent = '连接中…';
      let res;
      try { res = await window.topoShell.connect(cfg); } catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
      if (!res || !res.ok) {
        btn.disabled = false; btn.textContent = '连接';
        toast((res && res.error) || '无法发起连接');
        return;
      }
      close();
    };
    ov.querySelector('[data-act=connect]').onclick = doConnect;
    for (const sel of ['#wsHost', '#wsPort', '#wsUser', '#wsPass']) {
      ov.querySelector(sel).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doConnect(); } });
    }
    setTimeout(() => { if (document.body.contains(ov)) ov.querySelector('#wsHost').focus(); }, 250);
  }

  function toast(msg) {
    let t = $('#shToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'shToast';
      t.style.cssText = 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:200;background:var(--tooltip-bg);color:var(--tooltip-tx);padding:9px 18px;border-radius:10px;font-size:12.5px;box-shadow:0 10px 30px rgba(0,0,0,.3);transition:opacity .3s;max-width:70vw;pointer-events:none';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.opacity = '0'; }, 2600);
  }

  function init() {
    bindListeners();
    $('#shNew').onclick = openConnectDialog;
    $('#shEmptyNew').onclick = openConnectDialog;
    window.addEventListener('resize', () => {
      for (const [id, s] of sessions) {
        if (!s.wrapEl.classList.contains('active')) continue;
        try { s.fit.fit(); } catch (e) { /* ignore */ }
        window.topoShell.resize(id, s.term.cols, s.term.rows);
      }
    });
    if (sessions.size === 0) emptyEl.classList.remove('hidden');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
