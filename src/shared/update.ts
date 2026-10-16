export interface UpdateState {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
  currentVersion: string;
  version?: string;
  received: number;
  total: number;
  filePath?: string;
  message?: string;
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string | null;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v);
  const next = parse(candidate);
  const previous = parse(current);
  if (!next || !previous) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(next[i]) !== Number(previous[i])) return Number(next[i]) > Number(previous[i]);
  }
  return false;
}

export function selectInstaller(assets: ReleaseAsset[], platform: string, arch: string): ReleaseAsset | undefined {
  const extensions = platform === "darwin" ? [".dmg"] : platform === "win32" ? [".exe"] : platform === "linux" ? [".AppImage", ".deb", ".rpm"] : [];
  const aliases = arch === "x64" ? ["x64", "amd64", "x86_64"] : arch === "ia32" ? ["ia32", "i386", "i686"] : [arch];
  for (const extension of extensions) {
    const match = assets.find(asset => asset.name.endsWith(extension) && aliases.some(alias =>
      asset.name.replace(extension, "").split(/[-_. ]/).includes(alias) || (alias === "x86_64" && asset.name.includes("x86_64"))));
    if (match) return match;
  }
  return undefined;
}
