/**
 * IPC 通道名(单一事实来源)。
 * 本文件零依赖(不引 zod 等运行时包),preload 在沙箱中可直接运行时 import,
 * 由 electron-vite 打包内联;ipc.ts 从这里 re-export 以保持既有引用不变。
 */

export const CH = {
  /** 主窗 preload → main:播放状态 hook 转发(旧 metmusic-hook) */
  playbackSync: "hook:playback-sync",
  playbackSyncGet: "lyric:playback-get",
  evPlaybackSync: "lyric:playback-sync",
  hookState: "hook:state",
  /** 歌词/设置窗 → main:播放控制(旧 play-prev / play-next / play-or-pause) */
  playerCommand: "player:command",
  /** 窗口控制(旧 hide-window / show-window / open-settings / close-settings-window) */
  windowControl: "window:control",
  /** 歌词窗几何操作(旧 toggle-desktop-lyric-lock / hide-desktop-lyric-window /
   *  move-window / update-lyric-position / resize-window /
   *  save-lyric-window-bounds / reset-lyric-window-position) */
  lyricWindow: "lyric:window",
  /** invoke:歌词外观配置(旧 get-lyric-config) */
  lyricConfigGet: "lyric:config-get",
  /** send:保存歌词外观配置并广播(旧 update-lyric-config) */
  lyricConfigSet: "lyric:config-set",
  /** invoke:环境信息(旧 get-screen-size + get-window-system 合并) */
  appInfo: "app:info",
  /** invoke:歌词窗当前 bounds(旧 get-window-bounds) */
  lyricBoundsGet: "lyric:bounds-get",

  /* ---- main → 歌词/设置窗事件 ---- */
  /** 歌词行更新(旧 play-lyric-change,≥50ms 合并后) */
  evLyricChange: "lyric:line-change",
  /** 歌名变更(旧 play-song-change,payload 为 "歌名 - 歌手") */
  evSongChange: "lyric:song-change",
  /** 播放状态变更(旧 play-status-change,payload 为 boolean) */
  evStatusChange: "lyric:status-change",
  /** 配置变更广播(旧 lyric-config-changed) */
  evConfigChanged: "lyric:config-changed",
  /** 歌词窗尺寸变化(旧 window-resized,payload 为 [width, height]) */
  evWindowResized: "lyric:window-resized",
  /** 歌词窗 bounds 变化 → 设置窗(旧 lyric-bounds-changed) */
  evBoundsChanged: "lyric:bounds-changed",

  /* ---- 外部 API(HTTP / WebSocket)---- */
  /** invoke:外部 API 配置 */
  apiConfigGet: "api:config-get",
  /** send:保存外部 API 配置(据此重启/停止服务)并广播 */
  apiConfigSet: "api:config-set",
  /** invoke:外部 API 运行状态(是否在跑、实际端口、WS 连接数、错误) */
  apiStatusGet: "api:status-get",
  /** 外部 API 配置变更广播 */
  evApiConfigChanged: "api:config-changed",
  /** 外部 API 运行状态变更(启停成功/失败、连接数变化) */
  evApiStatusChanged: "api:status-changed",

  /* ---- 应用级设置(托盘进度、关闭按钮行为)---- */
  /** invoke:应用级设置 */
  appConfigGet: "app:config-get",
  /** send:保存应用级设置并广播 */
  appConfigSet: "app:config-set",
  /** 应用级设置变更广播(设置窗改的、或关闭确认框「记住选择」写回的) */
  evAppConfigChanged: "app:config-changed",

  /** invoke:写系统剪贴板(设置窗复制接口文档用) */
  clipboardWrite: "clipboard:write",
} as const;

export type ChannelName = (typeof CH)[keyof typeof CH];
