package expo.modules.motolink

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.DisplayMetrics
import android.view.Display
import java.nio.ByteBuffer

/**
 * Screen mirroring: a MediaProjection VirtualDisplay renders the phone screen
 * into an ImageReader; each frame is cropped, zoomed and fitted to the dash
 * picture and drawn into the same encoder the dash view uses. Does what
 * MirrorSender.swift does in the iOS broadcast extension, minus the separate
 * process (Android lets the app itself capture the screen).
 *
 * The ImageReader detour (instead of pointing the VirtualDisplay straight at
 * the encoder surface) costs one RGBA copy per frame at a reduced size, and
 * buys the crop/zoom/fit from setMirrorView with a plain Canvas instead of a
 * GL pipeline.
 */
class ScreenMirror(
  private val context: Context,
  private val encoder: () -> VideoEncoder?,
  private val onState: (Boolean) -> Unit,
  val log: (String) -> Unit
) {
  data class View(
    val zoom: Int = 1000,
    val trimTop: Int = 0,
    val trimBottom: Int = 0,
    val trimLeft: Int = 0,
    val trimRight: Int = 0,
    /** 0 auto, 1 fill, 2 fit. */
    val fit: Int = 0
  ) {
    /** Values an arbitrary caller could not use to produce an empty picture. */
    fun sanitized(): View = View(
      zoom = zoom.coerceIn(1000, 3000),
      trimTop = trimTop.coerceIn(0, 400),
      trimBottom = trimBottom.coerceIn(0, 400),
      trimLeft = trimLeft.coerceIn(0, 400),
      trimRight = trimRight.coerceIn(0, 400),
      fit = fit
    )
  }

  @Volatile
  var view = View()
    set(value) {
      field = value.sanitized()
    }

  @Volatile
  private var session: Session? = null

  val active: Boolean
    get() = session?.running == true

  /** Called by MirrorService once the user granted capture. */
  fun attach(granted: MediaProjection) {
    val previous = session
    val next = Session(granted)
    session = next
    previous?.stop()
    next.start()
  }

  /** Ends mirroring; safe from any thread and when not mirroring. */
  fun stop() {
    session?.stop()
  }

  private fun ended(ending: Session, wasRunning: Boolean) {
    // A newer grant may already have replaced this one; leave it alone.
    if (session !== ending) return
    session = null
    MirrorService.stop(context)
    if (wasRunning) onState(false)
  }

  /** One capture grant, with everything it owns living on its own thread. */
  private inner class Session(private val projection: MediaProjection) {
    private val thread = HandlerThread("motolink-mirror").also { it.start() }
    private val handler = Handler(thread.looper)
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var captureWidth = 0
    private var captureHeight = 0
    private var bitmap: Bitmap? = null
    private var scratch: ByteBuffer? = null
    private var contentWidth = 0
    private var contentHeight = 0
    private var lastEncodeMs = 0L
    private var finished = false
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)

    @Volatile
    var running = false

    fun start() {
      handler.post {
        // Android 14+ requires a callback before createVirtualDisplay.
        projection.registerCallback(object : MediaProjection.Callback() {
          override fun onStop() {
            handler.post { teardown() }
          }
        }, handler)
        val (width, height, dpi) = captureSize()
        val imageReader = newReader(width, height)
        val created = try {
          projection.createVirtualDisplay(
            "MotoLink",
            width,
            height,
            dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader.surface,
            null,
            handler
          )
        } catch (error: RuntimeException) {
          log("mirroring failed: ${error.message}")
          null
        }
        if (created == null) {
          imageReader.close()
          projection.stop()
          teardown()
          return@post
        }
        display = created
        reader = imageReader
        captureWidth = width
        captureHeight = height
        running = true
        onState(true)
        handler.postDelayed(repeatTick, REPEAT_CHECK_MS)
      }
    }

    fun stop() {
      handler.post {
        // Stopping the projection also fires onStop(); teardown() runs once.
        projection.stop()
        teardown()
      }
    }

    private fun teardown() {
      if (finished) return
      finished = true
      handler.removeCallbacks(repeatTick)
      display?.release()
      display = null
      reader?.close()
      reader = null
      bitmap = null
      val wasRunning = running
      running = false
      thread.quitSafely()
      ended(this, wasRunning)
    }

    private fun newReader(width: Int, height: Int): ImageReader {
      val imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
      imageReader.setOnImageAvailableListener({ source -> onImage(source) }, handler)
      return imageReader
    }

    private fun onImage(source: ImageReader) {
      if (finished) return
      val image: Image? = try {
        source.acquireLatestImage()
      } catch (error: IllegalStateException) {
        null
      }
      if (image == null) return
      try {
        val now = SystemClock.elapsedRealtime()
        val fps = encoder()?.config?.fps ?: 20
        if (now - lastEncodeMs >= 1000L / fps.coerceIn(5, 22)) {
          lastEncodeMs = now
          copy(image)?.let { draw(it) }
        }
      } finally {
        image.close()
      }
      followRotation()
    }

    /** RGBA plane to a Bitmap; rows may carry padding, which the source rect later skips. */
    private fun copy(image: Image): Bitmap? {
      val plane = image.planes.firstOrNull() ?: return null
      if (plane.pixelStride <= 0) return null
      val rowPixels = plane.rowStride / plane.pixelStride
      var target = bitmap
      if (target == null || target.width != rowPixels || target.height != image.height) {
        target = Bitmap.createBitmap(rowPixels, image.height, Bitmap.Config.ARGB_8888)
        bitmap = target
      }
      val source = plane.buffer
      source.rewind()
      val needed = target.byteCount
      // The last row is often not padded, so the plane can be a little short of a full bitmap.
      val pixels = if (source.remaining() >= needed) {
        source
      } else {
        val buffer = scratch?.takeIf { it.capacity() >= needed } ?: ByteBuffer.allocateDirect(needed).also { scratch = it }
        buffer.clear()
        buffer.put(source)
        while (buffer.position() < needed) buffer.put(0.toByte())
        buffer.flip()
        buffer
      }
      target.copyPixelsFromBuffer(pixels)
      contentWidth = image.width
      contentHeight = image.height
      return target
    }

    /**
     * The dash drops the link after about 9 s without a frame, and a
     * VirtualDisplay only produces frames when the screen changes. Re-send
     * the last picture when it is quiet.
     */
    private val repeatTick = object : Runnable {
      override fun run() {
        if (finished) return
        val last = bitmap
        if (last != null && SystemClock.elapsedRealtime() - lastEncodeMs >= REPEAT_AFTER_MS) {
          lastEncodeMs = SystemClock.elapsedRealtime()
          draw(last)
        }
        handler.postDelayed(this, REPEAT_CHECK_MS)
      }
    }

    /**
     * Cuts the trimmed edges, then places the picture on the dash. By default
     * a sideways screen fills the dash (a sliver is cropped) and an upright
     * screen is shown whole between black bars. Same maths as MirrorSender.scale.
     */
    private fun draw(source: Bitmap) {
      val target = encoder() ?: return
      val v = view
      val w = contentWidth.toFloat()
      val h = contentHeight.toFloat()
      if (w <= 0f || h <= 0f) return
      val kept = Rect(
        (w * v.trimLeft / 1000f).toInt(),
        (h * v.trimTop / 1000f).toInt(),
        (w - w * v.trimRight / 1000f).toInt(),
        (h - h * v.trimBottom / 1000f).toInt()
      )
      if (kept.width() <= 0 || kept.height() <= 0) return
      val outW = target.config.width.toFloat()
      val outH = target.config.height.toFloat()
      val fitX = outW / kept.width()
      val fitY = outH / kept.height()
      val fill = when (v.fit) {
        1 -> true
        2 -> false
        else -> kept.width() >= kept.height()
      }
      val factor = (if (fill) maxOf(fitX, fitY) else minOf(fitX, fitY)) * v.zoom / 1000f
      val drawW = kept.width() * factor
      val drawH = kept.height() * factor
      val dest = RectF((outW - drawW) / 2f, (outH - drawH) / 2f, (outW + drawW) / 2f, (outH + drawH) / 2f)
      target.drawFrame { canvas ->
        canvas.drawColor(Color.BLACK)
        canvas.drawBitmap(source, kept, dest, paint)
      }
    }

    /**
     * The VirtualDisplay keeps the size it was made with; after the phone
     * turns sideways the screen would be letterboxed inside a portrait
     * capture. Resize in place: Android 14+ allows one VirtualDisplay per grant.
     */
    private fun followRotation() {
      val current = display ?: return
      val (width, height, dpi) = captureSize()
      if ((width > height) == (captureWidth > captureHeight)) return
      val imageReader = newReader(width, height)
      current.resize(width, height, dpi)
      current.surface = imageReader.surface
      reader?.close()
      reader = imageReader
      captureWidth = width
      captureHeight = height
      bitmap = null
    }
  }

  /** Screen size scaled so the long side is at most [MAX_SIDE], kept even. */
  private fun captureSize(): Triple<Int, Int, Int> {
    // The physical display, read through DisplayManager so it works from the
    // application context and follows rotation (width and height swap).
    val displays = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    val metrics = DisplayMetrics()
    val screen = displays.getDisplay(Display.DEFAULT_DISPLAY)
    if (screen != null) {
      @Suppress("DEPRECATION")
      screen.getRealMetrics(metrics)
    } else {
      metrics.setTo(context.resources.displayMetrics)
    }
    val width = metrics.widthPixels
    val height = metrics.heightPixels
    val dpi = metrics.densityDpi
    val scale = minOf(1f, MAX_SIDE.toFloat() / maxOf(width, height, 1))
    val outW = ((width * scale).toInt() and 1.inv()).coerceAtLeast(2)
    val outH = ((height * scale).toInt() and 1.inv()).coerceAtLeast(2)
    return Triple(outW, outH, (dpi * scale).toInt().coerceAtLeast(1))
  }

  companion object {
    private const val MAX_SIDE = 1280
    private const val REPEAT_AFTER_MS = 400L
    private const val REPEAT_CHECK_MS = 250L
  }
}
