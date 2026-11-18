const { execFileSync } = require('node:child_process');
const { mkdirSync, renameSync } = require('node:fs');
const path = require('node:path');
if (process.platform !== 'darwin') process.exit(0);
const root = path.resolve(__dirname, '..', 'native', 'macos');
mkdirSync(path.join(root, 'build'), { recursive: true });
// Universal helper: both Electron release architectures use the same signed resource.
for (const arch of ['arm64', 'x86_64']) {
    execFileSync('xcrun', ['swiftc', '-O', '-parse-as-library', '-target', `${arch}-apple-macosx13.0`,
        path.join(root, 'Lyrics.swift'), '-o', path.join(root, 'build', `lyrics-${arch}`)], { stdio: 'inherit' });
}
execFileSync('xcrun', ['lipo', '-create', ...['arm64', 'x86_64'].map(arch => path.join(root, 'build', `lyrics-${arch}`)),
    '-output', path.join(root, 'build', 'MeTMusicLyrics.tmp')], { stdio: 'inherit' });
execFileSync('codesign', ['--force', '--sign', '-', path.join(root, 'build', 'MeTMusicLyrics.tmp')], { stdio: 'inherit' });
renameSync(path.join(root, 'build', 'MeTMusicLyrics.tmp'), path.join(root, 'build', 'MeTMusicLyrics'));
