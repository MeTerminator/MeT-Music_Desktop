import { app, dialog, net, shell } from "electron";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { CH } from "../shared/channels";
import { isNewerVersion, selectInstaller, type ReleaseAsset, type UpdateState } from "../shared/update";
import * as windowManager from "./window-manager";

const RELEASE_URL = "https://api.github.com/repos/MeTerminator/MeT-Music_Desktop/releases/latest";
let initialized = false;
let busy = false;
let state: UpdateState;

export function getUpdateState(): UpdateState {
    return state ??= { status: "idle", currentVersion: app.getVersion(), received: 0, total: 0 };
}

function publish(patch: Partial<UpdateState>): void {
    state = { ...getUpdateState(), ...patch };
    const win = windowManager.getSettingsWindow();
    if (win && !win.isDestroyed()) win.webContents.send(CH.evUpdateState, state);
}

export function revealUpdate(): void {
    const current = getUpdateState();
    if (current.status === "downloaded" && current.filePath) shell.showItemInFolder(current.filePath);
}

async function downloadInstaller(asset: ReleaseAsset): Promise<void> {
    const directory = app.getPath("downloads");
    await mkdir(directory, { recursive: true });
    const filename = path.basename(asset.name);
    if (!filename || filename !== asset.name || filename.includes("\\")) throw new Error("安装包名称无效");
    const url = new URL(asset.browser_download_url);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith("/MeTerminator/MeT-Music_Desktop/releases/download/")) {
        throw new Error("安装包下载地址无效");
    }
    const ext = path.extname(filename);
    let destination = path.join(directory, filename);
    for (let suffix = 1; existsSync(destination) || existsSync(`${destination}.part`); suffix++) {
        destination = path.join(directory, `${path.basename(filename, ext)} (${suffix})${ext}`);
    }
    const temporary = `${destination}.part`;
    const file = await open(temporary, "wx");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const hash = createHash("sha256");
    let received = 0;
    let lastPublished = 0;
    try {
        const response = await net.fetch(url.href, { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`下载安装包失败（HTTP ${response.status}）`);
        const reader = response.body.getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            timeout.refresh();
            // FileHandle.write may write fewer bytes than requested.
            let offset = 0;
            while (offset < value.length) {
                const { bytesWritten } = await file.write(value, offset, value.length - offset);
                if (!bytesWritten) throw new Error("无法写入下载文件");
                offset += bytesWritten;
            }
            hash.update(value);
            received += value.length;
            if (Date.now() - lastPublished > 200) {
                publish({ received, total: asset.size });
                lastPublished = Date.now();
            }
        }
        if (received !== asset.size || received === 0) throw new Error("安装包下载不完整，请重试");
        if (asset.digest?.startsWith("sha256:") && `sha256:${hash.digest("hex")}` !== asset.digest) {
            throw new Error("安装包校验失败，请重新下载");
        }
        await file.close();
        await rename(temporary, destination);
        publish({ status: "downloaded", received, total: received, filePath: destination });
    } catch (error) {
        controller.abort();
        await file.close();
        await rm(temporary, { force: true });
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function checkForUpdates(manual: boolean): Promise<void> {
    if (!manual && getUpdateState().status === "downloaded") return;
    if (busy) {
        if (getUpdateState().status === "downloading") windowManager.createSettingsWindow();
        return;
    }
    busy = true;
    publish({ status: "checking", received: 0, total: 0, message: undefined, version: undefined, filePath: undefined });
    try {
        if (!app.isPackaged) {
            publish({ status: "idle", message: "开发模式下不可用，请在打包后的客户端中检查更新" });
            if (manual) await dialog.showMessageBox({ type: "info", title: "检查更新", message: getUpdateState().message!, buttons: ["确定"] });
            return;
        }
        const response = await net.fetch(RELEASE_URL, {
            headers: { Accept: "application/vnd.github+json", "User-Agent": "MeT-Music-Desktop" },
            signal: AbortSignal.timeout(30_000)
        });
        if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}），请稍后重试`);
        const release = await response.json() as { tag_name: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[] };
        if (release.draft || release.prerelease || !isNewerVersion(release.tag_name, app.getVersion())) {
            publish({ status: "idle", message: `当前已是最新版本（v${app.getVersion()}）` });
            if (manual) await dialog.showMessageBox({ type: "info", title: "检查更新", message: getUpdateState().message!, buttons: ["确定"] });
            return;
        }
        const version = release.tag_name.replace(/^v/, "");
        const asset = selectInstaller(release.assets, process.platform, process.arch);
        if (!asset) throw new Error(`新版本 v${version} 暂无适用于当前系统和架构的安装包，请稍后重试`);
        publish({ status: "available", version });
        const { response: answer } = await dialog.showMessageBox({
            type: "info", title: "发现新版本", message: `发现新版本 v${version}，是否下载安装包？`,
            detail: `安装包将保存到系统下载文件夹：${app.getPath("downloads")}。下载完成后请手动安装更新。`,
            buttons: ["下载安装包", "稍后"], defaultId: 0, cancelId: 1
        });
        if (answer !== 0) return;
        windowManager.createSettingsWindow();
        publish({ status: "downloading", received: 0, total: asset.size });
        await downloadInstaller(asset);
        const { response: action } = await dialog.showMessageBox({
            type: "info", title: "安装包下载完成", message: `v${version} 安装包已下载，请安装更新`,
            detail: `${getUpdateState().filePath}\n请退出当前客户端后运行安装包完成更新。`,
            buttons: ["在文件夹中显示", "稍后安装"], defaultId: 0, cancelId: 1
        });
        if (action === 0) revealUpdate();
    } catch (error) {
        const message = error instanceof Error ? error.message : "更新失败，请检查网络连接后重试";
        publish({ status: "error", message });
        console.warn("[updater]", error);
        if (manual || getUpdateState().version) await dialog.showMessageBox({ type: "warning", title: "更新失败", message, buttons: ["确定"] });
    } finally {
        busy = false;
    }
}

export function initUpdater(): void {
    if (!app.isPackaged || initialized) return;
    initialized = true;
    setTimeout(() => {
        void checkForUpdates(false);
        setInterval(() => void checkForUpdates(false), 4 * 60 * 60 * 1000).unref();
    }, 10_000).unref();
}

export async function checkForUpdatesManually(): Promise<void> {
    await checkForUpdates(true);
}
