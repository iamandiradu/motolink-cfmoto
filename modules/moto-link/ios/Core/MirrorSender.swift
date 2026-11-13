import CoreGraphics
import CoreImage
import CoreText
import CoreVideo
import Foundation
import ImageIO
import Network

/// Extension side of screen mirroring: takes screen frames, fits them to the
/// dash picture, encodes them and sends them to the app.
///
/// Kept free of ReplayKit so it can be exercised on macOS; the broadcast
/// extension's SampleHandler is a thin wrapper around it.
final class MirrorSender {
  /// Called when the app cannot be reached and the broadcast should end.
  var onFatal: ((String) -> Void)?

  private let queue = DispatchQueue(label: "motolink.mirror.sender")
  private let lock = NSLock()
  private var connection: NWConnection?
  private var parser = MirrorWire.Parser()
  private var encoder: VideoEncoder?
  /// What was last encoded: the picture with the strip drawn on.
  private var lastScaled: CVPixelBuffer?
  /// The picture alone, already scaled to the dash, and the rectangle it was
  /// fitted into. Kept so a strip change can be redrawn on a static screen
  /// without holding ReplayKit's source buffer.
  private var lastPicture: CVPixelBuffer?
  private var lastPictureRect = CGRect.zero
  /// A strip change is waiting to go out at the normal frame pace.
  private var redrawPending = false
  private var view = MirrorWire.View()
  private var strip = MirrorWire.Strip()
  private var lastEncodeAt: CFAbsoluteTime = 0
  private var minInterval: CFAbsoluteTime = 1.0 / 20.0
  private var failures = 0
  private var stopped = false
  private var repeatTimer: DispatchSourceTimer?
  private let context = CIContext(options: [.cacheIntermediates: false])
  private let colorSpace = CGColorSpaceCreateDeviceRGB()

  /// The app may still be starting its listener; give it a few seconds.
  private static let maxFailures = 8
  /// The dash drops the link after 9 s without a frame, and the screen only
  /// produces frames when it changes. Re-send the last picture when it is quiet.
  private static let repeatAfter: CFAbsoluteTime = 0.4

  func start() {
    queue.async {
      self.stopped = false
      self.connect()
      let timer = DispatchSource.makeTimerSource(queue: self.queue)
      timer.schedule(deadline: .now() + 0.5, repeating: 0.25)
      timer.setEventHandler { [weak self] in self?.repeatIfQuiet() }
      timer.resume()
      self.repeatTimer = timer
    }
  }

  func stop() {
    queue.async {
      self.stopped = true
      self.repeatTimer?.cancel()
      self.repeatTimer = nil
      self.connection?.cancel()
      self.connection = nil
      self.lock.lock()
      self.encoder?.invalidate()
      self.encoder = nil
      self.forgetPicture()
      self.lock.unlock()
    }
  }

  /// Caller holds `lock`.
  private func forgetPicture() {
    lastScaled = nil
    lastPicture = nil
    redrawPending = false
  }

  /// One screen frame. Safe to call from any thread; drops frames that arrive
  /// faster than the dash can use them.
  func submit(_ pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation) {
    lock.lock()
    defer { lock.unlock() }
    guard let encoder else { return }
    let now = CFAbsoluteTimeGetCurrent()
    guard now - lastEncodeAt >= minInterval else { return }
    guard let rendered = render(pixelBuffer, orientation: orientation, config: encoder.config, encoder: encoder)
    else { return }
    lastEncodeAt = now
    lastPicture = rendered.picture
    lastPictureRect = rendered.rect
    lastScaled = rendered.composed
    redrawPending = false
    encoder.encode(rendered.composed)
  }

  private func repeatIfQuiet() {
    lock.lock()
    defer { lock.unlock() }
    guard let encoder, let lastScaled else { return }
    let now = CFAbsoluteTimeGetCurrent()
    let wait = redrawPending ? minInterval : MirrorSender.repeatAfter
    guard now - lastEncodeAt >= wait else { return }
    lastEncodeAt = now
    redrawPending = false
    encoder.encode(lastScaled)
  }

  /// Rotates the frame upright, cuts the trimmed edges, then places it on the
  /// dash. By default a sideways screen fills the dash (a sliver is cropped)
  /// and an upright screen is shown whole between black bars. With the strip
  /// on, all of that happens in the space the strip leaves.
  func scale(
    _ source: CVPixelBuffer,
    orientation: CGImagePropertyOrientation,
    config: VideoEncoder.Config,
    encoder: VideoEncoder,
    view: MirrorWire.View? = nil,
    strip: MirrorWire.Strip? = nil
  ) -> CVPixelBuffer? {
    render(source, orientation: orientation, config: config, encoder: encoder, view: view, strip: strip)?.composed
  }

  /// Dash-sized rectangles for the picture and the strip, in Core Image and
  /// Core Graphics coordinates (origin bottom left, so "top" is the high edge).
  static func layout(_ strip: MirrorWire.Strip, width: Int, height: Int) -> (picture: CGRect, strip: CGRect?) {
    let bounds = CGRect(x: 0, y: 0, width: width, height: height)
    guard strip.enabled else { return (bounds, nil) }
    let band = min(max((CGFloat(height) * CGFloat(strip.height) / 1000).rounded(), 1), CGFloat(height - 1))
    let (stripRect, pictureRect) = bounds.divided(atDistance: band, from: strip.edge == .top ? .maxYEdge : .minYEdge)
    return (pictureRect, stripRect)
  }

  private func render(
    _ source: CVPixelBuffer,
    orientation: CGImagePropertyOrientation,
    config: VideoEncoder.Config,
    encoder: VideoEncoder,
    view: MirrorWire.View? = nil,
    strip: MirrorWire.Strip? = nil
  ) -> (picture: CVPixelBuffer, rect: CGRect, composed: CVPixelBuffer)? {
    let view = view ?? self.view
    let strip = strip ?? self.strip
    let rects = MirrorSender.layout(strip, width: config.width, height: config.height)
    guard let picture = fitPicture(source, orientation: orientation, config: config, encoder: encoder, view: view, into: rects.picture),
      let composed = compose(picture, strip: strip, in: rects.strip, encoder: encoder)
    else { return nil }
    return (picture, rects.picture, composed)
  }

  private func fitPicture(
    _ source: CVPixelBuffer,
    orientation: CGImagePropertyOrientation,
    config: VideoEncoder.Config,
    encoder: VideoEncoder,
    view: MirrorWire.View,
    into area: CGRect
  ) -> CVPixelBuffer? {
    guard let target = encoder.makePixelBuffer() else { return nil }
    let bounds = CGRect(x: 0, y: 0, width: config.width, height: config.height)

    var image = CIImage(cvPixelBuffer: source).oriented(orientation)
    let full = image.extent
    // Core Image has its origin at the bottom left, so "top" is the high edge.
    let kept = CGRect(
      x: full.minX + full.width * CGFloat(view.trimLeft) / 1000,
      y: full.minY + full.height * CGFloat(view.trimBottom) / 1000,
      width: full.width * CGFloat(1000 - view.trimLeft - view.trimRight) / 1000,
      height: full.height * CGFloat(1000 - view.trimTop - view.trimBottom) / 1000
    )
    image = image.cropped(to: kept)
    let size = image.extent.size
    guard size.width > 0, size.height > 0 else { return nil }

    let fill: Bool
    switch view.fit {
    case .fill: fill = true
    case .fit: fill = false
    case .auto: fill = size.width >= size.height
    }
    image = MirrorSender.place(image, in: area, fill: fill, zoom: CGFloat(view.zoom) / 1000)
    if area != bounds {
      // A filled or zoomed picture would otherwise spill under the strip.
      image = image.cropped(to: area)
    }
    let background = CIImage(color: .black).cropped(to: bounds)
    context.render(image.composited(over: background), to: target, bounds: bounds, colorSpace: colorSpace)
    return target
  }

  private static func place(_ image: CIImage, in area: CGRect, fill: Bool, zoom: CGFloat) -> CIImage {
    let size = image.extent.size
    let fitX = area.width / size.width
    let fitY = area.height / size.height
    let factor = (fill ? max(fitX, fitY) : min(fitX, fitY)) * zoom
    let scaled = image.transformed(by: CGAffineTransform(scaleX: factor, y: factor))
    return scaled.transformed(
      by: CGAffineTransform(
        translationX: area.midX - scaled.extent.midX,
        y: area.midY - scaled.extent.midY
      ))
  }

  /// Moves an already scaled picture into a new rectangle when the strip's
  /// size or edge changes on a static screen. Approximate (the trims cannot be
  /// redone without the source frame); the next screen frame replaces it.
  private func refit(_ picture: CVPixelBuffer, from old: CGRect, to area: CGRect, encoder: VideoEncoder) -> CVPixelBuffer? {
    guard let target = encoder.makePixelBuffer(), old.width > 0, old.height > 0 else { return nil }
    let config = encoder.config
    let bounds = CGRect(x: 0, y: 0, width: config.width, height: config.height)
    var image = CIImage(cvPixelBuffer: picture).cropped(to: old)
    image = MirrorSender.place(image, in: area, fill: view.fit != .fit, zoom: 1).cropped(to: area)
    let background = CIImage(color: .black).cropped(to: bounds)
    context.render(image.composited(over: background), to: target, bounds: bounds, colorSpace: colorSpace)
    return target
  }

  /// The picture with the strip drawn over its band. Draws into a copy because
  /// the picture is kept for later redraws and may still be in the encoder.
  private func compose(_ picture: CVPixelBuffer, strip: MirrorWire.Strip, in band: CGRect?, encoder: VideoEncoder) -> CVPixelBuffer? {
    guard let band else { return picture }
    guard let target = encoder.makePixelBuffer(), MirrorSender.copy(picture, to: target) else { return nil }
    CVPixelBufferLockBaseAddress(target, [])
    defer { CVPixelBufferUnlockBaseAddress(target, []) }
    guard let base = CVPixelBufferGetBaseAddress(target),
      let cg = CGContext(
        data: base,
        width: CVPixelBufferGetWidth(target),
        height: CVPixelBufferGetHeight(target),
        bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(target),
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
      )
    else { return nil }
    MirrorSender.draw(strip, in: band, on: cg)
    return target
  }

  private static func copy(_ source: CVPixelBuffer, to target: CVPixelBuffer) -> Bool {
    CVPixelBufferLockBaseAddress(source, .readOnly)
    CVPixelBufferLockBaseAddress(target, [])
    defer {
      CVPixelBufferUnlockBaseAddress(target, [])
      CVPixelBufferUnlockBaseAddress(source, .readOnly)
    }
    guard let from = CVPixelBufferGetBaseAddress(source), let to = CVPixelBufferGetBaseAddress(target) else { return false }
    let fromRow = CVPixelBufferGetBytesPerRow(source)
    let toRow = CVPixelBufferGetBytesPerRow(target)
    let rows = min(CVPixelBufferGetHeight(source), CVPixelBufferGetHeight(target))
    let width = min(fromRow, toRow)
    for row in 0..<rows {
      memcpy(to + row * toRow, from + row * fromRow, width)
    }
    return true
  }

  /// A bitmap context over pixel memory has its origin at the bottom left like
  /// Core Image, so the same rectangles apply. Text is bold and sized from the
  /// band so it reads at arm's length on a small dash.
  static func draw(_ strip: MirrorWire.Strip, in band: CGRect, on cg: CGContext) {
    func cgColor(_ color: MirrorWire.Strip.Color) -> CGColor {
      CGColor(
        colorSpace: CGColorSpaceCreateDeviceRGB(),
        components: [CGFloat(color.red) / 255, CGFloat(color.green) / 255, CGFloat(color.blue) / 255, 1]
      ) ?? CGColor(gray: 0, alpha: 1)
    }

    cg.saveGState()
    defer { cg.restoreGState() }
    cg.clip(to: band)
    cg.setFillColor(cgColor(strip.background))
    cg.fill(band)

    let accentHeight = max(2, (band.height * 0.06).rounded())
    let accent = band.divided(atDistance: accentHeight, from: strip.edge == .top ? .minYEdge : .maxYEdge)
    cg.setFillColor(cgColor(strip.accent))
    cg.fill(accent.slice)

    let textArea = accent.remainder
    let fontSize = max(8, (textArea.height * 0.62).rounded())
    let font = CTFontCreateUIFontForLanguage(.emphasizedSystem, fontSize, nil)
      ?? CTFontCreateWithName("Helvetica-Bold" as CFString, fontSize, nil)
    let attributes: [NSAttributedString.Key: Any] = [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): cgColor(strip.text),
    ]
    let ellipsis = CTLineCreateWithAttributedString(NSAttributedString(string: "\u{2026}", attributes: attributes))

    func line(_ text: String, maxWidth: CGFloat) -> (CTLine, CGFloat)? {
      guard !text.isEmpty, maxWidth > 0 else { return nil }
      var line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
      if width(line) > maxWidth {
        guard let cut = CTLineCreateTruncatedLine(line, Double(maxWidth), .end, ellipsis) else { return nil }
        line = cut
      }
      return (line, width(line))
    }
    func width(_ line: CTLine) -> CGFloat {
      CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
    }

    let padding = (textArea.height * 0.3).rounded()
    let gap = (textArea.height * 0.4).rounded()
    let inner = textArea.insetBy(dx: padding, dy: 0)
    // Optical centre: cap height, not ascent, so digits sit mid-band.
    let baseline = (textArea.midY - CTFontGetCapHeight(font) / 2).rounded()

    let center = line(strip.center, maxWidth: inner.width * 0.4)
    let centerMinX = center.map { inner.midX - $0.1 / 2 } ?? inner.midX
    let centerMaxX = center.map { inner.midX + $0.1 / 2 } ?? inner.midX
    let leftLimit = center == nil ? inner.width / 2 - gap / 2 : centerMinX - gap - inner.minX
    let left = line(strip.left, maxWidth: leftLimit)
    let rightStart = max(center == nil ? inner.minX : centerMaxX, inner.minX + (left?.1 ?? 0)) + gap
    let right = line(strip.right, maxWidth: inner.maxX - rightStart)

    cg.setShouldAntialias(true)
    if let left {
      cg.textPosition = CGPoint(x: inner.minX, y: baseline)
      CTLineDraw(left.0, cg)
    }
    if let center {
      cg.textPosition = CGPoint(x: (inner.midX - center.1 / 2).rounded(), y: baseline)
      CTLineDraw(center.0, cg)
    }
    if let right {
      cg.textPosition = CGPoint(x: inner.maxX - right.1, y: baseline)
      CTLineDraw(right.0, cg)
    }
  }

  private func connect() {
    guard !stopped, let port = NWEndpoint.Port(rawValue: MirrorWire.port) else { return }
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    let connection = NWConnection(host: "127.0.0.1", port: port, using: NWParameters(tls: nil, tcp: tcp))
    self.connection = connection
    parser = MirrorWire.Parser()

    connection.stateUpdateHandler = { [weak self] state in
      guard let self, self.connection === connection else { return }
      switch state {
      case .ready:
        self.failures = 0
        self.read(connection)
      case .failed, .waiting:
        connection.cancel()
        self.retry()
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  private func retry() {
    guard !stopped else { return }
    connection = nil
    lock.lock()
    encoder?.invalidate()
    encoder = nil
    forgetPicture()
    lock.unlock()

    failures += 1
    if failures > MirrorSender.maxFailures {
      stopped = true
      onFatal?("Open MotoLink first, then start mirroring again.")
      return
    }
    queue.asyncAfter(deadline: .now() + 1) { [weak self] in
      self?.connect()
    }
  }

  private func read(_ connection: NWConnection) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, done, error in
      guard let self, self.connection === connection else { return }
      if let data, !data.isEmpty {
        for message in self.parser.push(data) {
          self.handle(message, on: connection)
        }
      }
      if done || error != nil || self.parser.failed {
        connection.cancel()
        self.retry()
        return
      }
      self.read(connection)
    }
  }

  private func handle(_ message: MirrorWire.Message, on connection: NWConnection) {
    switch message {
    case .config(let wanted):
      let config = VideoEncoder.Config(
        width: wanted.width,
        height: wanted.height,
        fps: wanted.fps,
        bitrate: wanted.bitrate,
        keyframeIntervalSec: wanted.keyframeIntervalSec
      )
      lock.lock()
      defer { lock.unlock() }
      if encoder?.config == config { return }
      encoder?.invalidate()
      forgetPicture()
      // Feed slightly under the dash's pull rate (about 24 fps).
      minInterval = 1.0 / Double(min(max(config.fps, 5), 22))
      encoder = try? VideoEncoder(config: config) { [weak connection] data, isKeyframe in
        connection?.send(
          content: MirrorWire.encode(.frame(data: data, isKeyframe: isKeyframe)),
          completion: .contentProcessed { _ in }
        )
      }
    case .view(let wanted):
      lock.lock()
      // Takes effect on the next screen frame. The source frame is not kept
      // around to redraw: holding ReplayKit's buffers starves its pool.
      view = wanted.sanitized
      lock.unlock()
    case .strip(let wanted):
      lock.lock()
      updateStrip(wanted.sanitized)
      lock.unlock()
    case .keyframe:
      lock.lock()
      encoder?.requestKeyframe()
      lock.unlock()
    case .frame:
      break
    }
  }

  /// Unlike a view change, a strip change is redrawn at once: the texts (speed,
  /// clock) change while the screen under them may be still. Caller holds `lock`.
  private func updateStrip(_ wanted: MirrorWire.Strip) {
    guard wanted != strip else { return }
    strip = wanted
    guard let encoder, var picture = lastPicture else { return }
    let rects = MirrorSender.layout(strip, width: encoder.config.width, height: encoder.config.height)
    if rects.picture != lastPictureRect {
      guard let moved = refit(picture, from: lastPictureRect, to: rects.picture, encoder: encoder) else { return }
      picture = moved
      lastPicture = moved
      lastPictureRect = rects.picture
    }
    guard let composed = compose(picture, strip: strip, in: rects.strip, encoder: encoder) else { return }
    lastScaled = composed
    let now = CFAbsoluteTimeGetCurrent()
    if now - lastEncodeAt >= minInterval {
      lastEncodeAt = now
      redrawPending = false
      encoder.encode(composed)
    } else {
      redrawPending = true
    }
  }
}
