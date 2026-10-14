import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
    type JSX,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { defaultLyricConfig, type LyricConfig, type LyricLineEvent } from "@shared/ipc";
import { coverThemeLyricColor, hexToRgba } from "@renderer/shared/color";
import { Toolbar } from "./Toolbar";
import type { SongSync, PlaybackSync } from "@shared/hook-contract";
import { anchorProgress, clockPosition, lyricAt } from "@shared/playback-clock";

type LyricWord = LyricLineEvent["lyricData"][number];
type CoverTheme = LyricLineEvent["coverTheme"];

/** 固定布局开销:#app 内边距 (12px*2) + 顶部工具条 (~20px),与旧实现一致 */
const LAYOUT_OVERHEAD = 44;
/** 主进程窗口最小尺寸(与旧实现 JS resize 分支的 minW/minH 一致) */
const MIN_WIDTH = 100;
const MIN_HEIGHT = 50;
/** 行切换过渡时长(与旧 .lyric-scroll 过渡 0.4s 一致) */
const LINE_TRANSITION_MS = 400;

const RESIZE_DIRS = [
    "top",
    "bottom",
    "left",
    "right",
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
] as const;
type ResizeDir = (typeof RESIZE_DIRS)[number];

interface LineState {
    key: number;
    text: string;
    trans: string;
    data: LyricWord[];
}

/** 离场行快照:冻结离场瞬间的 KTV 染色进度与横向滚动位置 */
interface LeavingLine extends LineState {
    posX: string;
    tx: number;
}

interface KtvMetrics {
    spanWidthRatios: number[];
    textWidth: number;
    containerWidth: number;
}

interface InteractionState {
    mode: "drag" | "resize";
    dir: ResizeDir | null;
    startX: number;
    startY: number;
    startWinX: number;
    startWinY: number;
    winWidth: number;
    winHeight: number;
    /** 异步取到窗口 bounds 之后才允许 move/resize,避免起点为 0 的跳变 */
    ready: boolean;
}

/**
 * KTV 逐字进度在同一行内单调递增,均值回落即视为进入了新的一行
 * (用于相邻两行歌词文本完全相同的场景,与旧实现一致)。
 */
function getDataProgress(data: LyricWord[]): number | null {
    if (!Array.isArray(data) || data.length === 0) return null;

    let total = 0;
    let count = 0;
    for (const word of data) {
        const progress = Number(word?.percent);
        if (!Number.isFinite(progress)) continue;
        total += progress;
        count += 1;
    }

    return count > 0 ? total / count : null;
}

/** 旧实现:backgroundPositionX = max(0, (1 - percent) * 100)% */
function ktvBackgroundPositionX(percent: number): string {
    return `${Math.max(0, (1 - percent) * 100).toFixed(2)}%`;
}

const INITIAL_LINE: LineState = { key: 0, text: "MeT-Music", trans: "", data: [] };

interface LyricLineProps {
    text: string;
    data: LyricWord[];
    /** KTV 染色进度(backgroundPositionX);纯文本行不使用 */
    posX: string;
    /** 超宽行横向滚动位移(px) */
    tx: number;
    lineRef?: (el: HTMLDivElement | null) => void;
}

/** 单行歌词(KTV 逐字行 / 纯文本行),当前行与离场行共用 */
function LyricLine({ text, data, posX, tx, lineRef }: LyricLineProps): JSX.Element {
    if (data.length > 0) {
        return (
            <div
                ref={lineRef}
                className="ktv-line"
                style={{ backgroundPositionX: posX, transform: `translateX(${tx}px)` }}
            >
                {data.map((word, index) => (
                    <span key={index} className="ktv-word">
                        {word.content}
                    </span>
                ))}
            </div>
        );
    }
    return (
        <div ref={lineRef} className="plain-line" style={{ transform: `translateX(${tx}px)` }}>
            {text || "MeT-Music"}
        </div>
    );
}

/** 翻译行(当前行与离场行共用) */
function TranslationLine({ className, trans }: { className: string; trans: string }): JSX.Element {
    return (
        <div className={className}>
            <div id="lyric-tran">{trans}</div>
        </div>
    );
}

export function App(): JSX.Element {
    const [config, setConfig] = useState<LyricConfig>(() => defaultLyricConfig());
    const [isPlaying, setIsPlaying] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [isWayland, setIsWayland] = useState(false);
    const [songLabel, setSongLabel] = useState("");
    const [coverTheme, setCoverTheme] = useState<CoverTheme>(null);
    const [line, setLine] = useState<LineState>(INITIAL_LINE);
    const [leaving, setLeaving] = useState<LeavingLine | null>(null);
    const [ktv, setKtv] = useState({ posX: ktvBackgroundPositionX(0), tx: 0 });
    const [mainContentHeight, setMainContentHeight] = useState(() =>
        Math.max(50, window.innerHeight - LAYOUT_OVERHEAD)
    );

    // ---- refs(事件回调中读取,避免闭包过期) ----
    const configRef = useRef(config);
    const isWaylandRef = useRef(false);
    const lineStateRef = useRef<LineState>(INITIAL_LINE);
    const latestDataRef = useRef<LyricWord[]>([]);
    const lineSigRef = useRef("");
    const lineIdRef = useRef<string | undefined>(undefined);
    const syncSongRef = useRef<SongSync | null>(null);
    const syncAnchorRef = useRef<ReturnType<typeof anchorProgress> | null>(null);
    const prevProgressRef = useRef<number | null>(null);
    const ktvRef = useRef({ percent: 0, tx: 0 });
    const metricsRef = useRef<KtvMetrics | null>(null);
    const rafRef = useRef<number | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const currentLineElRef = useRef<HTMLDivElement | null>(null);
    const interactionRef = useRef<InteractionState | null>(null);

    useEffect(() => {
        configRef.current = config;
    }, [config]);

    useEffect(() => {
        isWaylandRef.current = isWayland;
        document.body.classList.toggle("wayland-native", isWayland);
    }, [isWayland]);

    // ---- KTV 逐字染色:测量 / 进度计算(逐行对照旧实现) ----

    const measureKtvLayout = useCallback(() => {
        const lineDom = currentLineElRef.current;
        const containerDom = containerRef.current;
        const latest = latestDataRef.current;
        if (!lineDom || !containerDom || latest.length === 0) {
            metricsRef.current = null;
            return;
        }

        const spans = lineDom.querySelectorAll(".ktv-word");
        if (spans.length !== latest.length) {
            metricsRef.current = null;
            return;
        }

        const lineWidth = Math.max(1, lineDom.offsetWidth);
        metricsRef.current = {
            spanWidthRatios: Array.from(spans, (span) => (span as HTMLElement).offsetWidth / lineWidth),
            textWidth: lineDom.scrollWidth,
            containerWidth: containerDom.offsetWidth,
        };
    }, []);

    /** 进度更新复用缓存的布局测量;仅在行/字体/窗口尺寸变化时重新测量 */
    const updateKtvProgress = useCallback(() => {
        const latest = latestDataRef.current;
        if (latest.length === 0) {
            ktvRef.current = { percent: 0, tx: 0 };
            setKtv({ posX: ktvBackgroundPositionX(0), tx: 0 });
            return;
        }

        if (!metricsRef.current) measureKtvLayout();
        const metrics = metricsRef.current;
        if (!metrics) return;

        let percent = 0;
        for (let i = 0; i < metrics.spanWidthRatios.length; i++) {
            percent += (metrics.spanWidthRatios[i] ?? 0) * (latest[i]?.percent || 0);
        }
        percent = Math.max(0, Math.min(1, percent));

        // 超宽行横向滚动:以当前进度为中心,夹在首尾之间
        const { textWidth, containerWidth } = metrics;
        let tx = 0;
        if (textWidth > containerWidth) {
            const startLeft = (containerWidth - textWidth) / 2;
            tx = textWidth * (0.5 - percent);
            const maxTranslate = -startLeft;
            const minTranslate = startLeft;
            if (tx > maxTranslate) tx = maxTranslate;
            if (tx < minTranslate) tx = minTranslate;
        }

        ktvRef.current = { percent, tx };
        setKtv({ posX: ktvBackgroundPositionX(percent), tx });
    }, [measureKtvLayout]);

    const scheduleKtvUpdate = useCallback(() => {
        if (rafRef.current !== null) return;
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            updateKtvProgress();
        });
    }, [updateKtvProgress]);

    useEffect(() => {
        return () => {
            if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
            // StrictMode 会在首次挂载时清理并重跑 effect；被取消的帧不再是待执行帧。
            rafRef.current = null;
        };
    }, []);

    // ---- 歌词行事件(对照旧 play-lyric-change 处理) ----

    const handleLyricChange = useCallback(
        (data: LyricLineEvent) => {
            if (!data) return;

            const nextText = data.lyricText || "";
            const nextData = data.lyricData || [];
            const nextTrans = data.lyricTrans || "";
            const nextProgress = getDataProgress(nextData);

            const cur = lineStateRef.current;
            const textChanged = nextText !== cur.text;
            const nextSig = nextData.map((word) => word?.content || "").join("\u0001");
            const structureChanged = nextSig !== lineSigRef.current;
            const repeatedTextStartedNewLine =
                !textChanged &&
                prevProgressRef.current !== null &&
                nextProgress !== null &&
                nextProgress + 0.05 < prevProgressRef.current;
            const lineChanged = textChanged || structureChanged || (data.lineId !== undefined
                ? data.lineId !== lineIdRef.current : repeatedTextStartedNewLine);
            lineIdRef.current = data.lineId;

            latestDataRef.current = nextData;

            if (lineChanged) {
                const renderedStyle = currentLineElRef.current
                    ? getComputedStyle(currentLineElRef.current) : null;
                // 离场快照(冻结旧行的染色进度),行 key 自增以强制重放行切换过渡
                const snapshot: LeavingLine = {
                    ...cur,
                    posX: renderedStyle?.backgroundPositionX ?? ktvBackgroundPositionX(ktvRef.current.percent),
                    tx: renderedStyle && renderedStyle.transform !== "none"
                        ? new DOMMatrixReadOnly(renderedStyle.transform).m41 : ktvRef.current.tx,
                };
                const nextLine: LineState = {
                    key: cur.key + 1,
                    text: nextText,
                    trans: nextTrans,
                    data: nextData,
                };
                lineSigRef.current = nextSig;
                metricsRef.current = null;
                ktvRef.current = { percent: 0, tx: 0 };
                setKtv({ posX: ktvBackgroundPositionX(0), tx: 0 });
                lineStateRef.current = nextLine;
                setLine(nextLine);
                setLeaving(cur.data.length > 0 && nextData.length > 0 ? snapshot : null);
                // 封面主题只在行切换时刷新(IPC 每 tick 都是新对象,逐 tick 深比较不值得;
                // 同为 null 时 React 按引用相等跳过重渲染)
                setCoverTheme(data.coverTheme ?? null);
            } else {
                // 同行 tick:进度数据走 latestDataRef + rAF KTV 通道,不再 setLine 新对象;
                // 仅翻译实际变化时才触发一次 setLine
                const nextLine: LineState = { ...cur, text: nextText, trans: nextTrans, data: nextData };
                lineStateRef.current = nextLine;
                if (nextTrans !== cur.trans) setLine(nextLine);
            }

            prevProgressRef.current = nextProgress;

            // 行变化时由 line.key effect 在渲染完成后重测(对应旧 nextTick)
            if (!lineChanged) scheduleKtvUpdate();
        },
        [scheduleKtvUpdate]
    );

    useEffect(() => {
        let timer: ReturnType<typeof setInterval> | null = null;
        let disposed = false;
        let loadingSnapshot = false;
        let pendingProgress: PlaybackSync | null = null;
        const render = () => {
            const song = syncSongRef.current;
            const anchor = syncAnchorRef.current;
            if (!song || !anchor) return;
            handleLyricChange(lyricAt(song, clockPosition(anchor)));
        };
        const receive = (data: PlaybackSync) => {
            if (data.kind === "song") {
                syncSongRef.current = data;
                setSongLabel(`${data.songName} - ${data.songArtist}`);
                setCoverTheme(data.coverTheme ?? null);
            }
            if (syncSongRef.current?.revision !== data.revision) {
                pendingProgress = data;
                void restoreSnapshot();
                return;
            }
            pendingProgress = null;
            syncAnchorRef.current = anchorProgress(data);
            setIsPlaying(data.isPlaying);
            if (timer) clearInterval(timer);
            timer = null;
            render();
            if (data.isPlaying) timer = setInterval(render, 1000 / 30);
        };
        // 完整快照可能在窗口加载/旧 Hook 交接时丢失。进度包没有字时间轴，
        // 必须重新取主进程缓存，而不能永远等下一次歌曲变化才恢复逐字染色。
        const restoreSnapshot = async () => {
            if (loadingSnapshot || disposed) return;
            loadingSnapshot = true;
            try {
                const state = await window.desktopAPI.getPlaybackSync();
                if (disposed || !state || (syncAnchorRef.current && !pendingProgress)) return;
                const pending = pendingProgress;
                if (pending && pending.revision !== state.song.revision) return;
                receive(state.song);
                receive(pending && pending.timestamp >= state.progress.timestamp
                    ? pending : state.progress);
            } catch {
                // 下一个进度包会重试；旧 Hook 模式仍可正常渲染。
            } finally {
                loadingSnapshot = false;
            }
        };
        const unsubscribe = window.desktopAPI.onPlaybackSync(receive);
        void restoreSnapshot();
        return () => {
            disposed = true;
            unsubscribe();
            if (timer) clearInterval(timer);
        };
    }, [handleLyricChange]);

    /** 行切换后:渲染完成再测量新行布局(对应旧 nextTick(scheduleKtvProgressUpdate)) */
    useLayoutEffect(() => {
        metricsRef.current = null;
        updateKtvProgress();
    }, [line.key, updateKtvProgress]);

    /** 离场行在过渡结束后移除 */
    useEffect(() => {
        if (!leaving) return;
        const timer = setTimeout(() => setLeaving(null), LINE_TRANSITION_MS);
        return () => clearTimeout(timer);
    }, [leaving]);

    /** 窗口尺寸变化 → 显式失效缓存并调度重测(不依赖 mainContentHeight state 变化:
     *  高度不变仅宽度变化时 state 不更新,但 KTV 布局仍需重测) */
    const invalidateKtvLayout = useCallback(() => {
        metricsRef.current = null;
        scheduleKtvUpdate();
    }, [scheduleKtvUpdate]);

    // ---- 字号:按内容区高度自适应(与旧实现一致,config.fontSize 不直接参与) ----

    const hasTrans = config.showTranslation && line.trans !== "";
    const computedFontSize = hasTrans
        ? Math.max(16, Math.floor(mainContentHeight * 0.55))
        : Math.max(20, Math.floor(mainContentHeight * 0.75));
    const transScale = (config.transFontSizeScale ?? 23) / 100;
    const computedTransFontSize = Math.max(12, Math.floor(mainContentHeight * transScale));

    const lyricFontFamily = config.lyricFontFamily?.trim() || "inherit";
    const translationFontFamily = config.translationFontFamily?.trim() || "inherit";

    // LRC 和前奏歌曲信息没有逐字进度可供滚动，主行与译文必须同时完整放下。
    const isPlainLine = line.data.length === 0;
    useLayoutEffect(() => {
        const main = containerRef.current?.parentElement;
        if (!main) return;
        if (!isPlainLine) {
            main.style.removeProperty("--lyric-font-size");
            main.style.removeProperty("--trans-font-size");
            return;
        }

        const fit = () => {
            const text = currentLineElRef.current;
            const container = containerRef.current;
            if (!text || !container) return;
            const translation = main.querySelector<HTMLElement>("#lyric-tran");
            // 留出描边和取整余量，避免字形边缘被 overflow:hidden 裁掉。
            const clearance = Math.ceil(config.strokeWidth) + 2;
            const width = Math.max(0, container.clientWidth - clearance * 2);
            const height = Math.max(0, main.clientHeight - clearance * 2);
            const applyScale = (scale: number) => {
                main.style.setProperty("--lyric-font-size", `${computedFontSize * scale}px`);
                main.style.setProperty("--trans-font-size", `${computedTransFontSize * scale}px`);
            };
            const fits = () => text.scrollWidth <= width
                && (!translation || translation.scrollWidth <= width)
                && text.offsetHeight + (translation ? translation.offsetHeight + 4 : 0) <= height;

            applyScale(1);
            if (fits()) return;
            // 测量实际字体而非估算字符宽度；两行共用比例，保留译文字号设置。
            let low = 0;
            let high = 1;
            for (let i = 0; i < 14; i++) {
                const mid = (low + high) / 2;
                applyScale(mid);
                if (fits()) low = mid;
                else high = mid;
            }
            applyScale(low);
        };
        fit();
        const observer = new ResizeObserver(fit);
        observer.observe(main);
        document.fonts.addEventListener("loadingdone", fit);
        return () => {
            observer.disconnect();
            document.fonts.removeEventListener("loadingdone", fit);
        };
    }, [isPlainLine, line.text, line.trans, hasTrans, computedFontSize, computedTransFontSize,
        lyricFontFamily, translationFontFamily, config.lyricFontWeight,
        config.translationFontWeight, config.strokeWidth]);

    /** 字号/字体/字重变化会使已测量的 KTV 布局失效(对应旧 layoutStyleSignature) */
    useEffect(() => {
        metricsRef.current = null;
        scheduleKtvUpdate();
    }, [computedFontSize, lyricFontFamily, config.lyricFontWeight, scheduleKtvUpdate]);

    // ---- IPC 订阅与初始化 ----

    useEffect(() => {
        let disposed = false;
        const unsubs: Array<() => void> = [];

        // 两个 invoke 并发发出(allSettled 保留各自的失败兜底语义)
        void Promise.allSettled([
            window.desktopAPI.getAppInfo(),
            window.desktopAPI.getLyricConfig(),
        ]).then(([infoResult, configResult]) => {
            if (disposed) return;
            // 环境信息获取失败时按非 Wayland 处理
            if (infoResult.status === "fulfilled") {
                setIsWayland(Boolean(infoResult.value?.isWayland));
            }
            // 配置获取失败时保持默认配置
            if (configResult.status === "fulfilled" && configResult.value) {
                setConfig((prev) => ({ ...prev, ...configResult.value }));
            }
        });

        unsubs.push(window.desktopAPI.onLyricChange((data) => {
            syncSongRef.current = null;
            syncAnchorRef.current = null;
            handleLyricChange(data);
        }));
        unsubs.push(window.desktopAPI.onStatusChange((state) => setIsPlaying(Boolean(state))));
        unsubs.push(
            window.desktopAPI.onConfigChanged((newConfig) => {
                if (newConfig) setConfig((prev) => ({ ...prev, ...newConfig }));
            })
        );
        unsubs.push(window.desktopAPI.onSongChange((label) => setSongLabel(label || "")));
        // 主进程侧程序化调整窗口尺寸(Wayland 原生 resize 也走这里)
        unsubs.push(
            window.desktopAPI.onWindowResized((_width, height) => {
                setMainContentHeight(Math.max(50, height - LAYOUT_OVERHEAD));
                invalidateKtvLayout();
            })
        );

        return () => {
            disposed = true;
            for (const unsub of unsubs) unsub();
        };
    }, [handleLyricChange, invalidateKtvLayout]);

    /** 窗口自身 resize 事件(与主进程事件互为兜底,同旧实现) */
    useEffect(() => {
        const onResize = () => {
            setMainContentHeight(Math.max(50, window.innerHeight - LAYOUT_OVERHEAD));
            invalidateKtvLayout();
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, [invalidateKtvLayout]);

    // ---- 拖动 / 调整大小(非 Wayland:JS 实现;Wayland:原生 app-region + 原生边缘 resize) ----

    const startDrag = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
        if (configRef.current.isLock || isWaylandRef.current) return;
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (target && (target.closest(".item") || target.closest(".resize-handle"))) return;

        const state: InteractionState = {
            mode: "drag",
            dir: null,
            startX: event.screenX,
            startY: event.screenY,
            startWinX: 0,
            startWinY: 0,
            winWidth: 0,
            winHeight: 0,
            ready: false,
        };
        interactionRef.current = state;
        setIsDragging(true);

        void window.desktopAPI
            .getLyricBounds()
            .then((bounds) => {
                if (interactionRef.current !== state) return;
                state.startWinX = bounds.x;
                state.startWinY = bounds.y;
                state.winWidth = bounds.width;
                state.winHeight = bounds.height;
                state.ready = true;
            })
            .catch(() => {
                if (interactionRef.current === state) {
                    interactionRef.current = null;
                    setIsDragging(false);
                }
            });
    }, []);

    const startResize = useCallback((event: ReactMouseEvent<HTMLDivElement>, dir: ResizeDir) => {
        if (configRef.current.isLock || isWaylandRef.current) return;
        event.stopPropagation();
        event.preventDefault();

        const state: InteractionState = {
            mode: "resize",
            dir,
            startX: event.screenX,
            startY: event.screenY,
            startWinX: 0,
            startWinY: 0,
            winWidth: 0,
            winHeight: 0,
            ready: false,
        };
        interactionRef.current = state;

        void window.desktopAPI
            .getLyricBounds()
            .then((bounds) => {
                if (interactionRef.current !== state) return;
                state.startWinX = bounds.x;
                state.startWinY = bounds.y;
                state.winWidth = bounds.width;
                state.winHeight = bounds.height;
                state.ready = true;
            })
            .catch(() => {
                if (interactionRef.current === state) interactionRef.current = null;
            });
    }, []);

    useEffect(() => {
        const onMouseMove = (event: MouseEvent) => {
            const state = interactionRef.current;
            if (!state || !state.ready) return;

            const deltaX = event.screenX - state.startX;
            const deltaY = event.screenY - state.startY;

            if (state.mode === "drag") {
                const x = state.startWinX + deltaX;
                const y = state.startWinY + deltaY;
                window.desktopAPI.lyricWindow({ type: "move", x, y });
                return;
            }

            const dir = state.dir ?? "";
            let newX = state.startWinX;
            let newY = state.startWinY;
            let newW = state.winWidth;
            let newH = state.winHeight;

            if (dir.includes("top")) {
                newY = state.startWinY + deltaY;
                newH = state.winHeight - deltaY;
            } else if (dir.includes("bottom")) {
                newH = state.winHeight + deltaY;
            }

            if (dir.includes("left")) {
                newX = state.startWinX + deltaX;
                newW = state.winWidth - deltaX;
            } else if (dir.includes("right")) {
                newW = state.winWidth + deltaX;
            }

            if (newW < MIN_WIDTH) {
                if (dir.includes("left")) newX = state.startWinX + (state.winWidth - MIN_WIDTH);
                newW = MIN_WIDTH;
            }
            if (newH < MIN_HEIGHT) {
                if (dir.includes("top")) newY = state.startWinY + (state.winHeight - MIN_HEIGHT);
                newH = MIN_HEIGHT;
            }

            window.desktopAPI.lyricWindow({
                type: "resize",
                x: Math.floor(newX),
                y: Math.floor(newY),
                width: Math.floor(newW),
                height: Math.floor(newH),
            });

            // 由已知窗口高度直接推算内容区高度(与旧实现一致)
            setMainContentHeight(Math.max(50, Math.floor(newH) - LAYOUT_OVERHEAD));
        };

        const onMouseUp = () => {
            const state = interactionRef.current;
            interactionRef.current = null;
            setIsDragging(false);
            if (!state || !state.ready) return;

            // 拖动/调整大小结束:main 自读当前 bounds 落盘,无需回读 invoke
            window.desktopAPI.lyricWindow({ type: "save-current-bounds" });
        };

        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
        return () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
        };
    }, []);

    // ---- 工具条动作 ----

    const showApp = useCallback(() => window.desktopAPI.windowControl("show-main"), []);
    const openSettings = useCallback(() => window.desktopAPI.windowControl("open-settings"), []);
    const playPrev = useCallback(() => window.desktopAPI.playerCommand("prev"), []);
    const playNext = useCallback(() => window.desktopAPI.playerCommand("next"), []);
    const playOrPause = useCallback(() => window.desktopAPI.playerCommand("playOrPause"), []);
    const closeLyric = useCallback(() => window.desktopAPI.lyricWindow({ type: "toggle-visibility" }), []);
    const toggleLock = useCallback(() => {
        const nextLock = !configRef.current.isLock;
        setConfig((prev) => ({ ...prev, isLock: nextLock }));
        window.desktopAPI.lyricWindow({ type: "set-lock", isLock: nextLock });
    }, []);

    // 锁定态穿透联动:darwin/win32 的 setIgnoreMouseEvents(true, {forward}) 只转发
    // mousemove(点击仍穿透),因此解锁按钮 hover 时临时关闭穿透使其可点击。
    // Linux/Wayland 无 forward,锁定后收不到任何鼠标事件,这两个回调天然不会触发
    // (即保持旧行为:锁定态不显示/不响应按钮),无需按平台分支。
    const onLockButtonEnter = useCallback(() => {
        if (!configRef.current.isLock) return;
        window.desktopAPI.lyricWindow({ type: "set-passthrough", enabled: false });
    }, []);
    const onLockButtonLeave = useCallback(() => {
        if (!configRef.current.isLock) return;
        window.desktopAPI.lyricWindow({ type: "set-passthrough", enabled: true });
    }, []);

    // ---- 样式变量(对应旧 watchEffect 写入 #app 的 CSS 变量) ----

    const activeColor = (() => {
        if (config.useThemeColorForActive) {
            return coverThemeLyricColor(coverTheme?.light?.shadeTwo) ?? "#efefef95";
        }
        return config.colorActive;
    })();

    const baseOpacity = isPlaying ? 1 : (config.pausedOpacity ?? 50) / 100;
    const appOpacity = ((baseOpacity * (config.overallOpacity ?? 100)) / 100).toFixed(2);

    const appStyle = {
        "--lyric-font-size": `${computedFontSize}px`,
        "--trans-font-size": `${computedTransFontSize}px`,
        "--lyric-font-family": lyricFontFamily,
        "--translation-font-family": translationFontFamily,
        "--lyric-font-weight": String(config.lyricFontWeight ?? 700),
        "--translation-font-weight": String(config.translationFontWeight ?? 400),
        "--main-color": hexToRgba(config.textColor, config.textOpacity),
        "--color-active": activeColor,
        "--color-inactive": config.colorInactive,
        "--lyric-outline-filter": config.strokeWidth > 0 ? "url(#lyric-outline)" : "none",
        "--hover-bg-color": config.bgColor,
        opacity: appOpacity,
    } as CSSProperties;

    const appClassName = [config.isLock ? "lock-lyric" : "", isDragging ? "is-dragging" : ""]
        .filter(Boolean)
        .join(" ");

    const setCurrentLineEl = useCallback((el: HTMLDivElement | null) => {
        currentLineElRef.current = el;
    }, []);

    // 进场动画仅在发生过行切换时启用(初始渲染不动画,同旧 Vue transition 行为)
    const enterClass = leaving ? " lyric-scroll-enter" : "";
    const transEnterClass = leaving && leaving.trans !== "" ? " lyric-scroll-enter" : "";

    return (
        <div id="app" className={appClassName} style={appStyle}>
            <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
                <defs>
                    <filter id="lyric-outline" x="-50%" y="-100%" width="200%" height="300%"
                        colorInterpolationFilters="sRGB">
                        <feComponentTransfer in="SourceAlpha" result="glyph-mask">
                            <feFuncA type="linear" slope="10000" />
                        </feComponentTransfer>
                        <feMorphology in="glyph-mask" operator="dilate" radius={config.strokeWidth} result="expanded" />
                        <feComposite in="expanded" in2="glyph-mask" operator="out" result="outline" />
                        <feFlood floodColor={config.strokeColor} result="color" />
                        <feComposite in="color" in2="outline" operator="in" result="colored-outline" />
                        <feMerge>
                            <feMergeNode in="colored-outline" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                </defs>
            </svg>
            <div className="drag-area" onMouseDown={startDrag} />

            <Toolbar
                isPlaying={isPlaying}
                isLock={config.isLock}
                songLabel={songLabel}
                onShowApp={showApp}
                onOpenSettings={openSettings}
                onPlayPrev={playPrev}
                onPlayOrPause={playOrPause}
                onPlayNext={playNext}
                onToggleLock={toggleLock}
                onLockMouseEnter={onLockButtonEnter}
                onLockMouseLeave={onLockButtonLeave}
                onClose={closeLyric}
            />

            <main id="lyric-content" className={isPlainLine ? "plain-content" : undefined}>
                <div id="lyric-text-container" ref={containerRef}>
                    {[...(leaving ? [leaving] : []), line].map((renderedLine) => {
                        const isLeaving = renderedLine !== line;
                        const frozen = isLeaving ? renderedLine as LeavingLine : null;
                        return (
                            <div key={renderedLine.key}
                                className={`lyric-wrapper${isLeaving ? " lyric-scroll-leave" : enterClass}`}>
                                <LyricLine
                                    text={renderedLine.text}
                                    data={renderedLine.data}
                                    posX={frozen ? frozen.posX : ktv.posX}
                                    tx={frozen ? frozen.tx : ktv.tx}
                                    lineRef={isLeaving ? undefined : setCurrentLineEl}
                                />
                            </div>
                        );
                    })}
                </div>

                {hasTrans && (
                    <div id="lyric-tran-container">
                        {[...(leaving && leaving.trans !== "" ? [leaving] : []), line].map((renderedLine) => (
                            <TranslationLine
                                key={renderedLine.key}
                                className={`lyric-tran-wrapper${renderedLine !== line
                                    ? " lyric-scroll-leave" : transEnterClass}`}
                                trans={renderedLine.trans}
                            />
                        ))}
                    </div>
                )}
            </main>

            {RESIZE_DIRS.map((dir) => (
                <div
                    key={dir}
                    className={`resize-handle resize-${dir}`}
                    data-direction={dir}
                    onMouseDown={(event) => startResize(event, dir)}
                />
            ))}
        </div>
    );
}
