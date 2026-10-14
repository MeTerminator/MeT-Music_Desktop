/**
 * App 内部 IPC 契约(单一事实来源)。
 * main / preload / renderer 共享;main 侧入口对 send 通道 payload 做 zod 校验。
 * 旧实现的 ~25 个裸通道收敛为按域命名的类型化通道(迁移对照见各 schema 注释)。
 */
import { z } from "zod";
import {
  CoverThemeSchema,
  HookPayloadSchema,
  WordProgressSchema,
  type HookPayload,
  type PlaybackSync,
  type SongSync,
} from "./hook-contract";

export { HookPayloadSchema, type HookPayload };

/* ========== 通道名(定义在零依赖的 channels.ts,preload 运行时直接引用) ========== */

export { CH, type ChannelName } from "./channels";

/* ========== payload schema ========== */

/** 桌面歌词外观配置(旧 config.js DEFAULT_CONFIG,字段与持久化文件
 *  userData/desktop-lyric-config.json 保持一致,老用户配置无损) */
export const LyricConfigSchema = z.object({
  /** 历史遗留,无运行时消费;保留仅为老配置文件字段无损往返 */
  fontSize: z.number().default(36),
  /** 历史遗留,无运行时消费;保留仅为老配置文件字段无损往返 */
  transFontSize: z.number().default(18),
  lyricFontFamily: z.string().default(""),
  translationFontFamily: z.string().default(""),
  lyricFontWeight: z.number().default(700),
  translationFontWeight: z.number().default(400),
  textColor: z.string().default("#ffffff"),
  colorActive: z.string().default("#ffffff"),
  colorInactive: z.string().default("rgba(255, 255, 255, 1)"),
  showTranslation: z.boolean().default(false),
  isLock: z.boolean().default(false),
  bgColor: z.string().default("rgba(0, 0, 0, 0.2)"),
  useThemeColorForActive: z.boolean().default(true),
  textOpacity: z.number().default(100),
  strokeWidth: z.number().default(0),
  strokeColor: z.string().default("#000000"),
  windowX: z.number().nullable().default(null),
  windowY: z.number().nullable().default(null),
  windowWidth: z.number().nullable().default(null),
  windowHeight: z.number().nullable().default(null),
  overallOpacity: z.number().default(100),
  transFontSizeScale: z.number().default(23),
  pausedOpacity: z.number().default(50),
});
export type LyricConfig = z.infer<typeof LyricConfigSchema>;
export const defaultLyricConfig = (): LyricConfig => LyricConfigSchema.parse({});

/**
 * 配置补丁 schema:只校验提交上来的字段,**不填默认值**。
 *
 * 不能用 LyricConfigSchema.partial():Zod 4 起 .partial() 不再阻止 .default()
 * 生效,缺席字段照样会被默认值填满。于是「只改一项」的补丁落盘时会把其余所有
 * 字段静默重置为默认值 —— 锁定桌面歌词后去关翻译、锁定被取消,就是这么来的
 * (窗口位置/颜色/字体同样会被打回默认,只是不容易第一眼发现)。
 *
 * 故逐字段剥掉 default 再 optional,让「缺席」真正等于「不改」。
 */
type LyricConfigPatchShape = {
  [K in keyof LyricConfig]: z.ZodOptional<z.ZodType<LyricConfig[K]>>;
};

// 逐字段 unwrap 掉 ZodDefault 再 optional。shape 是动态拼的,TS 推不出逐键类型,
// 故在此处一次性断言;断言之外的调用点仍是完整类型。
const lyricConfigPatchShape = Object.fromEntries(
  Object.entries(LyricConfigSchema.shape).map(([key, schema]) => [
    key,
    schema.unwrap().optional(),
  ]),
) as unknown as LyricConfigPatchShape;

export const LyricConfigPatchSchema = z.object(lyricConfigPatchShape);
export type LyricConfigPatch = z.infer<typeof LyricConfigPatchSchema>;

/* ========== 外部 API(HTTP / WebSocket)========== */

/**
 * 外部 API 配置(持久化于 userData/external-api-config.json,与歌词配置分文件存放)。
 * 语义对齐 SPlayer-Next 的「外部 API」:默认关闭、默认只绑 127.0.0.1、无鉴权;
 * WebSocket 与 HTTP 共用端口,且必须先开 HTTP 才生效。
 */
export const ExternalApiConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(14558),
  /** 绑 0.0.0.0(局域网可访问);服务无鉴权,仅建议在可信网络开启 */
  allowLan: z.boolean().default(false),
  /** WebSocket(/ws)开关;enabled=false 时无论此值为何都不会起服务 */
  wsEnabled: z.boolean().default(false),
});
export type ExternalApiConfig = z.infer<typeof ExternalApiConfigSchema>;
export const defaultExternalApiConfig = (): ExternalApiConfig => ExternalApiConfigSchema.parse({});

/** 补丁 schema:缺席=不改(理由同 LyricConfigPatchSchema,Zod 4 的 .partial() 不挡 default) */
type ExternalApiConfigPatchShape = {
  [K in keyof ExternalApiConfig]: z.ZodOptional<z.ZodType<ExternalApiConfig[K]>>;
};

const externalApiConfigPatchShape = Object.fromEntries(
  Object.entries(ExternalApiConfigSchema.shape).map(([key, schema]) => [
    key,
    schema.unwrap().optional(),
  ]),
) as unknown as ExternalApiConfigPatchShape;

export const ExternalApiConfigPatchSchema = z.object(externalApiConfigPatchShape);
export type ExternalApiConfigPatch = z.infer<typeof ExternalApiConfigPatchSchema>;

/* ========== 应用级设置(托盘、主窗关闭行为) ========== */

/**
 * 应用级设置(持久化于 userData/app-config.json)。
 *
 * 又是一个独立文件:歌词那份是外观、外部 API 那份是服务,这份是壳本身的行为。
 * 三者分开存,「重置歌词配置」不会顺手把托盘和关闭行为也打回默认。
 */
export const AppConfigSchema = z.object({
  /** 托盘图标叠一条播放进度条,悬浮提示里同时给出已播放/总时长 */
  trayProgress: z.boolean().default(false),
  /** 主窗关闭按钮的行为:隐藏到托盘(后台继续放)/ 直接退出应用 */
  closeAction: z.enum(["minimize", "quit"]).default("minimize"),
  /** 点关闭时先弹一次确认框(框内可当场选最小化还是退出,并可勾选记住) */
  closeConfirm: z.boolean().default(false),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
export const defaultAppConfig = (): AppConfig => AppConfigSchema.parse({});

/** 补丁 schema:缺席=不改(理由同 LyricConfigPatchSchema) */
type AppConfigPatchShape = {
  [K in keyof AppConfig]: z.ZodOptional<z.ZodType<AppConfig[K]>>;
};

const appConfigPatchShape = Object.fromEntries(
  Object.entries(AppConfigSchema.shape).map(([key, schema]) => [
    key,
    schema.unwrap().optional(),
  ]),
) as unknown as AppConfigPatchShape;

export const AppConfigPatchSchema = z.object(appConfigPatchShape);
export type AppConfigPatch = z.infer<typeof AppConfigPatchSchema>;

/** 外部 API 运行状态(设置窗展示用;由 main 在启停/连接数变化时广播) */
export interface ExternalApiStatus {
  running: boolean;
  /** 实际监听端口(未运行时回显配置值) */
  port: number;
  /** 实际绑定地址:127.0.0.1 或 0.0.0.0 */
  host: string;
  /** 开启局域网访问且拿得到网卡地址时,给出局域网可用的 IPv4;否则为 null */
  lanAddress: string | null;
  /** 当前 WebSocket 连接数 */
  wsClients: number;
  /** 最近一次启动失败原因(端口占用等);正常时为 null */
  error: string | null;
}

export const PlayerCommandSchema = z.object({
  action: z.enum(["prev", "next", "playOrPause"]),
});
export type PlayerCommand = z.infer<typeof PlayerCommandSchema>;

export const WindowControlSchema = z.object({
  action: z.enum([
    "hide-main",
    "show-main",
    "open-settings",
    "close-settings",
    /* ---- 主窗窗口控制(主窗是 frame: false,按钮由远端 UI 渲染后回调过来) ---- */
    "minimize-main",
    "toggle-maximize-main",
    /** 走 win.close() —— 隐藏到托盘还是真正退出,由 main 侧既有的 close 处理决定 */
    "close-main",
  ]),
});
export type WindowControl = z.infer<typeof WindowControlSchema>;

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type Rect = z.infer<typeof RectSchema>;

/** 歌词窗几何操作判别联合 */
export const LyricWindowActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set-lock"), isLock: z.boolean() }),
  z.object({ type: z.literal("toggle-visibility") }),
  /** 拖动中实时移动(不落盘,旧 move-window) */
  z.object({ type: z.literal("move"), x: z.number(), y: z.number() }),
  /** 移动并保存坐标(旧 update-lyric-position) */
  z.object({ type: z.literal("save-position"), x: z.number(), y: z.number() }),
  /** JS 拖拽调整大小(旧 resize-window;Wayland 下用原生 resize,不走此通道) */
  z.object({ type: z.literal("resize"), x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  /** 保存完整 bounds(旧 save-lyric-window-bounds) */
  z.object({ type: z.literal("save-bounds"), bounds: RectSchema }),
  /** 拖动/缩放结束:main 自读 lyricWindow.getBounds() 落盘(渲染端无需回读 bounds) */
  z.object({ type: z.literal("save-current-bounds") }),
  z.object({ type: z.literal("reset-position") }),
]);
export type LyricWindowAction = z.infer<typeof LyricWindowActionSchema>;

/** 歌词行事件 payload(main 按 ≥50ms 合并后发出;
 *  showTranslation=false 时 main 侧清空 lyricTrans,行为与旧实现一致;
 *  lyricData / coverTheme 直接派生自 hook-contract,两端类型统一) */
export const LyricLineEventSchema = z.object({
  lineId: z.string().optional(),
  lyricText: z.string(),
  lyricData: z.array(WordProgressSchema),
  lyricTrans: z.string(),
  coverTheme: CoverThemeSchema.nullable(),
});
export type LyricLineEvent = z.infer<typeof LyricLineEventSchema>;

export interface AppInfo {
  screen: { width: number; height: number };
  isWayland: boolean;
}

/* ========== preload 暴露的 API 形状 ========== */

/** 主窗 preload(远程 UI 使用) */
export interface MainWindowAPI {
  sendHookData(data: HookPayload): void;
  sendPlaybackSync(data: PlaybackSync): void;
  hideWindow(): void;
  openSettings(): void;
  /* 窗口控制(无边框主窗的最小化/最大化/关闭,由 UI 顶栏按钮触发) */
  minimizeWindow(): void;
  toggleMaximize(): void;
  closeWindow(): void;
}

/** 歌词窗 / 设置窗 preload */
export interface DesktopAPI {
  // invoke
  getAppInfo(): Promise<AppInfo>;
  getPlaybackSync(): Promise<{ song: SongSync; progress: PlaybackSync } | null>;
  onPlaybackSync(cb: (data: PlaybackSync) => void): () => void;
  getLyricBounds(): Promise<Rect>;
  getLyricConfig(): Promise<LyricConfig>;
  getExternalApiConfig(): Promise<ExternalApiConfig>;
  getExternalApiStatus(): Promise<ExternalApiStatus>;
  getAppConfig(): Promise<AppConfig>;
  /** 写系统剪贴板;返回是否写入成功 */
  copyText(text: string): Promise<boolean>;
  // send
  playerCommand(action: PlayerCommand["action"]): void;
  windowControl(action: WindowControl["action"]): void;
  lyricWindow(action: LyricWindowAction): void;
  setLyricConfig(config: Partial<LyricConfig>): void;
  setExternalApiConfig(config: ExternalApiConfigPatch): void;
  setAppConfig(config: AppConfigPatch): void;
  // events(返回取消订阅函数)
  onLyricChange(cb: (data: LyricLineEvent) => void): () => void;
  onSongChange(cb: (label: string) => void): () => void;
  onStatusChange(cb: (isPlaying: boolean) => void): () => void;
  onConfigChanged(cb: (config: LyricConfig) => void): () => void;
  onWindowResized(cb: (width: number, height: number) => void): () => void;
  onBoundsChanged(cb: (bounds: Rect) => void): () => void;
  onExternalApiConfigChanged(cb: (config: ExternalApiConfig) => void): () => void;
  onExternalApiStatusChanged(cb: (status: ExternalApiStatus) => void): () => void;
  onAppConfigChanged(cb: (config: AppConfig) => void): () => void;
}

declare global {
  interface Window {
    /** 主窗(远程 UI)宿主 API */
    electronAPI: MainWindowAPI;
    /** 歌词窗/设置窗 API */
    desktopAPI: DesktopAPI;
  }
}
