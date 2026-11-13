package expo.modules.motolink

import android.os.SystemClock
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Encoded H.264 access units waiting for the dash to pull them.
 *
 * The dash pulls one frame per request and the wire format has no timestamps,
 * so a dropped P-frame corrupts the picture until the next keyframe. Hence on
 * overflow the whole backlog goes and the encoder is asked for a keyframe.
 * Same rules as FrameQueue.swift.
 */
class FrameQueue(private val capacity: Int = 8) {
  data class Stats(val sent: Int, val dropped: Int)

  private val lock = ReentrantLock()
  private val available = lock.newCondition()
  private val frames = ArrayDeque<ByteArray>()
  private var waitingForKeyframe = true
  private var sent = 0
  private var dropped = 0
  /** elapsedRealtime of the last pull; 0 means never. */
  private var lastPullAt = 0L

  /** Called (on the caller's thread) when the encoder must emit a keyframe. */
  @Volatile
  var onNeedKeyframe: (() -> Unit)? = null

  /**
   * Drops everything queued. Output is discarded until the next keyframe, so
   * the first frame the dash gets is SPS+PPS+IDR. Without that the dash keeps
   * pulling but stays black.
   */
  fun reset() {
    lock.withLock {
      frames.clear()
      waitingForKeyframe = true
    }
    onNeedKeyframe?.invoke()
  }

  fun push(frame: ByteArray, isKeyframe: Boolean) {
    var needKeyframe = false
    lock.withLock {
      if (waitingForKeyframe) {
        if (!isKeyframe) return
        waitingForKeyframe = false
      }
      if (frames.size >= capacity) {
        dropped += frames.size
        frames.clear()
        if (!isKeyframe) {
          waitingForKeyframe = true
          needKeyframe = true
        }
      }
      if (!waitingForKeyframe) {
        frames.addLast(frame)
        available.signal()
      }
    }
    if (needKeyframe) onNeedKeyframe?.invoke()
  }

  /** Blocks up to [timeoutMs] for the next frame. Call from the data-socket thread. */
  fun pop(timeoutMs: Long): ByteArray? {
    lock.withLock {
      lastPullAt = SystemClock.elapsedRealtime()
      var remaining = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
      while (frames.isEmpty()) {
        if (remaining <= 0L) return null
        remaining = available.awaitNanos(remaining)
      }
      sent += 1
      return frames.removeFirst()
    }
  }

  fun snapshot(): Stats = lock.withLock { Stats(sent, dropped) }

  /**
   * True while the dash is actively pulling. It stops pulling (socket stays
   * open) when the rider switches the dash to its own gauges screen.
   */
  fun isBeingPulled(withinMs: Long = 3000): Boolean = lock.withLock {
    lastPullAt != 0L && SystemClock.elapsedRealtime() - lastPullAt < withinMs
  }
}
