// Run: pnpm exec electron tests/cover-theme-color.test.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { stripTypeScriptTypes } = require('node:module');
const vm = require('node:vm');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'metmusic-color-test-'));
app.setPath('userData', userData);
const context = { exports: {} };
vm.runInNewContext(stripTypeScriptTypes(fs.readFileSync(path.resolve('src/renderer/shared/color.ts'), 'utf8'))
  .replace(/export function /g, 'function ') + '\nexports.coverThemeLyricColor = coverThemeLyricColor;', context);
const { coverThemeLyricColor } = context.exports;

app.whenReady().then(async () => {
  for (const invalid of [undefined, '', ' ', '255,,0', '256,0,0', '-1,0,0', 'red']) {
    assert.equal(coverThemeLyricColor(invalid), null);
  }
  const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { offscreen: true, backgroundThrottling: false } });
  await win.loadURL('about:blank');
  const hsv = ([r, g, b]) => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    let hue = 0;
    if (delta) hue = max === r ? ((g - b) / delta + 6) % 6
      : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    return { h: hue * 60, s: max ? delta / max : 0, v: max };
  };
  const samples = ['255,205,110', '255,180,205', '170,215,255', '175,240,190',
    '220,195,255', '250,235,240', '255,80,80', '255,255,255', '180,180,180',
    '24,65,90', '40,30,55', '250,249,249', '0,0,0', '255,0,0', '0,0,255'];
  for (const sample of samples) {
    const color = coverThemeLyricColor(sample);
    const result = await win.webContents.executeJavaScript(`(() => {
      const color = ${JSON.stringify(color)};
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return { supported: CSS.supports('color', color), pixels: [...ctx.getImageData(0, 0, 1, 1).data] };
    })()`);
    assert.ok(result.supported);
    const before = hsv(sample.split(',').map(Number));
    const after = hsv(result.pixels);
    if (before.s >= 0.12) {
      assert.ok(after.s >= 0.87, `actually rendered saturation stays high: ${sample}`);
      assert.ok(after.v >= 249, `actually rendered color is bright: ${sample}`);
      const hueDelta = Math.abs(before.h - after.h);
      assert.ok(Math.min(hueDelta, 360 - hueDelta) < 1.5, `hue preserved: ${sample}`);
    }
    if (before.s <= 0.02) {
      assert.ok(after.s < 0.025, `neutrals are not artificially tinted: ${sample}`);
      assert.ok(Math.abs(after.v - before.v) <= 1, 'neutral brightness preserved');
    }
    assert.ok(Math.abs(result.pixels[3] / 255 - 0.95) < 0.005, 'alpha retained');
  }
  // Low-saturation colors must not jump abruptly from gray to vivid.
  let previous;
  for (let green = 255; green >= 215; green--) {
    const rgb = coverThemeLyricColor(`255,${green},${green}`).match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number);
    if (previous) assert.ok(Math.max(...rgb.map((v, i) => Math.abs(v - previous[i]))) < 15);
    previous = rgb;
  }
  if (process.env.METMUSIC_COLOR_PREVIEW) {
    const rows = samples.slice(0, 7).map(sample => {
      const previous = `oklch(from rgb(${sample}) min(l, 0.72) calc(c + min(c, 0.08) * clamp(0, (l - 0.60) / 0.15, 1)) h / 0.95)`;
      return `<section>${[`rgb(${sample})`, previous, coverThemeLyricColor(sample)].map(color =>
        `<div><i style="background:${color}"></i><span style="color:${color}">音乐，让色彩发光</span><small style="color:${color}">音乐，让色彩发光</small></div>`).join('')}</section>`;
    }).join('');
    const html = `<style>body{margin:28px;background:#f4f5f7;font-family:Arial,sans-serif}h1{font-size:23px;margin:0 0 8px}p{color:#687080;font-size:13px;margin:0 0 20px}header,section{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}header{margin-bottom:10px;color:#596273;font-size:14px}section{margin-bottom:8px}section div{background:white;border-radius:8px;padding:10px}i{display:inline-block;width:17px;height:17px;border-radius:5px;margin-right:10px}span{font-size:21px;font-weight:800}small{display:block;background:#242936;padding:6px 12px;border-radius:4px;margin-top:7px;font-size:18px;font-weight:800}</style><h1>桌面歌词 · 鲜艳取色对比</h1><p>同一封面主题色，在浅色 / 深色背景下的显示效果</p><header><div>原始封面色</div><div>上一版 · 限制亮度</div><div>新版 · 高饱和、高亮度</div></header>${rows}`;
    await win.webContents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(html)}`);
    await new Promise(resolve => setTimeout(resolve, 300));
    fs.writeFileSync(process.env.METMUSIC_COLOR_PREVIEW, (await win.webContents.capturePage()).toPNG());
  }
  console.log('Cover theme colors: rendered saturation/brightness, hue, neutrals, smooth transitions and invalid input passed');
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => fs.rmSync(userData, { recursive: true, force: true }));
