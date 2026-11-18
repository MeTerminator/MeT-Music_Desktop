import { test } from "node:test";
import assert from "node:assert/strict";
import { lyricToolbarPosition } from "../src/shared/lyric-layout.ts";

test("controls face the display centre using the window centre", () => {
    const display = { y: 0, height: 1000 };
    assert.equal(lyricToolbarPosition({ y: 0, height: 100 }, display), "bottom");
    assert.equal(lyricToolbarPosition({ y: 449, height: 100 }, display), "bottom");
    assert.equal(lyricToolbarPosition({ y: 450, height: 100 }, display), "top");
    assert.equal(lyricToolbarPosition({ y: 900, height: 100 }, display), "top");
    assert.equal(lyricToolbarPosition({ y: 400, height: 250 }, display), "top", "resizing can cross the midpoint");
});

test("uses the current display origin, including displays above and below the primary", () => {
    assert.equal(lyricToolbarPosition({ y: -950, height: 100 }, { y: -1000, height: 1000 }), "bottom");
    assert.equal(lyricToolbarPosition({ y: -150, height: 100 }, { y: -1000, height: 1000 }), "top");
    assert.equal(lyricToolbarPosition({ y: 1100, height: 100 }, { y: 1000, height: 1000 }), "bottom");
    assert.equal(lyricToolbarPosition({ y: 1800, height: 100 }, { y: 1000, height: 1000 }), "top");
});
