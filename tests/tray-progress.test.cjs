// pnpm exec electron tests/tray-progress.test.cjs
// Real NativeImage rendering; deterministic clock and an in-memory system tray.
const { app, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require(require.resolve('esbuild', { paths: [require.resolve('electron-vite')] }));

function checkPlatform(platform) {
    let enabled = false;
    let now = 1000;
    let interval = null;
    let currentTray;
    class TestTray {
        constructor(image) { this.image = image; this.title = ''; this.destroyed = false; currentTray = this; }
        setImage(image) { this.image = image; }
        setTitle(title) { this.title = title; }
        setToolTip(tooltip) { this.tooltip = tooltip; }
        setContextMenu() {}
        on() {}
        isDestroyed() { return this.destroyed; }
        destroy() { this.destroyed = true; }
    }
    const dependencies = {
        electron: { app, nativeImage, Tray: TestTray, Menu: { buildFromTemplate: value => value } },
        'node:path': path,
        './app-config': { getConfig: () => ({ trayProgress: enabled }) },
        './config': { getConfig: () => ({}) },
        './window-manager': { isLyricWindowVisible: () => false },
        './updater': {},
    };
    const module = { exports: {} };
    const source = esbuild.transformSync(fs.readFileSync('src/main/tray-manager.ts', 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'es2022',
    }).code;
    vm.runInNewContext(source, {
        module, exports: module.exports, require: name => {
            assert.ok(name in dependencies, `unexpected import: ${name}`);
            return dependencies[name];
        },
        __dirname: path.resolve('src/main'), Buffer, console, process: { platform },
        performance: { now: () => now },
        setInterval: callback => { interval = callback; return { unref() {} }; },
        clearInterval: () => { interval = null; },
    });
    const manager = module.exports;
    manager.createTray(() => {}, () => {}, () => {});
    const base = currentTray.image.toBitmap();
    const song = { songName: 'Test song', songArtist: 'Artist', currentTime: 30, duration: 120, isPlaying: false };
    manager.updateTrayProgress(song);
    assert.equal(currentTray.title, '');
    assert.ok(!currentTray.tooltip.includes('0:30'));
    assert.deepEqual(currentTray.image.toBitmap(), base);

    enabled = true;
    manager.applyAppConfig(song);
    assert.ok(currentTray.tooltip.includes('0:30 / 2:00'), 'enabling while paused takes effect immediately');
    if (platform === 'darwin') assert.equal(currentTray.title, '0:30 / 2:00');
    assert.notDeepEqual(currentTray.image.toBitmap(), base, 'real native image contains a progress overlay');
    assert.equal(interval, null, 'pause needs no timer');

    manager.updateTrayProgress({ ...song, isPlaying: true, playbackRate: 2 });
    assert.equal(typeof interval, 'function');
    const before = currentTray.image.toBitmap();
    now += 15000;
    interval();
    assert.ok(currentTray.tooltip.includes('1:00 / 2:00'), 'clock advances without another UI message and respects playback rate');
    assert.notDeepEqual(currentTray.image.toBitmap(), before, 'icon also advances without IPC');
    enabled = false;
    manager.applyAppConfig(song);
    assert.equal(currentTray.title, '');
    assert.ok(!currentTray.tooltip.includes(' / '));
    assert.deepEqual(currentTray.image.toBitmap(), base, 'disabling restores the original icon');
    assert.equal(interval, null, 'disabled progress stops its timer');
    enabled = true;
    manager.applyAppConfig(song);
    assert.ok(currentTray.tooltip.includes('1:00 / 2:00'), 're-enabling does not rewind to the last IPC snapshot');

    manager.updateTrayProgress({ ...song, currentTime: 5 });
    now += 10000;
    assert.ok(currentTray.tooltip.includes('0:05 / 2:00'), 'seek and pause override the running clock');
    assert.equal(interval, null);
    manager.updateTrayProgress({ ...song, duration: 0 });
    assert.equal(currentTray.title, '');
    assert.deepEqual(currentTray.image.toBitmap(), base, 'unknown duration clears progress');
    manager.updateTrayProgress({ ...song, currentTime: 119, isPlaying: true });
    now += 5000;
    interval();
    assert.ok(currentTray.tooltip.includes('2:00 / 2:00'), 'clock clamps to duration');
    assert.equal(interval, null);
    manager.updateTrayProgress({ ...song, isPlaying: true });
    manager.destroyTray();
    assert.equal(interval, null, 'destroy cleans up the clock');
    console.log(`PASS tray progress (${platform})`);
}
app.whenReady().then(() => {
    try {
        for (const platform of ['darwin', 'win32', 'linux']) checkPlatform(platform);
        app.quit();
    } catch (error) {
        console.error(error);
        app.exit(1);
    }
});
