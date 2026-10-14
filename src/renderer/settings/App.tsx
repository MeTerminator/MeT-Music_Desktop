import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { defaultLyricConfig, type LyricConfig } from "@shared/ipc";
import { hexToRgba, rgbToHex } from "@renderer/shared/color";
import { FontSelect, NumberInput, Switch, type FeaturedFont } from "./components";
import ExternalApiPanel from "./ExternalApiPanel";
import GeneralPanel from "./GeneralPanel";

/* ========== 常量 ========== */

const FEATURED_FONTS: readonly FeaturedFont[] = [
  { label: "Spotify Mix（内置）", value: "Spotify Mix UI Title" },
  { label: "HarmonyOS Sans SC（内置）", value: "HarmonyOS Sans SC" },
  { label: "SF Pro（内置）", value: "MeT SF Pro" },
  { label: "PingFang SC（内置）", value: "MeT PingFang SC" },
];

const MOVE_STEPS = [1, 10, 50] as const;

/**
 * 左侧菜单分组。
 * 原先所有分区堆在一列里滚,加进外部 API 之后长得没法看;
 * 改成左菜单切换,每次只渲染当前组(切组即回到顶部,不必记滚动位置)。
 *
 * 菜单项再按归属分组带标题:前五项全是桌面歌词窗的外观/行为,
 * 外部 API 是整个客户端的能力,混在一列里看不出层级。
 */
const NAV_GROUPS = [
  {
    title: "桌面歌词",
    items: [
      { id: "font", label: "字体", icon: "Aa" },
      { id: "color", label: "颜色与描边", icon: "◐" },
      { id: "background", label: "背景与特效", icon: "▨" },
      { id: "layout", label: "窗口与位置", icon: "⊹" },
      { id: "misc", label: "其他选项", icon: "⋯" },
    ],
  },
  {
    title: "应用",
    items: [
      { id: "general", label: "常规", icon: "⚙" },
      { id: "api", label: "外部 API", icon: "⇄" },
    ],
  },
] as const;
type PaneId = (typeof NAV_GROUPS)[number]["items"][number]["id"];

/** 归「桌面歌词」组的面板 id(内容区那层加载封锁按此判定,新增应用级面板不会误入) */
const LYRIC_PANE_IDS: readonly PaneId[] = NAV_GROUPS[0].items.map((item) => item.id);

/* ========== 工具函数 ========== */

interface Geometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ScreenSize {
  width: number;
  height: number;
}

/** 外观配置(剔除窗口几何字段;旧设置窗的 update-lyric-config 不携带几何) */
type AppearanceConfig = Omit<LyricConfig, "windowX" | "windowY" | "windowWidth" | "windowHeight">;

function stripGeometry(config: LyricConfig): AppearanceConfig {
  const { windowX: _x, windowY: _y, windowWidth: _w, windowHeight: _h, ...rest } = config;
  return rest;
}

/** 解析 colorInactive → 颜色选择器 hex + 不透明度百分比(移植旧 parseConfigColors) */
function parseInactiveColor(colorInactive: string): { hex: string; opacity: number } | null {
  if (colorInactive.startsWith("rgba")) {
    const match = colorInactive.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
    if (match) {
      return {
        hex: rgbToHex(parseInt(match[1]!), parseInt(match[2]!), parseInt(match[3]!)),
        opacity: Math.round(parseFloat(match[4]!) * 100),
      };
    }
    const matchRGB = colorInactive.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (matchRGB) {
      return {
        hex: rgbToHex(parseInt(matchRGB[1]!), parseInt(matchRGB[2]!), parseInt(matchRGB[3]!)),
        opacity: 100,
      };
    }
    return null;
  }
  if (colorInactive.startsWith("#")) {
    return { hex: colorInactive.slice(0, 7), opacity: 100 };
  }
  return null;
}

/** 解析 bgColor → 颜色选择器 hex(移植旧 parseConfigColors) */
function parseBgColor(bgColor: string): string | null {
  if (bgColor.startsWith("rgba")) {
    const parts = bgColor.match(/\d+/g);
    if (parts && parts.length >= 3) {
      return rgbToHex(parseInt(parts[0]!), parseInt(parts[1]!), parseInt(parts[2]!));
    }
    return null;
  }
  if (bgColor.startsWith("#")) {
    return bgColor.slice(0, 7);
  }
  return null;
}

/* ========== 主组件 ========== */

export default function App(): React.JSX.Element {
  /* ---- 外观配置状态 ---- */
  const [config, setConfig] = useState<LyricConfig>(defaultLyricConfig);
  const configRef = useRef(config);
  // 初始 config 加载完成前禁用表单并丢弃 patch,避免用默认值覆盖持久化配置
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);

  /* ---- 字体 ---- */
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [fontLoadError, setFontLoadError] = useState("");

  /* ---- 屏幕与歌词窗几何 ---- */
  const [screenSize, setScreenSize] = useState<ScreenSize>({ width: 1920, height: 1080 });
  // 初值仅为拿到真实 bounds 前的占位,与 window-manager 的 DEFAULT_LYRIC_* 对齐
  const [geometry, setGeometry] = useState<Geometry>({ x: 0, y: 0, w: 1200, h: 100 });
  const screenRef = useRef(screenSize);
  const geometryRef = useRef(geometry);
  screenRef.current = screenSize;
  geometryRef.current = geometry;

  /* ---- 左侧菜单(当前分组) ---- */
  const [activePane, setActivePane] = useState<PaneId>("font");

  /* ---- 位移微调 / 拖动面板 ---- */
  const [moveStep, setMoveStep] = useState<number>(10);
  const padRef = useRef<HTMLDivElement>(null);
  const isPadDraggingRef = useRef(false);

  /* ---- 配置提交(80ms 防抖,与旧实现一致;只提交防抖窗口内实际改动的字段) ---- */
  const configTimerRef = useRef<number | null>(null);
  const pendingPatchRef = useRef<Partial<LyricConfig>>({});

  const patchConfig = useCallback((patch: Partial<LyricConfig>) => {
    if (!loadedRef.current) return;
    pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      configRef.current = next;
      return next;
    });
    if (configTimerRef.current !== null) window.clearTimeout(configTimerRef.current);
    configTimerRef.current = window.setTimeout(() => {
      configTimerRef.current = null;
      const pending = pendingPatchRef.current;
      pendingPatchRef.current = {};
      if (Object.keys(pending).length > 0) window.desktopAPI.setLyricConfig(pending);
    }, 80);
  }, []);

  // 卸载时冲刷未发送的防抖更新(对应旧 onUnmounted(flushConfigUpdate))
  useEffect(() => {
    return () => {
      if (configTimerRef.current !== null) {
        window.clearTimeout(configTimerRef.current);
        configTimerRef.current = null;
      }
      const pending = pendingPatchRef.current;
      pendingPatchRef.current = {};
      if (Object.keys(pending).length > 0) window.desktopAPI.setLyricConfig(pending);
    };
  }, []);

  /* ---- KTV 底色 / 悬停背景色(hex + 透明度 → rgba;选择器值渲染时从 config 派生) ---- */

  const updateInactiveColor = useCallback(
    (hex: string, opacity: number) => {
      patchConfig({ colorInactive: hexToRgba(hex, opacity) });
    },
    [patchConfig],
  );

  const updateBgColor = useCallback(
    (hex: string) => {
      patchConfig({ bgColor: hexToRgba(hex, 20) });
    },
    [patchConfig],
  );

  /* ---- 歌词窗几何操作 ---- */

  const updatePosition = useCallback((newX: number, newY: number) => {
    const screen = screenRef.current;
    const geom = geometryRef.current;
    const maxX = Math.max(0, screen.width - geom.w);
    const maxY = Math.max(0, screen.height - geom.h);
    const clampedX = Math.max(0, Math.min(maxX, Math.round(newX)));
    const clampedY = Math.max(0, Math.min(maxY, Math.round(newY)));

    setGeometry((prev) => ({ ...prev, x: clampedX, y: clampedY }));
    window.desktopAPI.lyricWindow({ type: "save-position", x: clampedX, y: clampedY });
  }, []);

  const updateWindowSize = useCallback((widthInput: number, heightInput: number) => {
    const screen = screenRef.current;
    const geom = geometryRef.current;
    const maxWidth = Math.max(100, screen.width);
    const maxHeight = Math.max(50, screen.height);
    const w = Math.max(100, Math.min(maxWidth, Math.round(widthInput) || 100));
    const h = Math.max(50, Math.min(maxHeight, Math.round(heightInput) || 50));

    const maxX = Math.max(0, screen.width - w);
    const maxY = Math.max(0, screen.height - h);
    const x = Math.max(0, Math.min(maxX, geom.x));
    const y = Math.max(0, Math.min(maxY, geom.y));

    setGeometry({ x, y, w, h });
    window.desktopAPI.lyricWindow({ type: "resize", x, y, width: w, height: h });
  }, []);

  const moveOffset = useCallback(
    (deltaX: number, deltaY: number) => {
      const geom = geometryRef.current;
      updatePosition(geom.x + deltaX, geom.y + deltaY);
    },
    [updatePosition],
  );

  const alignPosition = useCallback(
    (preset: "top-center" | "bottom-center" | "center" | "left" | "right") => {
      const { width: sw, height: sh } = screenRef.current;
      const { x, y, w: ww, h: wh } = geometryRef.current;

      let targetX = x;
      let targetY = y;

      switch (preset) {
        case "top-center":
          targetX = Math.round((sw - ww) / 2);
          targetY = 0;
          break;
        case "bottom-center":
          targetX = Math.round((sw - ww) / 2);
          targetY = Math.max(0, sh - wh);
          break;
        case "center":
          targetX = Math.round((sw - ww) / 2);
          targetY = Math.round((sh - wh) / 2);
          break;
        case "left":
          targetX = 0;
          break;
        case "right":
          targetX = Math.max(0, sw - ww);
          break;
      }

      updatePosition(targetX, targetY);
    },
    [updatePosition],
  );

  /* ---- 拖动面板 ---- */

  const handlePadMove = useCallback(
    (e: MouseEvent) => {
      if (!isPadDraggingRef.current || !padRef.current) return;
      const rect = padRef.current.getBoundingClientRect();
      const mouseX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const mouseY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

      const percentX = mouseX / rect.width;
      const percentY = mouseY / rect.height;

      const screen = screenRef.current;
      const geom = geometryRef.current;
      const targetX = percentX * Math.max(0, screen.width - geom.w);
      const targetY = percentY * Math.max(0, screen.height - geom.h);

      updatePosition(targetX, targetY);
    },
    [updatePosition],
  );

  const onPadMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      isPadDraggingRef.current = true;
      handlePadMove(e.nativeEvent);

      const onMouseUp = (): void => {
        isPadDraggingRef.current = false;
        window.removeEventListener("mousemove", handlePadMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", handlePadMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [handlePadMove],
  );

  /* ---- 其他动作 ---- */

  const closeSettings = useCallback(() => {
    window.desktopAPI.windowControl("close-settings");
  }, []);

  const resetLyricPosition = useCallback(() => {
    window.desktopAPI.lyricWindow({ type: "reset-position" });
  }, []);

  const resetConfig = useCallback(() => {
    // 恢复默认:提交全部外观字段(不含几何)的 partial,属预期的全量外观提交
    patchConfig(stripGeometry(defaultLyricConfig()));
  }, [patchConfig]);

  /* ---- 初始化 ---- */

  useEffect(() => {
    let disposed = false;

    const loadSystemFonts = async (): Promise<void> => {
      if (typeof window.queryLocalFonts !== "function") {
        if (!disposed) {
          setFontLoadError("当前系统不支持读取字体列表，仍可使用内置与推荐字体。");
        }
        return;
      }
      try {
        const fontData = await window.queryLocalFonts();
        if (disposed) return;
        setSystemFonts(
          [...new Set(fontData.map((font) => font.family).filter(Boolean))].sort((a, b) =>
            a.localeCompare(b, "zh-CN"),
          ),
        );
      } catch (error) {
        console.error("Failed to query local fonts:", error);
        if (!disposed) {
          setFontLoadError("无法读取系统字体列表，请检查本地字体访问权限。");
        }
      }
    };

    void (async () => {
      try {
        const currentConfig = await window.desktopAPI.getLyricConfig();
        if (!disposed && currentConfig) {
          setConfig((prev) => {
            const next = { ...prev, ...currentConfig };
            configRef.current = next;
            return next;
          });
        }
      } catch (error) {
        console.error("Failed to load lyric config:", error);
      }
      // 无论成败都解除表单封锁(失败时以默认值继续,可交互)
      loadedRef.current = true;
      if (!disposed) setLoaded(true);

      void loadSystemFonts();

      try {
        const info = await window.desktopAPI.getAppInfo();
        if (!disposed && info?.screen) setScreenSize(info.screen);

        const bounds = await window.desktopAPI.getLyricBounds();
        if (!disposed && bounds) {
          setGeometry({ x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height });
        }
      } catch (error) {
        console.error("Failed to retrieve screen/window bounds:", error);
      }
    })();

    return () => {
      disposed = true;
    };
  }, []);

  /* ---- 事件订阅 ---- */

  // 歌词窗 bounds 变化(拖动/缩放歌词窗时实时刷新;面板拖动中忽略,避免抖动)
  useEffect(() => {
    return window.desktopAPI.onBoundsChanged((bounds) => {
      if (bounds && !isPadDraggingRef.current) {
        setGeometry({ x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height });
      }
    });
  }, []);

  // 外部配置变更同步(托盘切换、set-lock、本窗提交的回声均为完整配置)。
  // 本窗只发真 diff,回声不会破坏已提交字段;仍未发出的本地待提交 diff 覆盖其上,
  // 避免覆盖正在编辑的字段。
  useEffect(() => {
    return window.desktopAPI.onConfigChanged((next) => {
      if (!next) return;
      setConfig(() => {
        const merged = { ...defaultLyricConfig(), ...next, ...pendingPatchRef.current };
        configRef.current = merged;
        return merged;
      });
    });
  }, []);

  /* ---- 派生渲染值 ---- */

  // 颜色选择器值直接从 config 派生(colorInactive / bgColor 为 rgba 字符串;解析失败回退默认)
  const inactiveDerived = parseInactiveColor(config.colorInactive) ?? { hex: "#ffffff", opacity: 100 };
  const inactiveColorHex = inactiveDerived.hex;
  const inactiveOpacity = inactiveDerived.opacity;
  const bgColorHex = parseBgColor(config.bgColor) ?? "#000000";

  const padMaxX = Math.max(1, screenSize.width - geometry.w);
  const padMaxY = Math.max(1, screenSize.height - geometry.h);
  const padHandleStyle: React.CSSProperties = {
    left: `${(Math.max(0, Math.min(1, geometry.x / padMaxX)) * 100).toFixed(2)}%`,
    top: `${(Math.max(0, Math.min(1, geometry.y / padMaxY)) * 100).toFixed(2)}%`,
  };

  /* ---- 渲染 ---- */

  return (
    <div className="settings-container">
      {/* Title Bar */}
      <header className="title-bar">
        <span className="title">MeT-Music 设置</span>
        <div className="close-btn" onClick={closeSettings} title="关闭">
          ×
        </div>
      </header>

      {/* 左侧菜单 + 内容区 */}
      <div className="settings-body">
        <nav className="settings-nav">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.title}>
              <div className="nav-group-title">{group.title}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`nav-item${activePane === item.id ? " active" : ""}`}
                  onClick={() => setActivePane(item.id)}
                >
                  <span className="nav-icon" aria-hidden>
                    {item.icon}
                  </span>
                  <span className="nav-label">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <main className="settings-content">
          {/* 歌词相关分组:初始配置加载完成前禁交互,防止把默认值当作用户改动提交
              (外部 API 面板自带一套加载态,不受这里的封锁影响)。
              整块只在「桌面歌词」组的面板下渲染 —— 否则底部那排歌词动作按钮会跑到
              应用级面板上方,看着像是那一组的按钮。 */}
          {LYRIC_PANE_IDS.includes(activePane) && (
            <div
              aria-busy={!loaded}
              style={loaded ? undefined : { pointerEvents: "none", opacity: 0.5 }}
            >
            {activePane === "font" && (
              <>
            {/* Fonts */}
            <section className="settings-section">
              <h3>字体</h3>
              <div className="setting-item">
                <label>歌词字体</label>
                <FontSelect
                  value={config.lyricFontFamily}
                  featuredFonts={FEATURED_FONTS}
                  systemFonts={systemFonts}
                  onChange={(value) => patchConfig({ lyricFontFamily: value })}
                />
                {fontLoadError && (
                  <input
                    type="text"
                    className="text-input"
                    placeholder="手动输入字体名称"
                    value={config.lyricFontFamily}
                    onChange={(e) => patchConfig({ lyricFontFamily: e.target.value })}
                  />
                )}
                <label>歌词字重：{config.lyricFontWeight}</label>
                <div className="range-wrapper flex-row-gap">
                  <input
                    type="range"
                    min={100}
                    max={900}
                    step={10}
                    value={config.lyricFontWeight}
                    onChange={(e) => patchConfig({ lyricFontWeight: e.currentTarget.valueAsNumber })}
                  />
                  <NumberInput
                    value={config.lyricFontWeight}
                    min={100}
                    max={900}
                    step={10}
                    onCommit={(value) => patchConfig({ lyricFontWeight: value })}
                  />
                </div>
              </div>
              <div className="setting-item">
                <label>翻译字体</label>
                <FontSelect
                  value={config.translationFontFamily}
                  featuredFonts={FEATURED_FONTS}
                  systemFonts={systemFonts}
                  onChange={(value) => patchConfig({ translationFontFamily: value })}
                />
                {fontLoadError && (
                  <input
                    type="text"
                    className="text-input"
                    placeholder="手动输入字体名称"
                    value={config.translationFontFamily}
                    onChange={(e) => patchConfig({ translationFontFamily: e.target.value })}
                  />
                )}
                <label>翻译字重：{config.translationFontWeight}</label>
                <div className="range-wrapper flex-row-gap">
                  <input
                    type="range"
                    min={100}
                    max={900}
                    step={10}
                    value={config.translationFontWeight}
                    onChange={(e) =>
                      patchConfig({ translationFontWeight: e.currentTarget.valueAsNumber })
                    }
                  />
                  <NumberInput
                    value={config.translationFontWeight}
                    min={100}
                    max={900}
                    step={10}
                    onCommit={(value) => patchConfig({ translationFontWeight: value })}
                  />
                </div>
              </div>
              {fontLoadError && <p className="font-status">{fontLoadError}</p>}
              <p className="font-license-note">
                本应用内置使用 HarmonyOS Sans（© Huawei Device Co., Ltd.），许可协议随字体文件一并分发。
              </p>
            </section>
              </>
            )}
            {activePane === "color" && (
              <>
            {/* Colors */}
            <section className="settings-section">
              <h3>歌词颜色</h3>
              <div className="setting-item flex-row">
                <label>常规字体颜色</label>
                <input
                  type="color"
                  value={config.textColor}
                  onChange={(e) => patchConfig({ textColor: e.target.value })}
                />
              </div>
              <div className="setting-item">
                <label>常规字体不透明度 ({config.textOpacity}%)</label>
                <div className="range-wrapper">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={config.textOpacity}
                    onChange={(e) => patchConfig({ textOpacity: e.currentTarget.valueAsNumber })}
                  />
                </div>
              </div>
              <div className="setting-item flex-row">
                <label>填充颜色使用歌曲主题色</label>
                <Switch
                  checked={config.useThemeColorForActive}
                  onChange={(value) => patchConfig({ useThemeColorForActive: value })}
                />
              </div>
              {!config.useThemeColorForActive && (
                <div className="setting-item flex-row">
                  <label>KTV 填充颜色</label>
                  <input
                    type="color"
                    value={config.colorActive}
                    onChange={(e) => patchConfig({ colorActive: e.target.value })}
                  />
                </div>
              )}
              <div className="setting-item flex-row">
                <label>底色颜色使用歌曲主题色</label>
                <Switch
                  checked={config.useThemeColorForInactive}
                  onChange={(value) => patchConfig({ useThemeColorForInactive: value })}
                />
              </div>
              {!config.useThemeColorForInactive && (
                <div className="setting-item flex-row">
                  <label>KTV 底色颜色</label>
                  <input
                    type="color"
                    value={inactiveColorHex}
                    onChange={(e) => updateInactiveColor(e.target.value, inactiveOpacity)}
                  />
                </div>
              )}
              <div className="setting-item">
                <label>KTV 底色不透明度 ({inactiveOpacity}%)</label>
                <div className="range-wrapper">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={inactiveOpacity}
                    onChange={(e) => updateInactiveColor(inactiveColorHex, e.currentTarget.valueAsNumber)}
                  />
                </div>
              </div>
            </section>

            {/* Text Stroke */}
            <section className="settings-section">
              <h3>文字描边</h3>
              <div className="setting-item">
                <label>描边粗细 ({config.strokeWidth}px)</label>
                <div className="range-wrapper">
                  <input
                    type="range"
                    min={0}
                    max={8}
                    value={config.strokeWidth}
                    onChange={(e) => patchConfig({ strokeWidth: e.currentTarget.valueAsNumber })}
                  />
                </div>
              </div>
              <div className="setting-item flex-row">
                <label>描边颜色</label>
                <input
                  type="color"
                  value={config.strokeColor}
                  onChange={(e) => patchConfig({ strokeColor: e.target.value })}
                />
              </div>
            </section>
              </>
            )}
            {activePane === "background" && (
              <>
            {/* Window Styles */}
            <section className="settings-section">
              <h3>背景与特效</h3>
              <div className="setting-item flex-row">
                <label>悬停背景色</label>
                <input
                  type="color"
                  value={bgColorHex}
                  onChange={(e) => updateBgColor(e.target.value)}
                />
              </div>
              <div className="setting-item">
                <label>总体不透明度 ({config.overallOpacity}%)</label>
                <div className="range-wrapper">
                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={config.overallOpacity}
                    onChange={(e) => patchConfig({ overallOpacity: e.currentTarget.valueAsNumber })}
                  />
                </div>
              </div>
              <div className="setting-item">
                <label>暂停时不透明度 ({config.pausedOpacity}%)</label>
                <div className="range-wrapper">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={config.pausedOpacity}
                    onChange={(e) => patchConfig({ pausedOpacity: e.currentTarget.valueAsNumber })}
                  />
                </div>
              </div>
            </section>
              </>
            )}
            {activePane === "layout" && (
              <>
            {/* Window Size */}
            <section className="settings-section">
              <h3>窗口尺寸</h3>
              <div className="setting-item">
                <label>歌词窗口宽度：{geometry.w} px</label>
                <div className="range-wrapper flex-row-gap">
                  <input
                    type="range"
                    min={100}
                    max={Math.max(100, screenSize.width)}
                    value={geometry.w}
                    onChange={(e) => updateWindowSize(e.currentTarget.valueAsNumber, geometry.h)}
                  />
                  <NumberInput
                    value={geometry.w}
                    min={100}
                    max={Math.max(100, screenSize.width)}
                    onCommit={(value) => updateWindowSize(value, geometryRef.current.h)}
                  />
                </div>
              </div>
              <div className="setting-item">
                <label>歌词窗口高度：{geometry.h} px</label>
                <div className="range-wrapper flex-row-gap">
                  <input
                    type="range"
                    min={50}
                    max={Math.max(50, screenSize.height)}
                    value={geometry.h}
                    onChange={(e) => updateWindowSize(geometry.w, e.currentTarget.valueAsNumber)}
                  />
                  <NumberInput
                    value={geometry.h}
                    min={50}
                    max={Math.max(50, screenSize.height)}
                    onCommit={(value) => updateWindowSize(geometryRef.current.w, value)}
                  />
                </div>
              </div>
            </section>

            {/* Position & Offset Control Module */}
            <section className="settings-section">
              <h3>位置与位移控制</h3>

              {/* Visual Interactive Drag Pad */}
              <div className="setting-item drag-pad-container">
                <div className="pad-header">
                  <label>位移拖动面板 (拖拽圆点调位置)</label>
                  <span className="screen-info">
                    屏幕: {screenSize.width} × {screenSize.height}
                  </span>
                </div>
                <div className="drag-pad-wrapper" ref={padRef} onMouseDown={onPadMouseDown}>
                  <div className="drag-pad-screen">
                    <div className="drag-pad-handle" style={padHandleStyle} title="拖拽圆点调整歌词位置">
                      <span className="handle-pulse"></span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Step / Directional Controller */}
              <div className="setting-item flex-col">
                <div className="step-header">
                  <label>方向微调位移</label>
                  <div className="step-selector">
                    {MOVE_STEPS.map((step) => (
                      <button
                        key={step}
                        className={`step-btn${moveStep === step ? " active" : ""}`}
                        onClick={() => setMoveStep(step)}
                      >
                        {step}px
                      </button>
                    ))}
                  </div>
                </div>
                <div className="dpad-grid">
                  <div></div>
                  <button className="dpad-btn" onClick={() => moveOffset(0, -moveStep)} title="向上移动">
                    ▲
                  </button>
                  <div></div>
                  <button className="dpad-btn" onClick={() => moveOffset(-moveStep, 0)} title="向左移动">
                    ◄
                  </button>
                  <button
                    className="dpad-btn dpad-center"
                    onClick={() => alignPosition("center")}
                    title="屏幕中央"
                  >
                    ●
                  </button>
                  <button className="dpad-btn" onClick={() => moveOffset(moveStep, 0)} title="向右移动">
                    ►
                  </button>
                  <div></div>
                  <button className="dpad-btn" onClick={() => moveOffset(0, moveStep)} title="向下移动">
                    ▼
                  </button>
                  <div></div>
                </div>
              </div>

              {/* Numeric Position Inputs & Sliders */}
              <div className="setting-item">
                <div className="coord-label-row">
                  <label>X 轴位置 (水平): {geometry.x} px</label>
                </div>
                <div className="range-wrapper flex-row-gap">
                  <input
                    type="range"
                    min={0}
                    max={Math.max(1, screenSize.width - geometry.w)}
                    value={geometry.x}
                    onChange={(e) => updatePosition(e.currentTarget.valueAsNumber, geometry.y)}
                  />
                  <NumberInput
                    value={geometry.x}
                    onCommit={(value) => updatePosition(value, geometryRef.current.y)}
                  />
                </div>
              </div>

              <div className="setting-item">
                <div className="coord-label-row">
                  <label>Y 轴位置 (垂直): {geometry.y} px</label>
                </div>
                <div className="range-wrapper flex-row-gap">
                  <input
                    type="range"
                    min={0}
                    max={Math.max(1, screenSize.height - geometry.h)}
                    value={geometry.y}
                    onChange={(e) => updatePosition(geometry.x, e.currentTarget.valueAsNumber)}
                  />
                  <NumberInput
                    value={geometry.y}
                    onCommit={(value) => updatePosition(geometryRef.current.x, value)}
                  />
                </div>
              </div>

              {/* Preset Quick Buttons */}
              <div className="setting-item flex-col">
                <label>快捷位置预设</label>
                <div className="preset-btn-row">
                  <button className="btn btn-preset" onClick={() => alignPosition("top-center")}>
                    顶部居中
                  </button>
                  <button className="btn btn-preset" onClick={() => alignPosition("bottom-center")}>
                    底部居中
                  </button>
                  <button className="btn btn-preset" onClick={() => alignPosition("center")}>
                    屏幕中央
                  </button>
                  <button className="btn btn-preset" onClick={() => alignPosition("left")}>
                    靠左
                  </button>
                  <button className="btn btn-preset" onClick={() => alignPosition("right")}>
                    靠右
                  </button>
                </div>
              </div>
            </section>
              </>
            )}
            {activePane === "misc" && (
              <>
            {/* Switches */}
            <section className="settings-section">
              <h3>其他选项</h3>
              <div className="setting-item flex-row">
                <label>显示歌词翻译</label>
                <Switch
                  checked={config.showTranslation}
                  onChange={(value) => patchConfig({ showTranslation: value })}
                />
              </div>
              {config.showTranslation && (
                <div className="setting-item">
                  <label>翻译字体大小比例 ({config.transFontSizeScale}%)</label>
                  <div className="range-wrapper">
                    <input
                      type="range"
                      min={15}
                      max={50}
                      value={config.transFontSizeScale}
                      onChange={(e) => patchConfig({ transFontSizeScale: e.currentTarget.valueAsNumber })}
                    />
                  </div>
                </div>
              )}
              <div className="setting-item flex-row">
                <label>锁定桌面歌词</label>
                <Switch checked={config.isLock} onChange={(value) => patchConfig({ isLock: value })} />
              </div>
            </section>
              </>
            )}
              {/* Actions:「重置位置」只在窗口与位置组露出;
                  「恢复默认」恢复的是全部歌词外观(不含窗口几何),各组都留着 */}
              <div className="action-row">
                {activePane === "layout" && (
                  <button className="btn btn-secondary" onClick={resetLyricPosition}>
                    重置位置
                  </button>
                )}
                <button className="btn btn-secondary" onClick={resetConfig}>
                  恢复默认
                </button>
              </div>
            </div>
          )}

          {activePane === "general" && <GeneralPanel />}
          {activePane === "api" && <ExternalApiPanel />}
        </main>
      </div>
    </div>
  );
}
