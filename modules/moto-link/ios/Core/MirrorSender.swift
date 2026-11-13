import CoreImage
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
  private var lastScaled: CVPixelBuffer?
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
      self.lastScaled = nil
      self.lock.unlock()
    }
  }

  /// One screen frame. Safe to call from any thread; drops frames that arrive
  /// faster than the dash can use them.
  func submit(_ pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation) {
    lock.lock()
    defer { lock.unlock() }
    guard let encoder else { return }
    let now = CFAbsoluteTimeGetCurrent()
    guard now - lastEncodeAt >= minInterval else { return }
    guard let scaled = scale(pixelBuffer, orientation: orientation, config: encoder.config, encoder: encoder) else { return }
    lastEncodeAt = now
    lastScaled = scaled
    encoder.encode(scaled)
  }

  private func repeatIfQuiet() {
    lock.lock()
    defer { lock.unlock() }
    guard let encoder, let lastScaled else { return }
    let now = CFAbsoluteTimeGetCurrent()
    guard now - lastEncodeAt >= MirrorSender.repeatAfter else { return }
    lastEncodeAt = now
    encoder.encode(lastScaled)
  }

  /// Rotates the frame upright and fits it to the dash. A landscape screen
  /// fills the dash (a sliver is cropped); a portrait screen is shown whole
  /// between black bars.
  private func scale(
    _ source: CVPixelBuffer,
    orientation: CGImagePropertyOrientation,
    config: VideoEncoder.Config,
    encoder: VideoEncoder
  ) -> CVPixelBuffer? {
    guard let target = encoder.makePixelBuffer() else { return nil }
    let bounds = CGRect(x: 0, y: 0, width: config.width, height: config.height)

    var image = CIImage(cvPixelBuffer: source).oriented(orientation)
    let size = image.extent.size
    guard size.width > 0, size.height > 0 else { return nil }

    let fitX = bounds.width / size.width
    let fitY = bounds.height / size.height
    let factor = size.width >= size.height ? max(fitX, fitY) : min(fitX, fitY)
    image = image.transformed(by: CGAffineTransform(scaleX: factor, y: factor))
    image = image.transformed(
      by: CGAffineTransform(
        translationX: bounds.midX - image.extent.midX,
        y: bounds.midY - image.extent.midY
      ))
    let background = CIImage(color: .black).cropped(to: bounds)
    context.render(image.composited(over: background), to: target, bounds: bounds, colorSpace: colorSpace)
    return target
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
    lastScaled = nil
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
      lastScaled = nil
      // Feed slightly under the dash's pull rate (about 24 fps).
      minInterval = 1.0 / Double(min(max(config.fps, 5), 22))
      encoder = try? VideoEncoder(config: config) { [weak connection] data, isKeyframe in
        connection?.send(
          content: MirrorWire.encode(.frame(data: data, isKeyframe: isKeyframe)),
          completion: .contentProcessed { _ in }
        )
      }
    case .keyframe:
      lock.lock()
      encoder?.requestKeyframe()
      lock.unlock()
    case .frame:
      break
    }
  }
}
