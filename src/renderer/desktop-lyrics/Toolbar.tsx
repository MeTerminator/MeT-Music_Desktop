import type { JSX } from "react";

/** 悬停工具条(与旧实现 header .tools 对齐,新增「打开设置」按钮与歌名显示) */

const AppLogoIcon = (
    <svg viewBox="0 0 1024 1024" version="1.1" width="32" height="32">
        <path
            d="M511.764091 131.708086a446.145957 446.145957 0 1 0 446.145957 446.145957 446.145957 446.145957 0 0 0-446.145957-446.145957z m0 519.76004A71.829499 71.829499 0 1 1 583.59359 580.530919 72.275645 72.275645 0 0 1 511.764091 651.468126z"
            fill="#F55E55"
        />
        <path
            d="M802.205109 0.541175l-168.197026 37.030114a67.814185 67.814185 0 0 0-53.091369 66.029602V223.614153l3.569168 349.778431h114.213365V223.614153h108.859613a26.322611 26.322611 0 0 0 26.768758-26.322611V26.863786a26.768757 26.768757 0 0 0-32.122509-26.322611z"
            fill="#F9BBB8"
        />
        <path
            d="M511.764091 386.457428a186.935156 186.935156 0 1 0 186.935156 186.48901A186.935156 186.935156 0 0 0 511.764091 386.457428z m0 264.564552a71.383353 71.383353 0 1 1 71.383353-71.383353 71.383353 71.383353 0 0 1-71.383353 71.383353z"
            fill="#F9BBB8"
        />
    </svg>
);

const SettingsIcon = (
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
        <path
            fill="currentColor"
            d="M19.14 12.94c.04-.3.06-.61.06-.94c0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6s3.6 1.62 3.6 3.6s-1.62 3.6-3.6 3.6"
        />
    </svg>
);

const PrevIcon = (
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
        <path
            fill="currentColor"
            d="M7 6c.55 0 1 .45 1 1v10c0 .55-.45 1-1 1s-1-.45-1-1V7c0-.55.45-1 1-1m3.66 6.82l5.77 4.07c.66.47 1.58-.01 1.58-.82V7.93c0-.81-.91-1.28-1.58-.82l-5.77 4.07a1 1 0 0 0 0 1.64"
        />
    </svg>
);

const PauseIcon = (
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
        <path
            fill="currentColor"
            d="M8 19c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2v10c0 1.1.9 2 2 2m6-12v10c0 1.1.9 2 2 2s2-.9 2-2V7c0-1.1-.9-2-2-2s-2 .9-2 2"
        />
    </svg>
);

const PlayIcon = (
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
        <path
            fill="currentColor"
            d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.69L9.54 5.98A.998.998 0 0 0 8 6.82"
        />
    </svg>
);

const NextIcon = (
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
        <path
            fill="currentColor"
            d="m7.58 16.89l5.77-4.07c.56-.4.56-1.24 0-1.63L7.58 7.11C6.91 6.65 6 7.12 6 7.93v8.14c0 .81.91 1.28 1.58.82M16 7v10c0 .55.45 1 1 1s1-.45 1-1V7c0-.55-.45-1-1-1s-1 .45-1 1"
        />
    </svg>
);

const LockedIcon = (
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
        <path
            fill="currentColor"
            d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2s-2 .9-2 2s.9 2 2 2m6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2m-6-5c1.66 0 3 1.34 3 3v2H9V6c0-1.66 1.34-3 3-3"
        />
    </svg>
);

const UnlockedIcon = (
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
        <path
            fill="currentColor"
            d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2M9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9zm9 14H6V10h12zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2s-2 .9-2 2s.9 2 2 2"
        />
    </svg>
);

const CloseIcon = (
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
        <path
            fill="currentColor"
            d="M13.46 12L19 17.54V19h-1.46L12 13.46L6.46 19H5v-1.46L10.54 12L5 6.46V5h1.46L12 10.54L17.54 5H19v1.46z"
        />
    </svg>
);

export interface ToolbarProps {
    isPlaying: boolean;
    isLock: boolean;
    songLabel: string;
    onShowApp: () => void;
    onOpenSettings: () => void;
    onPlayPrev: () => void;
    onPlayOrPause: () => void;
    onPlayNext: () => void;
    onToggleLock: () => void;
    /** 锁定态穿透联动:hover 解锁按钮时临时关闭窗口穿透(见 App.tsx) */
    onLockMouseEnter: () => void;
    onLockMouseLeave: () => void;
    onClose: () => void;
}

export function Toolbar({
    isPlaying,
    isLock,
    songLabel,
    onShowApp,
    onOpenSettings,
    onPlayPrev,
    onPlayOrPause,
    onPlayNext,
    onToggleLock,
    onLockMouseEnter,
    onLockMouseLeave,
    onClose,
}: ToolbarProps): JSX.Element {
    return (
        <header>
            <div className="tools" id="tools">
                <div className="item-section">
                    <div className="item" title="打开应用" onClick={onShowApp}>
                        {AppLogoIcon}
                    </div>
                    <div className="item" title="打开设置" onClick={onOpenSettings}>
                        {SettingsIcon}
                    </div>
                    {songLabel !== "" && (
                        <div className="song-label" title={songLabel}>
                            {songLabel}
                        </div>
                    )}
                </div>

                <div className="item-section playback-controls">
                    <div className="item" title="上一首" onClick={onPlayPrev}>
                        {PrevIcon}
                    </div>
                    <div className="item" title={isPlaying ? "暂停" : "播放"} onClick={onPlayOrPause}>
                        {isPlaying ? PauseIcon : PlayIcon}
                    </div>
                    <div className="item" title="下一首" onClick={onPlayNext}>
                        {NextIcon}
                    </div>
                </div>

                <div className="item-section">
                    <div
                        className="item item-lock"
                        title={isLock ? "解锁" : "锁定"}
                        onClick={onToggleLock}
                        onMouseEnter={onLockMouseEnter}
                        onMouseLeave={onLockMouseLeave}
                    >
                        {isLock ? LockedIcon : UnlockedIcon}
                    </div>
                    <div className="item" title="关闭" onClick={onClose}>
                        {CloseIcon}
                    </div>
                </div>
            </div>
        </header>
    );
}
