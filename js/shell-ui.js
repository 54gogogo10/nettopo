/* NetTopo Web Shell 窗口 —— 多标签 SSH/Telnet 终端管理 */
'use strict';
/** 会话录像解析（纯函数，Node 测试可 require）：JSONL 每行 {t, dir, d}；
 *  只保留 dir='out' 条目并按 t 升序，meta 行解析为对象；返回 { meta, entries, duration } */
function parseRecording(content) {
  const entries = [];
  let meta = null;
  for (const line of String(content == null ? '' : content).split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let j;
    try { j = JSON.parse(s); } catch (e) { continue; } // 坏行宽容跳过
    if (!j || typeof j !== 'object' || !Number.isFinite(j.t) || typeof j.d !== 'string') continue;
    if (j.dir === 'meta') { try { meta = JSON.parse(j.d); } catch (e2) { meta = null; } continue; }
    if (j.dir !== 'out') continue; // 回放只呈现终端输出（用户输入的回显已包含在输出流中）
    entries.push({ t: Math.max(0, Math.floor(j.t)), d: j.d });
  }
  entries.sort((a, b) => a.t - b.t);
  return { meta, entries, duration: entries.length ? entries[entries.length - 1].t : 0 };
}
/** 群发结果对比（纯函数，Node 测试可 require）：行在全部输出中都存在视为共有，否则标记差异 */
function diffSessionOutputs(outputs) {
  const arr = (Array.isArray(outputs) ? outputs : []).map(o => ({
    name: String((o && o.name) || ''),
    lines: (Array.isArray(o && o.lines) ? o.lines : []).map(s => String(s == null ? '' : s).replace(/\s+$/, ''))
  }));
  const sets = arr.map(o => new Set(o.lines));
  const common = (t) => sets.length > 0 && sets.every(s => s.has(t));
  return {
    names: arr.map(o => o.name),
    perOut: arr.map(o => o.lines.map(t => ({ text: t, diff: !common(t) })))
  };
}
/* ---- 连接书签（纯函数，Node 测试可 require）：白名单清洗 / 去重键 / 列表解析 ---- */
/** 书签字段清洗：宿主必填，协议/端口/编码白名单化，凭据密文限长；密码不落明文字段。 */
function sanitizeBookmark(b) {
  if (!b || typeof b !== 'object') return null;
  const host = String(b.host == null ? '' : b.host).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256);
  if (!host) return null;
  const protocol = b.protocol === 'telnet' ? 'telnet' : 'ssh';
  let port = String(b.port == null ? '' : b.port).replace(/\D/g, '').slice(0, 5);
  if (!(parseInt(port, 10) > 0)) port = protocol === 'telnet' ? '23' : '22';
  const out = {
    name: String(b.name == null ? '' : b.name).replace(/[\u0000-\u001f\u007f\r\n]/g, '').trim().slice(0, 64),
    protocol, host, port,
    username: String(b.username == null ? '' : b.username).replace(/[\u0000-\u001f\u007f\r\n]/g, '').trim().slice(0, 128) || 'admin',
    encoding: b.encoding === 'gbk' ? 'gbk' : 'utf8',
    passwordEnc: (typeof b.passwordEnc === 'string' && b.passwordEnc && b.passwordEnc.length <= 8192) ? b.passwordEnc : ''
  };
  if (b.jump && typeof b.jump === 'object' && String(b.jump.host || '').trim()) {
    out.jump = {
      host: String(b.jump.host).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 256),
      port: String(b.jump.port == null ? '' : b.jump.port).replace(/\D/g, '').slice(0, 5),
      username: String(b.jump.username == null ? '' : b.jump.username).replace(/[\u0000-\u001f\u007f\r\n]/g, '').trim().slice(0, 128),
      passwordEnc: (typeof b.jump.passwordEnc === 'string' && b.jump.passwordEnc && b.jump.passwordEnc.length <= 8192) ? b.jump.passwordEnc : ''
    };
  }
  return out;
}
/** 书签去重键：协议|宿主|端口|用户名（同键覆盖更新） */
function bookmarkKey(b) {
  if (!b || typeof b !== 'object') return '';
  return (b.protocol || 'ssh') + '|' + String(b.host || '').trim() + '|' + String(b.port || '') + '|' + String(b.username || '').trim();
}
/** 解析书签列表存储（JSON 数组）：坏项清洗丢弃，上限 100 条 */
function parseBookmarkList(json) {
  let arr = null;
  try { arr = JSON.parse(String(json == null ? '' : json)); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map(sanitizeBookmark).filter(Boolean).slice(0, 100);
}
/** 模糊匹配评分（快速命令面板用，纯函数）：不区分大小写。
 *  前缀 > 词首 > 连续子串 > 子序列（按跳跃扣分）；不匹配返回 null。 */
function fuzzyScore(query, text) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  const s = String(text == null ? '' : text).toLowerCase();
  if (!q) return 0;
  if (!s) return null;
  const idx = s.indexOf(q);
  if (idx === 0) return 160;                       // 前缀
  if (idx > 0) {
    const boundary = /[\s:：/\\\][(_\-@|]/.test(s[idx - 1]);
    return (boundary ? 140 : 100) - Math.min(idx, 30); // 词首优先于普通子串，越靠前越好
  }
  // 子序列：逐字符跳跃匹配，累计跳跃距离扣分
  let si = 0, gaps = 0, matched = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = s.indexOf(q[qi], si);
    if (found < 0) return null;
    gaps += found - si;
    si = found + 1;
    matched++;
  }
  return Math.max(1, 60 - gaps - (q.length - matched));
}
/** 命令历史合并（纯函数）：同文本频次 +1 并刷新时间，按频次/新近排序，超容量淘汰末尾。
 *  并列决胜用随条目持久化的单调 seq（数组下标每轮裁剪后语义反转，不可用）：
 *  同频且同时刻（同毫秒批量下发的命令）时后写入者靠前，保证淘汰的永远是最旧项。 */
function mergeCmdHistory(list, text, cap) {
  const t = String(text == null ? '' : text).replace(/\r|\n/g, ' ').trim();
  const src = Array.isArray(list) ? list : [];
  if (!t) return src.slice();
  const prev = src.find(x => x && typeof x.text === 'string' && x.text === t);
  const merged = src.filter(x => x && typeof x.text === 'string' && x.text !== t)
    .map(x => ({ text: x.text, n: Math.max(1, Math.floor(Number(x.n) || 1)), at: Number(x.at) || 0, seq: Math.floor(Number(x.seq) || 0) }));
  mergeCmdHistory._seq = (mergeCmdHistory._seq || 0) + 1;
  merged.push({ text: t.slice(0, 512), n: (prev ? Math.floor(Number(prev.n) || 1) : 0) + 1, at: Date.now(), seq: mergeCmdHistory._seq });
  merged.sort((a, b) => (b.n - a.n) || (b.at - a.at) || (b.seq - a.seq));
  return merged.slice(0, Math.max(1, Math.floor(cap) || 60)).map(x => ({ text: x.text, n: x.n, at: x.at, seq: x.seq }));
}
/** 恢复条目去重合并（纯函数，标签恢复列表用）：同键（协议|宿主|端口|用户）移到末尾；
 *  新条目密文为空时保留原密文（重连未带密码不得抹掉已存凭据）；超容量淘汰最旧。 */
function upsertRestoreEntry(list, entry, cap) {
  const clean = sanitizeBookmark(entry);
  if (!clean) return Array.isArray(list) ? list.slice() : [];
  const rest = (Array.isArray(list) ? list : []).filter(x => bookmarkKey(x) !== bookmarkKey(clean));
  const prev = (Array.isArray(list) ? list : []).find(x => bookmarkKey(x) === bookmarkKey(clean));
  if (prev) {
    if (!clean.passwordEnc && prev.passwordEnc) clean.passwordEnc = prev.passwordEnc;
    if (clean.jump && prev.jump && prev.jump.passwordEnc && !clean.jump.passwordEnc) clean.jump.passwordEnc = prev.jump.passwordEnc;
    if (!clean.name && prev.name) clean.name = prev.name;
  }
  rest.push(clean);
  return rest.slice(Math.max(0, rest.length - (Math.floor(cap) || 24)));
}
(function () {
  if (typeof module !== 'undefined' && module.exports) { module.exports = { diffSessionOutputs, parseRecording, sanitizeBookmark, bookmarkKey, parseBookmarkList, fuzzyScore, mergeCmdHistory, upsertRestoreEntry }; return; } // Node 测试直取纯函数
  if (!window.topoShell) {
    // 浏览器直接打开本页：给出明确提示（否则空状态不显示、按钮无响应，整页死白）
    const e = document.getElementById('shEmpty');
    if (e) {
      e.classList.remove('hidden');
      const p = e.querySelector('p'), s = e.querySelector('small'), b = e.querySelector('#shEmptyNew');
      if (p) p.textContent = 'Web Shell 需要桌面版';
      if (s) s.textContent = '请在 Electron 桌面版中从拓扑右键设备打开 Web Shell；浏览器直接打开本页无法建立 SSH/Telnet 连接。';
      if (b) b.style.display = 'none';
    }
    return;
  }
  const $ = (s, r) => (r || document).querySelector(s);
  const escAttr = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 终端横幅文本净化：标题/host/原因可源自恶意 CSV/工程或设备错误消息，字面 ESC(0x1b) 会被
  // xterm 解释为 ANSI 序列（改色/改标题/伪造横幅文案）——插值内容剔除转义与控制符
  const bannerText = (s) => String(s == null ? '' : s).replace(/\x1b/g, '*').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
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
      s.term.write('\r\n\x1b[90m' + bannerText(info.text) + '\x1b[0m\r\n');
    }
    // 首次连接：弹出指纹确认（TOFU），用户确认后由主进程放行握手
    if (state === 'fingerprint' && info.host) showFingerprintConfirm(info);
  }
  // 并发首连（对多台新设备同时发起连接）时，第二个指纹事件到达时确认框还在——直接丢弃会让
  // 该会话在主进程侧永远等不到 trustFingerprint，直到 12s 握手超时失败。排队依次展示。
  const fpQueue = [];
  function showFingerprintConfirm(info) {
    if ($('#fpModal')) { fpQueue.push(info); return; } // 已有确认框：排队，关闭后依次展示
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
      // 同主机的排队确认一并出队：trustFingerprint 已放行/拒绝该主机的全部待确认握手
      for (let i = fpQueue.length - 1; i >= 0; i--) if (fpQueue[i].host === info.host) fpQueue.splice(i, 1);
      if (fpQueue.length) showFingerprintConfirm(fpQueue.shift());
    }
  }
  function applyEnd(s, reason) {
    s.ended = true;
    s.dotEl.className = 'dot err';
    s.tabEl.title = reason || '连接已关闭';
    if (s.term) s.term.write('\r\n\x1b[33m[会话已结束] ' + bannerText(reason || '连接已关闭') + '\x1b[0m\r\n');
    castSel.delete(sid0(s));
    refreshCastCount();
    showReconnectBar(s, reason);
    // SFTP 面板正浏览该会话：刷新为断开提示（重新连接成功后切回标签会自动重新浏览）
    if (sftpPanelEl && !sftpPanelEl.classList.contains('hidden') && sid0(s) === sftpSid) sftpSyncToActive();
  }
  const sid0 = (s) => { for (const [id, v] of sessions) if (v === s) return id; return null; };
  function bindListeners() {
    window.topoShell.onOutput((sid, data) => {
      const s = sessions.get(sid);
      if (!s) return;
      recPush(data); // 会话录制：输出进入录像缓冲
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

  /* ---- 断线重连横幅：会话结束后在终端顶部显示「重新连接」按钮，原地重建同一标签 ---- */
  function showReconnectBar(s, reason) {
    if (!s.rcBar) return;
    s.rcReason.textContent = reason || '连接已关闭';
    s.rcBar.classList.remove('hide');
  }
  function hideReconnectBar(s) {
    if (s.rcBar) s.rcBar.classList.add('hide');
  }
  async function reconnectNow(s) {
    if (s._reconnecting) return;
    const id = sid0(s);
    if (!id) { toast('会话已关闭，无法重连'); return; }
    s._reconnecting = true;
    if (s.rcBtn) { s.rcBtn.disabled = true; s.rcBtn.textContent = '重连中…'; }
    let res;
    try { res = await window.topoShell.reconnect(id); } catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
    s._reconnecting = false;
    if (s.rcBtn) { s.rcBtn.disabled = false; s.rcBtn.textContent = '重新连接'; }
    if (!res || !res.ok) { toast((res && res.error) || '重连失败'); return; }
    // 复用同一 sid：终端与闭包无需改动；重置会话态，恢复可输入
    s.ended = false;
    s._fpShown = false; // 新连接可能重新触发 SSH 指纹确认
    if (s.term) s.term.write('\r\n\x1b[33m[正在重新连接 ' + bannerText((s.tabEl.querySelector('.tt') || {}).textContent || '') + ' …]\x1b[0m\r\n');
    if (castMode) castSel.add(id);
    hideReconnectBar(s);
    refreshCastCount();
    if (s.dotEl) s.dotEl.className = 'dot';
  }
  function addTab(info) {
    info = info || {};
    if (sessions.has(info.sid)) { activate(info.sid); return; }
    const sid = info.sid;
    emptyEl.classList.add('hidden');
    const tabEl = document.createElement('div');
    tabEl.className = 'sh-tab';
    tabEl.innerHTML = '<span class="dot"></span><span class="tt"></span><span class="cast" title="勾选参与群发（多标签命令广播）"></span><span class="x" title="关闭连接">×</span>';
    tabEl.querySelector('.tt').textContent = info.title || sid;
    tabEl.title = info.title || sid;
    const wrapEl = document.createElement('div');
    wrapEl.className = 'sh-term-wrap';
    const termEl = document.createElement('div');
    termEl.className = 'sh-term'; // 配套 CSS .sh-term-wrap > .sh-term（勿用 > div：会误伤重连横幅）
    wrapEl.appendChild(termEl);
    // 断线重连横幅（会话结束后显示；点击原地重建，不新开标签、不清空历史）
    const rcBar = document.createElement('div');
    rcBar.className = 'sh-rc hide';
    const rcReason = document.createElement('span');
    rcReason.className = 'sh-rc-reason';
    const rcBtn = document.createElement('button');
    rcBtn.className = 'tb primary sh-rc-btn';
    rcBtn.textContent = '重新连接';
    rcBar.appendChild(rcReason);
    rcBar.appendChild(rcBtn);
    wrapEl.appendChild(rcBar);
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
    const search = new SearchAddon.SearchAddon();
    term.loadAddon(search);
    term.open(termEl);
    const rec = { tabEl, wrapEl, term, fit, search, dotEl: tabEl.querySelector('.dot'), castEl: tabEl.querySelector('.cast'), ended: false, buf: [], rcBar, rcReason, rcBtn,
      meta: { host: info.host || '', port: info.port || '', username: info.username || '', deviceName: info.deviceName || '', protocol: info.protocol || '', encoding: info.encoding || 'utf8' } };
    rcBtn.addEventListener('click', (e) => { e.stopPropagation(); reconnectNow(rec); });
    sessions.set(sid, rec);
    // 标签恢复登记：保存连接元数据 + DPAPI 密文凭据（同名书签已存密文自动回填）
    upsertRestore({ protocol: info.protocol, host: info.host, port: info.port, username: info.username, encoding: info.encoding, name: info.deviceName, pwdEnc: info.pwdEnc, jumpPwdEnc: info.jumpPwdEnc, jump: info.jump });
    term.write('\x1b[33m正在连接 ' + bannerText(info.title || sid) + ' …\r\n\x1b[0m');
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
      if (e.target.classList.contains('cast')) { if (castMode) toggleCastSel(sid); return; }
      activate(sid);
    });
    activate(sid);
    if (castMode && !rec.ended) castSel.add(sid); // 群发模式下新建的标签默认参与
    refreshCastCount();
    // 搜索结果计数：仅当搜索条打开且本标签为活动标签时更新
    if (search && search.onDidChangeResults) {
      search.onDidChangeResults((res) => {
        if (!shSearchEl || shSearchEl.classList.contains('hidden')) return;
        const a = activeSession();
        if (!a || a.id !== sid) return;
        shSearchCountEl.textContent = !res.resultCount ? '无匹配'
          : (res.resultIndex < 0 ? '?' : (res.resultIndex + 1)) + ' / ' + res.resultCount;
      });
    }
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
        // 搜索条打开时切换标签：对新的活动标签重新执行当前搜索
        if (shSearchEl && !shSearchEl.classList.contains('hidden') && shSearchInputEl.value) {
          try { doSearch('next'); } catch (e) { /* ignore */ }
        }
      }
    }
    if (typeof sftpSyncToActive === 'function' && sftpPanelEl && !sftpPanelEl.classList.contains('hidden')) sftpSyncToActive();
  }

  function closeTab(sid) {
    const s = sessions.get(sid);
    if (!s) return;
    // 始终通知主进程关闭：活动会话关闭连接；已结束会话清理其建连参数（防内存留凭据副本）
    window.topoShell.close(sid);
    removeRestoreEntry(s.meta); // 显式关闭标签：从恢复列表移除，下次开窗不再重连
    s.tabEl.remove();
    s.wrapEl.remove();
    try { if (s.fit && s.fit.dispose) s.fit.dispose(); } catch (e) { /* ignore */ }
    try { s.term && s.term.dispose(); } catch (e) { /* ignore */ }
    sessions.delete(sid);
    castSel.delete(sid);
    refreshCastCount();
    if (sessions.size === 0) { if (castMode) setCastMode(false); emptyEl.classList.remove('hidden'); }
    else activate([...sessions.keys()][0]);
  }

  /* ---- 多标签命令广播（SecureCRT Chat Window 模式）：勾选标签，一条命令同时下发 ---- */
  const castBtnEl = $('#shCastBtn'), castEl = $('#shCast'), castInputEl = $('#shCastInput'),
        castSendEl = $('#shCastSend'), castCountEl = $('#shCastCount'), castEnterEl = $('#shCastEnter'),
        castDiffEl = $('#shCastDiff');
  let castMode = false;
  const castSel = new Set(); // 参与群发的 sid（结束的会话自动移出）
  const refreshCastCount = () => {
    if (!castCountEl) return;
    const live = liveCount();
    let n = 0;
    for (const id of castSel) { const s = sessions.get(id); if (s && !s.ended) n++; }
    castCountEl.textContent = '已选 ' + n + ' / ' + live;
    for (const [id, s] of sessions) {
      if (s.castEl) s.castEl.classList.toggle('on', castSel.has(id) && !s.ended);
    }
  };
  const liveCount = () => { let n = 0; for (const [, s] of sessions) if (!s.ended) n++; return n; };
  const setCastMode = (on) => {
    castMode = on;
    if (castBtnEl) castBtnEl.classList.toggle('on', on);
    if (castEl) castEl.classList.toggle('hidden', !on);
    if (tabsEl) tabsEl.classList.toggle('cast-on', on);
    if (on) {
      if (![...castSel].some((id) => { const s = sessions.get(id); return s && !s.ended; })) {
        for (const [id, s] of sessions) if (!s.ended) castSel.add(id);
      }
      refreshCastCount();
      if (castInputEl) castInputEl.focus();
    }
  };
  const toggleCastSel = (sid) => {
    const s = sessions.get(sid);
    if (!s || s.ended) { toast('该会话已结束，不能参与群发'); return; }
    if (castSel.has(sid)) castSel.delete(sid); else castSel.add(sid);
    refreshCastCount();
  };
  /** 变量替换：{ip}/{hostname}/{port}/{user}/{protocol} 按会话元数据替换（hostname 缺省回落 ip）。
   *  群发按各标签实际值替换；快捷按钮按当前会话替换。 */
  const substituteVars = (text, meta) => String(text == null ? '' : text).replace(/\{(ip|hostname|port|user|protocol)\}/gi, (m, k) => {
    if (!meta) return m;
    const key = String(k).toLowerCase();
    if (key === 'ip') return meta.host || m;
    if (key === 'hostname') return meta.deviceName || meta.host || m;
    if (key === 'port') return meta.port || m;
    if (key === 'user') return meta.username || m;
    if (key === 'protocol') return meta.protocol || m;
    return m;
  });
  const sendCast = () => {
    const targets = [...castSel].filter((id) => { const s = sessions.get(id); return s && !s.ended; });
    if (!targets.length) { toast('请先勾选要群发的标签'); return; }
    const text = castInputEl ? castInputEl.value : '';
    if (!text.trim()) { toast('请输入要群发的内容'); return; }
    recordCmd(text); // 历史命令：群发内容进入命令面板候选
    for (const id of targets) {
      (async () => {
        const s = sessions.get(id);
        const parts = parseSendText(substituteVars(text, s && s.meta)); // 按各标签设备变量替换
        if (castEnterEl && castEnterEl.checked) parts.push({ type: 'text', data: '\r' });
        for (const p of parts) {
          const s2 = sessions.get(id);
          if (!s2 || s2.ended) return;
          if (p.type === 'pause') await new Promise((r) => setTimeout(r, p.ms));
          else window.topoShell.sendData(id, p.data);
        }
      })();
    }
    toast('已群发到 ' + targets.length + ' 个标签');
  };
  /* ---- 群发结果对比：汇总勾选标签的终端缓冲区，共有行之外标记差异 ---- */
  const readTermLines = (s, maxLines) => {
    try {
      const buf = s.term.buffer.active;
      const total = buf.length;
      const lines = [];
      for (let i = Math.max(0, total - maxLines); i < total; i++) {
        const ln = buf.getLine(i);
        if (ln) lines.push(ln.translateToString(true));
      }
      while (lines.length && !lines[lines.length - 1]) lines.pop();
      return lines;
    } catch (e) { return []; }
  };
  const openCastDiff = () => {
    const targets = [...castSel].filter((id) => { const s = sessions.get(id); return s && !s.ended; });
    if (targets.length < 2) { toast('请先勾选至少两个要对比的标签'); return; }
    const outputs = targets.map((id) => {
      const s = sessions.get(id);
      return { name: (s.tabEl.querySelector('.tt') || {}).textContent || id, lines: readTermLines(s, 200) };
    });
    const d = diffSessionOutputs(outputs);
    const root = $('#modalRoot');
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal sh-dialog cast-diff-dialog" role="dialog" style="width:92vw;max-width:1400px;height:84vh;display:flex;flex-direction:column">
        <h3>群发结果对比</h3>
        <div class="m-sub">${d.names.length} 个标签的终端输出（各取最近 200 行）；<span class="cd-hl">高亮行</span>为未在全部标签中同时出现的差异行。</div>
        <div class="cd-grid">${d.perOut.map((out, i) => `
          <div class="cd-col">
            <div class="cd-name">${escAttr(d.names[i])}</div>
            <pre class="cd-body">${out.map(l => l.diff && l.text ? `<span class="cd-hl">${escAttr(l.text)}</span>` : escAttr(l.text)).join('\n')}</pre>
          </div>`).join('')}
        </div>
        <div class="m-actions"><button type="button" class="tb primary" data-act="close">关闭</button></div>
      </div>`;
    root.appendChild(ov);
    ov.tabIndex = -1; ov.focus();
    const close = () => ov.remove();
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
    ov.querySelector('[data-act=close]').onclick = close;
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  };

  /* ---- 会话录制 / 回放 ----
   * 录制：开启后所有标签的终端输出按时间戳缓冲成 JSONL 行（{t, dir:'out', d}），每 800ms 批量
   * 追加到主进程 userData/shell-recordings/rec_<时间戳>.ntrec.jsonl（文件名与路径由主进程白名单管理）。
   * 回放：读取录像 → 只读 xterm 按时间轴回放，支持 0.5~8 倍速 / 暂停 / 重播。 */
  const recBtnEl = $('#shRecBtn'), recPlayBtnEl = $('#shRecPlayBtn');
  let recActive = false, recFile = null, recStart = 0, recBuf = [], recTimer = null;
  const recPush = (data) => { if (recActive && recBuf.length < 20000) recBuf.push({ t: Date.now() - recStart, dir: 'out', d: data }); };
  const recFlush = async () => {
    if (!recActive || !recBuf.length) return;
    const lines = recBuf.map(e => JSON.stringify(e)).join('\n');
    recBuf = [];
    try {
      const r = await window.topoShell.recordAppend({ lines });
      if (!r || !r.ok) throw new Error((r && r.error) || '写入失败');
    } catch (e) {
      stopRecording(true);
      toast('录制写入失败，已停止录制：' + String((e && e.message) || e));
    }
  };
  const startRecording = async () => {
    if (recActive) return;
    let r;
    try { r = await window.topoShell.recordStart(); } catch (e) { r = null; }
    if (!r || !r.ok) { toast('录制启动失败：' + ((r && r.error) || '未知错误')); return; }
    recActive = true; recFile = r.name; recStart = Date.now(); recBuf = [];
    recTimer = setInterval(recFlush, 800);
    if (recBtnEl) { recBtnEl.classList.add('on'); recBtnEl.textContent = '⏺ 录制中…'; }
    toast('开始录制会话输出（再次点击停止）：' + r.name);
  };
  const stopRecording = async (silent) => {
    if (!recActive) return;
    recActive = false;
    if (recTimer) { clearInterval(recTimer); recTimer = null; }
    await recFlush();
    let r;
    try { r = await window.topoShell.recordStop(); } catch (e) { r = null; }
    if (recBtnEl) { recBtnEl.classList.remove('on'); recBtnEl.textContent = '⏺ 录制'; }
    if (!silent) toast('录制完成：' + ((r && r.name) || recFile || ''));
    recFile = null;
  };
  if (recBtnEl) recBtnEl.onclick = () => { recActive ? stopRecording() : startRecording(); };
  const rpSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** 回放器：只读 xterm 按时间轴写入，速度倍率 / 暂停 / 重播；关闭即终止 */
  const openReplayPlayer = async (item) => {
    let r;
    try { r = await window.topoShell.recordRead({ name: item.name }); } catch (e) { r = null; }
    if (!r || !r.ok) { toast((r && r.error) || '读取录像失败'); return; }
    const rec = parseRecording(r.content);
    if (!rec.entries.length) { toast('该录像没有可回放的内容'); return; }
    const root = $('#modalRoot');
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal sh-dialog" role="dialog" style="width:920px;height:82vh;display:flex;flex-direction:column">
        <h3>回放录像 · ${escAttr(item.name)}</h3>
        <div class="m-sub">${rec.entries.length} 条输出 · 录制时长约 ${Math.round(rec.duration / 1000)} 秒。回放为只读终端，输入已禁用。</div>
        <div id="rpTerm" style="flex:1;overflow:hidden;background:#0b1220;border-radius:8px;padding:6px 0 6px 8px"></div>
        <div class="m-actions" style="justify-content:flex-start">
          <select id="rpSpeed" class="sh-ai-mode" title="回放速度">
            <option value="0.5">0.5×</option>
            <option value="1" selected>1×</option>
            <option value="2">2×</option>
            <option value="4">4×</option>
            <option value="8">8×</option>
          </select>
          <button type="button" class="tb primary" id="rpPlay">播放</button>
          <button type="button" class="tb" id="rpRestart">重播</button>
          <span id="rpProg" style="font-size:11.5px;color:var(--muted);flex:1"></span>
          <button type="button" class="tb" data-act="close">关闭</button>
        </div>
      </div>`;
    root.appendChild(ov);
    ov.tabIndex = -1; ov.focus();
    let runId = 0, playing = false, paused = false, idx = 0;
    const term = new Terminal({ cursorBlink: false, fontSize: 12, fontFamily: 'Consolas, "Cascadia Mono", "Microsoft YaHei", monospace', theme: { background: '#0b1220', foreground: '#e2e8f0' }, scrollback: 5000, disableStdin: true });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(ov.querySelector('#rpTerm'));
    try { fit.fit(); } catch (e) { /* ignore */ }
    const prog = ov.querySelector('#rpProg');
    const playBtn = ov.querySelector('#rpPlay');
    const speedEl = ov.querySelector('#rpSpeed');
    const close = () => { runId++; try { term.dispose(); } catch (e) { /* ignore */ } ov.remove(); };
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    ov.querySelector('[data-act=close]').onclick = close;
    playBtn.onclick = () => { paused = !paused; playBtn.textContent = paused ? '▶ 继续' : '⏸ 暂停'; };
    ov.querySelector('#rpRestart').onclick = () => { paused = false; playBtn.textContent = '⏸ 暂停'; play(); };
    speedEl.onchange = () => { /* 速度即时生效，无需重启 */ };
    const play = async () => {
      const my = ++runId;
      playing = true; paused = false; idx = 0;
      try { term.reset(); } catch (e) { /* ignore */ }
      playBtn.textContent = '⏸ 暂停';
      let prevT = 0;
      while (idx < rec.entries.length) {
        if (my !== runId) return;
        if (paused) { await rpSleep(120); continue; }
        const e = rec.entries[idx];
        let delay = idx === 0 ? 0 : Math.max(0, (e.t - prevT)) / Number(speedEl.value || 1);
        prevT = e.t;
        let waited = 0;
        while (waited < delay) {
          if (my !== runId) return;
          if (paused) { await rpSleep(120); continue; }
          const step = Math.min(80, delay - waited);
          await rpSleep(step); waited += step;
        }
        if (my !== runId) return;
        term.write(e.d);
        idx++;
        if (idx % 25 === 0) prog.textContent = '进度 ' + idx + '/' + rec.entries.length + '（录制时间轴 ' + Math.round(e.t / 1000) + 's）';
      }
      if (my === runId) { playing = false; playBtn.textContent = '▶ 已完成，重播'; prog.textContent = '回放完成（' + rec.entries.length + ' 条）'; }
    };
    play();
  };
  if (recPlayBtnEl) recPlayBtnEl.onclick = async () => {
    let items = [];
    try { const r = await window.topoShell.recordList(); items = (r && r.items) || []; } catch (e) { /* ignore */ }
    const root = $('#modalRoot');
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal sh-dialog" role="dialog" style="width:620px">
        <h3>回放录像</h3>
        <div class="m-sub">选择要回放的会话录像（${items.length} 个）。录像保存在本机 shell-recordings 目录。</div>
        <div id="rpList" style="max-height:46vh;overflow:auto">${items.length ? '' : '<div class="bk-empty">暂无录像：点击顶栏「⏺ 录制」开始录制会话输出</div>'}</div>
        <div class="m-actions"><button type="button" class="tb primary" data-act="close">关闭</button></div>
      </div>`;
    root.appendChild(ov);
    ov.tabIndex = -1; ov.focus();
    const close = () => ov.remove();
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    ov.querySelector('[data-act=close]').onclick = close;
    const listEl = ov.querySelector('#rpList');
    const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
    if (items.length) {
      listEl.innerHTML = items.map(it => `
        <div class="lb-file" data-name="${escAttr(it.name)}" style="cursor:pointer">
          <span class="nm">${escAttr(it.name)}</span>
          <span class="sub">${fmtSize(it.size)} · ${new Date(it.at).toLocaleString()}</span>
          <button type="button" class="tb trust-del rp-del" title="删除该录像">删除</button>
        </div>`).join('');
      listEl.querySelectorAll('.lb-file').forEach(el => {
        el.onclick = (e) => {
          if (e.target.closest('.rp-del')) return;
          close();
          openReplayPlayer({ name: el.dataset.name });
        };
      });
      listEl.querySelectorAll('.rp-del').forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const name = btn.closest('.lb-file').dataset.name;
          try { await window.topoShell.recordDelete({ name }); btn.closest('.lb-file').remove(); toast('已删除录像'); } catch (err) { toast('删除失败'); }
        };
      });
    }
  };

  /* ---- SFTP 文件面板（复用当前 SSH 会话的远程文件浏览 / 上传 / 下载） ---- */
  const sftpBtnEl = $('#shSftpBtn'), sftpPanelEl = $('#shSftp'), sftpListEl = $('#shSftpList'),
        sftpStatusEl = $('#shSftpStatus'), sftpPathEl = $('#shSftpPath'), sftpHostEl = $('#shSftpHost');
  const sftpPaths = new Map(); // sid -> 最近浏览目录（会话级记忆，切标签回来不丢位置）
  let sftpSid = null;          // 面板当前浏览的会话（切标签/断开时刷新）
  let sftpSel = null;          // 当前选中项 {name, dir}
  let sftpBusy = false;        // 单飞：目录浏览请求进行中不再叠加
  const sftpSetStatus = (msg, err) => {
    if (!sftpStatusEl) return;
    sftpStatusEl.textContent = msg || '';
    sftpStatusEl.classList.toggle('err', !!err);
  };
  const sfmtSize = (n) => {
    if (!Number.isFinite(Number(n)) || n < 0) return '';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n;
    for (const u of units) { v /= 1024; if (v < 1024 || u === 'TB') return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u; }
    return '';
  };
  const sfmtTime = (ms) => {
    if (!Number.isFinite(Number(ms)) || !ms) return '';
    const d = new Date(ms), p2 = (x) => String(x).padStart(2, '0');
    return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  };
  /** 远程 POSIX 路径拼接（与主进程 sftpRemoteJoin 同口径，渲染层导航用） */
  const sftpJoin = (dir, name) => {
    dir = String(dir == null ? '.' : dir).trim() || '.';
    name = String(name == null ? '' : name).trim().replace(/[\r\n\0]/g, '');
    if (!name || name === '.' || name === '..' || name.indexOf('/') >= 0) return '';
    if (dir === '.' || dir === '' || dir === '~') return name;
    return (dir.endsWith('/') ? dir : dir + '/') + name;
  };
  const sftpParent = (p) => {
    let cur = String(p == null ? '.' : p).trim() || '.';
    if (cur === '.' || cur === '~') return '.';
    cur = cur.replace(/\/+$/, '') || '/';
    const i = cur.lastIndexOf('/');
    if (i < 0) return '.';
    return i === 0 ? '/' : cur.slice(0, i) || '/';
  };
  function renderSftpEmpty(msg) {
    if (!sftpListEl) return;
    sftpListEl.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'sf-empty';
    d.textContent = msg || '（空目录）';
    sftpListEl.appendChild(d);
  }
  function renderSftpList(items) {
    if (!sftpListEl) return;
    sftpListEl.innerHTML = '';
    if (!items || !items.length) { renderSftpEmpty('（空目录）'); return; }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'sf-row';
      const ic = document.createElement('span');
      ic.className = 'sf-ic';
      ic.textContent = it.dir ? '📁' : '📄';
      const nm = document.createElement('span');
      nm.className = 'sf-nm' + (it.dir ? ' is-dir' : '');
      nm.textContent = it.name;
      const sz = document.createElement('span');
      sz.className = 'sf-sz';
      sz.textContent = (it.dir ? '' : sfmtSize(it.size)) + (it.mtime ? '  ' + sfmtTime(it.mtime) : '');
      row.appendChild(ic); row.appendChild(nm); row.appendChild(sz);
      row.onclick = () => {
        sftpSel = { name: it.name, dir: it.dir };
        sftpListEl.querySelectorAll('.sf-row.sel').forEach(el => el.classList.remove('sel'));
        row.classList.add('sel');
        sftpSetStatus('已选中：' + it.name + (it.dir ? '（目录）' : '（' + (sfmtSize(it.size) || '0 B') + '）'));
      };
      row.ondblclick = () => {
        if (it.dir) sftpBrowse(sftpSid, sftpJoin(sftpPaths.get(sftpSid) || '.', it.name));
        else sftpDownloadSel(it.name);
      };
      sftpListEl.appendChild(row);
    }
  }
  async function sftpBrowse(sid, path, opts) {
    if (!sftpListEl || !sid) return;
    const s = sessions.get(sid);
    if (!s) { renderSftpEmpty('会话不存在'); return; }
    if (s.meta.protocol !== 'ssh') { renderSftpEmpty('Telnet 会话不支持 SFTP 文件浏览'); sftpSetStatus(''); return; }
    if (s.ended) { renderSftpEmpty('会话已断开，重新连接后可浏览远程文件'); sftpSetStatus(''); return; }
    if (sftpBusy) return;
    sftpBusy = true;
    if (!opts || !opts.keepList) sftpSetStatus('加载中…');
    let res;
    try { res = await window.topoShell.sftpList({ id: sid, path: path || '.' }); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    sftpBusy = false;
    if (sftpSid !== sid) return; // 期间已切到其他标签：结果作废
    if (!res || !res.ok) {
      if (!opts || !opts.keepList) renderSftpEmpty((res && res.error) || '浏览失败');
      sftpSetStatus((res && res.error) || '浏览失败', true);
      return;
    }
    sftpPaths.set(sid, res.path);
    if (sftpPathEl && document.activeElement !== sftpPathEl) sftpPathEl.value = res.path;
    sftpSel = null;
    renderSftpList(res.items);
    sftpSetStatus(res.items.length + ' 项 · ' + res.path);
  }
  const sftpCurDir = () => sftpPaths.get(sftpSid) || '.';
  const sftpActiveRow = () => {
    const s = sessions.get(sftpSid);
    if (!s || s.ended) { toast('会话已断开'); return null; }
    if (s.meta.protocol !== 'ssh') { toast('Telnet 会话不支持 SFTP'); return null; }
    return s;
  };
  const sftpRequireSel = (needFile) => {
    if (!sftpSel) { toast('请先在列表中选中一项'); return null; }
    if (needFile && sftpSel.dir) { toast('请选中一个文件（目录不支持该操作）'); return null; }
    return sftpSel;
  };
  async function sftpDownloadSel(name) {
    const sel = name ? { name } : sftpRequireSel(true);
    if (!sel || !sftpActiveRow()) return;
    sftpSetStatus('下载中：' + sel.name);
    let res;
    try { res = await window.topoShell.sftpDownload({ id: sftpSid, remotePath: sftpJoin(sftpCurDir(), sel.name) }); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    if (res && res.ok) sftpSetStatus('已下载：' + sel.name + ' → ' + (res.path || '本地'));
    else if (res && !res.canceled) sftpSetStatus('下载失败：' + ((res && res.error) || '未知错误'), true);
  }
  /** 通用输入小弹窗（新建目录 / 重命名共用） */
  function sftpPrompt(title, hint, defval, cb) {
    const root = $('#modalRoot');
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal sh-dialog" role="dialog">
        <h3>${escAttr(title)}</h3>
        <div class="m-sub">${escAttr(hint || '')}</div>
        <div class="frow"><input id="spIn" type="text" value="${escAttr(defval || '')}" spellcheck="false" autocomplete="off"/></div>
        <div class="m-actions">
          <button type="button" class="tb" data-act="cancel">取消</button>
          <button type="button" class="tb primary" data-act="ok">确定</button>
        </div>
      </div>`;
    root.appendChild(ov);
    ov.tabIndex = -1; ov.focus();
    const close = () => ov.remove();
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    const submit = () => {
      const v = ov.querySelector('#spIn').value.trim();
      if (!v) { toast('请输入名称'); return; }
      close();
      cb(v);
    };
    ov.querySelector('[data-act=cancel]').onclick = close;
    ov.querySelector('[data-act=ok]').onclick = submit;
    ov.querySelector('#spIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    setTimeout(() => { if (document.body.contains(ov)) { const i = ov.querySelector('#spIn'); i.focus(); i.select(); } }, 250);
  }
  function sftpConfirm(title, text, cb) {
    const root = $('#modalRoot');
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal sh-dialog" role="dialog">
        <h3>${escAttr(title)}</h3>
        <div class="m-sub">${escAttr(text || '')}</div>
        <div class="m-actions">
          <button type="button" class="tb" data-act="cancel">取消</button>
          <button type="button" class="tb primary" data-act="ok">删除</button>
        </div>
      </div>`;
    root.appendChild(ov);
    ov.tabIndex = -1; ov.focus();
    const close = () => ov.remove();
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    ov.querySelector('[data-act=cancel]').onclick = close;
    ov.querySelector('[data-act=ok]').onclick = () => { close(); cb(); };
  }
  function setSftpOpen(on) {
    if (!sftpPanelEl) return;
    sftpPanelEl.classList.toggle('hidden', !on);
    document.body.classList.toggle('sh-sftp-on', on);
    if (sftpBtnEl) sftpBtnEl.classList.toggle('on', on);
    const a = activeSession();
    if (a) requestAnimationFrame(() => {
      try { a.s.fit.fit(); } catch (e) { /* ignore */ }
      try { window.topoShell.resize(a.id, a.s.term.cols, a.s.term.rows); } catch (e) { /* ignore */ }
    });
    if (on) sftpSyncToActive();
  }
  function sftpSyncToActive() {
    if (!sftpPanelEl || sftpPanelEl.classList.contains('hidden')) return;
    const a = activeSession();
    sftpSid = a ? a.id : null;
    sftpSel = null;
    if (!a) {
      if (sftpHostEl) sftpHostEl.textContent = '';
      renderSftpEmpty('没有活动会话：新建 SSH 连接后可浏览远程文件');
      sftpSetStatus('');
      return;
    }
    if (sftpHostEl) sftpHostEl.textContent = (a.s.meta.host || '') + '（' + String(a.s.meta.protocol || '').toUpperCase() + '）';
    sftpBrowse(sftpSid, sftpPaths.get(sftpSid) || '.', { keepList: true });
  }
  function wireSftp() {
    if (!sftpPanelEl) return;
    if (sftpBtnEl) sftpBtnEl.onclick = () => setSftpOpen(sftpPanelEl.classList.contains('hidden'));
    $('#shSftpClose').onclick = () => setSftpOpen(false);
    $('#shSftpUp').onclick = () => sftpBrowse(sftpSid, sftpParent(sftpCurDir()));
    $('#shSftpHome').onclick = () => sftpBrowse(sftpSid, '.');
    $('#shSftpGo').onclick = () => sftpBrowse(sftpSid, sftpPathEl ? sftpPathEl.value : '.');
    if (sftpPathEl) sftpPathEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sftpBrowse(sftpSid, sftpPathEl.value); } });
    $('#shSftpRefresh').onclick = () => sftpBrowse(sftpSid, sftpCurDir());
    $('#shSftpMkdir').onclick = () => {
      if (!sftpActiveRow()) return;
      sftpPrompt('新建远程目录', '目录名将创建在 ' + sftpCurDir() + ' 下', '', (name) => {
        (async () => {
          let res;
          try { res = await window.topoShell.sftpMkdir({ id: sftpSid, path: sftpJoin(sftpCurDir(), name) }); }
          catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
          if (res && res.ok) { toast('目录已创建'); sftpBrowse(sftpSid, sftpCurDir()); }
          else toast('创建失败：' + ((res && res.error) || '未知错误'));
        })();
      });
    };
    $('#shSftpUpload').onclick = async () => {
      if (!sftpActiveRow()) return;
      let res;
      try { res = await window.topoShell.sftpUpload({ id: sftpSid, dir: sftpCurDir() }); }
      catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
      if (res && res.ok) {
        const fails = res.failed || 0, total = (res.files || []).length;
        sftpSetStatus(fails ? '上传完成：' + (total - fails) + '/' + total + ' 成功' : '已上传 ' + total + ' 个文件到 ' + sftpCurDir(), fails > 0);
        sftpBrowse(sftpSid, sftpCurDir(), { keepList: true });
      } else if (res && !res.canceled) {
        sftpSetStatus('上传失败：' + ((res && res.error) || '未知错误'), true);
      }
    };
    $('#shSftpDownload').onclick = () => sftpDownloadSel();
    $('#shSftpRename').onclick = () => {
      const sel = sftpRequireSel(false);
      if (!sel || !sftpActiveRow()) return;
      sftpPrompt('重命名', sel.name + ' → 新名称（同目录内）', sel.name, (name) => {
        (async () => {
          let res;
          try { res = await window.topoShell.sftpRename({ id: sftpSid, from: sftpJoin(sftpCurDir(), sel.name), to: sftpJoin(sftpCurDir(), name) }); }
          catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
          if (res && res.ok) { toast('已重命名'); sftpBrowse(sftpSid, sftpCurDir()); }
          else toast('重命名失败：' + ((res && res.error) || '未知错误'));
        })();
      });
    };
    $('#shSftpDelete').onclick = () => {
      const sel = sftpRequireSel(false);
      if (!sel || !sftpActiveRow()) return;
      sftpConfirm('删除远程' + (sel.dir ? '目录' : '文件'), '将删除 ' + sftpJoin(sftpCurDir(), sel.name) + (sel.dir ? '（目录必须为空）' : '') + '，此操作不可恢复。', () => {
        (async () => {
          let res;
          try { res = await window.topoShell.sftpRemove({ id: sftpSid, path: sftpJoin(sftpCurDir(), sel.name), isDir: !!sel.dir }); }
          catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
          if (res && res.ok) { toast('已删除'); sftpBrowse(sftpSid, sftpCurDir()); }
          else toast('删除失败：' + ((res && res.error) || '未知错误'));
        })();
      });
    };
    // 上传/下载进度（主进程节流 400ms 推送）
    if (window.topoShell.onSftpProgress) {
      window.topoShell.onSftpProgress((info) => {
        if (!info || !sftpPanelEl || sftpPanelEl.classList.contains('hidden')) return;
        const label = info.op === 'upload' ? '上传' : '下载';
        const nm = String(info.name || '').split('/').pop() || '';
        sftpSetStatus(label + '中：' + nm + '（' + sfmtSize(info.transferred) + (info.total ? ' / ' + sfmtSize(info.total) : '') + '）');
      });
    }
  }

  /* ---- 终端搜索（Ctrl+F 呼出：即输即搜、Enter/Shift+Enter 上下导航、结果计数） ---- */
  const shSearchEl = $('#shSearch'), shSearchBtnEl = $('#shSearchBtn'),
        shSearchInputEl = $('#shSearchInput'), shSearchCountEl = $('#shSearchCount');
  const SEARCH_DECO = { // 高亮配色按终端深色主题定值（SearchAddon 要求 #RRGGBB）
    matchBackground: '#31456b', matchBorder: '#5a7ab5', matchOverviewRuler: '#5a7ab5',
    activeMatchBackground: '#8a5a2b', activeMatchBorder: '#e8a04b', activeMatchColorOverviewRuler: '#e8a04b'
  };
  const activeSearchAddon = () => {
    const a = activeSession();
    return (a && a.s.search) ? a.s.search : null;
  };
  const setSearchOpen = (on) => {
    if (!shSearchEl) return;
    shSearchEl.classList.toggle('hidden', !on);
    if (on) {
      shSearchInputEl.focus();
      shSearchInputEl.select();
      if (shSearchInputEl.value) doSearch('next');
      else if (shSearchCountEl) shSearchCountEl.textContent = '';
    } else {
      const addon = activeSearchAddon();
      if (addon) { try { addon.clearDecorations(); } catch (e) { /* ignore */ } }
      if (shSearchCountEl) shSearchCountEl.textContent = '';
      const a = activeSession();
      if (a && a.s.term) { try { a.s.term.focus(); } catch (e) { /* ignore */ } }
    }
  };
  const doSearch = (dir) => {
    if (!shSearchEl || shSearchEl.classList.contains('hidden')) return;
    const addon = activeSearchAddon();
    if (!addon) { if (shSearchCountEl) shSearchCountEl.textContent = '无活动会话'; return; }
    const q = shSearchInputEl.value;
    if (!q) {
      try { addon.clearDecorations(); } catch (e) { /* ignore */ }
      if (shSearchCountEl) shSearchCountEl.textContent = '';
      return;
    }
    try {
      if (dir === 'prev') addon.findPrevious(q, { decorations: SEARCH_DECO });
      else addon.findNext(q, { decorations: SEARCH_DECO });
    } catch (e) { if (shSearchCountEl) shSearchCountEl.textContent = '搜索失败'; }
  };
  function wireSearch() {
    if (!shSearchEl) return;
    if (shSearchBtnEl) shSearchBtnEl.onclick = () => setSearchOpen(shSearchEl.classList.contains('hidden'));
    shSearchInputEl.addEventListener('input', () => doSearch('next')); // 即输即搜（增量高亮由 addon 处理）
    shSearchInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doSearch(e.shiftKey ? 'prev' : 'next'); }
      else if (e.key === 'Escape') { e.stopPropagation(); setSearchOpen(false); }
    });
    $('#shSearchPrev').onclick = () => doSearch('prev');
    $('#shSearchNext').onclick = () => doSearch('next');
    $('#shSearchClose').onclick = () => setSearchOpen(false);
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

  /* ---- AI 命令助手：自然语言需求 → 生成命令 → 按权限模式执行 ----
   * 权限模式（执行方式）：confirm 确认后执行（默认，生成先展示、人工确认再下发）|
   * fill 仅填入不执行（命令填入终端不回车，人工检查后手动执行）| auto 直接执行（生成即下发） */
  const AI_MODE_KEY = 'topoShellAiMode';
  const AI_MODES = ['confirm', 'fill', 'auto'];
  const AI_DEV_KEY = 'topoShellAiDev';
  const AI_KIND_KEY = 'topoShellAiKind';
  const AI_KINDS = ['cmd', 'config'];
  const aiBtnEl = $('#shAiBtn'), aiEl = $('#shAi'), aiModeEl = $('#shAiMode'),
        aiDevEl = $('#shAiDev'), aiKindEl = $('#shAiKind'), aiInputEl = $('#shAiInput'), aiCtxEl = $('#shAiCtx'),
        aiSendEl = $('#shAiSend'), aiResultEl = $('#shAiResult');
  let aiMode = (() => {
    try { const v = localStorage.getItem(AI_MODE_KEY); return AI_MODES.indexOf(v) >= 0 ? v : 'confirm'; }
    catch (e) { return 'confirm'; }
  })();
  if (aiModeEl) aiModeEl.value = aiMode;
  if (aiDevEl) {
    // 设备类型下拉：注入提示词生成对应 CLI 语法的命令；记忆上次选择（非法值回落自动识别）
    let dev = 'auto';
    try { dev = localStorage.getItem(AI_DEV_KEY) || 'auto'; } catch (e) { /* ignore */ }
    if (!aiDevEl.querySelector('option[value="' + dev + '"]')) dev = 'auto';
    aiDevEl.value = dev;
  }
  if (aiKindEl) {
    // 生成类型：逐条命令 / 配置段（完整配置变更序列）；记忆上次选择
    let kind = 'cmd';
    try { kind = localStorage.getItem(AI_KIND_KEY) || 'cmd'; } catch (e) { /* ignore */ }
    if (AI_KINDS.indexOf(kind) < 0) kind = 'cmd';
    aiKindEl.value = kind;
  }
  let aiBusy = false;   // 命令生成进行中（窗口级单飞，防竞态下发）
  let aiRunSeq = 0;     // 生成轮次：取消/重发后忽略过期响应
  const setAiMode = (m) => {
    if (AI_MODES.indexOf(m) < 0) m = 'confirm';
    aiMode = m;
    try { localStorage.setItem(AI_MODE_KEY, m); } catch (e) { /* ignore */ }
    if (aiModeEl) aiModeEl.value = m;
  };
  const setAiBar = (on) => {
    if (aiBtnEl) aiBtnEl.classList.toggle('on', on);
    if (aiEl) aiEl.classList.toggle('hidden', !on);
    if (!on) hideAiResult();
    if (on && aiInputEl) aiInputEl.focus();
    // 底部条展开/收起改变终端可用高度：主动重算 fit，防 xterm 画布溢出压住条
    const a = activeSession();
    if (a) requestAnimationFrame(() => {
      try { a.s.fit.fit(); } catch (e) { /* ignore */ }
      try { window.topoShell.resize(a.id, a.s.term.cols, a.s.term.rows); } catch (e) { /* ignore */ }
    });
  };
  const hideAiResult = () => { if (!aiResultEl) return; aiResultEl.classList.add('hidden'); aiResultEl.innerHTML = ''; };
  /** 结果条渲染：notes 为 {text, err} 段落；cmds 为命令 chips（点击复制）；acts 为 {label, primary, act} 按钮 */
  const showAiResult = (notes, cmds, acts) => {
    if (!aiResultEl) return;
    aiResultEl.innerHTML = '';
    const noteEl = document.createElement('div');
    noteEl.className = 'sh-ai-note';
    for (const n of (notes || [])) {
      const seg = document.createElement('div');
      if (n.err) seg.classList.add('err');
      seg.textContent = n.text;
      noteEl.appendChild(seg);
    }
    aiResultEl.appendChild(noteEl);
    if (cmds && cmds.length) {
      const wrap = document.createElement('div');
      wrap.className = 'sh-ai-cmds';
      for (const c of cmds) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sh-ai-cmd' + (c.done ? ' done' : '');
        b.title = '点击复制：' + c.text;
        b.textContent = c.text;
        b.onclick = () => { try { window.topoShell.copyText(c.text); toast('命令已复制'); } catch (e) { /* ignore */ } };
        wrap.appendChild(b);
      }
      aiResultEl.appendChild(wrap);
    }
    if (acts && acts.length) {
      const bar = document.createElement('div');
      bar.className = 'sh-ai-acts';
      for (const a of acts) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sh-ai-act' + (a.primary ? ' primary' : '');
        b.textContent = a.label;
        b.onclick = () => { hideAiResult(); a.act && a.act(); };
        bar.appendChild(b);
      }
      aiResultEl.appendChild(bar);
    }
    aiResultEl.classList.remove('hidden');
  };
  /** 逐条下发命令到指定会话：每条追加回车，间隔 400ms 给设备处理时间；中途断开即中止 */
  const sendCommandsToSession = async (sid, cmds) => {
    let sent = 0;
    for (const c of cmds) {
      const s = sessions.get(sid);
      if (!s || s.ended) { toast('会话已断开，剩余命令未下发'); break; }
      window.topoShell.sendData(sid, c + '\r');
      recordCmd(c); // 历史命令：AI 生成并实际下发的命令进入命令面板候选
      sent++;
      if (sent < cmds.length) await new Promise((r) => setTimeout(r, 400));
    }
    return sent;
  };
  const tabName = (sid) => {
    const s = sessions.get(sid);
    const tt = s && (s.tabEl.querySelector('.tt') || {});
    return (tt.textContent || sid);
  };
  const sendAi = async () => {
    if (aiBusy) { toast('AI 正在生成命令，请等待完成或先停止'); return; }
    if (!window.topoAI || !window.topoAI.shellChat) { toast('AI 助手需要桌面版（Electron）环境'); return; }
    const a = activeSession();
    if (!a) { toast('请先连接并选中一个终端标签'); return; }
    if (a.s.ended) { toast('当前会话已断开，请先重新连接'); return; }
    const req = aiInputEl ? aiInputEl.value.trim() : '';
    if (!req) { toast('请先输入需求描述'); return; }
    const sid = a.id;
    const target = tabName(sid);
    aiBusy = true;
    const seq = ++aiRunSeq;
    if (aiSendEl) { aiSendEl.disabled = true; aiSendEl.textContent = '生成中…'; }
    // busy 结果条：带「停止」按钮（取消主进程进行中的生成请求）
    showAiResult([{ text: 'AI 正在生成命令（目标：' + target + '）…' }], [], [
      { label: '停止', act: () => { try { window.topoAI.cancel(); } catch (e) { /* ignore */ } } }
    ]);
    const ctx = (aiCtxEl && aiCtxEl.checked && a.s.term) ? readTermLines(a.s, 60).join('\n') : '';
    const deviceType = aiDevEl ? aiDevEl.value : 'auto';
    const kind = aiKindEl ? aiKindEl.value : 'cmd';
    let r;
    try { r = await window.topoAI.shellChat({ requirement: req, termContext: ctx, deviceType, kind }); }
    catch (err) { r = { ok: false, error: String((err && err.message) || err) }; }
    if (seq !== aiRunSeq) return; // 已被新一轮生成作废
    aiBusy = false;
    if (aiSendEl) { aiSendEl.disabled = false; aiSendEl.textContent = '生成'; }
    if (r && r.refused) {
      // 拒绝语义先于 !ok 判断：主进程对拒绝返回 ok:false + refused 标记
      showAiResult([{ text: 'AI 拒绝生成：' + (r.reason || '该需求无法安全执行'), err: true }], [], [
        { label: '关闭', act: () => {} }
      ]);
      return;
    }
    if (!r || !r.ok) {
      const cancelled = r && r.cancelled;
      const msg = (r && r.error) || '未知错误';
      showAiResult([{ text: cancelled ? '已取消生成' : '生成失败：' + msg, err: !cancelled }], [], [
        { label: '关闭', act: () => {} }
      ]);
      return;
    }
    const cmds = (r.commands || []).map((c) => ({ text: c }));
    if (!cmds.length) {
      showAiResult([{ text: '未能从回复中提取命令', err: true }], [], [{ label: '关闭', act: () => {} }]);
      return;
    }
    if (aiMode === 'auto') {
      const n = await sendCommandsToSession(sid, cmds.map((c) => c.text));
      showAiResult([{ text: '已直接下发 ' + n + '/' + cmds.length + ' 条命令到「' + target + '」（模式：直接执行）' }], cmds, [{ label: '关闭', act: () => {} }]);
      return;
    }
    if (aiMode === 'fill') {
      // 仅填入：只把第一条粘贴进终端（不回车）；其余命令点击复制，避免多行粘贴直接触发执行
      const s = sessions.get(sid);
      if (!s || s.ended) { toast('会话已断开'); return; }
      try { s.term.paste(cmds[0].text); } catch (e) { /* ignore */ }
      cmds[0].done = true;
      const notes = [{ text: '已把第 1 条命令填入「' + target + '」终端（未回车，检查后手动执行）' }];
      if (cmds.length > 1) notes.push({ text: '其余 ' + (cmds.length - 1) + ' 条点击复制后手动执行（多行粘贴会逐行回车，故不直接填入）：' });
      showAiResult(notes, cmds, [{ label: '复制全部', act: () => { try { window.topoShell.copyText(cmds.map((c) => c.text).join('\n')); toast('命令已复制'); } catch (e) { /* ignore */ } } }]);
      return;
    }
    // confirm（默认）：展示命令人工确认
    showAiResult(
      [{ text: 'AI 生成了 ' + cmds.length + ' 条命令（目标：' + target + '），请确认后执行：' }],
      cmds,
      [
        { label: '执行全部', primary: true, act: async () => {
            const n = await sendCommandsToSession(sid, cmds.map((c) => c.text));
            toast('已下发 ' + n + '/' + cmds.length + ' 条命令到「' + target + '」');
          } },
        { label: '复制全部', act: () => { try { window.topoShell.copyText(cmds.map((c) => c.text).join('\n')); toast('命令已复制'); } catch (e) { /* ignore */ } } },
        { label: '放弃', act: () => {} }
      ]
    );
  };

  /* ---- 通用右键菜单（items 缺省时显示终端菜单） ---- */
  function showCtx(x, y, items) {
    if (!items) {
      const a = activeSession();
      const s = a && a.s;
      const sel = s && s.term.getSelection();
      items = [
        { label: '重新连接', disabled: !s || !s.ended, act: () => reconnectNow(s) },
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
    recordCmd(b.text); // 历史命令：快捷按钮内容进入命令面板候选
    const parts = parseSendText(substituteVars(b.text, a.s.meta)); // 按当前会话设备变量替换
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
        <div class="m-sub">点击按钮把内容发送到当前会话；内容支持 \\n 回车、\\t 制表、\\p 暂停 1 秒；变量 {ip} {hostname} {port} {user} 按当前会话实际值替换。</div>
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

  /* ---- 连接书签（保存常用连接；密码经 topoSecure(DPAPI) 加密后存本机 localStorage） ---- */
  const bmBtnEl = $('#shBmBtn');
  const BM_KEY = 'topoShellBookmarks';
  const loadBookmarks = () => { try { return parseBookmarkList(localStorage.getItem(BM_KEY)); } catch (e) { return []; } };
  const saveBookmarks = (list) => { try { localStorage.setItem(BM_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ } };
  const upsertBookmark = (b) => {
    const clean = sanitizeBookmark(b);
    if (!clean) return;
    const list = loadBookmarks();
    const i = list.findIndex(x => bookmarkKey(x) === bookmarkKey(clean));
    if (i >= 0) {
      // 覆盖更新：新密文为空时保留原密文（重连未勾「记住密码」不得抹掉已存密码），名称同理
      if (!clean.passwordEnc && list[i].passwordEnc) clean.passwordEnc = list[i].passwordEnc;
      if (clean.jump && list[i].jump && list[i].jump.passwordEnc && !clean.jump.passwordEnc) clean.jump.passwordEnc = list[i].jump.passwordEnc;
      if (!clean.name && list[i].name) clean.name = list[i].name;
      list[i] = clean;
    } else list.push(clean);
    saveBookmarks(list);
  };
  async function connectBookmark(b) {
    const cfg = { protocol: b.protocol, host: b.host, port: b.port, username: b.username, encoding: b.encoding, title: b.name || b.host };
    try { const fp = localStorage.getItem('topoShellFp:' + b.host) || ''; cfg.expectFp = fp.indexOf('SHA256:') === 0 ? fp : ''; } catch (e) { cfg.expectFp = ''; }
    if (b.passwordEnc && window.topoSecure && window.topoSecure.decryptSecret) {
      try { const r = await window.topoSecure.decryptSecret(b.passwordEnc); if (r && r.ok && r.text) cfg.password = r.text; } catch (e) { /* 解密失败按无密码连接 */ }
    }
    if (b.jump) {
      cfg.jump = { host: b.jump.host, port: b.jump.port, username: b.jump.username };
      if (b.jump.passwordEnc && window.topoSecure && window.topoSecure.decryptSecret) {
        try { const r = await window.topoSecure.decryptSecret(b.jump.passwordEnc); if (r && r.ok && r.text) cfg.jump.password = r.text; } catch (e) { /* ignore */ }
      }
    }
    let res;
    try { res = await window.topoShell.connect(cfg); } catch (err) { res = { ok: false, error: String((err && err.message) || err) }; }
    if (!res || !res.ok) { toast('连接失败：' + ((res && res.error) || '未知错误')); return false; }
    return true;
  }
  async function openBookmarks() {
    const items = loadBookmarks();
    const root = $('#modalRoot');
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal sh-dialog" role="dialog" style="width:600px">
        <h3>连接书签</h3>
        <div class="m-sub">双击条目或点「连接」直接建立连接；记住的密码经系统级加密保存、使用时自动解密。</div>
        <div id="bmList" style="max-height:52vh;overflow:auto">${items.length ? '' : '<div class="bk-empty">暂无书签：新建连接时勾选「保存为书签」即可收藏常用连接</div>'}</div>
        <div class="m-actions"><button type="button" class="tb primary" data-act="close">关闭</button></div>
      </div>`;
    root.appendChild(ov);
    ov.tabIndex = -1; ov.focus();
    const close = () => ov.remove();
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    ov.querySelector('[data-act=close]').onclick = close;
    const listEl = ov.querySelector('#bmList');
    const emptyHtml = listEl.innerHTML;
    items.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'lb-file';
      row.style.cursor = 'pointer';
      row.innerHTML = `<span class="nm">${escAttr(b.name || (b.host + ':' + b.port))}</span>
        <span class="sub">${escAttr(b.protocol.toUpperCase() + ' ' + b.host + ':' + b.port + ' · ' + b.username + (b.encoding === 'gbk' ? ' · GBK' : '') + (b.jump ? ' · 经跳板' : '') + (b.passwordEnc ? ' · 已存密码' : ''))}</span>
        <button type="button" class="tb sh-bm-edit" title="在连接对话框中编辑">编辑</button>
        <button type="button" class="tb trust-del sh-bm-del" title="删除书签">删除</button>`;
      row.onclick = (e) => {
        if (e.target.closest('.sh-bm-del') || e.target.closest('.sh-bm-edit')) return;
        close();
        connectBookmark(b);
      };
      row.querySelector('.sh-bm-edit').onclick = (e) => { e.stopPropagation(); close(); openConnectDialog(b); };
      row.querySelector('.sh-bm-del').onclick = (e) => {
        e.stopPropagation();
        const list = loadBookmarks();
        const idx = list.findIndex(x => bookmarkKey(x) === bookmarkKey(b));
        if (idx >= 0) {
          list.splice(idx, 1);
          saveBookmarks(list);
          row.remove();
          if (!listEl.querySelector('.lb-file')) listEl.innerHTML = emptyHtml;
          toast('已删除书签');
        }
      };
      listEl.appendChild(row);
    });
  }

  /* ---- 标签恢复（窗口重开后自动重连上次的连接；凭据为 DPAPI 密文，仅本机当前用户可解密） ---- */
  const RESTORE_KEY = 'topoShellRestore';
  const RESTORE_CAP = 24;
  const loadRestoreList = () => { try { return parseBookmarkList(localStorage.getItem(RESTORE_KEY)).slice(0, RESTORE_CAP); } catch (e) { return []; } };
  const saveRestoreList = (list) => { try { localStorage.setItem(RESTORE_KEY, JSON.stringify(list.slice(0, RESTORE_CAP))); } catch (e) { /* ignore */ } };
  const removeRestoreEntry = (meta) => {
    saveRestoreList(loadRestoreList().filter(x => bookmarkKey(x) !== bookmarkKey(meta)));
  };
  /** 连接建立时登记恢复条目：密文优先取连接透传的 pwdEnc，其次回填同名书签已存的密文 */
  const upsertRestore = (info) => {
    if (!info || !info.host) return;
    const keyProbe = { protocol: info.protocol, host: info.host, port: info.port, username: info.username };
    const bm = loadBookmarks().find(x => bookmarkKey(x) === bookmarkKey(keyProbe));
    const jumpMeta = (info.jump && info.jump.host) ? { host: info.jump.host, port: info.jump.port, username: info.jump.username } : (bm && bm.jump && bm.jump.host ? { host: bm.jump.host, port: bm.jump.port, username: bm.jump.username } : null);
    saveRestoreList(upsertRestoreEntry(loadRestoreList(), {
      protocol: info.protocol, host: info.host, port: info.port, username: info.username,
      encoding: info.encoding || 'utf8',
      name: info.deviceName || '',
      passwordEnc: info.pwdEnc || (bm ? bm.passwordEnc : ''),
      jump: jumpMeta ? Object.assign(jumpMeta, { passwordEnc: info.jumpPwdEnc || (bm && bm.jump ? bm.jump.passwordEnc : '') }) : null
    }, RESTORE_CAP));
  };
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  /** 窗口打开时恢复上次的连接：逐个错峰发起（300ms），避免多台设备同时握手 */
  async function restoreAtStartup() {
    const list = loadRestoreList();
    if (!list.length) return;
    toast('正在恢复上次的 ' + list.length + ' 个连接…');
    let okc = 0;
    for (const entry of list) {
      try { if (await connectBookmark(entry)) okc++; } catch (e) { /* 单个失败不影响其余 */ }
      await sleepMs(300);
    }
    if (sessions.size) toast('已恢复 ' + okc + '/' + list.length + ' 个连接（关闭标签即不再恢复）');
  }

  /* ---- 快速命令面板（Ctrl+P）：快捷按钮 / 连接书签 / 历史命令，模糊搜索回车执行 ---- */
  const CMDH_KEY = 'topoShellCmdHistory';
  const CMDH_CAP = 60;
  let cmdHistory = (() => {
    try {
      const a = JSON.parse(localStorage.getItem(CMDH_KEY) || '[]');
      return Array.isArray(a) ? a.filter(x => x && typeof x.text === 'string' && x.text).slice(0, CMDH_CAP) : [];
    } catch (e) { return []; }
  })();
  const saveCmdHistory = () => { try { localStorage.setItem(CMDH_KEY, JSON.stringify(cmdHistory)); } catch (e) { /* ignore */ } };
  const recordCmd = (text) => { cmdHistory = mergeCmdHistory(cmdHistory, text, CMDH_CAP); saveCmdHistory(); };
  const palEl = $('#shPal'), palInputEl = $('#shPalInput'), palListEl = $('#shPalList');
  let palItems = [], palSel = 0;
  /** 发送原始文本到当前会话（面板「命令」项执行入口，与快捷按钮同通道） */
  const sendTextToActive = async (text) => {
    const a = activeSession();
    if (!a) { toast('当前没有活动会话'); return; }
    if (a.s.ended) { toast('会话已结束'); return; }
    const parts = parseSendText(substituteVars(text, a.s.meta));
    parts.push({ type: 'text', data: '\r' });
    for (const p of parts) {
      if (a.s.ended) return;
      if (p.type === 'pause') await sleepMs(p.ms);
      else window.topoShell.sendData(a.id, p.data);
    }
  };
  const buildPaletteItems = () => {
    const btns = buttons.map(b => ({ cat: '按钮', label: b.label || String(b.text).split(/\r?\n/)[0].slice(0, 32), sub: b.text, act: () => sendBtn(b) }));
    const bms = loadBookmarks().map(b => ({ cat: '书签', label: b.name || (b.host + ':' + b.port), sub: b.protocol.toUpperCase() + ' ' + b.host + ':' + b.port + ' · ' + b.username + (b.encoding === 'gbk' ? ' · GBK' : ''), act: () => connectBookmark(b) }));
    const cmds = cmdHistory.slice(0, 20).map(h => ({ cat: '命令', label: h.text, sub: '已用 ' + h.n + ' 次', act: () => sendTextToActive(h.text) }));
    return btns.concat(bms, cmds);
  };
  const renderPalList = () => {
    if (!palListEl) return;
    if (!palItems.length) {
      palListEl.innerHTML = '<div class="sh-pal-empty">无匹配项：输入关键字搜索快捷按钮 / 书签 / 历史命令</div>';
      return;
    }
    palSel = Math.max(0, Math.min(palSel, palItems.length - 1));
    palListEl.innerHTML = palItems.map((it, i) => `
      <div class="sh-pal-item${i === palSel ? ' sel' : ''}" data-i="${i}">
        <span class="sh-pal-cat c-${it.cat === '按钮' ? 'btn' : it.cat === '书签' ? 'bm' : 'cmd'}">${it.cat}</span>
        <span class="sh-pal-label">${escAttr(it.label)}</span>
        <span class="sh-pal-sub">${escAttr(it.sub || '')}</span>
      </div>`).join('');
    const sel = palListEl.querySelector('.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    palListEl.querySelectorAll('.sh-pal-item').forEach(el => {
      el.onclick = () => { palSel = parseInt(el.dataset.i, 10) || 0; executePal(); };
      el.onpointerenter = () => { palSel = parseInt(el.dataset.i, 10) || 0; palListEl.querySelectorAll('.sh-pal-item.sel').forEach(x => x.classList.remove('sel')); el.classList.add('sel'); };
    });
  };
  const renderPal = () => {
    const all = buildPaletteItems();
    const q = palInputEl ? palInputEl.value.trim() : '';
    if (!q) { palItems = all.slice(0, 30); }
    else {
      palItems = all.map(it => {
        const s1 = fuzzyScore(q, it.label), s2 = fuzzyScore(q, it.sub || '');
        const sc = (s1 != null ? s1 : (s2 != null ? s2 - 40 : null));
        return { it, sc };
      }).filter(x => x.sc != null).sort((a, b) => b.sc - a.sc).slice(0, 30).map(x => x.it);
    }
    palSel = 0;
    renderPalList();
  };
  const openPal = () => {
    if (!palEl) return;
    palEl.classList.remove('hidden');
    if (palInputEl) { palInputEl.value = ''; renderPal(); setTimeout(() => { if (palInputEl) palInputEl.focus(); }, 30); }
  };
  const closePal = () => {
    if (!palEl) return;
    palEl.classList.add('hidden');
    const a = activeSession();
    if (a && a.s.term) { try { a.s.term.focus(); } catch (e) { /* ignore */ } }
  };
  const executePal = () => {
    const it = palItems[palSel];
    closePal();
    if (it && it.act) setTimeout(() => { it.act(); }, 60);
  };
  function wirePalette() {
    if (!palEl) return;
    palEl.addEventListener('pointerdown', (e) => { if (e.target === palEl) closePal(); });
    if (palInputEl) {
      palInputEl.addEventListener('input', renderPal);
      palInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palSel + 1, palItems.length - 1); renderPalList(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(palSel - 1, 0); renderPalList(); }
        else if (e.key === 'Enter') { e.preventDefault(); executePal(); }
        else if (e.key === 'Escape') { e.stopPropagation(); closePal(); }
      });
    }
  }

  /* ---- 新建连接对话框（窗口内直接发起连接） ---- */
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('topoShellCfg') || 'null'); } catch (e) { saved = null; }
  saved = saved || {};
  function openConnectDialog(prefill) {
    prefill = (prefill && typeof prefill === 'object') ? sanitizeBookmark(prefill) : null;
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
        <div class="frow">
          <label>输出编码</label>
          <select id="wsEnc">
            <option value="utf8"${(saved.encoding || 'utf8') === 'utf8' ? ' selected' : ''}>UTF-8（默认）</option>
            <option value="gbk"${saved.encoding === 'gbk' ? ' selected' : ''}>GBK（老设备 / 中文环境）</option>
          </select>
        </div>
        <div class="frow"><div class="frow-inline">
          <div class="frow"><label>端口</label><input id="wsPort" type="number" min="1" max="65535"/></div>
          <div class="frow"><label>用户名</label><input id="wsUser" type="text" placeholder="admin" value="${escAttr(saved.username || 'admin')}" autocomplete="off"/></div>
        </div></div>
        <div class="frow">
          <label>密码</label>
          <input id="wsPass" type="password" placeholder="SSH 密码；Telnet 通常可留空" autocomplete="new-password"/>
        </div>
        <div class="frow"><label style="display:flex;align-items:center;gap:6px"><input id="wsJumpOn" type="checkbox"/> 经跳板机连接（仅 SSH 目标生效）</label></div>
        <div class="frow" id="wsJumpWrap" style="display:none"><div class="frow-inline">
          <div class="frow"><label>跳板地址</label><input id="wsJumpHost" type="text" placeholder="堡垒机/跳板 IP" autocomplete="off"/></div>
          <div class="frow"><label>跳板端口</label><input id="wsJumpPort" type="number" min="1" max="65535" placeholder="22"/></div>
          <div class="frow"><label>跳板用户名</label><input id="wsJumpUser" type="text" placeholder="admin" autocomplete="off"/></div>
          <div class="frow"><label>跳板密码</label><input id="wsJumpPass" type="password" autocomplete="new-password"/></div>
        </div></div>
        <div class="frow"><div class="frow-inline">
          <label style="display:flex;align-items:center;gap:6px"><input id="wsSaveBm" type="checkbox"/> 保存为书签</label>
          <label style="display:flex;align-items:center;gap:6px" title="密码经系统级加密（DPAPI）保存在本机，仅本机当前用户可解密"><input id="wsRememberPwd" type="checkbox"/> 记住密码</label>
        </div></div>
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
    // 书签预填（「编辑书签」入口）：填充连接参数并尝试解密已存密码
    if (prefill) {
      ov.querySelector('#wsProto').value = prefill.protocol;
      ov.querySelector('#wsHost').value = prefill.host;
      ov.querySelector('#wsPort').value = prefill.port;
      ov.querySelector('#wsUser').value = prefill.username;
      ov.querySelector('#wsEnc').value = prefill.encoding;
      if (prefill.jump && prefill.jump.host) {
        ov.querySelector('#wsJumpOn').checked = true;
        ov.querySelector('#wsJumpWrap').style.display = '';
        ov.querySelector('#wsJumpHost').value = prefill.jump.host;
        ov.querySelector('#wsJumpPort').value = prefill.jump.port;
        ov.querySelector('#wsJumpUser').value = prefill.jump.username;
      }
      if (prefill.passwordEnc && window.topoSecure && window.topoSecure.decryptSecret) {
        window.topoSecure.decryptSecret(prefill.passwordEnc).then((r) => {
          if (r && r.ok && r.text && document.body.contains(ov)) ov.querySelector('#wsPass').value = r.text;
        }).catch(() => { /* ignore */ });
      }
    }
    const protoEl = ov.querySelector('#wsProto');
    const portEl = ov.querySelector('#wsPort');
    const autoPort = () => protoEl.value === 'telnet' ? '23' : '22';
    protoEl.addEventListener('change', () => {
      const cur = portEl.value.trim();
      const otherDefault = autoPort() === '23' ? '22' : '23';
      if (!cur || cur === otherDefault) portEl.value = autoPort();
    });
    if (!portEl.value.trim()) portEl.value = autoPort();
    const jumpOnEl = ov.querySelector('#wsJumpOn');
    jumpOnEl.addEventListener('change', () => { ov.querySelector('#wsJumpWrap').style.display = jumpOnEl.checked ? '' : 'none'; });
    const doConnect = async () => {
      const cfg = {
        protocol: protoEl.value,
        host: ov.querySelector('#wsHost').value.trim(),
        port: ov.querySelector('#wsPort').value.trim(),
        username: ov.querySelector('#wsUser').value.trim(),
        password: ov.querySelector('#wsPass').value,
        encoding: ov.querySelector('#wsEnc').value === 'gbk' ? 'gbk' : 'utf8',
        title: ov.querySelector('#wsHost').value.trim() || '连接'
      };
      if (cfg.protocol === 'ssh' && jumpOnEl.checked && ov.querySelector('#wsJumpHost').value.trim()) {
        cfg.jump = {
          host: ov.querySelector('#wsJumpHost').value.trim(),
          port: ov.querySelector('#wsJumpPort').value.trim(),
          username: ov.querySelector('#wsJumpUser').value.trim(),
          password: ov.querySelector('#wsJumpPass').value
        };
      }
      try { const fp = localStorage.getItem('topoShellFp:' + cfg.host) || ''; cfg.expectFp = fp.indexOf('SHA256:') === 0 ? fp : ''; } catch (e) { cfg.expectFp = ''; }
      if (!cfg.host) { toast('请填写主机地址（管理口 IP）'); return; }
      // 标签恢复登记用：密码加密为 DPAPI 密文随建连参数透传（明文不落盘）
      try {
        if (cfg.password && window.topoSecure && window.topoSecure.encryptSecret) {
          const r = await window.topoSecure.encryptSecret(cfg.password);
          if (r && r.ok && r.cipher) cfg.pwdEnc = r.cipher;
        }
        if (cfg.jump && cfg.jump.password && window.topoSecure && window.topoSecure.encryptSecret) {
          const rj = await window.topoSecure.encryptSecret(cfg.jump.password);
          if (rj && rj.ok && rj.cipher) cfg.jumpPwdEnc = rj.cipher;
        }
      } catch (e) { /* 加密失败仅影响恢复列表 */ }
      try { localStorage.setItem('topoShellCfg', JSON.stringify({ protocol: cfg.protocol, port: cfg.port, username: cfg.username, encoding: cfg.encoding })); } catch (e) {}
      // 保存为书签（同键覆盖；勾选「记住密码」时密码经 DPAPI 加密后保存）
      if (ov.querySelector('#wsSaveBm').checked) {
        const bm = { protocol: cfg.protocol, host: cfg.host, port: cfg.port, username: cfg.username, encoding: cfg.encoding, name: prefill ? prefill.name : '' };
        if (cfg.jump) bm.jump = { host: cfg.jump.host, port: cfg.jump.port, username: cfg.jump.username };
        if (ov.querySelector('#wsRememberPwd').checked && cfg.password && window.topoSecure && window.topoSecure.encryptSecret) {
          try {
            const r = await window.topoSecure.encryptSecret(cfg.password);
            if (r && r.ok && r.cipher) bm.passwordEnc = r.cipher;
            else toast('系统加密不可用，书签不保存密码');
            if (cfg.jump && cfg.jump.password && bm.jump) {
              const rj = await window.topoSecure.encryptSecret(cfg.jump.password);
              if (rj && rj.ok && rj.cipher) bm.jump.passwordEnc = rj.cipher;
            }
          } catch (e) { /* ignore */ }
        }
        upsertBookmark(bm);
      }
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

    // 多标签命令广播
    if (castBtnEl) castBtnEl.onclick = () => setCastMode(!castMode);
    if (castSendEl) castSendEl.onclick = sendCast;
    if (castDiffEl) castDiffEl.onclick = openCastDiff;
    if (castInputEl) castInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendCast(); }
    });

    // SFTP 文件面板
    wireSftp();

    // 终端搜索
    wireSearch();

    // 快速命令面板
    wirePalette();

    // 连接书签
    if (bmBtnEl) bmBtnEl.onclick = openBookmarks;

    // AI 命令助手
    if (aiBtnEl) aiBtnEl.onclick = () => setAiBar(aiEl.classList.contains('hidden'));
    if (aiModeEl) aiModeEl.addEventListener('change', () => setAiMode(aiModeEl.value));
    if (aiDevEl) aiDevEl.addEventListener('change', () => { try { localStorage.setItem(AI_DEV_KEY, aiDevEl.value); } catch (e) { /* ignore */ } });
    if (aiKindEl) aiKindEl.addEventListener('change', () => { try { localStorage.setItem(AI_KIND_KEY, aiKindEl.value); } catch (e) { /* ignore */ } });
    if (aiSendEl) aiSendEl.onclick = sendAi;
    if (aiInputEl) aiInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendAi(); }
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
      if ((e.ctrlKey || e.metaKey) && k === 'f') { e.preventDefault(); setSearchOpen(true); return; } // 终端搜索
      if ((e.ctrlKey || e.metaKey) && k === 'p') { e.preventDefault(); if (palEl && !palEl.classList.contains('hidden')) closePal(); else openPal(); return; } // 快速命令面板
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
    // 标签恢复：窗口打开后自动重连上次的连接（错峰发起）
    restoreAtStartup();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
