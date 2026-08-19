/* NetTopo 设备管理页窗口 —— 多标签内嵌浏览器 */
'use strict';
(function () {
  if (!window.topoWeb) return; // 非 Electron 环境直接退出
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const escAttr = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tabsEl = $('#wvTabs'), pagesEl = $('#wvPages'), emptyEl = $('#wvEmpty');
  const navEl = $('#wvNav'), addrEl = $('#wvAddr'), backEl = $('#wvBack'), fwdEl = $('#wvFwd'), reloadEl = $('#wvReload');
  const tabs = new Map(); // id -> { tabEl, pageEl, wv, spinEl, titleEl }
  let seq = 0;

  // URL 规范化：与 TopoUtil.normalizeWebUrl 单一实现收敛——仅放行 http(s)，无协议自动补 http://，危险协议返回 null
  const normUrl = (u) => {
    u = String(u || '').trim();
    if (!u) return null;
    return TopoUtil.normalizeWebUrl(u);
  };
  /* ---- 页面显示缩放（0.6~2.0，本机记忆） ---- */
  const ZOOM_KEY = 'webviewZoom';
  let pageZoom = (() => {
    try { const v = parseFloat(localStorage.getItem(ZOOM_KEY)); return Number.isFinite(v) ? Math.max(0.6, Math.min(2, v)) : 1; }
    catch (e) { return 1; }
  })();
  const zoomValEl = $('#wvZoomVal');
  const applyZoom = (wv) => {
    try { const wc = wv.getWebContents(); if (wc && wc.setZoomFactor) wc.setZoomFactor(pageZoom); } catch (e) { /* 未就绪时忽略 */ }
  };
  const setPageZoom = (delta) => {
    pageZoom = Math.max(0.6, Math.min(2, Math.round((pageZoom + delta) * 100) / 100));
    try { localStorage.setItem(ZOOM_KEY, String(pageZoom)); } catch (e) { /* ignore */ }
    if (zoomValEl) zoomValEl.textContent = Math.round(pageZoom * 100) + '%';
    const id = active();
    if (id) applyZoom(tabs.get(id).wv);
  };
  const active = () => { for (const [id, t] of tabs) if (t.tabEl.classList.contains('active')) return id; return null; };

  function showErr(rec, msg) {
    let err = rec.pageEl.querySelector('.wv-err');
    if (!err) { err = document.createElement('div'); err.className = 'wv-err'; rec.pageEl.appendChild(err); }
    err.innerHTML = '<b>页面加载失败</b><span>' + escAttr(msg || '未知错误') + '</span><span style="font-size:11px">点击「刷新」或检查设备管理页地址</span>';
  }
  function clearErr(rec) { const err = rec.pageEl.querySelector('.wv-err'); if (err) err.remove(); }

  function addTab(info) {
    info = info || {};
    const url = normUrl(info.url);
    if (!url) { toast('仅支持 http:// 或 https:// 地址'); return; } // 危险协议（javascript:/file: 等）拒绝
    emptyEl.classList.add('hidden');
    navEl.classList.remove('hidden');
    const id = 'w' + (++seq);
    const tabEl = document.createElement('div');
    tabEl.className = 'wv-tab';
    tabEl.innerHTML = '<span class="spin" style="display:none"></span><span class="tt"></span><span class="x" title="关闭页面">×</span>';
    tabEl.querySelector('.tt').textContent = info.title || url;
    tabEl.title = url;
    const pageEl = document.createElement('div');
    pageEl.className = 'wv-page';
    const wv = document.createElement('webview');
    wv.setAttribute('src', url);
    wv.setAttribute('partition', 'persist:nettopo-web');
    wv.setAttribute('allowpopups', ''); // 允许弹窗（主进程 did-attach-webview / 渲染层 setWindowOpenHandler 转为本窗口标签）
    pageEl.appendChild(wv);
    pagesEl.appendChild(pageEl);
    tabsEl.appendChild(tabEl);
    const rec = { tabEl, pageEl, wv, spinEl: tabEl.querySelector('.spin'), titleEl: tabEl.querySelector('.tt'), loading: true };
    tabs.set(id, rec);

    wv.addEventListener('page-title-updated', (e) => { rec.titleEl.textContent = e.title || rec.titleEl.textContent; });
    wv.addEventListener('dom-ready', () => {
      // 兼容性：覆盖 alert/confirm/prompt，避免设备管理页弹窗等待导致页面卡死（用元素方法，随时可用）
      try {
        wv.executeJavaScript(`(() => {
          try {
            const log = (t, m) => { try { console.log('[webview:' + t + '] ' + String(m == null ? '' : m).slice(0, 300)); } catch (e) {} };
            window.alert = (m) => log('alert', m);
            window.confirm = (m) => { log('confirm', m); return true; };
            window.prompt = (m, d) => { log('prompt', m); return d == null ? '' : String(d); };
          } catch (e) {}
        })()`).catch(() => {});
      } catch (e) { /* ignore */ }
      applyZoom(wv);
      // window.open 兜底：guest webContents 可能稍后才可获取，做几次重试
      let tries = 0;
      const install = () => {
        try {
          const wc = wv.getWebContents();
          if (wc && wc.setWindowOpenHandler) {
            wc.setWindowOpenHandler(({ url }) => {
              // 仅放行 http/https，避免弹出 file:/javascript: 等危险地址
              if (/^https?:\/\//i.test(url)) addTab({ url });
              return { action: 'deny' };
            });
            return;
          }
        } catch (e) { /* ignore */ }
        if (++tries < 10) setTimeout(install, 100);
      };
      install();
    });
    wv.addEventListener('did-start-loading', () => { rec.loading = true; rec.spinEl.style.display = ''; clearErr(rec); });
    wv.addEventListener('did-stop-loading', () => { rec.loading = false; rec.spinEl.style.display = 'none'; });
    wv.addEventListener('did-fail-load', (e) => { if (e.errorCode !== -3) showErr(rec, e.errorDescription); });
    wv.addEventListener('did-navigate', (e) => {
      rec.tabEl.title = e.url;
      if (active() === id) { addrEl.value = e.url; updateNavBtns(); }
    });
    wv.addEventListener('did-navigate-in-page', (e) => { if (active() === id) { addrEl.value = e.url; updateNavBtns(); } });

    tabEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.target.classList.contains('x')) { closeTab(id); return; }
      activate(id);
    });
    activate(id);
    return rec;
  }

  function activate(id) {
    for (const [tid, t] of tabs) {
      const on = tid === id;
      t.tabEl.classList.toggle('active', on);
      t.pageEl.classList.toggle('active', on);
      if (on) {
        try { addrEl.value = t.wv.getURL() || t.wv.getAttribute('src'); } catch (e) { addrEl.value = t.wv.getAttribute('src') || ''; }
        updateNavBtns();
      }
    }
  }

  function updateNavBtns() {
    const t = active() != null ? tabs.get(active()) : null;
    const wv = t && t.wv;
    let canB = false, canF = false;
    try { canB = wv ? wv.canGoBack() : false; canF = wv ? wv.canGoForward() : false; } catch (e) { /* ignore */ }
    backEl.disabled = !canB;
    fwdEl.disabled = !canF;
  }

  function closeTab(id) {
    const t = tabs.get(id);
    if (!t) return;
    t.tabEl.remove();
    t.pageEl.remove();
    tabs.delete(id);
    if (tabs.size === 0) {
      emptyEl.classList.remove('hidden');
      navEl.classList.add('hidden');
    } else {
      activate([...tabs.keys()][0]);
    }
  }

  /* ---- 证书安全告警（自签名/无效证书，手动允许） ---- */
  const certQueueAlerts = [];
  function showCertAlert(info) {
    if ($('#certModal')) { certQueueAlerts.push(info); return; }
    const root = $('#modalRoot');
    const ov = document.createElement('div');
    ov.id = 'certModal';
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal" role="dialog" style="width:480px">
        <h3>安全告警 · 证书不受信任</h3>
        <div class="m-sub">该页面使用的 HTTPS 证书未被系统信任（自签名或已过期/无效）。请确认站点身份后再继续。</div>
        <div class="frow"><label>站点</label><span style="font:12px/1.6 Consolas,monospace;color:var(--text);word-break:break-all">${escAttr(info.host || '')}</span></div>
        <div class="frow"><label>网址</label><span style="font:12px/1.6 Consolas,monospace;color:var(--text);word-break:break-all">${escAttr(info.url || '')}</span></div>
        <div class="frow"><label>错误</label><span style="color:var(--danger);font-size:12px">${escAttr(info.error || '')}</span></div>
        <div class="frow"><label style="display:flex;align-items:center;gap:6px"><input id="certRemember" type="checkbox"/> 本次运行内记住该站点，不再询问</label></div>
        <div class="m-actions">
          <button type="button" class="tb" data-act="cancel">取消</button>
          <button type="button" class="tb primary" data-act="continue">继续访问</button>
        </div>
      </div>`;
    root.appendChild(ov);
    ov.tabIndex = -1; ov.focus();
    const next = () => { ov.remove(); if (certQueueAlerts.length) showCertAlert(certQueueAlerts.shift()); };
    const decide = (allow) => {
      let remember = false;
      try { remember = ov.querySelector('#certRemember').checked; } catch (e) { /* ignore */ }
      window.topoWeb.allowCert({ id: info.id, allow, remember });
      next();
    };
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) decide(false); });
    ov.querySelector('[data-act=cancel]').onclick = () => decide(false);
    ov.querySelector('[data-act=continue]').onclick = () => decide(true);
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); decide(false); } });
  }

  function openUrlDialog() {
    const root = $('#modalRoot');
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal wv-dialog" role="dialog">
        <h3>打开网页</h3>
        <div class="m-sub">输入设备管理 Web 页地址（http:// 或 https://）。</div>
        <div class="frow"><label>网址</label><input id="wvUrl" type="text" placeholder="例如 http://10.255.0.1"/></div>
        <div class="m-actions">
          <button type="button" class="tb" data-act="cancel">取消</button>
          <button type="button" class="tb primary" data-act="open">打开</button>
        </div>
      </div>`;
    root.appendChild(ov);
    ov.tabIndex = -1; ov.focus();
    const close = () => ov.remove();
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
    ov.querySelector('[data-act=cancel]').onclick = close;
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    const doOpen = () => {
      const v = ov.querySelector('#wvUrl').value.trim();
      if (!v) { toast('请输入网址'); return; }
      const u = TopoUtil.normalizeWebUrl(v);
      if (!u) { toast('仅支持 http:// 或 https:// 地址'); return; }
      close();
      addTab({ url: u });
    };
    ov.querySelector('[data-act=open]').onclick = doOpen;
    ov.querySelector('#wvUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doOpen(); } });
    setTimeout(() => { if (document.body.contains(ov)) ov.querySelector('#wvUrl').focus(); }, 250);
  }

  function toast(msg) {
    let t = $('#wvToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'wvToast';
      t.style.cssText = 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:200;background:var(--tooltip-bg);color:var(--tooltip-tx);padding:9px 18px;border-radius:10px;font-size:12.5px;box-shadow:0 10px 30px rgba(0,0,0,.3);transition:opacity .3s;max-width:70vw;pointer-events:none';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.opacity = '0'; }, 2600);
  }

  function init() {
    window.topoWeb.onNewTab((info) => addTab(info));
    window.topoWeb.onCertError((info) => showCertAlert(info));
    $('#wvNew').onclick = openUrlDialog;
    $('#wvEmptyNew').onclick = openUrlDialog;
    $('#wvAddrForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = active();
      if (!id) return;
      const t = tabs.get(id);
      const u = TopoUtil.normalizeWebUrl(addrEl.value);
      if (!u) { toast('仅支持 http:// 或 https:// 地址'); return; }
      try { t.wv.loadURL(u); } catch (err) { toast('地址无效'); }
      t.wv.focus();
    });
    if (zoomValEl) zoomValEl.textContent = Math.round(pageZoom * 100) + '%';
    if ($('#wvZoomIn')) $('#wvZoomIn').onclick = () => setPageZoom(0.1);
    if ($('#wvZoomOut')) $('#wvZoomOut').onclick = () => setPageZoom(-0.1);
    document.addEventListener('keydown', (e) => {
      if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#modalRoot')) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_')) { e.preventDefault(); setPageZoom(-0.1); }
      if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); setPageZoom(0.1); }
    });
    backEl.onclick = () => { const id = active(); if (id) { try { tabs.get(id).wv.goBack(); } catch (e) {} } };
    fwdEl.onclick = () => { const id = active(); if (id) { try { tabs.get(id).wv.goForward(); } catch (e) {} } };
    reloadEl.onclick = () => { const id = active(); if (id) { try { tabs.get(id).wv.reload(); } catch (e) {} } };
    if (tabs.size === 0) emptyEl.classList.remove('hidden');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
