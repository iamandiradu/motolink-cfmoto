package expo.modules.motolink

import android.content.Context
import android.graphics.Color
import android.os.SystemClock
import android.view.Choreographer
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import java.lang.ref.WeakReference

/**
 * The picture sent to the dash. React Native lays its children out at the
 * exact size the dash asked for; [FrameCapturer] draws this view into the
 * encoder. The phone shows it scaled down as a preview: the JS transform is
 * this view's own scale, which View.draw() does not apply, so the capture
 * stays at full size (same as drawHierarchy on iOS).
 */
class MotoLinkView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  init {
    clipChildren = true
    current = WeakReference(this)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    current = WeakReference(this)
  }

  companion object {
    /** Most recently mounted surface. There is one dash, so one surface. */
    @Volatile
    var current: WeakReference<MotoLinkView> = WeakReference(null)
  }
}

/**
 * Draws the dash surface into the encoder on the main thread, throttled like
 * FrameCapturer.swift.
 *
 * Why a hardware canvas from Surface.lockHardwareCanvas() and View.draw():
 *  - it renders the view's own display lists at the encoder size, independent
 *    of the on-screen scale, so the dash gets full resolution while the phone
 *    shows a small preview;
 *  - React Native images are often hardware bitmaps (Fresco), which a
 *    software Canvas/Bitmap capture cannot draw (it throws);
 *  - PixelCopy would copy the on-screen, scaled-down pixels and needs the view
 *    visible and unobstructed.
 * Limitation shared with every View.draw() approach: content rendered into its
 * own SurfaceView (Google Maps by default) is not part of the view's display
 * list and comes out black.
 */
class FrameCapturer(private val frames: FrameQueue) : Choreographer.FrameCallback {
  /** Set while the phone screen is mirrored instead of this view. */
  @Volatile
  var paused = false
  private var encoder: VideoEncoder? = null
  private var running = false
  private var lastCaptureMs = 0L
  private var activeIntervalMs = 50L

  /** Main thread only. */
  fun start(encoder: VideoEncoder) {
    stop()
    this.encoder = encoder
    // Feed slightly under the dash's pull rate (about 24 fps) so the queue never backs up.
    activeIntervalMs = 1000L / encoder.config.fps.coerceIn(5, 22)
    running = true
    Choreographer.getInstance().postFrameCallback(this)
  }

  /** Main thread only. */
  fun stop() {
    if (running) Choreographer.getInstance().removeFrameCallback(this)
    running = false
    encoder = null
  }

  override fun doFrame(frameTimeNanos: Long) {
    if (!running) return
    Choreographer.getInstance().postFrameCallback(this)
    val encoder = encoder ?: return
    if (paused) return
    val view = MotoLinkView.current.get() ?: return
    if (!view.isAttachedToWindow || view.width <= 0 || view.height <= 0) return
    val now = SystemClock.elapsedRealtime()
    val interval = if (frames.isBeingPulled()) activeIntervalMs else IDLE_INTERVAL_MS
    if (now - lastCaptureMs < interval) return
    lastCaptureMs = now

    val width = encoder.config.width.toFloat()
    val height = encoder.config.height.toFloat()
    encoder.drawFrame { canvas ->
      canvas.drawColor(Color.BLACK)
      canvas.save()
      canvas.scale(width / view.width, height / view.height)
      view.draw(canvas)
      canvas.restore()
    }
  }

  companion object {
    /**
     * While the dash is not pulling (rider is on the gauges screen) a slow
     * trickle is enough to keep a fresh frame ready.
     */
    private const val IDLE_INTERVAL_MS = 500L
  }
}
