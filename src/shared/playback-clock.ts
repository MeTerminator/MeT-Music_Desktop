import type { PlaybackProgress, SongSync } from "./hook-contract";

/** 用系统时间补偿 IPC 延迟，再以单调时钟推进，避免系统校时导致歌词跳动。 */
export function anchorProgress(progress: PlaybackProgress, now = Date.now(), monotonic = performance.now()) {
    return {
        ...progress,
        currentTime: progress.currentTime + (progress.isPlaying
            ? Math.max(0, now - progress.timestamp) / 1000 * progress.playbackRate : 0),
        monotonic,
    };
}
export function clockPosition(anchor: ReturnType<typeof anchorProgress>, monotonic = performance.now()): number {
    const position = anchor.currentTime + (anchor.isPlaying
        ? Math.max(0, monotonic - anchor.monotonic) / 1000 * anchor.playbackRate : 0);
    return Math.max(0, anchor.duration > 0 ? Math.min(position, anchor.duration) : position);
}

/** 与 UI 的普通歌词和 TTML 行选择、逐字进度语义保持一致。 */
export function lyricAt(song: SongSync, seconds: number) {
    const lineTime = seconds * 1000 + song.lineOffset;
    const wordTime = seconds * 1000 + song.wordOffset;
    let index = -1;
    for (let i = 0; i < song.lyrics.length; i++) {
        const time = song.lyrics[i].time;
        if ((song.inclusive ? time <= lineTime : time < lineTime)
            && (index < 0 || time >= song.lyrics[index].time)) index = i;
    }
    const line = song.lyrics[index];
    const hasText = Boolean(line?.content.trim());
    return {
        lineId: `${song.revision}:${index}`,
        lyricText: hasText ? line.content : `${song.songName} - ${song.songArtist}`,
        lyricTrans: hasText ? line.tran ?? "" : "",
        lyricData: hasText ? (line.words ?? []).map((word) => ({
            content: word.content,
            percent: wordTime >= word.end ? 1 : wordTime <= word.start ? 0
                : (wordTime - word.start) / (word.end - word.start),
        })) : [],
        coverTheme: song.coverTheme ?? null,
    };
}
