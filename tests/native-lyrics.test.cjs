// macOS only: model timing and real helper pipe / geometry / lifetime integration.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
if (process.platform !== 'darwin') process.exit(0);
const temporary = mkdtempSync(path.join(os.tmpdir(), 'metmusic-native-tests-'));
try {
    const executable = path.join(temporary, 'model-tests');
    execFileSync('xcrun', ['swiftc', '-D', 'LYRICS_TEST', '-parse-as-library',
        'native/macos/Lyrics.swift', 'tests/native-lyrics-model.swift', '-o', executable], { stdio: 'inherit' });
    execFileSync(executable, [], { stdio: 'inherit' });
} finally { rmSync(temporary, { recursive: true, force: true }); }
const helper = spawn(path.resolve('native/macos/build/MeTMusicLyrics'));
const timer = setTimeout(() => { helper.kill(); throw new Error('Native lyrics IPC timed out'); }, 10000);
let ready = false;
let boundsReceived = false;
let unexpectedExit = false;
helper.stderr.pipe(process.stderr);
const bounds = { x: 170, y: 190, width: 800, height: 140 };
readline.createInterface({ input: helper.stdout }).on('line', line => {
    const data = JSON.parse(line);
    if (data.type === 'ready') {
        ready = true;
        // Fragment a UTF-8 JSON frame to exercise the streaming decoder.
        const message = Buffer.from(JSON.stringify({ type: 'bounds', bounds }) + '\n');
        helper.stdin.write(message.subarray(0, 7));
        helper.stdin.write(message.subarray(7));
    } else if (data.type === 'bounds' && !boundsReceived) {
        assert.deepEqual(data.bounds, bounds, 'AppKit coordinates round trip to Electron coordinates');
        boundsReceived = true;
        helper.stdin.end(); // Parent EOF must terminate the accessory process.
    }
});
helper.on('error', error => { unexpectedExit = true; throw error; });
helper.on('exit', code => {
    clearTimeout(timer);
    assert.equal(unexpectedExit, false);
    assert.equal(code, 0);
    assert.ok(ready && boundsReceived);
    console.log('Native lyrics IPC / geometry / parent EOF tests passed');
});
