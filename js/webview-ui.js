/* NetTopo 设备管理页窗口 —— 多标签内嵌浏览器 */
'use strict';
(function () {
  if (!window.topoWeb) return; // 非 Electron 环境直接退出
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const tabsEl = $('#wvTabs'), pagesEl = $('#wvPages'), emptyEl = $('#wvEmpty');
  const navEl = $('#wvNav'), addrEl = $('#wvAddr'), backEl = $('#wvBack'), fwdEl = $('#wvFwd'), reloadEl = $('#wvReload');
  const tabs = new Map(); // id -> { tabEl, pageEl, wv, spinEl, titleEl }
  let seq = 0;

  const normUrl = (u) => {
    u = String(u || '').trim();
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    return u;
  };
  const active = () => { for (const [id, t] of tabs) if (t.tabEl.classList.contains('active')) return id; return null; };

  function showErr(rec, msg) {
    let err = rec.pageEl.querySelector('.wv-err');
    if (!err) { err = document.createElement('div'); err.className = 'wv-err'; rec.pageEl.appendChild(err); }
    err.innerHTML = '<b>页面加载失败</b><span>' + (msg || '未知错误') + '</span><span style="font-size:11px">点击「刷新」或检查设备管理页地址</span>';
  }
  function clearErr(rec) { const err = rec.pageEl.querySelector('.wv-err'); if (err) err.remove(); }

  function addTab(info) {
    info = info || {};
    const url = normUrl(info.url);
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
    pageEl.appendChild(wv);
    pagesEl.appendChild(pageEl);
    tabsEl.appendChild(tabEl);
    const rec = { tabEl, pageEl, wv, spinEl: tabEl.querySelector('.spin'), titleEl: tabEl.querySelector('.tt'), loading: true };
    tabs.set(id, rec);

    wv.addEventListener('page-title-updated', (e) => { rec.titleEl.textContent = e.title || rec.titleEl.textContent; });
    wv.addEventListener('did-start-loading', () => { rec.loading = true; rec.spinEl.style.display = ''; });
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
      close();
      addTab({ url: normUrl(v) });
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
    $('#wvNew').onclick = openUrlDialog;
    $('#wvEmptyNew').onclick = openUrlDialog;
    $('#wvAddrForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = active();
      if (!id) return;
      const t = tabs.get(id);
      try { t.wv.loadURL(normUrl(addrEl.value)); } catch (err) { toast('地址无效'); }
      t.wv.focus();
    });
    backEl.onclick = () => { const id = active(); if (id) { try { tabs.get(id).wv.goBack(); } catch (e) {} } };
    fwdEl.onclick = () => { const id = active(); if (id) { try { tabs.get(id).wv.goForward(); } catch (e) {} } };
    reloadEl.onclick = () => { const id = active(); if (id) { try { tabs.get(id).wv.reload(); } catch (e) {} } };
    if (tabs.size === 0) emptyEl.classList.remove('hidden');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
