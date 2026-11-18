export const DEFAULT_LYRIC_HEIGHT = 120;

export type LyricToolbarPosition = "top" | "bottom";

/** Compare the window centre with the midpoint of its display, in desktop coordinates. */
export function lyricToolbarPosition(
    window: { y: number; height: number },
    display: { y: number; height: number },
): LyricToolbarPosition {
    return window.y + window.height / 2 < display.y + display.height / 2 ? "bottom" : "top";
}
