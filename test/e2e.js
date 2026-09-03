/* NetTopo e2e：无头 Chrome 加载页面、自动载入示例、截图并收集控制台错误 */
'use strict';
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

/* Chrome 探测：优先环境变量 NETTOPO_CHROME / CHROME_BIN，再按平台找常见安装位置
 * （兼容本机 Windows 与 Linux CI runner） */
function findChrome() {
  if (process.env.NETTOPO_CHROME) return process.env.NETTOPO_CHROME;
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates = process.platform === 'win32' ? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ] : [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ];
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch (e) { /* ignore */ } }
  return null;
}

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error('未找到 Chrome：请安装或用 NETTOPO_CHROME 环境变量指定路径'); process.exit(1); }
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--window-size=1680,950']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 950 });

  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  page.on('requestfailed', r => errors.push('[reqfail] ' + r.url() + ' ' + (r.failure() || {}).errorText));

  const pageUrl = 'file:///' + path.join(__dirname, 'e2e.html').replace(/\\/g, '/');
  await page.goto(pageUrl, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => localStorage.removeItem('nettopo.graph')); // 首次清除，刷新时保留
  const hasHook = await page.evaluate(() => !!window.__topo);
  console.log('__topo 钩子存在:', hasHook);
  if (!hasHook) { console.log('控制台错误:\n' + errors.join('\n')); await browser.close(); process.exit(1); }

  // 避免 confirm 弹窗阻塞
  await page.evaluate(() => { window.confirm = () => true; });

  // 空状态截图
  await page.screenshot({ path: 'shot_empty.png' });

  // 载入示例
  await page.evaluate(() => window.__topo.loadSample());
  await new Promise(r => setTimeout(r, 1600)); // 等布局动画

  // 画布内容断言
  const stats = await page.evaluate(() => ({
    nodes: document.querySelectorAll('.node').length,
    links: document.querySelectorAll('.link').length,
    // 回归：连线必须真实落位（非 (0,0) 剩余）；渲染层 update() 若中途抛错，连线会全部停在原点不可见。
    // 直角布线改版后连线元素统一为 SVGGeometryElement（path/line 兼容），用 getTotalLength 判定
    visibleLinks: [...document.querySelectorAll('g.link .ln')].filter(li => {
      try { return li.getTotalLength() > 0.01; } catch (e) { return false; }
    }).length,
    labels: [...document.querySelectorAll('.link .lb')].filter(t => t.textContent.trim()).length,
    statGraph: document.querySelector('#statGraph').textContent,
    emptyHidden: document.querySelector('#empty').classList.contains('hidden'),
    svgSize: document.querySelector('#svg').getBoundingClientRect().width + 'x' + document.querySelector('#svg').getBoundingClientRect().height,
    zoom: document.querySelector('#zVal').textContent
  }));
  console.log('画布统计:', JSON.stringify(stats));
  if (stats.visibleLinks !== stats.links) errors.push('[render] 连线不可见或数量不符 visible=' + stats.visibleLinks + ' total=' + stats.links);
  await page.screenshot({ path: 'shot_light.png' });

  // 选中一个节点 → 详情卡（真实鼠标事件）
  const nodePos = await page.evaluate(() => {
    const r = document.querySelector('.node .shape').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(nodePos.x, nodePos.y);
  await new Promise(r => setTimeout(r, 250));
  const selCard = await page.evaluate(() => document.querySelector('#selCard').textContent.slice(0, 60));
  console.log('节点选中卡片:', JSON.stringify(selCard));
  await page.screenshot({ path: 'shot_selected.png' });

  // 拖拽节点 → 位置变化 + 撤销可用
  const before = await page.evaluate(() => window.__topo.state.nodes[0].x);
  await page.mouse.move(nodePos.x, nodePos.y);
  await page.mouse.down();
  await page.mouse.move(nodePos.x + 120, nodePos.y + 80, { steps: 8 });
  await page.mouse.up();
  await new Promise(r => setTimeout(r, 200));
  const after = await page.evaluate(() => window.__topo.state.nodes[0].x);
  const undoDisabled = await page.evaluate(() => document.querySelector('#btnUndo').disabled);
  console.log('拖拽位移:', (after - before).toFixed(0) + 'px, 撤销按钮可用:', !undoDisabled);
  await page.screenshot({ path: 'shot_dragged.png' });
  await page.evaluate(() => document.querySelector('#btnUndo').click());
  await new Promise(r => setTimeout(r, 200));
  const afterUndo = await page.evaluate(() => window.__topo.state.nodes[0].x);
  const undoDiff = Math.abs(afterUndo - before);
  console.log('撤销还原位移差:', undoDiff.toFixed(1) + 'px');
  if (undoDiff > 1) errors.push('[undo] 第一次撤销未还原节点位置 (diff=' + undoDiff.toFixed(1) + 'px)');

  // 点击连线 → 选中保持（不闪退）
  const linkPos = await page.evaluate(() => {
    const ln = document.querySelector('.link .ln');
    const r = ln.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(linkPos.x, linkPos.y);
  await new Promise(r => setTimeout(r, 250));
  const linkCard = await page.evaluate(() => document.querySelector('#selCard').textContent.includes('连线'));
  console.log('点击连线后选中保持:', linkCard);
  await page.screenshot({ path: 'shot_link_selected.png' });

  // 添加连线模式提示（当前 UI：编辑下拉菜单）
  const menuClick = async (label) => {
    await page.evaluate((lb) => {
      document.querySelector('#btnDropEdit').click();
      const b = [...document.querySelectorAll('#drop .ci')].find(x => x.textContent.includes(lb));
      if (!b) throw new Error('菜单项不存在: ' + lb);
      b.click();
    }, label);
  };
  await menuClick('添加连线');
  await new Promise(r => setTimeout(r, 150));
  const hint = await page.evaluate(() => document.querySelector('#hintBar').textContent);
  console.log('连线模式提示:', JSON.stringify(hint));
  await page.screenshot({ path: 'shot_linkmode.png' });
  await menuClick('添加连线');

  // 主题切换（暗色）
  await page.evaluate(() => document.querySelector('#btnTheme').click());
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: 'shot_dark.png' });

  // 双击节点 → 编辑弹窗（合成 dblclick；CDP 无法合成真实双击）
  await page.evaluate(() => {
    const n = document.querySelector('.node');
    n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, view: window }));
  });
  await new Promise(r => setTimeout(r, 250));
  const modal = await page.evaluate(() => document.querySelector('.modal') ? document.querySelector('.modal h3').textContent : '(无弹窗)');
  console.log('编辑弹窗:', JSON.stringify(modal));
  await page.screenshot({ path: 'shot_modal.png' });
  await page.evaluate(() => document.querySelector('#modalRoot .overlay').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
  await new Promise(r => setTimeout(r, 150));

  // 导出 CSV / VDX 冒烟（拦截下载）
  await page.evaluate(() => {
    window.__topo.exportCSV();
    window.__topo.exportVisio();
    window.__topo.exportPdf();
  });
  await new Promise(r => setTimeout(r, 300));
  console.log('导出调用无异常 ✓');

  // ---- 持久化：刷新后自动恢复 ----
  const beforeReload = await page.evaluate(() => window.__topo.state.nodes.length);
  await page.reload({ waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 600));
  const afterReload = await page.evaluate(() => {
    const n = window.__topo ? window.__topo.state.nodes.length : -1;
    const vis = document.querySelectorAll('.node').length;
    return { state: n, rendered: vis };
  });
  console.log('刷新恢复: 刷新前', beforeReload, '节点 → 刷新后', JSON.stringify(afterReload));
  await page.screenshot({ path: 'shot_restored.png' });
  // 刷新后重新覆盖 confirm，避免后续测试弹窗阻塞
  await page.evaluate(() => { window.confirm = () => true; });

  // ---- 长名称宽度自适应（走编辑弹窗 UI） ----
  await page.evaluate(() => {
    document.querySelector('.node').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, view: window }));
  });
  await new Promise(r => setTimeout(r, 200));
  const rename = await page.evaluate(() => {
    const input = document.querySelector('.modal input[name=name]');
    if (!input) return 'no-modal';
    input.value = '核心交换机-办公区接入汇聚设备A';
    document.querySelector('.modal form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return 'ok';
  });
  await new Promise(r => setTimeout(r, 250));
  const wAfter = await page.evaluate(() => window.__topo.state.nodes[0].w);
  const nameShown = await page.evaluate(() => {
    const t = document.querySelector('.node .nm');
    return t.textContent.includes('…') ? '截断' : '完整';
  });
  console.log('改名后宽度:', wAfter, '(>160 即自适应), 名称显示:', nameShown);
  await page.screenshot({ path: 'shot_longname.png' });

  // ---- 定位 ping 动画 ----
  await page.evaluate(() => {
    document.querySelector('.pitem[data-kind=node]').click();
  });
  await new Promise(r => setTimeout(r, 60));
  const ping = await page.evaluate(() => !!document.querySelector('.node .ping'));
  console.log('定位脉冲元素存在:', ping);
  await page.screenshot({ path: 'shot_ping.png' });

  // ---- 自定义类型 + 设备图片 ----
  const imgDataURL = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const x = c.getContext('2d');
    x.fillStyle = '#e11d48'; x.fillRect(0, 0, 32, 32);
    x.fillStyle = '#ffffff'; x.beginPath(); x.arc(16, 16, 10, 0, 7); x.fill();
    return c.toDataURL('image/png');
  });
  await page.evaluate((d) => { window.TopoUtil.addCustomType('核心存储', d); }, imgDataURL);

  // 类型管理弹窗显示缩略图（编辑下拉菜单）
  await menuClick('类型管理');
  await new Promise(r => setTimeout(r, 200));
  const tmThumb = await page.evaluate(() => !!document.querySelector('#tmCustom .tm-thumb'));
  const tmRow = await page.evaluate(() => document.querySelector('#tmCustom .tm-row').textContent.trim());
  console.log('类型管理缩略图:', tmThumb, '| 自定义类型行:', tmRow);
  await page.screenshot({ path: 'shot_typemgr.png' });
  await page.evaluate(() => document.querySelector('#tmCustom .tm-row [data-key]'));
  // 关闭弹窗
  await page.evaluate(() => {
    document.querySelector('#modalRoot .overlay [data-act=close]').click();
  });
  await new Promise(r => setTimeout(r, 150));

  // 添加自定义类型的设备（走 放置模式 → 弹窗，编辑下拉菜单）
  await menuClick('添加设备');
  await new Promise(r => setTimeout(r, 120));
  const stageRect = await page.evaluate(() => {
    const r = document.querySelector('#stage').getBoundingClientRect();
    return { x: r.x + r.width / 2 + 120, y: r.y + r.height / 2 - 80 };
  });
  await page.mouse.click(stageRect.x, stageRect.y);
  await new Promise(r => setTimeout(r, 200));
  const addRes = await page.evaluate(() => {
    const sel = document.querySelector('.modal select[name=type]');
    if (!sel) return 'no-modal';
    const hasCustom = [...sel.options].some(o => o.value === 'ct1');
    document.querySelector('.modal input[name=name]').value = '存储阵列ST1';
    sel.value = 'ct1';
    document.querySelector('.modal form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return hasCustom ? 'has-custom' : 'no-custom-option';
  });
  await new Promise(r => setTimeout(r, 250));
  const imgRendered = await page.evaluate(() => {
    const n = [...document.querySelectorAll('.node')].find(g => g.querySelector('.nm').textContent.includes('存储阵列'));
    return n ? !!n.querySelector('image') : 'node-missing';
  });
  const imgSize = await page.evaluate(() => {
    const n = [...document.querySelectorAll('.node')].find(g => g.querySelector('.nm').textContent.includes('存储阵列'));
    return n ? n.querySelector('image').getBoundingClientRect().width.toFixed(0) + 'px' : '-';
  });
  console.log('添加自定义类型设备:', addRes, '| 图片渲染:', imgRendered, '| 图标尺寸:', imgSize);
  await page.screenshot({ path: 'shot_customnode.png' });

  // 导出 VDX 含自定义类型颜色（不再有 <t> 元素）
  const vdxCheck = await page.evaluate(() => {
    window.__topo.exportVisio();
    return true;
  });
  await new Promise(r => setTimeout(r, 200));
  console.log('含自定义类型导出 VDX 无异常:', vdxCheck);

  // ================= 集成场景补充 =================
  // 关闭当前最上层弹窗（兼容表单弹窗：cancel/close/提交按钮）
  const closeTopModal = () => page.evaluate(() => {
    const ov = [...document.querySelectorAll('#modalRoot .overlay')].pop();
    if (!ov) return;
    const btn = ov.querySelector('[data-act=close]') || ov.querySelector('[data-act=cancel]') || ov.querySelector('form button[type=submit]');
    if (btn) btn.click();
    else ov.remove();
  });

  // ---- 面板搜索过滤 ----
  await page.evaluate(() => {
    const input = document.querySelector('#searchInput');
    input.value = '交换机';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 200));
  const searchRes = await page.evaluate(() => ({
    items: [...document.querySelectorAll('#listWrap .pitem')].map(x => x.textContent.trim().split('\n')[0]),
    tab: document.querySelector('.tab.active').textContent.trim()
  }));
  const searchOk = searchRes.items.length >= 2 && searchRes.items.every(t => t.includes('交换机'));
  console.log('搜索「交换机」过滤:', searchOk ? 'OK' : 'FAIL', JSON.stringify(searchRes));
  if (!searchOk) errors.push('[search] 搜索过滤结果异常');
  await page.evaluate(() => {
    const input = document.querySelector('#searchInput');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 150));

  // ---- 拓扑校验（示例含重复 IP 192.168.1.10 → 应报错） ----
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drop .ci')].find(x => x.textContent.includes('拓扑校验'));
    document.getElementById('btnDropLayout').click();
  });
  await new Promise(r => setTimeout(r, 200));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drop .ci')].find(x => x.textContent.includes('拓扑校验'));
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 300));
  const validation = await page.evaluate(() => {
    const m = [...document.querySelectorAll('#modalRoot .modal')].pop();
    return m ? { title: m.querySelector('h3').textContent, rows: m.querySelectorAll('.vrow').length, errs: m.querySelectorAll('.vrow.err').length, sub: m.querySelector('.m-sub').textContent } : null;
  });
  const validationOk = validation && validation.title === '拓扑校验报告' && validation.rows > 0 && validation.errs > 0;
  console.log('拓扑校验报告:', validationOk ? 'OK' : 'FAIL', JSON.stringify(validation));
  if (!validationOk) errors.push('[validation] 拓扑校验报告异常');
  await closeTopModal();
  await new Promise(r => setTimeout(r, 150));

  // ---- 路径分析（正常）：路由器 → 办公PC1（多跳） ----
  const runPath = async () => {
    await page.evaluate(() => document.getElementById('btnDropLayout').click());
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#drop .ci')].find(x => x.textContent.includes('路径分析'));
      if (b) b.click();
    });
    await new Promise(r => setTimeout(r, 250));
    await page.evaluate(() => {
      const f = document.querySelector('#modalRoot .modal form');
      const fromOpt = [...f.elements.from.options].find(o => window.__topo.state.nodes.find(n => n.id === o.value && n.type === 'router'));
      const toOpt = [...f.elements.to.options].find(o => o.textContent === '办公PC1');
      if (!fromOpt || !toOpt) return 'no-opt';
      f.elements.from.value = fromOpt.value;
      f.elements.to.value = toOpt.value;
      f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return 'ok';
    });
    await new Promise(r => setTimeout(r, 300));
    return page.evaluate(() => {
      const m = [...document.querySelectorAll('#modalRoot .modal')].pop();
      return m ? { title: m.querySelector('h3').textContent, text: m.textContent } : null;
    });
  };
  const pathRes = await runPath();
  const pathOk = pathRes && pathRes.title === '路径分析结果' && pathRes.text.includes('跳') && pathRes.text.includes('→');
  console.log('路径分析 路由器→办公PC1:', pathOk ? 'OK' : 'FAIL', pathRes && pathRes.text.slice(0, 120));
  if (!pathOk) errors.push('[path] 路径分析异常');
  await closeTopModal();
  await new Promise(r => setTimeout(r, 150));

  // ---- 故障标记 → 路径分析绕行 → 恢复 ----
  const faultLinkId = await page.evaluate(() => {
    const l = window.__topo.state.links.find(x => x.aIf === 'GE0/0/1' && x.aIp === '10.0.0.1');
    return l ? l.id : null;
  });
  if (faultLinkId) {
    await page.evaluate((id) => {
      const el = document.querySelector('.link[data-id="' + id + '"]');
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 300 }));
    }, faultLinkId);
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#ctx .ci')].find(x => x.textContent.includes('标记链路故障'));
      if (b) b.click();
    });
    await new Promise(r => setTimeout(r, 250));
    const downed = await page.evaluate((id) => !!document.querySelector('.link[data-id="' + id + '"].down'), faultLinkId);
    console.log('标记链路故障（R1-SW1）:', downed ? 'OK' : 'FAIL');
    if (!downed) errors.push('[fault] 故障标记未生效');
    const reroute = await runPath();
    const rerouteOk = reroute && reroute.text.includes('已排除 1 条故障链路') && reroute.text.includes('防火墙FW1');
    console.log('故障后路径绕行:', rerouteOk ? 'OK' : 'FAIL', reroute && reroute.text.slice(0, 150));
    if (!rerouteOk) errors.push('[fault] 故障后未绕行');
    await closeTopModal();
    await new Promise(r => setTimeout(r, 150));
    // 恢复链路
    await page.evaluate((id) => {
      const el = document.querySelector('.link[data-id="' + id + '"]');
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 300 }));
    }, faultLinkId);
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#ctx .ci')].find(x => x.textContent.includes('恢复链路'));
      if (b) b.click();
    });
    await new Promise(r => setTimeout(r, 250));
    const recovered = await page.evaluate((id) => !document.querySelector('.link[data-id="' + id + '"].down'), faultLinkId);
    console.log('恢复链路:', recovered ? 'OK' : 'FAIL');
    if (!recovered) errors.push('[fault] 链路恢复未生效');
  } else {
    errors.push('[fault] 未找到 R1-SW1 链路');
  }

  // ---- 多选 + 对齐/分布 ----
  // 先点击画布空白清空选择/关闭右键菜单，再 Ctrl+点选 3 台设备
  await page.evaluate(() => {
    document.querySelector('#svg').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }));
  });
  await new Promise(r => setTimeout(r, 150));
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('.node')].slice(0, 3);
    const fire = (el, ctrl) => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, ctrlKey: ctrl, button: 0, clientX: 5, clientY: 5 }));
    fire(els[0], false);
    fire(els[1], true);
    fire(els[2], true);
  });
  await new Promise(r => setTimeout(r, 250));
  const selCount = await page.evaluate(() => window.__topo.renderer.selectedNodes().length);
  console.log('多选设备数:', selCount);
  if (selCount === 3) {
    await menuClick('对齐 / 分布选中…');
    await new Promise(r => setTimeout(r, 200));
    const selBefore = await page.evaluate(() => window.__topo.renderer.selectedNodes());
    const alignBtn = await page.evaluate(() => {
      const b = document.querySelector('.align-grid .tb[data-k=left]');
      if (b) b.click();
      return !!b;
    });
    await new Promise(r => setTimeout(r, 250));
    const xs = await page.evaluate((ids) => ids.map(id => window.__topo.state.nodes.find(n => n.id === id).x), selBefore);
    const alignOk = alignBtn && xs.length === 3 && Math.max(...xs) - Math.min(...xs) < 0.5;
    console.log('多选 3 台左对齐:', alignOk ? 'OK' : 'FAIL', JSON.stringify(xs));
    if (!alignOk) errors.push('[align] 对齐未生效');
    await page.evaluate(() => document.querySelector('#btnUndo').click()); // 撤销对齐
    await new Promise(r => setTimeout(r, 150));
    // 批量重命名（验证 openRename 修复：只作用于选中的设备）
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('.node')].slice(0, 3);
      const fire = (el, ctrl) => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, ctrlKey: ctrl, button: 0, clientX: 5, clientY: 5 }));
      fire(els[0], false); fire(els[1], true); fire(els[2], true);
    });
    await new Promise(r => setTimeout(r, 200));
    await menuClick('批量重命名…');
    await new Promise(r => setTimeout(r, 200));
    const rnApplied = await page.evaluate(() => {
      const m = [...document.querySelectorAll('#modalRoot .modal')].pop();
      const title = m.querySelector('h3').textContent;
      const prefix = m.querySelector('#rnPrefix');
      if (!prefix) return 'no-modal';
      prefix.value = 'TEST-';
      document.querySelector('[data-act=apply]').click();
      return title;
    });
    await new Promise(r => setTimeout(r, 300));
    const rnNames = await page.evaluate((ids) => ids.map(id => window.__topo.state.nodes.find(n => n.id === id).name), selBefore);
    const rnOk = rnApplied && rnApplied.includes('3 台设备') && rnNames.length === 3 && rnNames.every(n => n.startsWith('TEST-'));
    console.log('批量重命名 3 台加前缀:', rnOk ? 'OK' : 'FAIL', JSON.stringify(rnNames));
    if (!rnOk) errors.push('[rename] 批量重命名未生效');
    await page.evaluate(() => document.querySelector('#btnUndo').click()); // 撤销重命名
    await new Promise(r => setTimeout(r, 150));
  } else {
    console.log('多选 3 台左对齐: FAIL（选中数=' + selCount + '）');
    errors.push('[align] 多选未生效');
  }

  // ---- 配置生成 + 设备选择器 ----
  await page.evaluate(() => document.getElementById('btnDropExport').click());
  await new Promise(r => setTimeout(r, 200));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drop .ci')].find(x => x.textContent.includes('生成设备配置'));
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 300));
  const cfgInit = await page.evaluate(() => {
    const ov = [...document.querySelectorAll('#modalRoot .overlay')].pop();
    const out = ov.querySelector('#cfgOut').value;
    const devs = window.__topo.state.nodes.map(n => n.name);
    const secs = devs.filter(n => out.split('\n').some(l => l.startsWith('# ' + n + '  ')));
    return { pickBtn: !!ov.querySelector('#cfgPick'), cnt: ov.querySelector('#cfgPickCnt').textContent, secs: secs.length, total: devs.length };
  });
  await page.evaluate(() => document.querySelector('#cfgPick').click());
  await new Promise(r => setTimeout(r, 250));
  const pickerInfo = await page.evaluate(() => {
    const ov = [...document.querySelectorAll('#modalRoot .overlay')].pop();
    if (!ov.querySelector('#dpList')) return null;
    return { items: ov.querySelectorAll('#dpList .dp-item').length, count: ov.querySelector('#dpCount').textContent, search: !!ov.querySelector('#dpSearch') };
  });
  await page.evaluate(() => {
    const ov = [...document.querySelectorAll('#modalRoot .overlay')].pop();
    const boxes = [...ov.querySelectorAll('#dpList input[type=checkbox]')];
    [boxes[1], boxes[3]].forEach(b => b.click());
    ov.querySelector('[data-act=confirm]').click();
  });
  await new Promise(r => setTimeout(r, 300));
  const cfgAfter = await page.evaluate(() => {
    const ov = [...document.querySelectorAll('#modalRoot .overlay')].pop();
    const out = ov.querySelector('#cfgOut').value;
    const devs = window.__topo.state.nodes.map(n => n.name);
    const secs = devs.filter(n => out.split('\n').some(l => l.startsWith('# ' + n + '  ')));
    return { cnt: ov.querySelector('#cfgPickCnt').textContent, secs: secs.length };
  });
  const cfgOkFinal = cfgInit && cfgInit.pickBtn && cfgInit.cnt.includes('全部')
    && pickerInfo && pickerInfo.items === cfgInit.total && pickerInfo.search
    && cfgAfter && cfgAfter.cnt.includes('/ ' + cfgInit.total + ' 台') && cfgAfter.cnt.includes((cfgInit.total - 2) + ' /')
    && cfgAfter.secs === cfgInit.total - 2;
  console.log('配置生成设备选择器:', cfgOkFinal ? 'OK' : 'FAIL', JSON.stringify({ cnt: cfgInit && cfgInit.cnt, secs: cfgAfter && cfgAfter.secs, total: cfgInit && cfgInit.total }));
  if (!cfgOkFinal) errors.push('[configgen] 设备选择器流程异常');
  await page.evaluate(() => { [...document.querySelectorAll('#modalRoot .overlay')].pop().querySelector('[data-act=close]').click(); });
  await new Promise(r => setTimeout(r, 150));

  // ---- 备份管理（浏览器回退提示） ----
  await page.evaluate(() => document.getElementById('btnDropFile').click());
  await new Promise(r => setTimeout(r, 200));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drop .ci')].find(x => x.textContent.includes('备份管理'));
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 300));
  const bkModal = await page.evaluate(() => {
    const m = [...document.querySelectorAll('#modalRoot .modal')].pop();
    return m ? { title: m.querySelector('h3').textContent, sub: (m.querySelector('.m-sub') || {}).textContent || '' } : null;
  });
  const bkOk = bkModal && bkModal.title === '备份管理' && bkModal.sub.includes('桌面版专属');
  console.log('备份管理（浏览器回退）:', bkOk ? 'OK' : 'FAIL');
  if (!bkOk) errors.push('[backup] 备份管理回退弹窗异常');
  await page.evaluate(() => { [...document.querySelectorAll('#modalRoot .overlay')].pop().querySelector('form button[type=submit]').click(); });
  await new Promise(r => setTimeout(r, 150));

  // ---- 模板添加设备 ----
  await menuClick('从模板添加设备…');
  await new Promise(r => setTimeout(r, 250));
  const tplAdded = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.tpl')].find(x => x.textContent.includes('核心交换机'));
    if (b) b.click();
    return !!b;
  });
  await new Promise(r => setTimeout(r, 300));
  const hasTplNode = await page.evaluate(() => window.__topo.state.nodes.some(n => n.name === '核心交换机'));
  console.log('模板添加核心交换机:', tplAdded && hasTplNode ? 'OK' : 'FAIL');
  if (!(tplAdded && hasTplNode)) errors.push('[template] 模板添加设备失败');

  // ---- 设备编辑：配置厂家（逐设备指定，生成配置时优先于全局） ----
  await page.evaluate(() => {
    document.querySelector('.node').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, view: window }));
  });
  await new Promise(r => setTimeout(r, 250));
  const vendorSel = await page.evaluate(() => {
    const sel = document.querySelector('.modal select[name=vendor]');
    if (!sel) return null;
    const opts = [...sel.options].map(o => o.textContent);
    sel.value = 'cisco';
    document.querySelector('.modal form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return opts;
  });
  await new Promise(r => setTimeout(r, 250));
  const vendorState = await page.evaluate(() => {
    const n = window.__topo.state.nodes.find(x => x.vendor);
    return n ? n.vendor : '';
  });
  const vendorOk = vendorSel && vendorSel.some(t => t.includes('跟随全局')) && vendorState === 'cisco';
  console.log('设备编辑配置厂家:', vendorOk ? 'OK' : 'FAIL', JSON.stringify({ opts: vendorSel && vendorSel.slice(0, 4), vendor: vendorState }));
  if (!vendorOk) errors.push('[vendor] 编辑设备配置厂家未生效');

  // ---- 设计报告不再附加设备配置 ----
  const repNoCfg = await page.evaluate(() => {
    const html = window.TopoUtil.buildReportHtml(window.__topo.state.nodes, window.__topo.state.links);
    return { hasCfg: html.includes('设备配置'), hasCore: html.includes('设备清单') && html.includes('IP 规划') && html.includes('链路明细') };
  });
  const repOk = repNoCfg && repNoCfg.hasCore && !repNoCfg.hasCfg;
  console.log('设计报告不含配置:', repOk ? 'OK' : 'FAIL');
  if (!repOk) errors.push('[report] 设计报告仍含设备配置');

  // ---- 打开工程（uploadFile 往返） ----
  const tmpProj = path.join(__dirname, '_tmp_open.nettopo');
  require('fs').writeFileSync(tmpProj, JSON.stringify({
    app: 'NetTopo', version: 1,
    nodes: [{ id: 'n1', name: '导入设备A', type: 'router', x: 0, y: 0, w: 160, h: 56 }, { id: 'n2', name: '导入设备B', type: 'switch', x: 300, y: 0, w: 160, h: 56 }],
    links: [{ id: 'l1', a: 'n1', b: 'n2', aIf: 'GE0/0/1', aIp: '10.1.1.1', bIf: 'GE1/0/1', bIp: '10.1.1.2' }],
    texts: []
  }));
  await page.$eval('input#projInput', (el) => { el.value = ''; });
  const projInput = await page.$('input#projInput');
  await projInput.uploadFile(tmpProj);
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => { const b = document.querySelector('#modalRoot [data-act=yes]'); if (b) b.click(); });
  await new Promise(r => setTimeout(r, 400));
  const opened = await page.evaluate(() => ({ nodes: window.__topo.state.nodes.length, links: window.__topo.state.links.length, rendered: document.querySelectorAll('.node').length }));
  const openOk = opened.nodes === 2 && opened.links === 1 && opened.rendered === 2;
  console.log('打开工程往返:', openOk ? 'OK' : 'FAIL', JSON.stringify(opened));
  if (!openOk) errors.push('[open] 打开工程未生效');
  require('fs').unlinkSync(tmpProj);

  // ---- 新建空白画布 ----
  await page.evaluate(() => document.getElementById('btnDropFile').click());
  await new Promise(r => setTimeout(r, 200));
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#drop .ci')].find(x => x.textContent.includes('新建空白画布'));
    if (b) b.click();
  });
  await new Promise(r => setTimeout(r, 250));
  await page.evaluate(() => { const b = document.querySelector('#modalRoot [data-act=yes]'); if (b) b.click(); });
  await new Promise(r => setTimeout(r, 300));
  const blank = await page.evaluate(() => ({
    nodes: window.__topo.state.nodes.length,
    emptyHidden: document.querySelector('#empty').classList.contains('hidden'),
    zoomHidden: document.querySelector('#zoomCtl').classList.contains('hidden')
  }));
  // 设计意图：空白画布模式不显示空状态卡片（无表格也可直接画），画布与缩放控件为空
  const blankOk = blank.nodes === 0 && blank.emptyHidden && blank.zoomHidden;
  console.log('新建空白画布:', blankOk ? 'OK' : 'FAIL', JSON.stringify(blank));
  if (!blankOk) errors.push('[new] 新建空白画布未生效');

  const clickMenuItem = async (btnId, label) => {
    await page.evaluate((id) => document.getElementById(id).click(), btnId);
    await new Promise(r => setTimeout(r, 150));
    return page.evaluate((txt) => {
      const b = [...document.querySelectorAll('#drop .ci')].find(x => x.textContent.includes(txt));
      if (b) b.click();
      return !!b;
    }, label);
  };
  const closeOverlay = () => page.evaluate(() => {
    const b = document.querySelector('#modalRoot .overlay [data-act=close], #modalRoot .overlay [data-act=cancel]');
    if (b) b.click();
    return !document.querySelector('#modalRoot .overlay');
  });

  // ---- CSV 表格导入（文件 → 解析 → 拓扑，管线集成） ----
  {
    const csv = [
      '源设备,源接口,源IP,目标设备,目标接口,目标IP',
      '核心SW1,GE0/0/1,10.1.1.1,汇聚SW2,GE0/0/2,10.1.1.2',
      '汇聚SW2,GE0/0/24,10.2.1.2,出口FW1,GE0/0/1,10.2.1.1'
    ].join('\r\n');
    const tmpCsv = path.join(__dirname, '_e2e-import.csv');
    require('fs').writeFileSync(tmpCsv, csv, 'utf8');
    await page.$eval('input#fileInput', (el) => { el.value = ''; });
    const fileInput = await page.$('input#fileInput');
    await fileInput.uploadFile(tmpCsv);
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => { const b = document.querySelector('#modalRoot [data-act=yes]'); if (b) b.click(); });
    await new Promise(r => setTimeout(r, 600));
    const imp = await page.evaluate(() => {
      const st = window.__topo.state;
      return {
        names: st.nodes.map(n => n.name).sort(),
        links: st.links.map(l => (l.aIf || '') + '|' + (l.aIp || '') + '>' + (l.bIf || '')).sort()
      };
    });
    const impOk = imp.names.length === 3 && imp.names.includes('核心SW1') && imp.names.includes('出口FW1')
      && imp.links.length === 2 && imp.links.every(s => s.includes('10.1.1.1') || s.includes('10.2.1.2'));
    console.log('CSV 表格导入:', impOk ? 'OK' : 'FAIL', JSON.stringify(imp));
    if (!impOk) errors.push('[import] CSV 表格导入未生效: ' + JSON.stringify(imp));
    require('fs').unlinkSync(tmpCsv);
  }

  // ---- 从邻居表导入（LLDP）UI 全流程：解析预览 → 导入 → 同名设备复用、新设备自动建 ----
  {
    const before = await page.evaluate(() => ({ nodes: window.__topo.state.nodes.length, links: window.__topo.state.links.length }));
    const itemHit = await clickMenuItem('btnDropFile', '从邻居表导入');
    await new Promise(r => setTimeout(r, 250));
    const dlgOpen = await page.evaluate(() => !!document.querySelector('#modalRoot .overlay #nbText'));
    await page.evaluate(() => {
      const ov = document.querySelector('#modalRoot .overlay');
      const opt = [...ov.querySelector('#nbLocal').options].find(o => o.textContent === '核心SW1');
      if (opt) ov.querySelector('#nbLocal').value = opt.value;
      ov.querySelector('#nbText').value = [
        '<核心SW1>display lldp neighbor brief',
        'Local Intf     Neighbor Dev             Neighbor Intf     Exptime',
        'GE0/0/1        汇聚SW2                  GE0/0/2           120',
        'GE0/0/4        接入SW3                  GE0/0/1           96',
        ''
      ].join('\r\n');
      ov.querySelector('#nbParse').click();
    });
    await new Promise(r => setTimeout(r, 200));
    const prev = await page.evaluate(() => ({
      rows: document.querySelectorAll('#modalRoot .overlay #nbPrev tr').length - 1,
      fmt: (document.querySelector('#modalRoot .overlay #nbPrev .comp-total') || {}).textContent || '',
      goEnabled: !document.querySelector('#modalRoot .overlay #nbGo').disabled
    }));
    await page.evaluate(() => document.querySelector('#modalRoot .overlay #nbGo').click());
    await new Promise(r => setTimeout(r, 600));
    const after = await page.evaluate(() => {
      const st = window.__topo.state;
      return { nodes: st.nodes.length, links: st.links.length, sw2: st.nodes.filter(n => n.name === '汇聚SW2').length };
    });
    const nbOk = itemHit && dlgOpen && prev.rows === 2 && prev.goEnabled && prev.fmt.includes('2')
      && after.nodes === before.nodes + 1 && after.links === before.links + 1 && after.sw2 === 1;
    console.log('邻居表导入 UI:', nbOk ? 'OK' : 'FAIL', JSON.stringify({ prev, before, after }));
    if (!nbOk) errors.push('[neighbors] 邻居表导入 UI 流程未生效: ' + JSON.stringify({ prev, before, after }));
  }

  // ---- 接口总表：集中编辑 → 应用修改一次性写入（集成写回） ----
  {
    const itemHit = await clickMenuItem('btnDropEdit', '接口总表');
    await new Promise(r => setTimeout(r, 250));
    const row = await page.evaluate(() => {
      const tr = document.querySelector('#modalRoot .overlay #iftBody tr[data-key]');
      return tr ? { key: tr.dataset.key, ip: tr.querySelector('input[data-f=ip]').value } : null;
    });
    await page.evaluate(() => {
      const tr = document.querySelector('#modalRoot .overlay #iftBody tr[data-key]');
      const set = (sel, v) => {
        const inp = tr.querySelector(sel);
        inp.value = v;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('input[data-f=ip]', '172.16.0.254');
      set('input[data-f=vlan]', '30');
    });
    await page.evaluate(() => document.querySelector('#modalRoot .overlay [data-act=apply]').click());
    await new Promise(r => setTimeout(r, 300));
    const applied = await page.evaluate((key) => {
      const sp = key.lastIndexOf('|');
      const l = window.__topo.state.links.find(x => x.id === key.slice(0, sp));
      const side = key.slice(sp + 1);
      return { ip: l[side + 'Ip'], vlan: l[side + 'Vlan'], mode: l[side + 'VlanMode'] };
    }, row.key);
    const iftOk = itemHit && !!row && applied.ip === '172.16.0.254' && applied.vlan === '30' && applied.mode === 'access';
    console.log('接口总表编辑应用:', iftOk ? 'OK' : 'FAIL', JSON.stringify({ row, applied }));
    if (!iftOk) errors.push('[iftable] 接口总表应用修改未写回: ' + JSON.stringify({ row, applied }));
  }

  // ---- 网段分析：CIDR 汇总表 + 点击行定位高亮 ----
  {
    const itemHit = await clickMenuItem('btnDropLayout', '网段分析');
    await new Promise(r => setTimeout(r, 250));
    const snt = await page.evaluate(() => ({
      rows: document.querySelectorAll('#modalRoot .overlay #sntBody tr[data-i]').length,
      sub: (document.querySelector('#modalRoot .overlay .m-sub') || {}).textContent || ''
    }));
    await page.evaluate(() => document.querySelector('#modalRoot .overlay #sntBody tr[data-i]').click());
    const hl = await page.evaluate(() => document.querySelectorAll('.path-hl').length);
    await closeOverlay();
    const sntOk = itemHit && snt.rows >= 2 && snt.sub.includes('个网段') && hl > 0;
    console.log('网段分析:', sntOk ? 'OK' : 'FAIL', JSON.stringify({ rows: snt.rows, highlight: hl }));
    if (!sntOk) errors.push('[subnet] 网段分析表格/高亮未生效: ' + JSON.stringify({ rows: snt.rows, highlight: hl }));
  }

  // ---- 单点故障分析：割点/割边列表 + 点击定位红色高亮受影响设备 ----
  // 5 节点链 接入A—汇聚H1—核心M—汇聚H2—接入B：核心M 为中间割点（故障必然隔离一侧 ≥2 台，按最大连通块为存续主网络），
  // 两条中间链路为无冗余关键链路（各隔离 2 台）；两端叶子链路仅隔离直连 1 台，按设计折叠不逐条列出
  {
    await page.evaluate(() => {
      window.__topo.loadGraph({
        nodes: [
          { id: 'e2a', name: '接入A', type: 'switch', x: 0, y: 0, w: 160, h: 56 },
          { id: 'e2h1', name: '汇聚H1', type: 'switch', x: 300, y: 0, w: 160, h: 56 },
          { id: 'e2m', name: '核心M', type: 'switch', x: 600, y: 0, w: 160, h: 56 },
          { id: 'e2h2', name: '汇聚H2', type: 'switch', x: 900, y: 0, w: 160, h: 56 },
          { id: 'e2b', name: '接入B', type: 'switch', x: 1200, y: 0, w: 160, h: 56 }
        ],
        links: [
          { id: 'e2l1', a: 'e2a', b: 'e2h1', aIf: 'GE0/0/1', bIf: 'GE0/0/1' },
          { id: 'e2l2', a: 'e2h1', b: 'e2m', aIf: 'GE0/0/2', bIf: 'GE0/0/1' },
          { id: 'e2l3', a: 'e2m', b: 'e2h2', aIf: 'GE0/0/2', bIf: 'GE0/0/2' },
          { id: 'e2l4', a: 'e2h2', b: 'e2b', aIf: 'GE0/0/3', bIf: 'GE0/0/1' }
        ],
        texts: []
      }, 'e2e');
    });
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => { const b = document.querySelector('#modalRoot [data-act=yes]'); if (b) b.click(); });
    await new Promise(r => setTimeout(r, 300));
    const itemHit = await clickMenuItem('btnDropLayout', '单点故障分析');
    await new Promise(r => setTimeout(r, 250));
    const sp = await page.evaluate(() => [...document.querySelectorAll('#modalRoot .overlay .vrow .v-msg')].map(v => v.textContent));
    await page.evaluate(() => document.querySelector('#modalRoot .overlay .vrow [data-act=locate]').click());
    await new Promise(r => setTimeout(r, 250));
    const imp = await page.evaluate(() => document.querySelectorAll('.impact-hl').length);
    const spOk = itemHit && sp.length === 3 && sp[0].includes('单点设备') && sp[0].includes('核心M')
      && sp[0].includes('拆散全部网络')
      && sp.slice(1).every(s => s.includes('关键链路')) && imp === 4;
    console.log('单点故障分析:', spOk ? 'OK' : 'FAIL', JSON.stringify({ sp, impactHl: imp }));
    if (!spOk) errors.push('[spof] 单点故障分析条目/高亮不符合预期: ' + JSON.stringify({ sp, impactHl: imp }));
  }

  // ---- 故障影响分析（右键设备）：模拟单点故障 → 失联区域 chips + 红色高亮 ----
  {
    const ctx = await page.evaluate(() => {
      const st = window.__topo.state;
      const b = st.nodes.find(n => n.name === '汇聚H2');
      const el = document.querySelector('g.node[data-id="' + b.id + '"]');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));
      return [...document.querySelectorAll('#ctx .ci')].map(x => x.textContent);
    });
    await new Promise(r => setTimeout(r, 150));
    await page.evaluate(() => {
      const t = [...document.querySelectorAll('#ctx .ci')].find(x => x.textContent.includes('故障影响分析'));
      if (t) t.click();
    });
    await new Promise(r => setTimeout(r, 300));
    const imp = await page.evaluate(() => {
      const ov = document.querySelector('#modalRoot .overlay');
      if (!ov) return null;
      return {
        title: ov.querySelector('h3').textContent,
        sub: ov.querySelector('.m-sub').textContent,
        chips: [...ov.querySelectorAll('.imp-chip')].map(c => c.textContent),
        hl: document.querySelectorAll('.impact-hl').length
      };
    });
    await closeOverlay();
    // 汇聚H2 故障：下挂 接入B 与主网络失联（chips 分支），存续主网络 3 台
    const ctxOk = ctx.some(x => x.includes('故障影响分析')) && imp && imp.title === '故障影响分析：汇聚H2'
      && imp.chips.length === 1 && imp.chips[0] === '接入B' && imp.hl === 1;
    console.log('右键故障影响分析:', ctxOk ? 'OK' : 'FAIL', JSON.stringify({ ctxItems: ctx.length, imp }));
    if (!ctxOk) errors.push('[impact] 右键故障影响分析未生效: ' + JSON.stringify({ ctxItems: ctx.length, imp }));
  }

  // ---- 画布快速搜索（Ctrl+F）：呼出 → 输入匹配 → Enter 定位选中 → Esc 关闭 ----
  {
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await new Promise(r => setTimeout(r, 150));
    await page.evaluate(() => {
      const inp = document.querySelector('#qsInput');
      inp.value = '核心';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const qs = await page.evaluate(() => ({
      visible: !document.querySelector('#quickSearch').classList.contains('hidden'),
      count: document.querySelector('#qsCount').textContent,
      first: (document.querySelector('#qsList .qs-item .qs-t') || {}).textContent || ''
    }));
    await page.evaluate(() => {
      document.querySelector('#qsInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await new Promise(r => setTimeout(r, 150));
    const selName = await page.evaluate(() => {
      const s = window.__topo.state.sel;
      if (!s || s.kind !== 'node') return '';
      const n = window.__topo.state.nodes.find(x => x.id === s.id);
      return n ? n.name : '';
    });
    await page.evaluate(() => {
      document.querySelector('#qsInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    const qsClosed = await page.evaluate(() => document.querySelector('#quickSearch').classList.contains('hidden'));
    const qsOk = qs.visible && qs.count.includes('个匹配') && qs.first.includes('核心') && selName.includes('核心') && qsClosed;
    console.log('画布快速搜索:', qsOk ? 'OK' : 'FAIL', JSON.stringify({ qs, selName, qsClosed }));
    if (!qsOk) errors.push('[quicksearch] 快速搜索未生效: ' + JSON.stringify({ qs, selName, qsClosed }));
  }

  // ---- 多图纸：新建页隔离（当前拓扑存第 1 页）→ 切回还原 ----
  {
    const s0 = await page.evaluate(() => ({ n: window.__topo.state.sheets.length, idx: window.__topo.state.sheetIdx, nodes: window.__topo.state.nodes.length }));
    await page.evaluate(() => document.getElementById('sheetAdd').click());
    await new Promise(r => setTimeout(r, 300));
    const s1 = await page.evaluate(() => ({ n: window.__topo.state.sheets.length, idx: window.__topo.state.sheetIdx, nodes: window.__topo.state.nodes.length }));
    await page.evaluate(() => document.querySelector('#sheetTabs .sheet-tab[data-idx="0"]').click());
    await new Promise(r => setTimeout(r, 300));
    const s2 = await page.evaluate(() => ({ n: window.__topo.state.sheets.length, idx: window.__topo.state.sheetIdx, nodes: window.__topo.state.nodes.length }));
    const sheetOk = s1.n === 2 && s1.idx === 1 && s1.nodes === 0 && s2.idx === 0 && s2.nodes === s0.nodes && s0.nodes > 0;
    console.log('多图纸切换:', sheetOk ? 'OK' : 'FAIL', JSON.stringify({ s0, s1, s2 }));
    if (!sheetOk) errors.push('[sheets] 多图纸新建/切换未生效: ' + JSON.stringify({ s0, s1, s2 }));
  }

  // ---- 浏览器降级探测：桌面专属弹窗在浏览器环境给出提示而非报错 ----
  {
    const fb = await page.evaluate(() => {
      window.__topo.openMonitorCenter();
      const mc = (document.querySelector('#toastTmp') || {}).textContent || '';
      window.__topo.openComplianceCheck();
      const comp = (document.querySelector('#toastTmp') || {}).textContent || '';
      return { mc, comp };
    });
    const fbOk = fb.mc.includes('桌面版') && fb.comp.includes('桌面版');
    console.log('浏览器降级提示:', fbOk ? 'OK' : 'FAIL', JSON.stringify(fb));
    if (!fbOk) errors.push('[fallback] 浏览器降级提示缺失: ' + JSON.stringify(fb));
  }

  // ---- 删除级联 + 多步撤销/重做（键盘 Delete + 右键删除 + btnUndo/btnRedo） ----
  {
    await page.evaluate(() => {
      window.__topo.loadGraph({
        // 坐标全部非零：loadGraph 以 n.x||n.y 判定「全部带坐标」，含 (0,0) 会触发自动布局动画导致视图/位置不确定
        nodes: [
          { id: 'da', name: '级联A', type: 'switch', x: 120, y: 80, w: 160, h: 56 },
          { id: 'db', name: '级联B', type: 'switch', x: 520, y: 80, w: 160, h: 56 },
          { id: 'dc', name: '级联C', type: 'switch', x: 920, y: 80, w: 160, h: 56 }
        ],
        links: [{ id: 'dl1', a: 'da', b: 'db' }, { id: 'dl2', a: 'db', b: 'dc' }],
        texts: []
      }, 'e2e');
    });
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => { const b = document.querySelector('#modalRoot [data-act=yes]'); if (b) b.click(); });
    await new Promise(r => setTimeout(r, 300));
    // 点击选中中间节点 → Delete 键 → 级联删除其 2 条连线。
    // 选中用合成 pointerdown/up（与 app.onDown 同一处理链）；真实 mouse.click 在长序列下会受
    // 前序用例指针状态影响出现视图漂移（单跑无此现象），该路径已由开头「节点选中/拖拽」用例覆盖。
    const selOk = await page.evaluate(() => {
      const b = window.__topo.state.nodes.find(n => n.name === '级联B');
      const el = document.querySelector('g.node[data-id="' + b.id + '"]');
      const r = el.getBoundingClientRect();
      const ev = { bubbles: true, cancelable: true, pointerId: 5, pointerType: 'mouse', isPrimary: true, clientX: r.left + 10, clientY: r.top + 10, buttons: 1 };
      el.dispatchEvent(new PointerEvent('pointerdown', ev));
      el.dispatchEvent(new PointerEvent('pointerup', { ...ev, buttons: 0 }));
      return window.__topo.state.sel && window.__topo.state.sel.id === b.id;
    });
    await page.keyboard.press('Delete');
    await new Promise(r => setTimeout(r, 250));
    const del = await page.evaluate(() => ({ nodes: window.__topo.state.nodes.length, links: window.__topo.state.links.length }));
    await page.evaluate(() => document.getElementById('btnUndo').click());
    await new Promise(r => setTimeout(r, 250));
    const undone = await page.evaluate(() => ({ nodes: window.__topo.state.nodes.length, links: window.__topo.state.links.length }));
    await page.evaluate(() => document.getElementById('btnRedo').click());
    await new Promise(r => setTimeout(r, 250));
    const redone = await page.evaluate(() => ({ nodes: window.__topo.state.nodes.length, links: window.__topo.state.links.length }));
    // 右键删除端点设备 → 撤销还原
    await page.evaluate(() => {
      const a = window.__topo.state.nodes.find(n => n.name === '级联A');
      const r = document.querySelector('g.node[data-id="' + a.id + '"]').getBoundingClientRect();
      document.querySelector('g.node[data-id="' + a.id + '"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));
    });
    await new Promise(r => setTimeout(r, 150));
    await page.evaluate(() => {
      const t = [...document.querySelectorAll('#ctx .ci')].find(x => x.textContent.includes('删除设备及连线'));
      if (t) t.click();
    });
    await new Promise(r => setTimeout(r, 250));
    const ctxDel = await page.evaluate(() => window.__topo.state.nodes.length);
    await page.evaluate(() => document.getElementById('btnUndo').click());
    await new Promise(r => setTimeout(r, 250));
    const ctxUndone = await page.evaluate(() => window.__topo.state.nodes.length);
    // 重做后画布剩 级联A/级联C 两台：右键删 A → 1 台，撤销还原 → 2 台
    const delOk = selOk && del.nodes === 2 && del.links === 0 && undone.nodes === 3 && undone.links === 2
      && redone.nodes === 2 && redone.links === 0 && ctxDel === 1 && ctxUndone === 2;
    console.log('删除级联+撤销重做:', delOk ? 'OK' : 'FAIL', JSON.stringify({ del, undone, redone, ctxDel, ctxUndone }));
    if (!delOk) errors.push('[delete] 删除级联/撤销重做不符合预期: ' + JSON.stringify({ del, undone, redone, ctxDel, ctxUndone }));
  }

  // ---- 平行链路校验提示 → 右键组成聚合组后豁免（校验联动集成） ----
  {
    await page.evaluate(() => {
      window.__topo.loadGraph({
        nodes: [
          { id: 'pa', name: '并联A', type: 'switch', x: 0, y: 0, w: 160, h: 56 },
          { id: 'pb', name: '并联B', type: 'switch', x: 600, y: 0, w: 160, h: 56 }
        ],
        links: [
          { id: 'pl1', a: 'pa', b: 'pb', aIf: 'GE0/0/1', bIf: 'GE0/0/1' },
          { id: 'pl2', a: 'pa', b: 'pb', aIf: 'GE0/0/2', bIf: 'GE0/0/2' }
        ],
        texts: []
      }, 'e2e');
    });
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => { const b = document.querySelector('#modalRoot [data-act=yes]'); if (b) b.click(); });
    await new Promise(r => setTimeout(r, 300));
    await clickMenuItem('btnDropLayout', '拓扑校验');
    await new Promise(r => setTimeout(r, 250));
    const rep1 = await page.evaluate(() => [...document.querySelectorAll('#modalRoot .overlay .v-msg')].map(v => v.textContent));
    await closeOverlay();
    // 右键其中一条连线 → 「与平行链路组成聚合组…」→ 命名提交 → 两条平行链路同组
    await page.evaluate(() => {
      const l = window.__topo.state.links[0];
      const el = document.querySelector('g.link[data-id="' + l.id + '"]');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
    });
    await new Promise(r => setTimeout(r, 150));
    const aggItem = await page.evaluate(() => {
      const t = [...document.querySelectorAll('#ctx .ci')].find(x => x.textContent.includes('组成聚合组'));
      if (t) t.click();
      return !!t;
    });
    await new Promise(r => setTimeout(r, 250));
    await page.evaluate(() => {
      const inp = document.querySelector('#modalRoot .overlay input[name="agg"]');
      inp.value = 'Eth-Trunk1';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#modalRoot .overlay button[type=submit]').click();
    });
    await new Promise(r => setTimeout(r, 300));
    const aggs = await page.evaluate(() => window.__topo.state.links.map(l => l.agg));
    await clickMenuItem('btnDropLayout', '拓扑校验');
    await new Promise(r => setTimeout(r, 250));
    const rep2 = await page.evaluate(() => [...document.querySelectorAll('#modalRoot .overlay .v-msg')].map(v => v.textContent));
    await closeOverlay();
    const aggOk = rep1.some(t => t.includes('平行链路')) && aggItem && aggs.length === 2 && aggs.every(a => a === 'Eth-Trunk1')
      && !rep2.some(t => t.includes('平行链路'));
    console.log('聚合组校验豁免:', aggOk ? 'OK' : 'FAIL', JSON.stringify({ before: rep1.length, aggs, after: rep2.length }));
    if (!aggOk) errors.push('[agg] 聚合组标记后平行链路提示未豁免: ' + JSON.stringify({ rep1, aggs, rep2 }));
  }

  // ---- 保存工程：下载拦截 + 文件内容断言（导出管线集成） ----
  {
    const dlDir = path.join(__dirname, '_e2e-dl');
    require('fs').rmSync(dlDir, { recursive: true, force: true });
    require('fs').mkdirSync(dlDir, { recursive: true });
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
    await clickMenuItem('btnDropFile', '保存工程');
    await new Promise(r => setTimeout(r, 250));
    await page.evaluate(() => document.querySelector('#modalRoot .overlay [data-act=save]').click());
    await new Promise(r => setTimeout(r, 1200));
    const files = require('fs').readdirSync(dlDir).filter(f => f.endsWith('.nettopo'));
    let saved = null;
    if (files.length) {
      const data = JSON.parse(require('fs').readFileSync(path.join(dlDir, files[0]), 'utf8'));
      saved = { nodes: (data.nodes || []).length, links: (data.links || []).length, ver: data.ver || data.version || '' };
    }
    client.detach();
    require('fs').rmSync(dlDir, { recursive: true, force: true });
    const saveOk = files.length === 1 && saved && saved.nodes === 2 && saved.links === 2;
    console.log('保存工程下载:', saveOk ? 'OK' : 'FAIL', JSON.stringify({ files, saved }));
    if (!saveOk) errors.push('[save] 保存工程未产出有效文件: ' + JSON.stringify({ files, saved }));
  }

  // ---- 接口总表 CSV 导出：下载拦截 + 表头/行数内容断言 ----
  {
    await page.evaluate(() => { window.__topo.loadSample(); });
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => { const b = document.querySelector('#modalRoot [data-act=yes]'); if (b) b.click(); });
    await new Promise(r => setTimeout(r, 1500));
    const dlDir = path.join(__dirname, '_e2e-dl');
    require('fs').rmSync(dlDir, { recursive: true, force: true });
    require('fs').mkdirSync(dlDir, { recursive: true });
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
    await clickMenuItem('btnDropEdit', '接口总表');
    await new Promise(r => setTimeout(r, 250));
    const rowCount = await page.evaluate(() => document.querySelectorAll('#modalRoot .overlay #iftBody tr[data-key]').length);
    await page.evaluate(() => document.querySelector('#modalRoot .overlay [data-act=csv]').click());
    await new Promise(r => setTimeout(r, 1200));
    const files = require('fs').readdirSync(dlDir).filter(f => f.endsWith('.csv'));
    let csv = null;
    if (files.length) {
      const lines = require('fs').readFileSync(path.join(dlDir, files[0]), 'utf8').trim().split(/\r?\n/);
      csv = { lines: lines.length, head: lines[0] };
    }
    await closeOverlay();
    client.detach();
    require('fs').rmSync(dlDir, { recursive: true, force: true });
    const csvOk = files.length === 1 && csv && csv.lines === rowCount + 1 && csv.head.includes('设备') && csv.head.includes('聚合组');
    console.log('接口总表 CSV 导出:', csvOk ? 'OK' : 'FAIL', JSON.stringify({ rowCount, files, csv }));
    if (!csvOk) errors.push('[csvexport] 接口总表 CSV 导出内容不符: ' + JSON.stringify({ rowCount, files, csv }));
  }

  // ---- Excel（xlsx）导入管线：Node 侧用内置 xlsx 库生成文件 → 文件选择器上传 ----
  {
    await page.evaluate(() => { window.__topo.newGraph(); });
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => { const b = document.querySelector('#modalRoot [data-act=yes]'); if (b) b.click(); });
    await new Promise(r => setTimeout(r, 300));
    const XLSX = require(path.join(__dirname, '..', 'lib', 'xlsx.full.min.js'));
    const ws = XLSX.utils.aoa_to_sheet([
      ['源设备', '源接口', '源IP', '目标设备', '目标接口', '目标IP'],
      ['ExcelA', 'GE0/0/1', '10.9.1.1', 'ExcelB', 'GE0/0/2', '10.9.1.2'],
      ['ExcelB', 'GE0/0/24', '10.9.2.2', 'ExcelC', 'GE0/0/1', '10.9.2.1']
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '拓扑');
    const tmpX = path.join(__dirname, '_e2e-import.xlsx');
    require('fs').writeFileSync(tmpX, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    await page.$eval('input#fileInput', (el) => { el.value = ''; });
    const fileInput = await page.$('input#fileInput');
    await fileInput.uploadFile(tmpX);
    await new Promise(r => setTimeout(r, 700));
    await page.evaluate(() => { const b = document.querySelector('#modalRoot [data-act=yes]'); if (b) b.click(); });
    await new Promise(r => setTimeout(r, 600));
    const imp = await page.evaluate(() => {
      const st = window.__topo.state;
      return {
        names: st.nodes.map(n => n.name).sort(),
        links: st.links.map(l => l.aIp + '>' + l.bIf).sort()
      };
    });
    require('fs').unlinkSync(tmpX);
    const impOk = imp.names.length === 3 && imp.names.includes('ExcelA') && imp.names.includes('ExcelC')
      && imp.links.length === 2 && imp.links.every(s => s.includes('10.9.1.1') || s.includes('10.9.2.2'));
    console.log('Excel 导入:', impOk ? 'OK' : 'FAIL', JSON.stringify(imp));
    if (!impOk) errors.push('[xlsx] Excel 导入未生效: ' + JSON.stringify(imp));
  }

  // ---- 接口总表勾「二层」清空 IP（与连线弹窗口径一致的集成验证） ----
  {
    await page.evaluate(() => {
      window.__topo.loadGraph({
        nodes: [
          { id: 'l2a', name: '二层A', type: 'switch', x: 0, y: 0, w: 160, h: 56 },
          { id: 'l2b', name: '二层B', type: 'switch', x: 400, y: 0, w: 160, h: 56 }
        ],
        links: [{ id: 'l2l', a: 'l2a', b: 'l2b', aIf: 'GE0/0/1', aIp: '10.5.0.1', bIf: 'GE0/0/2' }],
        texts: []
      }, 'e2e');
    });
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => { const b = document.querySelector('#modalRoot [data-act=yes]'); if (b) b.click(); });
    await new Promise(r => setTimeout(r, 300));
    await clickMenuItem('btnDropEdit', '接口总表');
    await new Promise(r => setTimeout(r, 250));
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#modalRoot .overlay #iftBody tr[data-key]')];
      const tr = rows.find(r => r.querySelector('input[data-f=ip]').value);
      const cb = tr.querySelector('input[data-f=l2]');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.evaluate(() => document.querySelector('#modalRoot .overlay [data-act=apply]').click());
    await new Promise(r => setTimeout(r, 300));
    const l2res = await page.evaluate(() => {
      const l = window.__topo.state.links[0];
      return { aIp: l.aIp, aL2: l.aL2, aIf: l.aIf };
    });
    const l2Ok = l2res.aIp === '' && l2res.aL2 === true && l2res.aIf === 'GE0/0/1';
    console.log('二层勾选清 IP:', l2Ok ? 'OK' : 'FAIL', JSON.stringify(l2res));
    if (!l2Ok) errors.push('[l2] 勾二层未清空 IP: ' + JSON.stringify(l2res));
  }

  // ---- 主题切换：暗色 attribute 应用 + 描边颜色随主题变化（:where() 特异性回归） ----
  {
    const before = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      stroke: getComputedStyle(document.querySelector('g.node .shape')).stroke
    }));
    await page.evaluate(() => document.getElementById('btnTheme').click());
    await new Promise(r => setTimeout(r, 150));
    const dark = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      stroke: getComputedStyle(document.querySelector('g.node .shape')).stroke
    }));
    await page.evaluate(() => document.getElementById('btnTheme').click());
    await new Promise(r => setTimeout(r, 150));
    const back = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      stroke: getComputedStyle(document.querySelector('g.node .shape')).stroke
    }));
    const themeOk = before.theme === 'light' && dark.theme === 'dark' && dark.stroke.startsWith('rgba(0, 0, 0')
      && back.theme === 'light' && back.stroke.startsWith('rgba(15, 23, 42');
    console.log('主题切换描边:', themeOk ? 'OK' : 'FAIL', JSON.stringify({ before, dark, back }));
    if (!themeOk) errors.push('[theme] 主题切换描边未生效: ' + JSON.stringify({ before, dark, back }));
  }

  // ---- 区域慢速拖动（回归：moved 须按累计位移判定，慢速拖动也要有撤销点） ----
  // 重新载入示例 → 建一个罩住首台设备的区域 → 1px/步 慢速拖动（合成 pointer 事件，避开上层链路命中层）→ 断言区域被移动且 Ctrl+Z 能还原
  await page.evaluate(() => { window.__topo.loadSample(); });
  await new Promise(r => setTimeout(r, 200));
  await page.evaluate(() => { const b = document.querySelector('#modalRoot [data-act=yes]'); if (b) b.click(); }); // 画布非空时出现「替换当前拓扑」确认
  await new Promise(r => setTimeout(r, 1600));
  const rg = await page.evaluate(() => {
    const st = window.__topo.state, rd = window.__topo.renderer;
    const n = st.nodes[0];
    st.regions = [{ id: 'rg_e2e', name: '测试区域', x: n.x - 180, y: n.y - 120, w: 420, h: 280, color: '#3b82f6' }];
    rd.setData(st.nodes, st.links, st.texts, st.regions);
    return { rx: st.regions[0].x, ry: st.regions[0].y };
  });
  await page.evaluate(() => {
    const svg = document.querySelector('#svg');
    const fill = document.querySelector('g.region[data-id="rg_e2e"] rect.region-fill');
    const b = fill.getBoundingClientRect();
    const sx = b.left + 30, sy = b.top + b.height - 30; // 左下角空白处（避开区域内设备/标题/链路命中层）
    const pe = (type, x, y, tgt) => tgt.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true,
      clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1
    }));
    pe('pointerdown', sx, sy, fill);
    for (let i = 1; i <= 120; i++) pe('pointermove', sx + i, sy - i * 0.7, svg); // 1px/步：每步增量远小于判定阈值
    pe('pointerup', sx + 120, sy - 84, svg);
  });
  await new Promise(r => setTimeout(r, 250));
  const rgMoved = await page.evaluate(() => window.__topo.state.regions[0].x);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyZ');
  await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 250));
  const rgUndo = await page.evaluate(() => window.__topo.state.regions[0].x);
  const dragOk = Math.abs(rgMoved - rg.rx) > 50 && Math.abs(rgUndo - rg.rx) < 1;
  console.log('区域慢速拖动+撤销:', dragOk ? 'OK' : 'FAIL', JSON.stringify({ before: rg.rx, after: rgMoved, undo: rgUndo }));
  if (!dragOk) errors.push('[region] 慢速拖动未记为拖动或撤销未还原（before=' + rg.rx + ' after=' + rgMoved + ' undo=' + rgUndo + '）');

  console.log(errors.length ? '发现错误:\n' + errors.join('\n') : '无控制台错误 ✓');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error('e2e 失败:', e.message); process.exit(1); });
