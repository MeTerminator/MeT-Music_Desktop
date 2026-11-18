import { app, ipcMain } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { CH, type Rect } from "../shared/ipc";

/** The small window surface used by the playback router and settings IPC. */
export interface LyricWindow {
    webContents: { send(channel: string, payload: unknown): void };
    isDestroyed(): boolean;
    isVisible(): boolean;
    getBounds(): Rect;
    hide(): void;
    show(): void;
    setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
    setPosition(x: number, y: number): void;
    setBounds(bounds: Rect): void;
}

export class NativeLyricsWindow implements LyricWindow {
    private child: ChildProcessWithoutNullStreams | null = null;
    private visible = true;
    private destroyed = false;
    private ready = false;
    private restarts = 0;
    private snapshot = new Map<string, unknown>();
    private song: unknown;
    readonly webContents = { send: (channel: string, payload: unknown): void => {
        if (channel === CH.evPlaybackSync && (payload as { kind?: string })?.kind === "song") this.song = payload;
        if (channel === CH.evLyricChange) {
            this.song = undefined;
            this.snapshot.delete(CH.evPlaybackSync);
        }
        this.snapshot.set(channel, payload);
        this.send({ channel, payload });
    } };

    constructor(private bounds: Rect, private onShow: () => void,
        private onBounds: (bounds: Rect) => void) {
        this.start();
    }

    private start(): void {
        const executable = app.isPackaged
            ? path.join(process.resourcesPath, "native", "MeTMusicLyrics")
            : path.join(app.getAppPath(), "native", "macos", "build", "MeTMusicLyrics");
        const fonts = app.isPackaged
            ? path.join(process.resourcesPath, "app.asar.unpacked", "out", "renderer", "assets")
            : path.join(app.getAppPath(), "src", "renderer", "shared-fonts");
        const appIcon = app.isPackaged
            ? path.join(process.resourcesPath, "native", "icon.png")
            : path.join(app.getAppPath(), "public", "icons", "icon.png");
        const child = spawn(executable, ["--fonts", fonts, "--app-icon", appIcon], { stdio: ["pipe", "pipe", "pipe"] });
        this.child = child;
        child.stdin.on("error", error => console.error("[native-lyrics] stdin:", error.message));
        child.stderr.on("data", data => console.error("[native-lyrics]", String(data).trim()));
        child.on("error", error => console.error("[native-lyrics] launch failed:", error));
        createInterface({ input: child.stdout }).on("line", line => {
            try {
                const message = JSON.parse(line);
                if (message.type === "ready") {
                    this.ready = true;
                    this.send({ type: "bounds", bounds: this.bounds });
                    for (const [channel, payload] of this.snapshot) {
                        if (channel !== CH.evPlaybackSync) this.send({ channel, payload });
                    }
                    if (this.song) this.send({ channel: CH.evPlaybackSync, payload: this.song });
                    if (this.snapshot.has(CH.evPlaybackSync)) this.send({ channel: CH.evPlaybackSync, payload: this.snapshot.get(CH.evPlaybackSync) });
                    this.send({ type: "visible", visible: this.visible });
                    this.onShow();
                } else if (message.type === "bounds" && ["x", "y", "width", "height"].every(key => Number.isFinite(message.bounds?.[key]))) {
                    this.bounds = message.bounds;
                    this.onBounds(this.bounds);
                } else if ([CH.playerCommand, CH.windowControl, CH.lyricWindow].includes(message.channel)) {
                    // Same schema-validated handlers as the Electron renderer; no new command surface.
                    ipcMain.emit(message.channel, {}, message.payload);
                }
            } catch (error) { console.warn("[native-lyrics] invalid message:", error); }
        });
        child.on("exit", () => {
            this.ready = false;
            if (this.child === child) this.child = null;
            if (!this.destroyed && this.restarts++ < 3) this.start();
        });
    }
    private send(message: unknown): void {
        if (this.ready && this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(message) + "\n");
    }
    isDestroyed(): boolean { return this.destroyed; }
    isVisible(): boolean { return this.visible && !this.destroyed; }
    getBounds(): Rect { return { ...this.bounds }; }
    hide(): void { this.visible = false; this.send({ type: "visible", visible: false }); }
    show(): void { this.visible = true; this.send({ type: "visible", visible: true }); this.onShow(); }
    setIgnoreMouseEvents(ignore: boolean): void { this.send({ type: "lock", value: ignore }); }
    setPosition(x: number, y: number): void { this.setBounds({ ...this.bounds, x, y }); }
    setBounds(bounds: Rect): void { this.bounds = bounds; this.send({ type: "bounds", bounds }); }
    destroy(): void { this.destroyed = true; this.child?.kill(); this.child = null; }
}
