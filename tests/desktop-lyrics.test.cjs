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
    const win = new BrowserWindow({ show: false, frame: false, width: 1000, height: 160,
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

    const layout = () => win.webContents.executeJavaScript(`(() => {
        const main = document.querySelector('main');
        const container = document.querySelector('#lyric-text-container');
        const text = document.querySelector('.lyric-wrapper:not(.lyric-scroll-leave) > div');
        const translation = document.querySelector('.lyric-tran-wrapper:not(.lyric-scroll-leave) > div');
        const bounds = element => {
            const { left, right, top, bottom } = element.getBoundingClientRect();
            return { left, right, top, bottom };
        };
        return { plain: main.classList.contains('plain-content'), main: bounds(main),
            container: bounds(container), text: bounds(text),
            translation: translation && bounds(translation),
            fontSize: parseFloat(getComputedStyle(text).fontSize),
            tx: text.style.transform, animation: text.parentElement.getAnimations().length };
    })()`);
    const assertFits = async () => {
        const result = await layout();
        assert.ok(result.plain, 'static text uses complete-fit layout');
        for (const rect of [result.text, result.translation].filter(Boolean)) {
            assert.ok(rect.left >= result.container.left && rect.right <= result.container.right,
                'complete text fits horizontally');
            assert.ok(rect.top >= result.main.top && rect.bottom <= result.main.bottom,
                'main text and translation fit vertically');
        }
        assert.equal(result.tx, 'translateX(0px)', 'static text does not pan');
        assert.equal(result.animation, 0, 'static text does not flip');
        return result;
    };
    win.webContents.send('lyric:config-changed', { showTranslation: true });
    const longText = '这是一行需要完整显示而不能裁切的普通歌词'.repeat(3);
    win.webContents.send('lyric:line-change', { lyricText: longText, lyricData: [],
        lyricTrans: 'A much longer translation that also needs to fit entirely. '.repeat(5) });
    await waitFor(async () => (await layout()).plain);
    await delay(450);
    const wide = await assertFits();
    win.setSize(300, 160);
    await delay(150);
    const narrow = await assertFits();
    assert.ok(narrow.fontSize < wide.fontSize, 'width-only resize refits static text');
    win.setSize(300, 70);
    await delay(150);
    await assertFits();
    win.setSize(100, 50);
    await delay(150);
    await assertFits();

    // Intro information in a song with word timings still uses the static layout.
    const introSong = { ...song, revision: 3, currentTime: 0, isPlaying: false,
        timestamp: Date.now(), songName: longText, songArtist: 'Artist',
        lyrics: song.lyrics.map(line => ({ ...line, time: 5000 })) };
    win.webContents.send('lyric:playback-sync', introSong);
    await delay(150);
    await assertFits();
    win.setSize(300, 160);
    win.webContents.send('lyric:playback-sync', { ...introSong, kind: 'progress',
        currentTime: 6, timestamp: Date.now() });
    await waitFor(async () => !(await layout()).plain);
    const wordLayout = await layout();
    assert.ok(wordLayout.text.right - wordLayout.text.left >
        wordLayout.container.right - wordLayout.container.left,
        'word lyrics retain large text and horizontal scrolling');

    // Switch while horizontal scrolling/coloring are still interpolating.
    const words = content => Array.from(content, content => ({ content, percent: 0.9 }));
    const oldText = '保持旧行的实际显示位置与节点，不要切行重置'.repeat(2);
    win.webContents.send('lyric:line-change', { lyricText: oldText, lyricData: words(oldText), lyricTrans: '' });
    await delay(450);
    win.webContents.send('lyric:line-change', { lyricText: oldText,
        lyricData: words(oldText).map(word => ({ ...word, percent: 1 })), lyricTrans: '' });
    await delay(40);
    await win.webContents.executeJavaScript(`window.oldLyricNode = document.querySelector('.ktv-line')`);
    const nextText = '下一行平滑进入';
    win.webContents.send('lyric:line-change', { lyricText: nextText,
        lyricData: words(nextText), lyricTrans: '' });
    await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('.lyric-scroll-leave'))`));
    const transition = await win.webContents.executeJavaScript(`(() => {
        const leaving = document.querySelector('.lyric-scroll-leave .ktv-line');
        const current = document.querySelector('.lyric-wrapper:not(.lyric-scroll-leave) .ktv-line');
        return { sameNode: leaving === window.oldLyricNode,
            transition: getComputedStyle(leaving).transitionDuration,
            currentPosition: parseFloat(current.style.backgroundPositionX),
            frozen: [getComputedStyle(leaving).transform, getComputedStyle(leaving).backgroundPositionX] };
    })()`);
    assert.ok(transition.sameNode, 'outgoing line keeps its DOM and compositor state');
    assert.equal(transition.transition, '0s', 'outgoing line does not restart horizontal/color transitions');
    assert.ok(transition.currentPosition < 20, 'new line progress is ready before entering');
    await delay(70);
    const frozen = await win.webContents.executeJavaScript(`(() => {
        const style = getComputedStyle(window.oldLyricNode);
        return [style.transform, style.backgroundPositionX];
    })()`);
    assert.deepEqual(frozen, transition.frozen, 'outgoing display remains frozen while sliding up');
    await delay(400);
    assert.equal(await win.webContents.executeJavaScript(`window.oldLyricNode.isConnected`), false,
        'outgoing line is removed after animation');

    win.webContents.send('lyric:config-changed', { strokeWidth: 4, strokeColor: '#ff0000' });
    await delay(100);
    const outline = await win.webContents.executeJavaScript(`(() => {
        const style = getComputedStyle(document.querySelector('.ktv-line'));
        return { stroke: style.webkitTextStrokeWidth, filter: style.filter };
    })()`);
    assert.equal(outline.stroke, '0px', 'outline never strokes the text itself');
    assert.ok(outline.filter.includes('lyric-outline'), 'outer contour filter is enabled');

    // Compare actual Chromium pixels: opaque glyph interiors stay identical,
    // while the selected outline color appears outside the glyphs.
    win.setSize(1000, 160);
    win.webContents.send('lyric:config-changed', { strokeWidth: 0, pausedOpacity: 100,
        colorActive: '#ffffff', colorInactive: '#ffffff' });
    await win.webContents.executeJavaScript(`document.body.style.background = '#123456'`);
    await delay(450);
    const beforeOutline = (await win.webContents.capturePage()).toBitmap();
    win.webContents.send('lyric:config-changed', { strokeWidth: 4 });
    await delay(150);
    const afterOutline = (await win.webContents.capturePage()).toBitmap();
    assert.equal(afterOutline.length, beforeOutline.length);
    let interiorPixels = 0;
    let changedInterior = 0;
    let outerPixels = 0;
    for (let i = 0; i < beforeOutline.length; i += 4) {
        const [b, g, r] = beforeOutline.subarray(i, i + 3);
        if (r > 250 && g > 250 && b > 250) {
            interiorPixels++;
            if (!beforeOutline.subarray(i, i + 4).equals(afterOutline.subarray(i, i + 4))) changedInterior++;
        }
        const [outlinedB, outlinedG, outlinedR] = afterOutline.subarray(i, i + 3);
        if (outlinedR > 200 && outlinedG < 30 && outlinedB < 30 && r < 200) outerPixels++;
    }
    assert.ok(interiorPixels > 100, 'test captures real glyph interiors');
    assert.equal(changedInterior, 0, 'outer outline does not alter glyph interiors');
    assert.ok(outerPixels > 100, 'outline is actually rendered outside the text');

    const inactive = () => win.webContents.executeJavaScript(
        `document.querySelector('#app').style.getPropertyValue('--color-inactive')`);
    win.webContents.send('lyric:config-changed', { useThemeColorForInactive: true,
        colorInactive: 'rgba(12, 34, 56, 0.4)' });
    win.webContents.send('lyric:line-change', { lyricText: '主题底色测试',
        lyricData: words('主题底色测试'), lyricTrans: '',
        coverTheme: { light: { shadeTwo: '255,0,0' }, dark: {} } });
    await waitFor(async () => await inactive() === 'rgba(255, 0, 0, 0.40)');
    win.webContents.send('lyric:config-changed', { colorInactive: 'rgba(12, 34, 56, 0)' });
    await waitFor(async () => await inactive() === 'rgba(255, 0, 0, 0.00)');
    win.webContents.send('lyric:config-changed', { useThemeColorForInactive: false });
    await waitFor(async () => await inactive() === 'rgba(12, 34, 56, 0)');
    win.webContents.send('lyric:config-changed', { useThemeColorForInactive: true });
    win.webContents.send('lyric:line-change', { lyricText: '无主题色回退',
        lyricData: words('无主题色回退'), lyricTrans: '', coverTheme: null });
    await waitFor(async () => await inactive() === 'rgba(12, 34, 56, 0)');

    const mouseActions = [];
    ipcMain.on('lyric:window', (_event, action) => mouseActions.push(action));
    ipcMain.on('player:command', (_event, action) => mouseActions.push(action));
    win.webContents.send('lyric:config-changed', { isLock: true });
    await waitFor(() => win.webContents.executeJavaScript(`document.querySelector('#app').classList.contains('lock-lyric')`));
    for (const [x, y] of [[20, 20], [500, 80], [970, 20], [998, 158]]) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    }
    await delay(100);
    const locked = await win.webContents.executeJavaScript(`(() => {
        const tools = getComputedStyle(document.querySelector('.tools'));
        return { opacity: tools.opacity, visibility: tools.visibility,
            interactive: [...document.querySelectorAll('#app, #app *')]
                .some(element => getComputedStyle(element).pointerEvents !== 'none') };
    })()`);
    assert.equal(locked.opacity, '0', 'locked toolbar stays hidden at every mouse position');
    assert.equal(locked.visibility, 'hidden');
    assert.equal(locked.interactive, false, 'locked lyrics have no mouse targets, including unlock and resize');
    assert.deepEqual(mouseActions, [], 'locked mouse input sends no window/player commands');
    win.webContents.send('lyric:config-changed', { isLock: false });
    await waitFor(() => win.webContents.executeJavaScript(`!document.querySelector('#app').classList.contains('lock-lyric')`));
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.item-lock')).pointerEvents`),
        'auto', 'external config unlock restores interaction');
    console.log('Desktop lyrics: playback, fitting, transitions, outline and complete mouse lock passed');
    win.destroy();
    app.quit();
}).catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => fs.rmSync(userData, { recursive: true, force: true }));
