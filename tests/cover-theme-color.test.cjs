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
  // 颜色已由 UI 完成饱和度与明度处理，宿主必须原样使用 RGB。
  const samples = ['255,205,110', '255,180,205', '170,215,255', '175,240,190',
    '220,195,255', '255,255,255', '180,180,180', '24,65,90', '0,0,0'];
  for (const sample of samples) {
    for (const opacity of [0, 0.4, 0.95, 1]) {
      const color = coverThemeLyricColor(sample, opacity);
      assert.equal(color, `rgba(${sample.split(',').join(', ')}, ${opacity.toFixed(2)})`);
      assert.equal(await win.webContents.executeJavaScript(`CSS.supports('color', ${JSON.stringify(color)})`), true);
    }
  }
  console.log('Cover theme colors: UI RGB passthrough, local opacity and invalid input passed');
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => fs.rmSync(userData, { recursive: true, force: true }));
