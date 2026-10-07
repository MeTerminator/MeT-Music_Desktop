import { ZodError, type z } from "zod";
import {
    ExternalCommandSchema, ExternalEventSchemas, ExternalServerMessageSchema, SeekBodySchema, VolumeBodySchema,
    type ExternalEventType, type ExternalEventData, type ExternalServerMessage
} from "../shared/external-api-contract";
import http from "node:http";
import os from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import type { ExternalApiConfig, ExternalApiStatus } from "../shared/ipc";
import { LyricsSnapshotSchema, NowPlayingSchema, PlaybackSnapshotSchema, type LyricsSnapshot, type NowPlaying, type PlaybackSnapshot } from "../shared/hook-contract";

/**
 * 外部 API(HTTP + WebSocket)。
 *
 * 对齐 SPlayer-Next 的同名能力(https://splayer-next.imsyy.top/api.html、
 * /socket.html):基础路径 /api,默认端口 14558,时间单位毫秒,
 * 控制类接口回 { ok: true },参数非法回 400。WebSocket 与 HTTP 共用端口,
 * 挂在 /ws,且必须先开 HTTP 才会起。
 *
 * 安全约定与文档一致:默认只绑 127.0.0.1、**不含任何鉴权**;
 * 需要局域网访问时用户显式打开「允许局域网访问」(绑 0.0.0.0)。
 *
 * 数据全部现取自远端 UI(见 hook-contract 末尾的 $MeTMusic_get* 系列),
 * 不复用播放 tick 推来的 hook 缓存 —— 那份数据暂停后就不再更新了。
 */

/** UI 侧能力缺失(UI 版本过旧)时,取数返回 null,端点回 501 */
export interface ExternalApiDeps {
    play(): void;
    pause(): void;
    stop(): void;
    next(): void;
    prev(): void;
    /** 目标进度(毫秒) */
    seek(positionMs: number): void;
    /** 音量 0 ~ 1 */
    setVolume(volume: number): void;
    getPlaybackState(): Promise<PlaybackSnapshot | null>;
    getNowPlaying(): Promise<NowPlaying | null>;
    getLyrics(): Promise<LyricsSnapshot | null>;
    /** 应用名与版本(GET /api/info) */
    appInfo(): { name: string; version: string };
}

/** 下行事件(kind: "event")的类型 */
export type ExternalApiEventType = ExternalEventType;

const MAX_BODY_BYTES = 64 * 1024;

let deps: ExternalApiDeps | null = null;
let httpServer: http.Server | null = null;
let wsServer: WebSocketServer | null = null;
let statusListener: ((status: ExternalApiStatus) => void) | null = null;

/** 正在监听的配置快照(判断是否需要重启;null 表示当前没在跑) */
let activeConfig: ExternalApiConfig | null = null;
let lastError: string | null = null;
/** 未运行时状态里回显的端口/绑定地址,取自最近一次配置 */
let desiredConfig: ExternalApiConfig | null = null;

function hostOf(config: ExternalApiConfig): string {
    return config.allowLan ? "0.0.0.0" : "127.0.0.1";
}

/** 绑 0.0.0.0 时给设置窗一个能真正填进浏览器的局域网地址(取第一块非内部 IPv4 网卡) */
function lanAddressOf(config: ExternalApiConfig): string | null {
    if (!config.allowLan) return null;
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family === "IPv4" && !entry.internal) return entry.address;
        }
    }
    return null;
}

export function getStatus(): ExternalApiStatus {
    const config = activeConfig ?? desiredConfig;
    return {
        running: Boolean(httpServer && httpServer.listening),
        port: config?.port ?? 14558,
        host: config ? hostOf(config) : "127.0.0.1",
        lanAddress: config ? lanAddressOf(config) : null,
        wsClients: wsServer ? wsServer.clients.size : 0,
        error: lastError
    };
}

function emitStatus(): void {
    statusListener?.(getStatus());
}

export function setStatusListener(listener: (status: ExternalApiStatus) => void): void {
    statusListener = listener;
}

/* ========== HTTP ========== */

type HttpResponseBody = PlaybackSnapshot | NowPlaying | LyricsSnapshot | { error: string } | { ok: true } | { volume: number } | { name: string; version: string; wsClients: number };

function sendJson(res: http.ServerResponse, statusCode: number, body: HttpResponseBody): void {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        // 本地控制接口,允许浏览器脚本直接调用(服务本身无鉴权,这一条不额外放宽攻击面)
        "Access-Control-Allow-Origin": "*"
    });
    res.end(payload);
}

/** 读取并解析 JSON 请求体;空体按 {} 处理,超限或非法 JSON 抛错 */
async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > MAX_BODY_BYTES) throw new Error("body too large");
        chunks.push(buf);
    }
    if (size === 0) return {};
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
}

/** 取数类端点:UI 缺少对应能力时统一回 501 */
async function respondSnapshot<T extends PlaybackSnapshot | NowPlaying | LyricsSnapshot>(
    res: http.ServerResponse,
    load: () => Promise<T | null>,
    schema: z.ZodType<T>
): Promise<void> {
    const data = await load();
    if (data === null || data === undefined) {
        sendJson(res, 501, { error: "player is not ready" });
        return;
    }
    sendJson(res, 200, schema.parse(data));
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const api = deps;
    if (!api) {
        sendJson(res, 503, { error: "service unavailable" });
        return;
    }

    // 预检:GET/POST + JSON body 会触发 preflight,统一放行
    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400"
        });
        res.end();
        return;
    }

    // 只取 pathname(带 query 也不影响路由匹配),末尾斜杠归一
    const path = (req.url ?? "/").split("?")[0]!.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (method === "GET") {
        switch (path) {
            case "/api/info": {
                const info = api.appInfo();
                sendJson(res, 200, { ...info, wsClients: wsServer ? wsServer.clients.size : 0 });
                return;
            }
            case "/api/status":
                await respondSnapshot(res, () => api.getPlaybackState(), PlaybackSnapshotSchema.strict());
                return;
            case "/api/volume": {
                const state = await api.getPlaybackState();
                if (!state) {
                    sendJson(res, 501, { error: "player is not ready" });
                    return;
                }
                sendJson(res, 200, { volume: PlaybackSnapshotSchema.strict().parse(state).volume });
                return;
            }
            case "/api/now-playing":
                await respondSnapshot(res, () => api.getNowPlaying(), NowPlayingSchema.strict());
                return;
            case "/api/lyrics":
                await respondSnapshot(res, () => api.getLyrics(), LyricsSnapshotSchema.strict());
                return;
        }
    }

    if (method === "POST") {
        switch (path) {
            case "/api/play":
                api.play();
                sendJson(res, 200, { ok: true });
                return;
            case "/api/pause":
                api.pause();
                sendJson(res, 200, { ok: true });
                return;
            case "/api/stop":
                api.stop();
                sendJson(res, 200, { ok: true });
                return;
            case "/api/next":
                api.next();
                sendJson(res, 200, { ok: true });
                return;
            case "/api/prev":
                api.prev();
                sendJson(res, 200, { ok: true });
                return;
            case "/api/seek": {
                const body = await readJsonBody(req);
                const { positionMs } = SeekBodySchema.parse(body);
                if (positionMs < 0) {
                    sendJson(res, 400, { error: "positionMs must be a number >= 0" });
                    return;
                }
                api.seek(positionMs);
                sendJson(res, 200, { ok: true });
                return;
            }
            case "/api/volume": {
                const body = await readJsonBody(req);
                const { volume } = VolumeBodySchema.parse(body);
                if (volume < 0 || volume > 1) {
                    sendJson(res, 400, { error: "volume must be a number between 0 and 1" });
                    return;
                }
                api.setVolume(volume);
                sendJson(res, 200, { ok: true });
                return;
            }
        }
    }

    sendJson(res, 404, { error: "not found" });
}

/* ========== WebSocket ========== */

function sendWs(socket: WebSocket, message: ExternalServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(ExternalServerMessageSchema.parse(message)));
}

/** 广播播放事件(index.ts 在 hook 状态变化时调用;无连接时是空操作) */
export function broadcastEvent<T extends ExternalApiEventType>(type: T, data: ExternalEventData<T>): void {
    if (!wsServer || wsServer.clients.size === 0) return;
    const message = JSON.stringify({ kind: "event", type, data: ExternalEventSchemas[type].parse(data) });
    for (const client of wsServer.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    }
}

function handleWsMessage(socket: WebSocket, raw: string): void {
    const api = deps;
    if (!api) return;

    let payload: unknown;
    try {
        payload = JSON.parse(raw);
    } catch {
        sendWs(socket, { kind: "error", op: null, error: "invalid JSON" });
        return;
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        sendWs(socket, { kind: "error", op: null, error: "message must be a JSON object" });
        return;
    }

    const result = ExternalCommandSchema.safeParse(payload);
    if (!result.success) {
        const op = typeof payload === "object" && payload !== null && "op" in payload && typeof payload.op === "string" ? payload.op : null;
        sendWs(socket, { kind: "error", op, error: "invalid command" });
        return;
    }
    const body = result.data;
    const op = body.op;

    switch (body.op) {
        case "play":
            api.play();
            break;
        case "pause":
            api.pause();
            break;
        case "stop":
            api.stop();
            break;
        case "next":
            api.next();
            break;
        case "prev":
            api.prev();
            break;
        case "seek": {
            const { positionMs } = body;
            if (positionMs < 0) {
                sendWs(socket, { kind: "error", op, error: "positionMs must be a number >= 0" });
                return;
            }
            api.seek(positionMs);
            break;
        }
        case "setVolume": {
            const { volume } = body;
            if (volume < 0 || volume > 1) {
                sendWs(socket, { kind: "error", op, error: "volume must be a number between 0 and 1" });
                return;
            }
            api.setVolume(volume);
            break;
        }
        default:
            sendWs(socket, { kind: "error", op, error: "unknown op" });
            return;
    }

    sendWs(socket, { kind: "ack", op });
}

/**
 * 新连接的开场快照(hello 之后紧跟着发,只发给这一个 socket)。
 *
 * 广播事件一律「变了才发」,而变化的驱动源是 UI 的播放 tick —— 暂停时 tick 是停的。
 * 于是在暂停态连上来的客户端,在用户恢复播放或切歌之前收不到任何 track/state,
 * 只能自己去打一次 HTTP 才知道现在放的是什么。这里补一份现取的快照
 * (与 GET /api/now-playing 同源,不依赖 tick),事件形状与广播完全一致,
 * 客户端一套 handler 就能吃下,不必为「连接时」单独写一条分支。
 *
 * UI 太旧或主窗不在时拿不到快照,静默跳过 —— 连接本身不受影响。
 */
async function sendHelloSnapshot(socket: WebSocket): Promise<void> {
    const api = deps;
    if (!api) return;
    const snapshot = await api.getNowPlaying();
    const now = snapshot ? NowPlayingSchema.strict().parse(snapshot) : null;
    // 取数是异步的,期间客户端可能已经断开;sendWs 自己判 readyState,这里不必再判
    if (!now) return;
    sendWs(socket, {
        kind: "event",
        type: "track" satisfies ExternalApiEventType,
        data: {
            id: now.id,
            name: now.name,
            artist: now.artist,
            cover: now.cover,
            duration: now.duration
        }
    });
    sendWs(socket, {
        kind: "event",
        type: "state" satisfies ExternalApiEventType,
        data: { state: now.state, position: now.position, duration: now.duration }
    });
}

function createWsServer(server: http.Server): WebSocketServer {
    const wss = new WebSocketServer({ server, path: "/ws" });

    wss.on("connection", (socket) => {
        sendWs(socket, { kind: "hello", clients: wss.clients.size });
        void sendHelloSnapshot(socket).catch(() => {
            sendWs(socket, { kind: "error", op: null, error: "invalid player snapshot" });
        });
        emitStatus();

        socket.on("message", (data) => {
            handleWsMessage(socket, data.toString());
        });
        socket.on("close", () => emitStatus());
        // 客户端异常断开时 ws 会同时触发 error 与 close,这里只吞掉错误避免 crash
        socket.on("error", () => {});
    });

    return wss;
}

/* ========== 生命周期 ========== */

export function init(externalDeps: ExternalApiDeps): void {
    deps = externalDeps;
}

/** 关停服务(幂等);正在监听时会断开全部 WebSocket 连接 */
export function stop(): void {
    if (wsServer) {
        for (const client of wsServer.clients) client.terminate();
        wsServer.close();
        wsServer = null;
    }
    if (httpServer) {
        const server = httpServer;
        httpServer = null;
        server.close();
        // close() 只停止接收新连接,keep-alive 的旧连接会拖住关闭;直接掐断
        server.closeAllConnections?.();
    }
    activeConfig = null;
}

function start(config: ExternalApiConfig): void {
    lastError = null;

    const server = http.createServer((req, res) => {
        void handleRequest(req, res).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            // 请求体非法/超限属于客户端问题,回 400;其余按 500
            const isBadRequest =
                err instanceof ZodError || message.includes("body") || message.toLowerCase().includes("json");
            if (!res.headersSent) {
                sendJson(res, isBadRequest ? 400 : 500, { error: message });
            } else {
                res.end();
            }
        });
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
        lastError =
            err.code === "EADDRINUSE"
                ? `端口 ${config.port} 已被占用`
                : (err.message ?? String(err));
        console.error("[external-api] server error:", err);
        // 监听失败:清干净再回报状态,避免留下半启动的服务
        stop();
        emitStatus();
    });

    httpServer = server;
    if (config.wsEnabled) wsServer = createWsServer(server);

    server.listen(config.port, hostOf(config), () => {
        activeConfig = { ...config };
        console.log(`[external-api] listening on http://${hostOf(config)}:${config.port}/api`);
        emitStatus();
    });
}

/**
 * 按配置对齐服务状态(启/停/换端口重启)。
 * 关掉再打开、改端口、开关 WebSocket 都走这里,调用方无需自己判断差异。
 */
export function applyConfig(config: ExternalApiConfig): void {
    desiredConfig = { ...config };

    if (!config.enabled) {
        const wasRunning = Boolean(httpServer);
        stop();
        lastError = null;
        if (wasRunning) console.log("[external-api] stopped");
        emitStatus();
        return;
    }

    const same =
        activeConfig !== null &&
        activeConfig.port === config.port &&
        activeConfig.allowLan === config.allowLan &&
        activeConfig.wsEnabled === config.wsEnabled;
    if (same && httpServer?.listening) {
        emitStatus();
        return;
    }

    stop();
    start(config);
    emitStatus();
}
