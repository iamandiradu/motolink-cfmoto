import Foundation

/// Encoded H.264 access units waiting for the dash to pull them.
///
/// The dash pulls one frame per request and the wire format has no timestamps,
/// so a dropped P-frame corrupts the picture until the next keyframe. Hence on
/// overflow the whole backlog goes and the encoder is asked for a keyframe.
final class FrameQueue {
  struct Stats {
    var sent = 0
    var dropped = 0
  }

  private let lock = NSCondition()
  private var frames: [Data] = []
  private var waitingForKeyframe = true
  private var stats = Stats()
  private var lastPull = Date.distantPast
  private let capacity: Int

  /// Called (on the caller's thread) when the encoder must emit a keyframe.
  var onNeedKeyframe: (() -> Void)?

  init(capacity: Int = 8) {
    self.capacity = capacity
  }

  /// Drops everything queued. Output is discarded until the next keyframe, so
  /// the first frame the dash gets is SPS+PPS+IDR. Without that the dash keeps
  /// pulling but stays black.
  func reset() {
    lock.lock()
    frames.removeAll()
    waitingForKeyframe = true
    lock.unlock()
    onNeedKeyframe?()
  }

  func push(_ frame: Data, isKeyframe: Bool) {
    var needKeyframe = false
    lock.lock()
    if waitingForKeyframe {
      if !isKeyframe {
        lock.unlock()
        return
      }
      waitingForKeyframe = false
    }
    if frames.count >= capacity {
      stats.dropped += frames.count
      frames.removeAll()
      if !isKeyframe {
        waitingForKeyframe = true
        needKeyframe = true
      }
    }
    if !waitingForKeyframe {
      frames.append(frame)
      lock.signal()
    }
    lock.unlock()
    if needKeyframe { onNeedKeyframe?() }
  }

  /// Blocks up to `timeout` for the next frame. Call from the data-socket queue.
  func pop(timeout: TimeInterval) -> Data? {
    let deadline = Date().addingTimeInterval(timeout)
    lock.lock()
    defer { lock.unlock() }
    lastPull = Date()
    while frames.isEmpty {
      if !lock.wait(until: deadline) { return nil }
    }
    stats.sent += 1
    return frames.removeFirst()
  }

  func snapshot() -> Stats {
    lock.lock()
    defer { lock.unlock() }
    return stats
  }

  /// True while the dash is actively pulling. It stops pulling (socket stays
  /// open) when the rider switches the dash to its own gauges screen.
  func isBeingPulled(within seconds: TimeInterval = 3) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return Date().timeIntervalSince(lastPull) < seconds
  }
}
