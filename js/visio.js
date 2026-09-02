/* ============================================================
 * NetTopo visio.js —— 导出 Visio VDX (Visio 2003 XML Drawing)
 *
 * 参照真实 Visio 导出文件（VisioAutomation 模板 / Lucidchart VDX）：
 *   - 命名空间 http://schemas.microsoft.com/visio/2003/core
 *   - 所有 cell 值采用「元素文本内容」形式 <PinX>1.5</PinX>
 *     （注意：<PinX V="1.5"/> 属性形式会被 Visio 忽略，导致空白页！）
 *   - 1-D 连线包含 XForm1D + 公式型 XForm（拖拽端点时自动更新）
 *   - FaceNames / StyleSheets(No Style) / Colors 文档结构
 *   - 文本 <pp IX/><cp IX/> 顺序，多行用多个 pp 段落
 * 纯函数 buildVDX(graph, opts) → XML 字符串，可在 Node 中测试。
 * ============================================================ */
(function (global) {
'use strict';
const U = global.TopoUtil;

function buildVDX(graph, opts) {
  opts = opts || {};
  const scale = opts.scale || 1 / 96;          // px → 英寸
  const margin = opts.margin != null ? opts.margin : 0.5;
  const pageName = opts.pageName || '网络拓扑图';
  const nodes = graph.nodes || [];
  const links = graph.links || [];
  const IN = (v) => Math.round(v * 1000) / 1000;
  const X = (v) => U.escXml(String(v));

  /* ---------- 页面尺寸 ---------- */
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 600; }
  const pad = margin / scale;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const pw = Math.max((maxX - minX) * scale, 8.5);
  const ph = Math.max((maxY - minY) * scale, 11);
  const Y = (y) => ph - (y - minY) * scale; // Visio Y 轴向上

  /* ---------- 形状 ID ---------- */
  let sid = 2;
  const nodeShape = new Map();
  for (const n of nodes) nodeShape.set(n.id, sid++);
  const linkShape = new Map();
  for (const l of links) linkShape.set(l.id, sid++);

  /* cell 文本形式 */
  const c = (name, v, extra) =>
    `      <${name}${extra ? ' ' + extra : ''}>${IN(v)}</${name}>\n`;
  const cText = (name, v, extra) =>
    `      <${name}${extra ? ' ' + extra : ''}>${X(v)}</${name}>\n`;
  const cF = (name, v, formula, extra) =>
    `      <${name}${extra ? ' ' + extra : ''} F='${formula}'>${IN(v)}</${name}>\n`;

  /* Char / Para / TextBlock 公共片段 */
  const charSection = (fontId, color, bold, sizeIn) =>
    `    <Char IX='0'>
      <Font>${fontId}</Font>
      <Color>${color}</Color>
      <Style>${bold ? 1 : 0}</Style>
      <Case>0</Case>
      <Pos>0</Pos>
      <Size>${sizeIn}</Size>
      <Strikethru>0</Strikethru>
      <ColorTrans>0</ColorTrans>
      <AsianFont>${fontId}</AsianFont>
      <ComplexScriptFont>${fontId}</ComplexScriptFont>
    </Char>`;

  const paraSection = (horz) =>
    `    <Para IX='0'>
      <IndFirst>0</IndFirst>
      <IndLeft>0</IndLeft>
      <IndRight>0</IndRight>
      <SpLine Unit='DT'>-1.2</SpLine>
      <SpBefore>0</SpBefore>
      <SpAfter>0</SpAfter>
      <HorzAlign>${horz}</HorzAlign>
      <Bullet>0</Bullet>
    </Para>`;

  /* 多段落：每个 pp IX 对应一个 Para 行（否则段落引用缺失、文字重叠） */
  const paraMulti = (count, horz) => Array.from({ length: count }, (_, i) =>
    `    <Para IX='${i}'>
      <IndFirst>0</IndFirst>
      <IndLeft>0</IndLeft>
      <IndRight>0</IndRight>
      <SpLine Unit='DT'>-1.2</SpLine>
      <SpBefore>0</SpBefore>
      <SpAfter>0</SpAfter>
      <HorzAlign>${horz}</HorzAlign>
      <Bullet>0</Bullet>
    </Para>`).join('\n');

  const textBlock = () =>
    `    <TextBlock>
      <LeftMargin>0.05</LeftMargin>
      <RightMargin>0.05</RightMargin>
      <TopMargin>0.02</TopMargin>
      <BottomMargin>0.02</BottomMargin>
      <VerticalAlign>1</VerticalAlign>
    </TextBlock>`;

  /* ---------- 设备形状 ---------- */
  const shapeParts = [];
  for (const n of nodes) {
    const t = U.getType(n.type);
    const cx = (n.x + n.w / 2 - minX) * scale;
    const cy = Y(n.y + n.h / 2);
    const w = n.w * scale, h = n.h * scale;
    const sid_ = nodeShape.get(n.id);
    shapeParts.push(`  <Shape ID='${sid_}' Type='Shape' LineStyle='0' FillStyle='0' TextStyle='0'>
    <XForm>
${c('PinX', cx, "Unit='IN'")}${c('PinY', cy, "Unit='IN'")}${c('Width', w, "Unit='IN'")}${c('Height', h, "Unit='IN'")}${cF('LocPinX', w / 2, 'Width*0.5', "Unit='IN'")}${cF('LocPinY', h / 2, 'Height*0.5', "Unit='IN'")}
      <Angle>0</Angle>
      <FlipX>0</FlipX>
      <FlipY>0</FlipY>
      <ResizeMode>0</ResizeMode>
    </XForm>
    <Geom IX='0'>
      <NoFill>0</NoFill>
      <NoLine>0</NoLine>
      <NoShow>0</NoShow>
      <MoveTo IX='1'>
${cF('X', 0, 'Width*0', "Unit='IN'")}${cF('Y', 0, 'Height*0', "Unit='IN'")}      </MoveTo>
      <LineTo IX='2'>
${cF('X', w, 'Width*1', "Unit='IN'")}${cF('Y', 0, 'Height*0', "Unit='IN'")}      </LineTo>
      <LineTo IX='3'>
${cF('X', w, 'Width*1', "Unit='IN'")}${cF('Y', h, 'Height*1', "Unit='IN'")}      </LineTo>
      <LineTo IX='4'>
${cF('X', 0, 'Width*0', "Unit='IN'")}${cF('Y', h, 'Height*1', "Unit='IN'")}      </LineTo>
      <LineTo IX='5'>
${cF('X', 0, 'Width*0', "Unit='IN'")}${cF('Y', 0, 'Height*0', "Unit='IN'")}      </LineTo>
    </Geom>
    <TextXForm>
${cF('TxtPinX', w / 2, 'Width*0.5', "Unit='IN'")}${cF('TxtPinY', h / 2, 'Height*0.5', "Unit='IN'")}${cF('TxtWidth', w * 0.94, 'Width*0.94', "Unit='IN'")}${cF('TxtHeight', h * 0.86, 'Height*0.86', "Unit='IN'")}${cF('TxtLocPinX', w * 0.47, 'TxtWidth*0.5', "Unit='IN'")}${cF('TxtLocPinY', h * 0.43, 'TxtHeight*0.5', "Unit='IN'")}
      <TxtAngle>0</TxtAngle>
    </TextXForm>
    <Fill>
      <FillForegnd>${X(t.c1)}</FillForegnd>
      <FillBkgnd>${X(t.c2)}</FillBkgnd>
      <FillForegndTrans>0</FillForegndTrans>
      <FillBkgndTrans>0</FillBkgndTrans>
      <FillPattern>1</FillPattern>
      <ShapeShdwType>1</ShapeShdwType>
      <ShapeShdwOffsetX>0.08</ShapeShdwOffsetX>
      <ShapeShdwOffsetY>0.08</ShapeShdwOffsetY>
    </Fill>
    <Line>
      <LineWeight>0.01</LineWeight>
      <LineColor>${X(t.stroke)}</LineColor>
      <LineColorTrans>0</LineColorTrans>
      <LinePattern>1</LinePattern>
      <Rounding>0.08</Rounding>
      <BeginArrow>0</BeginArrow>
      <EndArrow>0</EndArrow>
      <BeginArrowSize>2</BeginArrowSize>
      <EndArrowSize>2</EndArrowSize>
    </Line>
${charSection(6, '#FFFFFF', true, 0.166667)}
${paraSection(1)}
${textBlock()}
    <Prop Name='type'>
${cText('Label', t.label)}${cText('Value', t.label)}
    </Prop>
    <Prop Name='note'>
${cText('Label', '备注')}${cText('Value', n.note || '')}
    </Prop>
    <Text><pp IX='0'/><cp IX='0'/>${X(n.name)}</Text>
  </Shape>`);
  }

  /* ---------- 连线形状（1-D，仅画线） + 独立文本框（2-D，永远水平） ---------- */
  const byId = {};
  for (const n of nodes) byId[n.id] = n;

  for (const l of links) {
    const a = byId[l.a], b = byId[l.b];
    if (!a || !b) continue;
    const p1 = U.anchorPoint(a.x + a.w / 2, a.y + a.h / 2, a.w / 2, a.h / 2,
      b.x + b.w / 2, b.y + b.h / 2);
    const p2 = U.anchorPoint(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2,
      a.x + a.w / 2, a.y + a.h / 2);
    const bx = (p1.x - minX) * scale, by = Y(p1.y);
    const ex = (p2.x - minX) * scale, ey = Y(p2.y);
    const len = Math.hypot(ex - bx, ey - by);
    const mx = (bx + ex) / 2, my = (by + ey) / 2;
    const sid_ = linkShape.get(l.id);

    shapeParts.push(`  <Shape ID='${sid_}' Type='Shape' LineStyle='0' FillStyle='0' TextStyle='0'>
    <XForm1D>
${c('BeginX', bx, "Unit='IN'")}${c('BeginY', by, "Unit='IN'")}${c('EndX', ex, "Unit='IN'")}${c('EndY', ey, "Unit='IN'")}
    </XForm1D>
    <XForm>
${cF('Width', len, 'SQRT((EndX-BeginX)^2+(EndY-BeginY)^2)', "Unit='IN'")}
      <Height>0.02</Height>
${cF('PinX', mx, '(BeginX+EndX)/2', "Unit='IN'")}${cF('PinY', my, '(BeginY+EndY)/2', "Unit='IN'")}${cF('LocPinX', len / 2, 'Width*0.5', "Unit='IN'")}
      <LocPinY>0.01</LocPinY>
${cF('Angle', Math.PI, 'ATAN2(EndY-BeginY,EndX-BeginX)', '')}
      <FlipX>0</FlipX>
      <FlipY>0</FlipY>
      <ResizeMode>0</ResizeMode>
    </XForm>
    <Line>
      <LineWeight>0.01</LineWeight>
      <LineColor>${X(U.bwColor(l.bw))}</LineColor>
      <LineColorTrans>0</LineColorTrans>
      <LinePattern>1</LinePattern>
      <Rounding>0</Rounding>
      <BeginArrow>0</BeginArrow>
      <EndArrow>0</EndArrow>
      <BeginArrowSize>2</BeginArrowSize>
      <EndArrowSize>2</EndArrowSize>
    </Line>
    <Geom IX='0'>
      <NoFill>1</NoFill>
      <NoLine>0</NoLine>
      <NoShow>0</NoShow>
      <MoveTo IX='1'>
${cF('X', 0, 'Width*0', '')}${cF('Y', 0, 'Height*0', '')}      </MoveTo>
      <LineTo IX='2'>
${cF('X', len, 'Width*1', '')}${cF('Y', 0, 'Height*0', '')}      </LineTo>
    </Geom>
  </Shape>`);

    /* ---- 独立的 2D 文本框（水平、透明、无边框） ---- */
    const lines = U.labelLines(l);
    const tw = 2.3, th = 0.55;
    const tpx = mx, tpy = my + 0.32; // 线中点上方（Visio Y 向上）
    let textRuns = '';
    lines.forEach((ln, i) => {
      textRuns += `<pp IX='${i}'/>${i === 0 ? "<cp IX='0'/>" : ''}` + X(ln);
    });
    const sidT = sid++; // 文本框 ID：与全部形状共用同一计数器（固定偏移 +10000 在链路过万时与线 ID 重叠）
    shapeParts.push(`  <Shape ID='${sidT}' Type='Shape' NameU='Label${sidT}' Name='标注-${X((l.aIf || '') + '-' + (l.bIf || ''))}'>
    <XForm>
${c('PinX', tpx, "Unit='IN'")}${c('PinY', tpy, "Unit='IN'")}${c('Width', tw, "Unit='IN'")}${c('Height', th, "Unit='IN'")}${cF('LocPinX', tw / 2, 'Width*0.5', "Unit='IN'")}${cF('LocPinY', th / 2, 'Height*0.5', "Unit='IN'")}
      <Angle>0</Angle>
      <FlipX>0</FlipX>
      <FlipY>0</FlipY>
      <ResizeMode>0</ResizeMode>
    </XForm>
    <Geom IX='0'>
      <NoFill>1</NoFill>
      <NoLine>1</NoLine>
      <NoShow>0</NoShow>
      <MoveTo IX='1'>
${cF('X', 0, 'Width*0', '')}${cF('Y', 0, 'Height*0', '')}      </MoveTo>
      <LineTo IX='2'>
${cF('X', tw, 'Width*1', '')}${cF('Y', 0, 'Height*0', '')}      </LineTo>
      <LineTo IX='3'>
${cF('X', tw, 'Width*1', '')}${cF('Y', th, 'Height*1', '')}      </LineTo>
      <LineTo IX='4'>
${cF('X', 0, 'Width*0', '')}${cF('Y', th, 'Height*1', '')}      </LineTo>
      <LineTo IX='5'>
${cF('X', 0, 'Width*0', '')}${cF('Y', 0, 'Height*0', '')}      </LineTo>
    </Geom>
    <Fill>
      <FillForegnd>#FFFFFF</FillForegnd>
      <FillBkgnd>#FFFFFF</FillBkgnd>
      <FillPattern>0</FillPattern>
    </Fill>
    <Line>
      <LineWeight>0</LineWeight>
      <LineColor>#FFFFFF</LineColor>
      <LinePattern>0</LinePattern>
    </Line>
${charSection(6, '#334155', false, 0.125)}
${paraMulti(Math.max(lines.length, 1), 1)}
${textBlock()}
    <Text>${textRuns}</Text>
  </Shape>`);
  }

  /* ---------- 粘合：连线两端 → 设备中心 ---------- */
  const connects = links
    .map(l => {
      if (!byId[l.a] || !byId[l.b]) return '';
      return `  <Connect FromSheet='${linkShape.get(l.id)}' FromCell='BeginX' ToSheet='${nodeShape.get(l.a)}' ToCell='PinX'/>\n  <Connect FromSheet='${linkShape.get(l.id)}' FromCell='EndX' ToSheet='${nodeShape.get(l.b)}' ToCell='PinX'/>`;
    })
    .filter(Boolean).join('\n');

  const xml = `<?xml version='1.0' encoding='UTF-8'?>
<VisioDocument start='190' metric='0' xml:space='preserve' xmlns='http://schemas.microsoft.com/visio/2003/core'>
  <DocumentProperties>
    <Creator>网络拓扑管理软件</Creator>
    <Company>NetTopo</Company>
    <Desc>由网络拓扑管理软件导出的网络拓扑图，可在 Visio 中继续编辑</Desc>
    <BuildNumberCreated>805312791</BuildNumberCreated>
    <BuildNumberEdited>805312791</BuildNumberEdited>
  </DocumentProperties>
  <DocumentSettings>
    <GlueSettings>9</GlueSettings>
    <SnapSettings>15</SnapSettings>
  </DocumentSettings>
  <Colors>
    <ColorEntry IX='0' RGB='#000000'/>
    <ColorEntry IX='1' RGB='#FFFFFF'/>
    <ColorEntry IX='2' RGB='#FF0000'/>
    <ColorEntry IX='3' RGB='#00FF00'/>
    <ColorEntry IX='4' RGB='#0000FF'/>
  </Colors>
  <FaceNames>
    <FaceName ID='1' Name='Arial Unicode MS' UnicodeRanges='-1 -369098753 63 0' CharSets='1614742015 -65536' Panos='2 11 6 4 2 2 2 2 2 4' Flags='357'/>
    <FaceName ID='4' Name='Arial' UnicodeRanges='-536859905 -1073711037 9 0' CharSets='1073742335 -65536' Panos='2 11 6 4 2 2 2 2 2 4' Flags='325'/>
    <FaceName ID='5' Name='SimSun' UnicodeRanges='3 680460288 6 0' CharSets='262145 0' Panos='2 1 6 0 3 1 1 1 1 1' Flags='421'/>
    <FaceName ID='6' Name='Microsoft YaHei' UnicodeRanges='-536859905 -1073711037 9 0' CharSets='1073742335 -65536' Panos='2 1 6 0 3 1 1 1 1 1' Flags='325'/>
  </FaceNames>
  <StyleSheets>
    <StyleSheet ID='0' NameU='No Style' Name='No Style'>
      <StyleProp>
        <EnableLineProps>1</EnableLineProps>
        <EnableFillProps>1</EnableFillProps>
        <EnableTextProps>1</EnableTextProps>
        <HideForApply>0</HideForApply>
      </StyleProp>
      <Line>
        <LineWeight>0.01</LineWeight>
        <LineColor>0</LineColor>
        <LineColorTrans>0</LineColorTrans>
        <LinePattern>1</LinePattern>
        <Rounding>0</Rounding>
        <BeginArrow>0</BeginArrow>
        <EndArrow>0</EndArrow>
        <BeginArrowSize>2</BeginArrowSize>
        <EndArrowSize>2</EndArrowSize>
      </Line>
      <Fill>
        <FillForegnd>0</FillForegnd>
        <FillBkgnd>1</FillBkgnd>
        <FillForegndTrans>0</FillForegndTrans>
        <FillBkgndTrans>0</FillBkgndTrans>
        <FillPattern>1</FillPattern>
        <ShapeShdwType>1</ShapeShdwType>
        <ShapeShdwOffsetX>0.08</ShapeShdwOffsetX>
        <ShapeShdwOffsetY>0.08</ShapeShdwOffsetY>
      </Fill>
      <Char IX='0'>
        <Font>4</Font>
        <Color>0</Color>
        <Style>0</Style>
        <Size>0.1666666666666667</Size>
      </Char>
      <Para IX='0'>
        <HorzAlign>0</HorzAlign>
      </Para>
    </StyleSheet>
  </StyleSheets>
  <Pages>
    <Page ID='0' Name='${X(pageName)}'>
      <PageSheet LineStyle='0' FillStyle='0' TextStyle='0'>
        <PageProps>
${c('PageWidth', pw, "Unit='IN'")}${c('PageHeight', ph, "Unit='IN'")}
          <PageScale>1</PageScale>
          <DrawingScale>1</DrawingScale>
          <DrawingSizeType>4</DrawingSizeType>
          <DrawingScaleType>0</DrawingScaleType>
        </PageProps>
      </PageSheet>
      <Shapes>
${shapeParts.join('\n')}
      </Shapes>
      <Connects>
${connects}
      </Connects>
    </Page>
  </Pages>
</VisioDocument>
`;
  return xml;
}

global.TopoVisio = { buildVDX };
})(typeof globalThis !== 'undefined' ? globalThis : this);
