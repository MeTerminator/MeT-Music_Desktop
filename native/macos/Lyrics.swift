import AppKit
import SwiftUI
import CoreText

// Private newline-delimited JSON transport over the parent process's pipes.
func emit(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}
func command(_ channel: String, _ payload: [String: Any]) { emit(["channel": channel, "payload": payload]) }
func number(_ object: [String: Any], _ key: String, _ fallback: Double = 0) -> Double {
    (object[key] as? NSNumber)?.doubleValue ?? fallback
}
func flag(_ object: [String: Any], _ key: String) -> Bool { object[key] as? Bool ?? false }
func string(_ object: [String: Any], _ key: String) -> String { object[key] as? String ?? "" }
func color(_ css: String) -> NSColor {
    let value = css.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.hasPrefix("#") {
        let hex = String(value.dropFirst())
        if let n = UInt64(hex, radix: 16), hex.count == 6 || hex.count == 8 {
            let rgb = hex.count == 8 ? n >> 8 : n
            return NSColor(srgbRed: Double((rgb >> 16) & 255) / 255,
                green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255,
                alpha: hex.count == 8 ? Double(n & 255) / 255 : 1)
        }
    }
    let parts = value.replacingOccurrences(of: "rgba(", with: "").replacingOccurrences(of: "rgb(", with: "")
        .replacingOccurrences(of: ")", with: "").split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    if parts.count >= 3 { return NSColor(srgbRed: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255, alpha: parts.count > 3 ? parts[3] : 1) }
    return .white
}

struct NativeLyricWord {
    let content: String
    let start: Double
    let end: Double
}

final class NativeLyricLine {
    let time: Double
    let text: String
    let translation: String
    let words: [NativeLyricWord]
    let hasText: Bool
    init(time: Double = 0, text: String, translation: String = "", words: [NativeLyricWord] = []) {
        self.time = time; self.text = text; self.translation = translation; self.words = words
        self.hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

private let lyricScrollDuration = 0.4

struct NativeLyricFrame {
    let line: NativeLyricLine
    let wordTime: Double
    let legacyProgress: [Double]?
    var timeUntilFirstWord: Double? = nil
    func progress(_ index: Int) -> Double {
        if let values = legacyProgress { return index < values.count ? min(1, max(0, values[index])) : 0 }
        let word = line.words[index]
        return wordTime >= word.end ? 1 : wordTime <= word.start ? 0
            : (wordTime - word.start) / max(1, word.end - word.start)
    }
}

// High-frequency playback changes invalidate only the canvas, never the toolbar or window layout.
final class LyricsRenderState: ObservableObject {
    @Published var revision = 0
    func invalidate() { revision &+= 1 }
}

final class LyricsModel: ObservableObject {
    @Published var config: [String: Any] = [:]
    var legacy: [String: Any] = [:]
    var song: [String: Any] = [:]
    var progress: [String: Any] = [:]
    let renderState = LyricsRenderState()
    private(set) var styleRevision = 0
    private var themeSignature = ""
    private var lines: [NativeLyricLine] = []
    private var scrollCues: [(time: Double, line: NativeLyricLine)] = []
    private var intro = NativeLyricLine(text: "")
    private var legacyLine = NativeLyricLine(text: "")
    private var legacyProgress: [Double] = []
    private var lineOffset = 0.0
    private var wordOffset = 0.0
    private var inclusive = true
    private var duration = 0.0
    private var playbackRate = 1.0
    @Published private(set) var hasSyncedClock = false
    @Published private(set) var visible = false
    var shouldAnimate: Bool { playing && visible && hasSyncedClock }
    @Published var toolbarAtBottom = false
    @Published var hovering = false
    @Published var playing = false
    @Published var label = "MeT-Music"
    var anchorTime: Double = 0
    var anchorPosition: Double = 0
    var panel: NSPanel!
    var locked: Bool { flag(config, "isLock") }

    func receive(_ message: [String: Any]) {
        switch string(message, "type") {
        case "visible":
            let next = flag(message, "visible")
            if visible != next { visible = next }
            if next { panel?.orderFrontRegardless() } else { panel?.orderOut(nil) }
        case "lock": panel?.ignoresMouseEvents = flag(message, "value")
        case "bounds":
            if let b = message["bounds"] as? [String: Any] {
                // Electron coordinates start at the primary display's top-left; AppKit uses bottom-left.
                let top = NSScreen.screens.first?.frame.maxY ?? 0
                panel.setFrame(NSRect(x: number(b, "x"), y: top - number(b, "y") - number(b, "height"),
                    width: max(100, number(b, "width")), height: max(50, number(b, "height"))), display: true)
            }
        default:
            let payload = message["payload"]
            switch string(message, "channel") {
            case "lyric:toolbar-position":
                let next = (payload as? String) == "bottom"
                if toolbarAtBottom != next { toolbarAtBottom = next }
            case "lyric:config-changed":
                let next = payload as? [String: Any] ?? [:]
                if !NSDictionary(dictionary: config).isEqual(to: next) {
                    config = next
                    styleRevision &+= 1
                    renderState.invalidate()
                }
                panel?.ignoresMouseEvents = locked
            case "lyric:line-change":
                legacy = payload as? [String: Any] ?? [:]; song = [:]; progress = [:]
                if hasSyncedClock { hasSyncedClock = false }
                lines.removeAll(keepingCapacity: true)
                scrollCues.removeAll(keepingCapacity: true)
                let words = legacy["lyricData"] as? [[String: Any]] ?? []
                let text = string(legacy, "lyricText"), translation = string(legacy, "lyricTrans")
                let contents = words.map { string($0, "content") }
                if text != legacyLine.text || translation != legacyLine.translation
                    || contents != legacyLine.words.map({ $0.content }) {
                    legacyLine = NativeLyricLine(text: text, translation: translation,
                        words: contents.map { NativeLyricWord(content: $0, start: 0, end: 0) })
                }
                legacyProgress = words.map { number($0, "percent") }
                updateTheme(legacy)
                renderState.invalidate()
            case "lyric:song-change":
                let next = payload as? String ?? ""
                if label != next { label = next }
            case "lyric:status-change":
                setPlaying(payload as? Bool ?? false)
            case "lyric:playback-sync":
                guard let p = payload as? [String: Any] else { return }
                if string(p, "kind") == "song" {
                    song = p
                    let next = "\(string(p, "songName")) - \(string(p, "songArtist"))"
                    if label != next { label = next }
                    intro = NativeLyricLine(text: next)
                    lineOffset = number(p, "lineOffset"); wordOffset = number(p, "wordOffset")
                    inclusive = flag(p, "inclusive")
                    let rawLines = p["lyrics"] as? [[String: Any]] ?? []
                    lines = rawLines.enumerated().sorted {
                        let a = number($0.element, "time"), b = number($1.element, "time")
                        return a == b ? $0.offset < $1.offset : a < b
                    }.map { entry in
                        let line = entry.element
                        let words = (line["words"] as? [[String: Any]] ?? []).map {
                            NativeLyricWord(content: string($0, "content"), start: number($0, "start"), end: number($0, "end"))
                        }
                        return NativeLyricLine(time: number(line, "time"), text: string(line, "content"),
                            translation: string(line, "tran"), words: words)
                    }
                    scrollCues = lines.map { line in
                        let firstWord = line.hasText ? line.words.first : nil
                        return (time: firstWord.map { $0.start - wordOffset } ?? line.time - lineOffset, line: line)
                    }.sorted { $0.time < $1.time }
                    updateTheme(p)
                    if !hasSyncedClock { hasSyncedClock = true }
                }
                guard !song.isEmpty, number(p, "revision") == number(song, "revision") else { return }
                progress = p; setPlaying(flag(p, "isPlaying"))
                duration = number(p, "duration"); playbackRate = number(p, "playbackRate", 1)
                anchorTime = ProcessInfo.processInfo.systemUptime
                let delay = max(0, Date().timeIntervalSince1970 - number(p, "timestamp") / 1000)
                anchorPosition = number(p, "currentTime") + (playing ? delay * playbackRate : 0)
                renderState.invalidate()
            default: break
            }
        }
    }

    private func setPlaying(_ next: Bool) {
        if playing != next { playing = next }
    }
    private func updateTheme(_ data: [String: Any]) {
        let theme = data["coverTheme"] as? [String: Any]
        let light = theme?["light"] as? [String: Any]
        let signature = light?["shadeTwo"] as? String ?? ""
        if signature != themeSignature {
            themeSignature = signature
            styleRevision &+= 1
        }
    }
    func currentFrame(at monotonic: Double = ProcessInfo.processInfo.systemUptime,
                      prepareScroll: Bool = false) -> NativeLyricFrame {
        if !hasSyncedClock { return NativeLyricFrame(line: legacyLine, wordTime: 0, legacyProgress: legacyProgress) }
        var seconds = anchorPosition + (playing ? max(0, monotonic - anchorTime) * playbackRate : 0)
        seconds = max(0, duration > 0 ? min(duration, seconds) : seconds)
        let position = seconds * 1000
        let lineTime = position + lineOffset
        let wordTime = position + wordOffset
        // Convert the animation's wall time to song time. Only selection looks ahead.
        let lead = lyricScrollDuration * playbackRate * 1000
        // Lines are decoded and sorted once per song. Binary search also handles seek backwards.
        var low = 0, high = lines.count
        while low < high {
            let mid = (low + high) / 2
            let reached: Bool
            if prepareScroll {
                // Rapid consecutive lines may have less than 400 ms between their first words.
                // Keep the current line through its own cue and shorten the following scroll.
                let start = scrollCues[mid].time - lead
                let previousCue = mid > 0 ? scrollCues[mid - 1].time : start
                reached = position >= max(start, previousCue)
            } else {
                reached = inclusive ? lines[mid].time <= lineTime : lines[mid].time < lineTime
            }
            if reached { low = mid + 1 }
            else { high = mid }
        }
        let selected = low == 0 ? intro : (prepareScroll ? scrollCues[low - 1].line : lines[low - 1])
        let line = selected.hasText ? selected : intro
        let remaining = line.words.first.map { ($0.start - wordTime) / (1000 * playbackRate) }
        return NativeLyricFrame(line: line, wordTime: wordTime, legacyProgress: nil, timeUntilFirstWord: remaining)
    }
    func currentLine() -> (String, String, [(String, Double)]) {
        let frame = currentFrame()
        return (frame.line.text, frame.line.translation, frame.line.words.indices.map {
            (frame.line.words[$0].content, frame.progress($0))
        })
    }
    func themeColor(_ active: Bool) -> NSColor {
        let fallback = color(string(config, active ? "colorActive" : "colorInactive"))
        guard flag(config, active ? "useThemeColorForActive" : "useThemeColorForInactive") else { return fallback }
        let theme = (song.isEmpty ? legacy : song)["coverTheme"] as? [String: Any]
        guard let light = theme?["light"] as? [String: Any], let rgb = light["shadeTwo"] as? String else {
            return active ? color("#efefef95") : fallback
        }
        return color("rgb(\(rgb))").withAlphaComponent(active ? 0.95 : fallback.alphaComponent)
    }
    func font(_ translation: Bool, _ size: Double) -> NSFont {
        var family = string(config, translation ? "translationFontFamily" : "lyricFontFamily")
        family = ["MeT SF Pro": "SF Pro", "MeT PingFang SC": "PingFang SC",
            "Spotify Mix UI Title": "Spotify Mix UI Title Var"][family] ?? family
        let weight = number(config, translation ? "translationFontWeight" : "lyricFontWeight", translation ? 400 : 600)
        let nativeWeight: NSFont.Weight = weight >= 800 ? .heavy : weight >= 700 ? .bold : weight >= 600 ? .semibold : weight >= 500 ? .medium : weight <= 300 ? .light : .regular
        if !family.isEmpty {
            let descriptor = NSFontDescriptor(fontAttributes: [.family: family, .traits: [NSFontDescriptor.TraitKey.weight: nativeWeight.rawValue]])
            if let font = NSFont(descriptor: descriptor, size: size) { return font }
        }
        return NSFont.systemFont(ofSize: size, weight: nativeWeight)
    }
}

// Keep only the current line's raster layers. Clock ticks never re-shape text or re-draw outlines.
struct NativeTextImage {
    let image: CGImage
    let size: CGSize
    let padding: Double
    func draw(in context: CGContext, x: Double, y: Double) {
        context.saveGState()
        context.translateBy(x: x - padding, y: y - padding + size.height)
        context.scaleBy(x: 1, y: -1)
        context.draw(image, in: CGRect(origin: .zero, size: size))
        context.restoreGState()
    }
}

final class LyricsRenderer {
    private struct Key: Equatable {
        let line: NativeLyricLine
        let size: CGSize
        let scale: Double
        let styleRevision: Int
        static func == (lhs: Key, rhs: Key) -> Bool {
            lhs.line === rhs.line && lhs.size == rhs.size && lhs.scale == rhs.scale && lhs.styleRevision == rhs.styleRevision
        }
    }
    private struct Layout {
        let normal: NativeTextImage?
        let active: NativeTextImage?
        let translation: NativeTextImage?
        let wordWidths: [Double]
        let textWidth: Double
        let y: Double
        let translationY: Double
        let clearance: Double
        let available: Double
    }
    private var key: Key?
    private var cached: Layout?
    private(set) var layoutBuildCount = 0
    private static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    private func shape(_ text: String, font: NSFont) -> CTLine {
        CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: font]))
    }
    private func width(_ line: CTLine) -> Double { CTLineGetTypographicBounds(line, nil, nil, nil) }
    private func raster(_ text: String, font: NSFont, fill: NSColor, model: LyricsModel, scale: Double) -> NativeTextImage? {
        let stroke = number(model.config, "strokeWidth")
        let padding = ceil(stroke) + 2
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: fill]
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
        let size = CGSize(width: ceil(width(line) + padding * 2),
            height: ceil(font.ascender - font.descender + padding * 2))
        // Bound the raster allocation for exceptionally long lyric lines.
        let resolution = min(max(1, scale), 32768 / max(1, size.width), 32768 / max(1, size.height))
        guard let bitmap = CGContext(data: nil, width: max(1, Int(ceil(size.width * resolution))),
            height: max(1, Int(ceil(size.height * resolution))), bitsPerComponent: 8, bytesPerRow: 0,
            space: Self.colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        bitmap.scaleBy(x: resolution, y: resolution)
        bitmap.textMatrix = .identity
        let baseline = CGPoint(x: padding, y: padding - font.descender)
        if stroke > 0 {
            // Stroke first, then restore the fill so thick outlines never hollow out small translations.
            var outline = attributes
            outline[.strokeColor] = color(string(model.config, "strokeColor"))
            outline[.strokeWidth] = stroke * 200 / max(1, font.pointSize)
            bitmap.textPosition = baseline
            CTLineDraw(CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: outline)), bitmap)
        }
        bitmap.textPosition = baseline
        CTLineDraw(line, bitmap)
        guard let image = bitmap.makeImage() else { return nil }
        return NativeTextImage(image: image, size: size, padding: padding)
    }
    private func layout(for frame: NativeLyricFrame, model: LyricsModel, size: CGSize, scale: Double) -> Layout {
        let nextKey = Key(line: frame.line, size: size, scale: scale, styleRevision: model.styleRevision)
        if key == nextKey, let cached { return cached }
        layoutBuildCount += 1
        let line = frame.line
        let hasTranslation = flag(model.config, "showTranslation") && !line.translation.isEmpty
        let height = max(20, size.height)
        var font = model.font(false, max(hasTranslation ? 16 : 20, floor(height * (hasTranslation ? 0.55 : 0.75))))
        var transFont = model.font(true, max(12, floor(height * number(model.config, "transFontSizeScale", 23) / 100)))
        let clearance = number(model.config, "strokeWidth") + 4
        let available = max(1, size.width - 2 * clearance)
        let text = line.words.isEmpty ? line.text : line.words.map { $0.content }.joined()
        var shaped = shape(text, font: font)
        var textWidth = width(shaped)
        if line.words.isEmpty {
            let fit = min(1, available / max(1, textWidth),
                hasTranslation ? available / max(1, width(shape(line.translation, font: transFont))) : 1,
                height / max(1, font.ascender - font.descender + (hasTranslation ? transFont.ascender - transFont.descender + 4 : 0)))
            if fit < 1 {
                font = model.font(false, font.pointSize * fit)
                transFont = model.font(true, transFont.pointSize * fit)
                shaped = shape(text, font: font)
                textWidth = width(shaped)
            }
        }
        // Query caret positions in the already-shaped line instead of shaping every text prefix.
        var utf16Index = 0
        var previousOffset = CTLineGetOffsetForStringIndex(shaped, 0, nil)
        let wordWidths = line.words.map { word -> Double in
            utf16Index += word.content.utf16.count
            let offset = CTLineGetOffsetForStringIndex(shaped, utf16Index, nil)
            defer { previousOffset = offset }
            return abs(offset - previousOffset)
        }
        let mainHeight = font.ascender - font.descender
        let totalHeight = mainHeight + (hasTranslation ? transFont.ascender - transFont.descender + 4 : 0)
        let y = (size.height - totalHeight) / 2
        let plainColor = color(string(model.config, "textColor")).withAlphaComponent(number(model.config, "textOpacity", 100) / 100)
        var translation: NativeTextImage?
        if hasTranslation {
            let fit = min(1, available / max(1, width(shape(line.translation, font: transFont))))
            let fitted = fit < 1 ? model.font(true, transFont.pointSize * fit) : transFont
            translation = raster(line.translation, font: fitted, fill: plainColor, model: model, scale: scale)
        }
        let result = Layout(
            normal: raster(text, font: font, fill: line.words.isEmpty ? plainColor : model.themeColor(false), model: model, scale: scale),
            active: line.words.isEmpty ? nil : raster(text, font: font, fill: model.themeColor(true), model: model, scale: scale),
            translation: translation, wordWidths: wordWidths, textWidth: textWidth, y: y,
            translationY: y + mainHeight + 4, clearance: clearance, available: available)
        key = nextKey
        cached = result
        return result
    }
    func draw(_ frame: NativeLyricFrame, model: LyricsModel, in context: CGContext, size: CGSize, scale: Double) {
        let layout = layout(for: frame, model: model, size: size, scale: scale)
        if frame.line.words.isEmpty {
            layout.normal?.draw(in: context, x: (size.width - layout.textWidth) / 2, y: layout.y)
        } else {
            var progressWidth = 0.0
            for index in layout.wordWidths.indices { progressWidth += layout.wordWidths[index] * frame.progress(index) }
            let offset = layout.textWidth <= layout.available ? (size.width - layout.textWidth) / 2
                : layout.clearance - min(layout.textWidth - layout.available, max(0, progressWidth - layout.available * 0.45))
            context.saveGState()
            context.clip(to: CGRect(x: layout.clearance, y: 0, width: layout.available, height: size.height))
            layout.normal?.draw(in: context, x: offset, y: layout.y)
            context.saveGState()
            context.clip(to: CGRect(x: offset, y: 0, width: progressWidth, height: size.height))
            layout.active?.draw(in: context, x: offset, y: layout.y)
            context.restoreGState()
            context.restoreGState()
        }
        if let translation = layout.translation {
            let textWidth = translation.size.width - translation.padding * 2
            translation.draw(in: context, x: (size.width - textWidth) / 2, y: layout.translationY)
        }
    }
}

struct LyricsCanvas: View {
    @ObservedObject var model: LyricsModel
    @ObservedObject private var renderState: LyricsRenderState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(model: LyricsModel) {
        self.model = model
        self.renderState = model.renderState
    }

    var body: some View {
        let _ = renderState.revision
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: !model.shouldAnimate)) { _ in
            let animate = model.visible && !reduceMotion
            let frame = model.currentFrame(prepareScroll: animate)
            // A late frame or seek uses only the time still available before highlighting starts.
            let duration = min(lyricScrollDuration, max(0, frame.timeUntilFirstWord ?? lyricScrollDuration))
            ZStack {
                LyricsLineCanvas(model: model, frame: frame)
                    .id(ObjectIdentifier(frame.line))
                    .transition(animate ? .asymmetric(insertion: .move(edge: .bottom),
                                                      removal: .move(edge: .top)) : .identity)
            }
            .clipped()
            .animation(animate && duration > 0 ? .timingCurve(0.2, 0, 0.2, 1, duration: duration) : nil,
                       value: ObjectIdentifier(frame.line))
        }
        .id(model.visible)
    }
}

private struct LyricsLineCanvas: View {
    let model: LyricsModel
    let frame: NativeLyricFrame
    @State private var renderer = LyricsRenderer()

    var body: some View {
        // Each displayed line owns its cache, so the outgoing line keeps its last highlight and image.
        Canvas { context, size in
            context.withCGContext { cg in
                renderer.draw(frame, model: model, in: cg, size: size, scale: Double(model.panel?.backingScaleFactor ?? 2))
            }
        }
        .accessibilityLabel(frame.line.text)
    }
}

struct LyricsView: View {
    @ObservedObject var model: LyricsModel
    let appLogo: NSImage?
    @State private var dragStart: NSRect?
    @State private var mouseStart = NSPoint.zero
    private func button(_ icon: String, _ help: String, _ action: @escaping () -> Void) -> some View {
        button(Image(systemName: icon), help, action)
    }
    private func button(_ icon: Image, _ help: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            icon.resizable().scaledToFit()
                .frame(width: 16, height: 16).padding(2)
                .contentShape(Rectangle())
        }.buttonStyle(.plain).help(help).accessibilityLabel(help)
    }
    private var toolbar: some View {
        GeometryReader { geometry in
            // Match Electron's header .tools: 4px section margins, 8px gaps,
            // and a 16px icon with 2px padding inside each 20px button.
            HStack(spacing: 0) {
                HStack(spacing: 8) {
                    button(appLogo.map { Image(nsImage: $0).renderingMode(.original) }
                        ?? Image(systemName: "music.note.house"), "显示主窗口") {
                        command("window:control", ["action": "show-main"])
                    }
                    button("gearshape", "歌词设置") { command("window:control", ["action": "open-settings"]) }
                    if !model.label.isEmpty {
                        Text(model.label).font(.system(size: 12)).lineLimit(1)
                            .truncationMode(.tail)
                            .frame(maxWidth: (geometry.size.width + 24) * 0.3, alignment: .leading)
                            .opacity(0.85)
                    }
                }
                .padding(.horizontal, 4)
                Spacer(minLength: 0)
                HStack(spacing: 8) {
                    button("backward.end.fill", "上一曲") { command("player:command", ["action": "prev"]) }
                    button(model.playing ? "pause.fill" : "play.fill", "播放 / 暂停") { command("player:command", ["action": "playOrPause"]) }
                    button("forward.end.fill", "下一曲") { command("player:command", ["action": "next"]) }
                }
                .fixedSize().padding(.horizontal, 4)
                HStack(spacing: 8) {
                    button("lock.open", "锁定歌词") { command("lyric:window", ["type": "set-lock", "isLock": true]) }
                    button("xmark", "隐藏歌词") { command("lyric:window", ["type": "toggle-visibility"]) }
                }
                .fixedSize().padding(.horizontal, 4)
            }
        }
        .frame(height: 20)
        .padding(.horizontal, 12)
        .padding(.top, model.toolbarAtBottom ? 0 : 12)
        .padding(.bottom, model.toolbarAtBottom ? 12 : 0)
        .opacity(model.hovering && !model.locked ? 1 : 0)
        .allowsHitTesting(model.hovering && !model.locked)
    }
    var body: some View {
        VStack(spacing: 0) {
            if !model.toolbarAtBottom { toolbar }
            LyricsCanvas(model: model).padding(.horizontal, 8)
                .padding(.top, model.toolbarAtBottom ? 6 : 0)
                .padding(.bottom, model.toolbarAtBottom ? 0 : 6)
            if model.toolbarAtBottom { toolbar }
        }
        .foregroundStyle(.white)
        .background(Color.black.opacity(model.locked ? 0 : 0.01))
        .background(model.hovering && !model.locked ? Color(nsColor: color(string(model.config, "bgColor"))) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .opacity(number(model.config, "overallOpacity", 100) / 100 * (model.playing ? 1 : number(model.config, "pausedOpacity", 50) / 100))
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 3).onChanged { value in
            guard !model.locked else { return }
            let mouse = NSEvent.mouseLocation
            if dragStart == nil {
                dragStart = model.panel.frame
                mouseStart = NSPoint(x: mouse.x - value.translation.width, y: mouse.y + value.translation.height)
            }
            if let start = dragStart {
                model.panel.setFrameOrigin(NSPoint(x: start.minX + mouse.x - mouseStart.x,
                    y: start.minY + mouse.y - mouseStart.y))
            }
        }.onEnded { _ in dragStart = nil })
        .overlay(alignment: .bottomTrailing) {
            if model.hovering && !model.locked {
                ResizeHandle(panel: model.panel).frame(width: 16, height: 16)
            }
        }
    }
}

struct ResizeHandle: NSViewRepresentable {
    let panel: NSPanel
    func makeNSView(context: Context) -> Handle { let view = Handle(); view.panel = panel; return view }
    func updateNSView(_ nsView: Handle, context: Context) {}
    final class Handle: NSView {
        weak var panel: NSPanel?
        var start = NSRect.zero
        var mouse = NSPoint.zero
        override func mouseDown(with event: NSEvent) { start = panel?.frame ?? .zero; mouse = NSEvent.mouseLocation }
        override func mouseDragged(with event: NSEvent) {
            let delta = NSEvent.mouseLocation
            let height = max(50, start.height - delta.y + mouse.y)
            panel?.setFrame(NSRect(x: start.minX, y: start.maxY - height,
                width: max(100, start.width + delta.x - mouse.x), height: height), display: true)
        }
        override func draw(_ dirtyRect: NSRect) {
            NSColor.white.withAlphaComponent(0.5).setStroke()
            let path = NSBezierPath(); path.move(to: NSPoint(x: 4, y: 3)); path.line(to: NSPoint(x: 13, y: 12)); path.stroke()
        }
    }
}

// A nonactivating panel needs tracking even while another application has focus.
final class LyricsHostingView: NSHostingView<LyricsView> {
    weak var model: LyricsModel?
    private var hoverTracking: NSTrackingArea?
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        hoverTracking = area
    }
    private func setHovering(_ next: Bool) {
        if let model, model.hovering != next { model.hovering = next }
    }
    override func mouseEntered(with event: NSEvent) { setHovering(true) }
    override func mouseMoved(with event: NSEvent) { setHovering(true) }
    override func mouseExited(with event: NSEvent) { setHovering(false) }
}

final class LyricsPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class LyricsDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let model = LyricsModel()
    var initialized = false
    var pending = Data()
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        if let index = CommandLine.arguments.firstIndex(of: "--fonts"), index + 1 < CommandLine.arguments.count {
            let directory = URL(fileURLWithPath: CommandLine.arguments[index + 1])
            for file in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
                where ["ttf", "woff2"].contains(file.pathExtension.lowercased()) {
                CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil)
            }
        }
        let panel = LyricsPanel(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 120),
            styleMask: [.borderless, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
        model.panel = panel
        panel.isMovableByWindowBackground = false
        panel.acceptsMouseMovedEvents = true
        panel.isFloatingPanel = true
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: 100, height: 50)
        panel.delegate = self
        let appLogo = CommandLine.arguments.firstIndex(of: "--app-icon").flatMap { index in
            CommandLine.arguments.dropFirst(index + 1).first.flatMap { NSImage(contentsOfFile: $0) }
        }
        let hosting = LyricsHostingView(rootView: LyricsView(model: model, appLogo: appLogo))
        hosting.model = model
        panel.contentView = hosting
        // Read incrementally: availableData blocks until data or parent EOF, never on the UI thread.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while true {
                let data = FileHandle.standardInput.availableData
                if data.isEmpty { DispatchQueue.main.async { NSApp.terminate(nil) }; return }
                DispatchQueue.main.async { self?.consume(data) }
            }
        }
        emit(["type": "ready"])
    }
    func consume(_ data: Data) {
        pending.append(data)
        while let end = pending.firstIndex(of: 10) {
            let line = pending.prefix(upTo: end); pending.removeSubrange(...end)
            if let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] { model.receive(message)
                if string(message, "type") == "bounds" { initialized = true; sendBounds() }
            }
        }
    }
    func windowDidMove(_ notification: Notification) { sendBounds() }
    func windowDidResize(_ notification: Notification) { sendBounds() }
    func sendBounds() {
        guard initialized else { return }
        let frame = model.panel.frame
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        emit(["type": "bounds", "bounds": ["x": frame.minX.rounded(), "y": (top - frame.maxY).rounded(),
            "width": frame.width.rounded(), "height": frame.height.rounded()]])
    }
}

@main struct LyricsApp {
    static func main() {
        #if LYRICS_TEST
        runNativeLyricsTests()
        return
        #else
        let app = NSApplication.shared
        let delegate = LyricsDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
        #endif
    }
}
