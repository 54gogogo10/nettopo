/* NetTopo Web Shell 窗口 —— 多标签 SSH/Telnet 终端管理 */
'use strict';
(function () {
  if (!window.topoShell) return; // 非 Electron 环境直接退出
  const $ = (s, r) => (r || document).querySelector(s);
  const escAttr = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tabsEl = $('#shTabs'), termsEl = $('#shTerms'), emptyEl = $('#shEmpty');
  const ctxEl = $('#shCtx'), fontValEl = $('#shFontVal');
  const sessions = new Map(); // sid -> { tabEl, wrapEl, term, fit, dotEl, ended, buf }

  /* ---- 终端字号（本地记忆，9~28px） ---- */
  const FONT_KEY = 'topoShellFontSize';
  let fontSize = (() => {
    try { const v = parseInt(localStorage.getItem(FONT_KEY), 10); return Number.isFinite(v) ? Math.max(9, Math.min(28, v)) : 13; }
    catch (e) { return 13; }
  })();
  const setFontSize = (delta) => {
    fontSize = Math.max(9, Math.min(28, fontSize + delta));
    try { localStorage.setItem(FONT_KEY, String(fontSize)); } catch (e) { /* ignore */ }
    if (fontValEl) fontValEl.textContent = fontSize;
    for (const s of sessions.values()) {
      try { s.term.options.fontSize = fontSize; } catch (e) { /* ignore */ }
    }
    const a = activeSession();
    if (a) {
      try { a.s.fit.fit(); } catch (e) { /* ignore */ }
      window.topoShell.resize(a.id, a.s.term.cols, a.s.term.rows);
    }
  };
  const activeSession = () => {
    for (const [id, s] of sessions) if (s.wrapEl.classList.contains('active')) return { id, s };
    return null;
  };

  function applyStatus(s, info) {
    const state = info && info.state;
    s.dotEl.className = 'dot' + (state === 'error' ? ' err' : state === 'connected' ? ' ok' : '');
    s.tabEl.title = (info && info.text) || s.tabEl.title;
    // info 类状态（如 SSH 主机密钥指纹）写入终端，便于人工核对
    if (state === 'info' && info.text && s.term && !s._fpShown) {
      s._fpShown = true;
      s.term.write('\r\n\x1b[90m' + info.text + '\x1b[0m\r\n');
    }
    // 首次连接：弹出指纹确认（TOFU），用户确认后由主进程放行握手
    if (state === 'fingerprint' && info.host) showFingerprintConfirm(info);
  }
  function showFingerprintConfirm(info) {
    if ($('#fpModal')) return; // 已有确认框
    const root = $('#modalRoot');
    const ov = document.createElement('div');
    ov.id = 'fpModal';
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal sh-dialog" role="dialog">
        <h3>首次连接 · 确认主机指纹</h3>
        <div class="m-sub">首次连接 ${escAttr(info.host || '')}，请核对 SSH 主机密钥指纹（可用 <b>ssh-keygen -l -E sha256</b> 比对）：</div>
        <div class="frow"><code style="font:12px/1.7 Consolas,monospace;color:var(--text);background:var(--panel2);padding:6px 10px;border-radius:8px;word-break:break-all">${escAttr(info.fp || '')}</code></div>
        <div class="m-sub" style="color:var(--muted)">确认无误后信任并连接；若与已知指纹不一致，可能遭遇中间人攻击，请取消。</div>
        <div class="m-actions">
          <button type="button" class="tb" data-act="cancel">取消</button>
          <button type="button" class="tb primary" data-act="trust">信任并连接</button>
        </div>
      </div>`;
    root.appendChild(ov);
    ov.tabIndex = -1; ov.focus();
    const close = () => ov.remove();
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) { decide(false); } });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); decide(false); } });
    ov.querySelector('[data-act=cancel]').onclick = () => decide(false);
    ov.querySelector('[data-act=trust]').onclick = () => decide(true);
    function decide(trust) {
      if (trust) { try { localStorage.setItem('topoShellFp:' + info.host, info.fp); } catch (e) { /* ignore */ } }
      window.topoShell.trustFingerprint(info.host, trust);
      close();
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
      cursorBlink: true, fontSize,
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
    // 选中即复制（PuTTY 风格）
    term.onSelectionChange(() => {
      try {
        const sel = term.getSelection();
        if (sel && window.topoShell.copyText) window.topoShell.copyText(sel);
      } catch (e) { /* ignore */ }
    });
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

  /* ---- 复制 / 粘贴 ---- */
  const copySelection = (s) => {
    try { const sel = s.term.getSelection(); if (sel) window.topoShell.copyText(sel); } catch (e) { /* ignore */ }
  };
  const pasteTo = async (s) => {
    try {
      const txt = await window.topoShell.pasteText();
      if (txt && !s.ended) s.term.paste(txt);
    } catch (e) { /* ignore */ }
  };

  /* ---- 通用右键菜单（items 缺省时显示终端菜单） ---- */
  function showCtx(x, y, items) {
    if (!items) {
      const a = activeSession();
      const s = a && a.s;
      const sel = s && s.term.getSelection();
      items = [
        { label: '复制选中', disabled: !sel, act: () => copySelection(s) },
        { label: '粘贴', disabled: !s || s.ended, act: () => pasteTo(s) },
        { label: '全选', disabled: !s, act: () => { try { s.term.selectAll(); } catch (e) { /* ignore */ } } },
        { sep: true },
        { label: '减小字号（Ctrl+-）', act: () => setFontSize(-1) },
        { label: '增大字号（Ctrl+=）', act: () => setFontSize(1) }
      ];
    }
    ctxEl.innerHTML = items.map(it => it.sep
      ? '<div class="d-sep"></div>'
      : `<button class="ci" ${it.disabled ? 'disabled' : ''}>${it.label}</button>`).join('');
    ctxEl.classList.remove('hidden');
    const r = ctxEl.getBoundingClientRect();
    ctxEl.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px';
    ctxEl.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + 'px';
    let bi = 0;
    for (const it of items) {
      if (it.sep) continue;
      const b = ctxEl.querySelectorAll('.ci')[bi++];
      b.onclick = () => { hideCtx(); it.act && it.act(); };
    }
  }
  function hideCtx() { ctxEl.classList.add('hidden'); }

  /* ---- 快捷按钮条（SecureCRT Button Bar 风格） ---- */
  const BTN_KEY = 'topoShellButtons';
  let buttons = [];
  try { buttons = JSON.parse(localStorage.getItem(BTN_KEY) || '[]') || []; } catch (e) { buttons = []; }
  const btnWrapEl = $('#shBBtnWrap'), bbarEl = $('#shBbar'), btnAddEl = $('#shBAdd');
  const saveButtons = () => { try { localStorage.setItem(BTN_KEY, JSON.stringify(buttons)); } catch (e) { /* ignore */ } };
  /* 解析发送内容：\n / \r → 回车(\r)，\t → 制表，\p → 暂停 1 秒，\\ → 字面反斜杠 */
  const parseSendText = (t) => {
    const out = [];
    let cur = '';
    const flush = () => { if (cur) { out.push({ type: 'text', data: cur }); cur = ''; } };
    const s = String(t);
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && i + 1 < s.length) {
        const c = s[i + 1];
        if (c === 'p' || c === 'P') { flush(); out.push({ type: 'pause', ms: 1000 }); i++; continue; }
        if (c === 'r' || c === 'n') { cur += '\r'; i++; continue; }
        if (c === 't') { cur += '\t'; i++; continue; }
        if (c === '\\') { cur += '\\'; i++; continue; }
      }
      cur += s[i];
    }
    flush();
    return out;
  };
  const sendBtn = async (b) => {
    const a = activeSession();
    if (!a) { toast('当前没有活动会话'); return; }
    if (a.s.ended) { toast('会话已结束'); return; }
    const parts = parseSendText(b.text);
    if (b.enter) parts.push({ type: 'text', data: '\r' });
    for (const p of parts) {
      if (a.s.ended) return;
      if (p.type === 'pause') await new Promise((r) => setTimeout(r, p.ms));
      else window.topoShell.sendData(a.id, p.data);
    }
  };
  function renderBar() {
    if (!btnWrapEl) return;
    btnWrapEl.innerHTML = '';
    if (!buttons.length) {
      const h = document.createElement('span');
      h.className = 'sh-bbar-empty';
      h.textContent = '右键或点 ＋ 新建快捷按钮（发送到当前会话）';
      btnWrapEl.appendChild(h);
      return;
    }
    buttons.forEach((b, i) => {
      const el = document.createElement('button');
      el.className = 'sh-bbtn';
      el.textContent = b.label || b.text || ('按钮 ' + (i + 1));
      el.title = (b.label ? b.label + '：' : '') + b.text + (b.enter ? ' ⏎' : '');
      el.onclick = () => sendBtn(b);
      btnWrapEl.appendChild(el);
    });
  }
  function openButtonDialog(idx) {
    const editing = idx >= 0 && idx < buttons.length;
    const b = editing ? buttons[idx] : { label: '', text: '', enter: true };
    const root = $('#modalRoot');
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal sh-dialog" role="dialog">
        <h3>${editing ? '编辑快捷按钮' : '新建快捷按钮'}</h3>
        <div class="m-sub">点击按钮把内容发送到当前会话；内容支持 \\n 回车、\\t 制表、\\p 暂停 1 秒。</div>
        <div class="frow"><label>按钮名称</label><input id="bbLabel" type="text" value="${escAttr(b.label)}" placeholder="例如：查看版本"/></div>
        <div class="frow"><label>发送内容</label><textarea id="bbText" style="height:80px" placeholder="例如：show version\\n">${escAttr(b.text)}</textarea></div>
        <div class="frow"><label style="display:flex;align-items:center;gap:6px"><input id="bbEnter" type="checkbox" ${b.enter ? 'checked' : ''}/> 发送后追加回车（Enter）</label></div>
        <div class="m-actions">
          <button type="button" class="tb" data-act="cancel">取消</button>
          <button type="button" class="tb primary" data-act="save">保存</button>
        </div>
      </div>`;
    root.appendChild(ov);
    ov.tabIndex = -1; ov.focus();
    const close = () => ov.remove();
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
    ov.querySelector('[data-act=cancel]').onclick = close;
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    ov.querySelector('[data-act=save]').onclick = () => {
      const label = ov.querySelector('#bbLabel').value.trim();
      const text = ov.querySelector('#bbText').value;
      if (!text.trim()) { toast('请输入发送内容'); return; }
      const item = { label: label || text.split(/\n|\r/)[0].trim().slice(0, 24), text, enter: ov.querySelector('#bbEnter').checked };
      if (editing) buttons[idx] = item; else buttons.push(item);
      saveButtons();
      renderBar();
      close();
    };
    setTimeout(() => { if (document.body.contains(ov)) ov.querySelector('#bbLabel').focus(); }, 250);
  }
  function openBarCtx(e, idx) {
    e.preventDefault();
    hideCtx();
    const items = [
      { label: '新建按钮…', act: () => openButtonDialog(-1) }
    ];
    if (idx >= 0) {
      items.push(
        { label: '编辑按钮…', act: () => openButtonDialog(idx) },
        { label: '删除按钮', act: () => { buttons.splice(idx, 1); saveButtons(); renderBar(); } }
      );
      if (buttons.length > 1) {
        items.push(
          { sep: true },
          { label: '左移', disabled: idx === 0, act: () => { const [it] = buttons.splice(idx, 1); buttons.splice(idx - 1, 0, it); saveButtons(); renderBar(); } },
          { label: '右移', disabled: idx === buttons.length - 1, act: () => { const [it] = buttons.splice(idx, 1); buttons.splice(idx + 1, 0, it); saveButtons(); renderBar(); } }
        );
      }
    } else {
      items.push({ sep: true }, { label: '清空全部按钮', disabled: !buttons.length, act: () => { buttons = []; saveButtons(); renderBar(); } });
    }
    showCtx(e.clientX, e.clientY, items);
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
      try { const fp = localStorage.getItem('topoShellFp:' + cfg.host) || ''; cfg.expectFp = fp.indexOf('SHA256:') === 0 ? fp : ''; } catch (e) { cfg.expectFp = ''; }
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
    if ($('#shFontDec')) $('#shFontDec').onclick = () => setFontSize(-1);
    if ($('#shFontInc')) $('#shFontInc').onclick = () => setFontSize(1);
    if (fontValEl) fontValEl.textContent = fontSize;

    // 快捷按钮条
    renderBar();
    if (btnAddEl) btnAddEl.onclick = () => openButtonDialog(-1);
    if (bbarEl) bbarEl.addEventListener('contextmenu', (e) => {
      const btn = e.target.closest('.sh-bbtn');
      openBarCtx(e, btn ? [...btnWrapEl.querySelectorAll('.sh-bbtn')].indexOf(btn) : -1);
    });

    // 终端区域右键菜单（不拦截弹窗内输入）
    termsEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!sessions.size) return;
      hideCtx();
      showCtx(e.clientX, e.clientY);
    });
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#shCtx')) hideCtx(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { hideCtx(); return; }
      // 弹窗输入框内不拦截快捷键
      if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#modalRoot')) return;
      const k = (e.key || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'c') { e.preventDefault(); const a = activeSession(); if (a) copySelection(a.s); return; }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'v') { e.preventDefault(); const a = activeSession(); if (a) pasteTo(a.s); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_')) { e.preventDefault(); setFontSize(-1); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); setFontSize(1); return; }
    });

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
