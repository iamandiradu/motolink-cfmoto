package expo.modules.motolink

import android.graphics.Canvas
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.view.Surface
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

/**
 * H.264 encoder for the dash: Baseline 3.1, no B-frames, Annex-B output with
 * SPS/PPS in front of every keyframe. Mirrors VideoEncoder.swift.
 *
 * Input is a Surface: the capturer (and the screen mirror) draw into it with
 * a hardware canvas, so pixels never pass through the CPU.
 */
class VideoEncoder(
  val config: Config,
  /** Receives one Annex-B access unit and whether it is a keyframe. Runs on the drain thread. */
  private val output: (ByteArray, Boolean) -> Unit,
  private val log: (String) -> Unit
) {
  data class Config(
    val width: Int,
    val height: Int,
    val fps: Int,
    val bitrate: Int,
    val keyframeIntervalSec: Int
  )

  private val codec: MediaCodec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
  private val surface: Surface
  private val drawLock = Any()
  @Volatile
  private var running = true
  /** SPS+PPS in Annex-B, from the codec-config buffer or the output format. */
  private var parameterSets: ByteArray? = null
  private val drainThread: Thread

  init {
    try {
      configure(withProfile = true)
    } catch (error: RuntimeException) {
      // Some encoders reject an explicit level; Baseline is their default anyway.
      log("encoder rejected Baseline 3.1 ($error); retrying with defaults")
      codec.reset()
      configure(withProfile = false)
    }
    surface = codec.createInputSurface()
    codec.start()
    drainThread = thread(name = "motolink-encoder", isDaemon = true) { drain() }
  }

  private fun configure(withProfile: Boolean) {
    // Most hardware encoders want even sizes; the dash sizes seen so far are multiples of 16.
    val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, config.width and 1.inv(), config.height and 1.inv())
    format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
    format.setInteger(MediaFormat.KEY_BIT_RATE, config.bitrate)
    format.setInteger(MediaFormat.KEY_FRAME_RATE, config.fps.coerceAtLeast(1))
    format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, config.keyframeIntervalSec.coerceAtLeast(1))
    // Real-time priority.
    format.setInteger(MediaFormat.KEY_PRIORITY, 0)
    if (withProfile) {
      format.setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
      format.setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel31)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      // The wire format has no timestamps: frames must leave in display order.
      format.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
    }
    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
  }

  /**
   * Runs [draw] on a hardware canvas of the encoder's input surface. Safe to
   * call from the main thread (view capture) and the mirror thread; the lock
   * keeps the two from holding the surface at once and from racing release().
   */
  fun drawFrame(draw: (Canvas) -> Unit) {
    synchronized(drawLock) {
      if (!running) return
      val canvas = try {
        surface.lockHardwareCanvas()
      } catch (error: RuntimeException) {
        return
      }
      try {
        draw(canvas)
      } finally {
        surface.unlockCanvasAndPost(canvas)
      }
    }
  }

  fun requestKeyframe() {
    if (!running) return
    try {
      codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
    } catch (error: IllegalStateException) {
      // Codec is being released.
    }
  }

  fun release() {
    synchronized(drawLock) {
      if (!running) return
      running = false
    }
    try {
      drainThread.join(500)
    } catch (error: InterruptedException) {
      Thread.currentThread().interrupt()
    }
    try {
      codec.stop()
    } catch (error: IllegalStateException) {
      // Already stopped.
    }
    codec.release()
    surface.release()
  }

  private fun drain() {
    val info = MediaCodec.BufferInfo()
    while (running) {
      val index = try {
        codec.dequeueOutputBuffer(info, 10_000)
      } catch (error: IllegalStateException) {
        return
      }
      when {
        index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          // Some encoders publish SPS/PPS only here, as csd-0 and csd-1.
          val format = codec.outputFormat
          val sps = format.getByteBuffer("csd-0")
          val pps = format.getByteBuffer("csd-1")
          if (sps != null && pps != null && parameterSets == null) {
            val bytes = ByteArray(sps.remaining() + pps.remaining())
            sps.duplicate().get(bytes, 0, sps.remaining())
            pps.duplicate().get(bytes, sps.remaining(), pps.remaining())
            parameterSets = AnnexB.clean(bytes)
          }
        }
        index >= 0 -> {
          val buffer = codec.getOutputBuffer(index)
          if (buffer != null && info.size > 0) {
            buffer.position(info.offset)
            buffer.limit(info.offset + info.size)
            val bytes = ByteArray(info.size)
            buffer.get(bytes)
            handle(bytes, info.flags)
          }
          codec.releaseOutputBuffer(index, false)
        }
        // INFO_TRY_AGAIN_LATER and the deprecated buffers-changed code: nothing to do.
        else -> Unit
      }
    }
  }

  private fun handle(bytes: ByteArray, flags: Int) {
    if (flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
      parameterSets = AnnexB.clean(bytes)
      return
    }
    val isKeyframe = flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
    val unit = AnnexB.clean(bytes)
    if (unit.isEmpty()) return
    val config = parameterSets
    // The dash needs SPS+PPS in the same access unit as every IDR. Skip the
    // prefix if this encoder already put them there.
    val out = if (isKeyframe && config != null && !AnnexB.startsWithParameterSet(unit)) config + unit else unit
    output(out, isKeyframe)
  }
}

/**
 * Android encoders already emit Annex-B, but start codes may be 3 or 4 bytes
 * and some add SEI. The dash decoder wants 4-byte start codes, parameter sets
 * and slices only, as the reference streams carry.
 */
object AnnexB {
  private val startCode = byteArrayOf(0, 0, 0, 1)

  /** Re-emits every NAL unit with a 4-byte start code, dropping SEI (type 6). */
  fun clean(data: ByteArray): ByteArray {
    val nals = split(data)
    if (nals.isEmpty()) return data
    val out = ByteArrayOutputStream(data.size + 16)
    for ((start, end) in nals) {
      if (end <= start) continue
      if (data[start].toInt() and 0x1F == 6) continue
      out.write(startCode)
      out.write(data, start, end - start)
    }
    return out.toByteArray()
  }

  fun startsWithParameterSet(unit: ByteArray): Boolean {
    val first = split(unit).firstOrNull() ?: return false
    return first.first < unit.size && unit[first.first].toInt() and 0x1F == 7
  }

  /** NAL payload ranges [start, end) between start codes. */
  private fun split(data: ByteArray): List<Pair<Int, Int>> {
    val ranges = mutableListOf<Pair<Int, Int>>()
    var i = 0
    var nalStart = -1
    while (i + 2 < data.size) {
      if (data[i].toInt() == 0 && data[i + 1].toInt() == 0 && data[i + 2].toInt() == 1) {
        if (nalStart >= 0) {
          // Trailing zero of a 4-byte start code belongs to the next code, not the NAL.
          var end = i
          while (end > nalStart && data[end - 1].toInt() == 0) end--
          ranges.add(Pair(nalStart, end))
        }
        i += 3
        nalStart = i
      } else {
        i++
      }
    }
    if (nalStart >= 0 && nalStart < data.size) ranges.add(Pair(nalStart, data.size))
    return ranges
  }
}
