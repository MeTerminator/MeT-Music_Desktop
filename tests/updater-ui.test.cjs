// Run after pnpm build: pnpm exec electron tests/updater-ui.test.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  let win;
  try {
    let state = { status: 'idle', currentVersion: '2.3.0', received: 0, total: 0 };
    const values = {
      'update:state-get': () => state,
      'app:config-get': () => ({ trayProgress: true, closeAction: 'minimize', closeConfirm: true }),
      'lyric:config-get': () => null,
      'app:info': () => ({ screen: { width: 1920, height: 1080 }, isWayland: false }),
      'lyric:bounds-get': () => ({ x: 0, y: 0, width: 1200, height: 130 }),
    };
    for (const [channel, handler] of Object.entries(values)) ipcMain.handle(channel, handler);
    win = new BrowserWindow({ width: 1000, height: 760, show: false, webPreferences: { preload: path.resolve('out/preload/local-window.js'), sandbox: true, contextIsolation: true } });
    await win.loadFile(path.resolve('out/renderer/settings/index.html'));
    await delay(400);
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.nav-item')).find(el => el.textContent.includes('常规')).click()`);
    await delay(100);
    assert.ok(await win.webContents.executeJavaScript(`document.body.textContent.includes('MeT-Music v2.3.0')`));
    assert.ok(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).some(el => el.textContent.includes('检查更新') && !el.disabled)`));
    state = { ...state, status: 'downloading', version: '2.4.0', received: 5 * 1024 * 1024, total: 10 * 1024 * 1024 };
    win.webContents.send('update:state', state);
    await delay(100);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('dialog').open`), true);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('progress').value`), 50);
    assert.ok(await win.webContents.executeJavaScript(`Math.abs(document.querySelector('dialog').getBoundingClientRect().left + document.querySelector('dialog').getBoundingClientRect().width / 2 - innerWidth / 2) < 2`), 'progress dialog is centered');
    assert.ok(await win.webContents.executeJavaScript(`document.querySelector('dialog').textContent.includes('50.0%')`));
    fs.writeFileSync('/tmp/met-music-update-progress.png', (await win.webContents.capturePage()).toPNG());
    state = { ...state, status: 'downloaded', filePath: '/Downloads/test.dmg' };
    win.webContents.send('update:state', state);
    await delay(100);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('dialog').open`), false);
    assert.ok(await win.webContents.executeJavaScript(`document.body.textContent.includes('在文件夹中显示安装包')`));
    console.log('PASS settings version, check button, progress modal and completion reminder');
    win.destroy();
    app.exit(0);
  } catch (error) { console.error(error); win?.destroy(); app.exit(1); }
});
