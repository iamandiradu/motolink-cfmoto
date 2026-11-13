import CoreVideo
import ExpoModulesCore
import UIKit

/// The picture sent to the dash. React Native lays its children out at the
/// exact size the dash asked for; the capturer below snapshots this view and
/// feeds the encoder. It stays touchable: the dash has no touch screen, but
/// on the phone the preview can be tapped to try the pages. The phone screen can show it scaled down as a preview:
/// an ancestor transform does not affect the snapshot.
class MotoLinkView: ExpoView {
  /// Most recently mounted surface. There is one dash, so one surface.
  static weak var current: MotoLinkView?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    MotoLinkView.current = self
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { MotoLinkView.current = self }
  }
}

/// Snapshots the dash surface on the main thread and hands pixel buffers to
/// the encoder.
final class FrameCapturer {
  private var displayLink: CADisplayLink?
  /// Set while the phone screen is mirrored instead of this view.
  var paused = false
  private var encoder: VideoEncoder?
  private let frames: FrameQueue
  private var lastCapture: CFTimeInterval = 0
  private var activeInterval: CFTimeInterval = 1.0 / 20.0
  /// While the dash is not pulling (rider is on the gauges screen) a slow
  /// trickle is enough to keep a fresh frame ready.
  private let idleInterval: CFTimeInterval = 0.5

  init(frames: FrameQueue) {
    self.frames = frames
  }

  func start(encoder: VideoEncoder) {
    stop()
    self.encoder = encoder
    // Feed slightly under the dash's pull rate (about 24 fps) so the queue never backs up.
    activeInterval = 1.0 / Double(min(max(encoder.config.fps, 5), 22))
    let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
    link.add(to: .main, forMode: .common)
    displayLink = link
  }

  func stop() {
    displayLink?.invalidate()
    displayLink = nil
    encoder = nil
  }

  @objc private func tick(_ link: CADisplayLink) {
    guard !paused, let encoder, let view = MotoLinkView.current, view.window != nil else { return }
    let interval = frames.isBeingPulled() ? activeInterval : idleInterval
    guard link.timestamp - lastCapture >= interval else { return }
    lastCapture = link.timestamp

    guard view.bounds.width > 0, view.bounds.height > 0, let buffer = encoder.makePixelBuffer() else { return }
    let width = encoder.config.width
    let height = encoder.config.height

    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard
      let context = CGContext(
        data: CVPixelBufferGetBaseAddress(buffer),
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
      )
    else { return }

    context.setFillColor(UIColor.black.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    // Bitmap contexts are bottom-up; UIKit draws top-down.
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: CGFloat(width) / view.bounds.width, y: -CGFloat(height) / view.bounds.height)

    UIGraphicsPushContext(context)
    // drawHierarchy captures everything, map tiles included, but only while the
    // app is in the foreground. Fall back to a plain layer render otherwise.
    let foreground = UIApplication.shared.applicationState == .active
    if !foreground || !view.drawHierarchy(in: view.bounds, afterScreenUpdates: false) {
      view.layer.render(in: context)
    }
    UIGraphicsPopContext()

    encoder.encode(buffer)
  }
}
