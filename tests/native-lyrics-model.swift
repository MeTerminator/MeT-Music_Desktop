import Foundation
import AppKit
import Combine

func runNativeLyricsTests() {
    let model = LyricsModel()
    model.receive(["channel": "lyric:toolbar-position", "payload": "bottom"])
    assert(model.toolbarAtBottom, "upper display half puts controls below lyrics")
    model.receive(["channel": "lyric:toolbar-position", "payload": "top"])
    assert(!model.toolbarAtBottom, "lower display half puts controls above lyrics")
    let now = Date().timeIntervalSince1970 * 1000
    // The model receives exactly the existing playback contract, in seconds / milliseconds.
    var song: [String: Any] = ["kind": "song", "revision": 4, "timestamp": now,
        "currentTime": 1.5, "duration": 20, "isPlaying": false, "playbackRate": 1,
        "songName": "Song", "songArtist": "Artist", "lineOffset": 0, "wordOffset": 300,
        "inclusive": true, "lyrics": [
            ["time": 1000, "content": "你好", "tran": "Hello", "words": [
                ["content": "你", "start": 1000, "end": 2000],
                ["content": "好", "start": 2000, "end": 3000]]],
            ["time": 3000, "content": "下一行"]]]
    func receive(_ p: [String: Any]) { model.receive(["channel": "lyric:playback-sync", "payload": p]) }
    receive(song)
    assert(model.currentLine().0 == "你好")
    assert(model.currentLine().1 == "Hello")
    assert(abs(model.currentLine().2[0].1 - 0.8) < 0.001, "word offset applies separately")
    let paused = model.currentLine().2[0].1
    Thread.sleep(forTimeInterval: 0.05)
    assert(model.currentLine().2[0].1 == paused, "paused position stays fixed")
    receive(["kind": "progress", "revision": 3, "currentTime": 10, "isPlaying": false])
    assert(model.currentLine().0 == "你好", "stale revisions are ignored")
    song["currentTime"] = 3.0; receive(song)
    assert(model.currentLine().0 == "下一行", "inclusive boundary selects next line")
    song["inclusive"] = false; receive(song)
    assert(model.currentLine().0 == "你好", "exclusive boundary keeps previous line")
    song["currentTime"] = 0; receive(song)
    assert(model.currentLine().0 == "Song - Artist", "intro displays song label")
    song["currentTime"] = 1.0; song["isPlaying"] = true
    song["timestamp"] = Date().timeIntervalSince1970 * 1000
    receive(song)
    let before = model.currentLine().2[0].1
    Thread.sleep(forTimeInterval: 0.06)
    assert(model.currentLine().2[0].1 > before + 0.04, "local clock advances without IPC")
    model.receive(["channel": "lyric:line-change", "payload": ["lyricText": "旧版", "lyricTrans": "Legacy", "lyricData": [["content": "旧版", "percent": 0.4]]]])
    assert(model.song.isEmpty && model.currentLine().0 == "旧版", "legacy frames replace full song")
    assert(abs(model.currentLine().2[0].1 - 0.4) < 0.001)
    assert(abs(color("rgba(255, 128, 0, 0.3)").alphaComponent - 0.3) < 0.001)
    assert(abs(color("#ffffff80").alphaComponent - 128.0 / 255) < 0.001)
    runNativeRenderingTests()
    print("Native lyrics model / cache / rendering tests passed")
}


func runNativeRenderingTests() {
    let model = LyricsModel()
    var config: [String: Any] = ["showTranslation": true, "textColor": "#ffffff", "textOpacity": 100,
        "colorActive": "#ff0000", "colorInactive": "#ffffff", "useThemeColorForActive": false,
        "strokeWidth": 2, "strokeColor": "#000000", "lyricFontWeight": 700]
    model.receive(["channel": "lyric:config-changed", "payload": config])
    let song: [String: Any] = ["kind": "song", "revision": 8, "timestamp": Date().timeIntervalSince1970 * 1000,
        "currentTime": 1.5, "duration": 60, "isPlaying": true, "playbackRate": 1,
        "songName": "Rendering", "songArtist": "Test", "lineOffset": 0, "wordOffset": 0, "inclusive": true,
        "lyrics": [["time": 0, "content": "原生歌词", "tran": "Native lyrics", "words":
            Array("原生歌词").enumerated().map { ["content": String($0.element), "start": $0.offset * 1000, "end": ($0.offset + 1) * 1000] }]]]
    model.receive(["channel": "lyric:playback-sync", "payload": song])
    assert(!model.shouldAnimate, "hidden windows do not tick")
    model.receive(["type": "visible", "visible": true])
    assert(model.shouldAnimate)
    model.receive(["type": "visible", "visible": false])
    assert(!model.shouldAnimate)

    let size = CGSize(width: 800, height: 120)
    let context = CGContext(data: nil, width: 1600, height: 240, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.scaleBy(x: 2, y: 2)
    context.translateBy(x: 0, y: size.height)
    context.scaleBy(x: 1, y: -1)
    let renderer = LyricsRenderer()
    func draw(_ dimensions: CGSize = size, scale: Double = 2) {
        context.clear(CGRect(origin: .zero, size: size))
        renderer.draw(model.currentFrame(at: model.anchorTime), model: model, in: context, size: dimensions, scale: scale)
    }
    draw()
    var red = 0, white = 0, translationWhite = 0
    let pixels = context.data!.bindMemory(to: UInt8.self, capacity: context.bytesPerRow * context.height)
    for y in 0..<context.height {
        for x in 0..<context.width {
            let i = y * context.bytesPerRow + x * 4
            if pixels[i] > 100 && pixels[i + 1] < 80 && pixels[i + 2] < 80 && pixels[i + 3] > 80 { red += 1 }
            if pixels[i] > 180 && pixels[i + 1] > 180 && pixels[i + 2] > 180 && pixels[i + 3] > 180 {
                white += 1
                if y > context.height * 2 / 3 { translationWhite += 1 }
            }
        }
    }
    assert(red > 100 && white > 100, "raster layers preserve played and unplayed colours")
    assert(translationWhite > 100, "outlined translations retain their fill")
    if let output = ProcessInfo.processInfo.environment["METMUSIC_LYRICS_RENDER_OUTPUT"] {
        let image = NSBitmapImageRep(cgImage: context.makeImage()!)
        try! image.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
    }

    let start = ProcessInfo.processInfo.systemUptime
    for frame in 0..<600 {
        context.clear(CGRect(origin: .zero, size: size))
        renderer.draw(model.currentFrame(at: model.anchorTime + Double(frame) / 1200), model: model,
            in: context, size: size, scale: 2)
    }
    assert(renderer.layoutBuildCount == 1, "600 progress frames reuse one shaped/rasterized lyric layout")
    print("600 cached lyric frames: \((ProcessInfo.processInfo.systemUptime - start) * 1000) ms; layouts=\(renderer.layoutBuildCount)")

    var windowUpdates = 0
    let subscription = model.objectWillChange.sink { windowUpdates += 1 }
    for _ in 0..<20 {
        model.receive(["channel": "lyric:playback-sync", "payload": ["kind": "progress", "revision": 8,
            "timestamp": Date().timeIntervalSince1970 * 1000, "currentTime": 1.5,
            "duration": 60, "playbackRate": 1, "isPlaying": true]])
        draw()
    }
    assert(windowUpdates == 0, "progress packets do not re-layout the toolbar or whole window")
    assert(renderer.layoutBuildCount == 1, "progress sync does not invalidate text caches")
    model.receive(["channel": "lyric:config-changed", "payload": config])
    assert(windowUpdates == 0, "identical config does not publish redundant changes")
    config["strokeWidth"] = 3
    model.receive(["channel": "lyric:config-changed", "payload": config])
    draw()
    assert(renderer.layoutBuildCount == 2, "appearance changes invalidate cached images")
    draw(CGSize(width: 600, height: 90))
    assert(renderer.layoutBuildCount == 3, "resizing re-fits text")
    draw(CGSize(width: 600, height: 90), scale: 1)
    assert(renderer.layoutBuildCount == 4, "display scale changes rebuild crisp text images")
    withExtendedLifetime(subscription) {}

    func legacy(_ percent: Double, theme: String) {
        model.receive(["channel": "lyric:line-change", "payload": ["lyricText": "旧版", "lyricTrans": "Legacy",
            "lyricData": [["content": "旧版", "percent": percent]], "coverTheme": ["light": ["shadeTwo": theme]]]])
    }
    legacy(0.2, theme: "255,0,0")
    let first = model.currentFrame().line
    draw()
    let builds = renderer.layoutBuildCount
    legacy(0.8, theme: "255,0,0")
    assert(model.currentFrame().line === first, "legacy progress retains the shaped line identity")
    assert(!model.shouldAnimate, "legacy frames redraw from IPC without a redundant animation timer")
    draw()
    assert(renderer.layoutBuildCount == builds)
    legacy(0.8, theme: "0,255,0")
    draw()
    assert(renderer.layoutBuildCount == builds + 1, "cover colour changes invalidate cached colours")
}
