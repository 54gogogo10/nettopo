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
(function () {
  if (typeof module !== 'undefined' && module.exports) { module.exports = { diffSessionOutputs, parseRecording }; return; } // Node 测试直取纯函数
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
    term.open(termEl);
    const rec = { tabEl, wrapEl, term, fit, dotEl: tabEl.querySelector('.dot'), castEl: tabEl.querySelector('.cast'), ended: false, buf: [], rcBar, rcReason, rcBtn,
      meta: { host: info.host || '', port: info.port || '', username: info.username || '', deviceName: info.deviceName || '', protocol: info.protocol || '' } };
    rcBtn.addEventListener('click', (e) => { e.stopPropagation(); reconnectNow(rec); });
    sessions.set(sid, rec);
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
    // 始终通知主进程关闭：活动会话关闭连接；已结束会话清理其建连参数（防内存留凭据副本）
    window.topoShell.close(sid);
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
        <div class="frow"><label style="display:flex;align-items:center;gap:6px"><input id="wsJumpOn" type="checkbox"/> 经跳板机连接（仅 SSH 目标生效）</label></div>
        <div class="frow" id="wsJumpWrap" style="display:none"><div class="frow-inline">
          <div class="frow"><label>跳板地址</label><input id="wsJumpHost" type="text" placeholder="堡垒机/跳板 IP" autocomplete="off"/></div>
          <div class="frow"><label>跳板端口</label><input id="wsJumpPort" type="number" min="1" max="65535" placeholder="22"/></div>
          <div class="frow"><label>跳板用户名</label><input id="wsJumpUser" type="text" placeholder="admin" autocomplete="off"/></div>
          <div class="frow"><label>跳板密码</label><input id="wsJumpPass" type="password" autocomplete="new-password"/></div>
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

    // 多标签命令广播
    if (castBtnEl) castBtnEl.onclick = () => setCastMode(!castMode);
    if (castSendEl) castSendEl.onclick = sendCast;
    if (castDiffEl) castDiffEl.onclick = openCastDiff;
    if (castInputEl) castInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendCast(); }
    });

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
