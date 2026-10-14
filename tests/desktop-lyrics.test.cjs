// Run after pnpm build: pnpm exec electron tests/desktop-lyrics.test.cjs
// Also test StrictMode in dev: METMUSIC_LYRICS_TEST_URL=http://localhost:5173/desktop-lyrics/index.html pnpm exec electron tests/desktop-lyrics.test.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'metmusic-lyrics-test-'));
app.setPath('userData', userData);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let snapshot = null;
let reads = 0;
app.whenReady().then(async () => {
    ipcMain.handle('lyric:playback-get', () => { reads++; return snapshot; });
    ipcMain.handle('app:info', () => ({ isWayland: false }));
    ipcMain.handle('lyric:config-get', () => ({ useThemeColorForActive: false }));
    const win = new BrowserWindow({ show: false, width: 1000, height: 160,
        webPreferences: { backgroundThrottling: false,
            preload: path.resolve('out/preload/local-window.js') } });
    if (process.env.METMUSIC_LYRICS_TEST_URL) {
        await win.loadURL(process.env.METMUSIC_LYRICS_TEST_URL);
    } else {
        await win.loadFile(path.resolve('out/renderer/desktop-lyrics/index.html'));
    }
    const position = () => win.webContents.executeJavaScript(
        `Number.parseFloat(document.querySelector('.ktv-line')?.style.backgroundPositionX)`);
    const waitFor = async predicate => {
        for (let i = 0; i < 60; i++) {
            if (await predicate()) return;
            await delay(50);
        }
        throw new Error('Timed out waiting for lyric rendering');
    };
    await waitFor(() => reads > 0);
    const song = { kind: 'song', revision: 1, timestamp: Date.now(), currentTime: 1,
        duration: 30, isPlaying: true, playbackRate: 1, songName: 'Song', songArtist: 'Artist',
        lineOffset: 0, wordOffset: 0, inclusive: true,
        lyrics: [{ time: 0, content: '逐字歌词测试', words: Array.from('逐字歌词测试',
            (content, i) => ({ content, start: i * 2000, end: (i + 1) * 2000 })) }] };
    snapshot = { song, progress: song };
    win.webContents.send('lyric:playback-sync', song);
    await waitFor(async () => Number.isFinite(await position()));
    const start = await position();
    await delay(700);
    assert.ok(await position() < start - 2, 'local clock advances coloring without IPC ticks');

    // A late legacy frame clears the renderer's local song. Compact progress must recover it.
    win.webContents.send('lyric:line-change', { lyricText: '逐字歌词测试', lyricData: [], lyricTrans: '' });
    await waitFor(async () => !Number.isFinite(await position()));
    const progress = { ...song, kind: 'progress', currentTime: 2, timestamp: Date.now() };
    snapshot.progress = progress;
    win.webContents.send('lyric:playback-sync', progress);
    await waitFor(async () => Number.isFinite(await position()));
    const restored = await position();
    await delay(700);
    assert.ok(await position() < restored - 2, 'restores word timing after a legacy frame');

    // A missed full-song event must also recover when the next revision's progress arrives.
    snapshot = { song: { ...song, revision: 2 }, progress: { ...progress, revision: 2,
        currentTime: 6, isPlaying: false, timestamp: Date.now() } };
    const beforeReads = reads;
    win.webContents.send('lyric:playback-sync', snapshot.progress);
    await waitFor(async () => reads > beforeReads && Math.abs(await position() - 50) < 1);
    await delay(300); // Let the CSS transition settle before checking paused stability.
    const paused = await position();
    await delay(500);
    assert.equal(await position(), paused, 'pause freezes coloring');
    win.webContents.send('lyric:playback-sync', { ...snapshot.progress, currentTime: 1,
        timestamp: Date.now() });
    await waitFor(async () => await position() > paused + 30);
    console.log('Desktop lyrics: local coloring, legacy recovery, revision recovery, pause and seek passed');
    win.destroy();
    app.quit();
}).catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => fs.rmSync(userData, { recursive: true, force: true }));
