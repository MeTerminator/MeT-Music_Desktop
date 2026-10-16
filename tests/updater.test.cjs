const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const esbuild = require(require.resolve('esbuild', { paths: [require.resolve('electron-vite')] }));
function load(filename, dependencies = {}, extra = {}) {
  const module = { exports: {} };
  const source = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  vm.runInNewContext(source, { module, exports: module.exports, require: name => dependencies[name] ?? require(name),
    console: { warn() {} }, process, URL, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, ...extra });
  return module.exports;
}
const helpers = load('src/shared/update.ts');
const channels = load('src/shared/channels.ts');
test('version comparison and platform/architecture installer selection', () => {
  assert.equal(helpers.isNewerVersion('v2.3.0', '2.2.0'), true);
  for (const version of ['2.2.0', '2.1.9', '2.3.0-beta.1', 'invalid']) assert.equal(helpers.isNewerVersion(version, '2.2.0'), false);
  const assets = ['app-2.3.0-arm64.dmg', 'app-2.3.0-x64.dmg', 'app-2.3.0-x64.zip', 'app-2.3.0-ia32.exe', 'app-2.3.0-x64.exe', 'app-2.3.0-amd64.deb', 'app-2.3.0-x64.AppImage'].map(name => ({ name }));
  assert.equal(helpers.selectInstaller(assets, 'darwin', 'x64').name, 'app-2.3.0-x64.dmg');
  assert.equal(helpers.selectInstaller(assets, 'win32', 'ia32').name, 'app-2.3.0-ia32.exe');
  assert.equal(helpers.selectInstaller(assets, 'linux', 'x64').name, 'app-2.3.0-x64.AppImage');
  assert.equal(helpers.selectInstaller(assets, 'linux', 'arm64'), undefined);
});

async function scenario({ corrupt = false, incomplete = false, decline = false, current = false, networkFailure = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'met-updater-'));
  const name = 'MeT-MusicQ-2.3.0-arm64.dmg';
  const bytes = Buffer.from('installer content for test');
  fs.writeFileSync(path.join(directory, name), 'existing installer');
  const snapshots = [];
  const dialogs = [];
  let downloadRequests = 0;
  let revealed;
  const api = load('src/main/updater.ts', {
    '../shared/update': helpers, '../shared/channels': channels,
    './window-manager': { createSettingsWindow() {}, getSettingsWindow: () => ({ isDestroyed: () => false, webContents: { send: (_, state) => snapshots.push(state) } }) },
    electron: {
      app: { isPackaged: true, getVersion: () => '2.2.0', getPath: () => directory },
      shell: { showItemInFolder: value => { revealed = value; } },
      dialog: { showMessageBox: async options => { dialogs.push(options); return { response: decline ? 1 : 0 }; } },
      net: { fetch: async url => {
        if (networkFailure) throw new Error('network disconnected');
        if (url.includes('api.github.com')) return { ok: true, json: async () => ({ tag_name: current ? '2.2.0' : '2.3.0', assets: [{ name, size: bytes.length,
          digest: 'sha256:' + (corrupt ? 'bad' : createHash('sha256').update(bytes).digest('hex')),
          browser_download_url: 'https://github.com/MeTerminator/MeT-Music_Desktop/releases/download/2.3.0/' + name }] }) };
        downloadRequests++;
        let step = 0;
        return { ok: true, body: { getReader: () => ({ read: async () => ++step === 1 ? { value: incomplete ? bytes.subarray(0, 4) : bytes, done: false } : { done: true } }) } };
      } }
    }
  }, { process: { platform: 'darwin', arch: 'arm64' } });
  try {
    await Promise.all([api.checkForUpdatesManually(), api.checkForUpdatesManually()]);
    assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), 'existing installer', 'must preserve existing downloads');
    if (networkFailure || corrupt || incomplete) {
      assert.equal(api.getUpdateState().status, 'error');
      assert.equal(fs.readdirSync(directory).length, 1, 'failed/partial file is removed');
      assert.ok(!dialogs.some(value => value.title === '安装包下载完成'));
    } else if (decline || current) {
      assert.equal(downloadRequests, 0);
    } else {
      assert.equal(downloadRequests, 1, 'concurrent checks share one download');
      assert.equal(api.getUpdateState().status, 'downloaded');
      assert.equal(fs.readFileSync(revealed, 'utf8'), bytes.toString());
      assert.ok(revealed.startsWith(directory));
      assert.ok(revealed.endsWith('(1).dmg'));
      assert.ok(snapshots.some(value => value.status === 'downloading' && value.received > 0));
      assert.ok(dialogs.some(value => value.title === '安装包下载完成'));
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
for (const [name, options] of Object.entries({ download: {}, corrupt: { corrupt: true }, incomplete: { incomplete: true }, decline: { decline: true }, latest: { current: true }, network: { networkFailure: true } })) {
  test('update flow: ' + name, () => scenario(options));
}
