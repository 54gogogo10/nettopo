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
    labels: [...document.querySelectorAll('.link .lb')].filter(t => t.textContent.trim()).length,
    statGraph: document.querySelector('#statGraph').textContent,
    emptyHidden: document.querySelector('#empty').classList.contains('hidden'),
    svgSize: document.querySelector('#svg').getBoundingClientRect().width + 'x' + document.querySelector('#svg').getBoundingClientRect().height,
    zoom: document.querySelector('#zVal').textContent
  }));
  console.log('画布统计:', JSON.stringify(stats));
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

  console.log(errors.length ? '发现错误:\n' + errors.join('\n') : '无控制台错误 ✓');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error('e2e 失败:', e.message); process.exit(1); });
