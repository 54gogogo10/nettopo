/* NetTopo e2e：无头 Chrome 加载页面、自动载入示例、截图并收集控制台错误 */
'use strict';
const path = require('path');
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
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

  console.log(errors.length ? '发现错误:\n' + errors.join('\n') : '无控制台错误 ✓');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error('e2e 失败:', e.message); process.exit(1); });
