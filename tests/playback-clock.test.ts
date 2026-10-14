import { test } from "node:test";
import assert from "node:assert/strict";
import { anchorProgress, clockPosition, lyricAt } from "../src/shared/playback-clock.ts";
import { PlaybackSyncSchema, SongSyncSchema, HookPayloadSchema } from "../src/shared/hook-contract.ts";

const song = SongSyncSchema.parse({
    kind: "song", revision: 1, timestamp: 1000, songName: "Song", songArtist: "Artist",
    songMid: 1, currentTime: 0, duration: 10, isPlaying: true, playbackRate: 1,
    lyricText: "", lyricData: [], lineOffset: 0, wordOffset: 300, inclusive: false,
    lyrics: [
        { time: 1000, content: "repeat", tran: "翻译", words: [{ content: "repeat", start: 1000, end: 2000 }] },
        { time: 3000, content: "repeat", words: [{ content: "repeat", start: 3000, end: 4000 }] },
    ],
});

test("compensates transit delay, advances by rate, clamps at duration, and freezes on pause", () => {
    const anchor = anchorProgress({ ...song, currentTime: 1, playbackRate: 2 }, 1250, 500);
    assert.equal(clockPosition(anchor, 1000), 2.5);
    assert.equal(clockPosition(anchor, 50000), 10);
    const paused = anchorProgress({ ...song, isPlaying: false, currentTime: 3 }, 9000, 500);
    assert.equal(clockPosition(paused, 100000), 3);
    const rewind = anchorProgress({ ...song, isPlaying: false, currentTime: 0.5 }, 9000, 500);
    assert.equal(clockPosition(rewind, 100000), 0.5);
    assert.equal(clockPosition(anchorProgress(song, 900, 500), 500), 0);
});

test("preserves separate line and word offsets, intro placeholder, repeated lines and seek back", () => {
    assert.equal(lyricAt(song, 0).lyricText, "Song - Artist");
    assert.equal(lyricAt(song, 1).lyricText, "Song - Artist");
    assert.equal(lyricAt(song, 1.2).lyricData[0].percent, 0.5);
    assert.equal(lyricAt(song, 1.2).lyricTrans, "翻译");
    assert.notEqual(lyricAt(song, 1.2).lineId, lyricAt(song, 3.2).lineId);
    assert.equal(lyricAt(song, 1.2).lineId, "1:0");
    assert.equal(lyricAt({ ...song, lineOffset: -1000 }, 1.2).lyricText, "Song - Artist");
});

test("TTML selects the latest overlapping line with inclusive boundaries and shared offsets", () => {
    const ttml = { ...song, inclusive: true, lineOffset: -800, wordOffset: -800 };
    assert.equal(lyricAt(ttml, 1.8).lyricText, "repeat");
    assert.equal(lyricAt(ttml, 2).lyricData[0].percent, 0.2);
    assert.equal(lyricAt(ttml, 3.8).lineId, "1:1");
});

test("sync accepts compact progress, rejects malformed data, and preserves the v2 Hook", () => {
    assert.equal(HookPayloadSchema.safeParse(song).success, true);
    const progress = { kind: "progress", revision: 1, currentTime: 3, duration: 10,
        timestamp: 1000, isPlaying: false, playbackRate: 1 };
    assert.equal(PlaybackSyncSchema.safeParse(progress).success, true);
    for (const patch of [{ timestamp: undefined }, { playbackRate: 0 }, { currentTime: Infinity }, { revision: -1 }]) {
        assert.equal(PlaybackSyncSchema.safeParse({ ...progress, ...patch }).success, false);
    }
});
