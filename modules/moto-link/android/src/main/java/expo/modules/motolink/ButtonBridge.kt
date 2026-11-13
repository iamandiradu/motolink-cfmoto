package expo.modules.motolink

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.ContentObserver
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.ContextCompat

/**
 * Receives the handlebar buttons. Mirrors ButtonBridge.swift.
 *
 * The dash does not send them over Wi-Fi. It sends Bluetooth AVRCP to the
 * paired phone, in two shapes:
 *   - an absolute-volume change for the up/down rocker (no key event), and
 *   - play/pause, next, previous transport keys.
 *
 * Android routes transport keys to the media session that most recently
 * played audio, so 'full' mode plays a silent loop, holds audio focus and
 * keeps an active MediaSession in the playing state.
 *
 * Keeping the process alive (the iOS silent-audio trick) is done by the
 * [LinkService] foreground service instead, in every mode.
 */
class ButtonBridge(
  private val context: Context,
  private val emit: (Map<String, Any?>) -> Unit,
  private val log: (String) -> Unit
) {
  enum class Mode {
    /** No button capture, only keeps the app running behind another app. */
    KEEP_ALIVE,
    /** Volume rocker only. No audio focus, so music keeps playing. */
    VOLUME,
    /** Rocker plus transport keys. Takes audio focus; other music pauses. */
    FULL;

    companion object {
      fun from(raw: String): Mode = when (raw) {
        "keepAlive" -> KEEP_ALIVE
        "full" -> FULL
        else -> VOLUME
      }
    }
  }

  private val main = Handler(Looper.getMainLooper())
  private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var active = false
  private var mode = Mode.VOLUME
  private var pinVolume = true
  private var lastVolume = 0
  private var expectedPin: Int? = null
  private var session: MediaSession? = null
  private var track: AudioTrack? = null
  private var focusRequest: AudioFocusRequest? = null
  private var observer: ContentObserver? = null
  private var receiver: BroadcastReceiver? = null

  private val maxVolume: Int
    get() = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)

  /** Main thread. */
  fun start(mode: Mode, pinVolume: Boolean) {
    stop()
    this.mode = mode
    this.pinVolume = pinVolume
    active = true
    LinkService.start(context, log)

    if (mode == Mode.FULL) startMediaSession()

    lastVolume = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
    if (mode != Mode.KEEP_ALIVE) {
      // Volume changes land in Settings.System (per output device, so the
      // Bluetooth absolute volume too). The hidden VOLUME_CHANGED_ACTION
      // broadcast is a second source on devices whose observer is quiet;
      // both feed volumeChanged(), which ignores repeats of the same value.
      val volumeObserver = object : ContentObserver(main) {
        override fun onChange(selfChange: Boolean) = volumeChanged()
      }
      context.contentResolver.registerContentObserver(Settings.System.CONTENT_URI, true, volumeObserver)
      observer = volumeObserver
      val volumeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = volumeChanged()
      }
      ContextCompat.registerReceiver(
        context,
        volumeReceiver,
        IntentFilter(VOLUME_CHANGED_ACTION),
        ContextCompat.RECEIVER_EXPORTED
      )
      receiver = volumeReceiver
      if (pinVolume) pin()
    }
  }

  /** Main thread. */
  fun stop() {
    if (!active) return
    active = false
    observer?.let { context.contentResolver.unregisterContentObserver(it) }
    observer = null
    receiver?.let {
      try {
        context.unregisterReceiver(it)
      } catch (error: IllegalArgumentException) {
        // Not registered.
      }
    }
    receiver = null
    stopMediaSession()
    LinkService.stop(context)
  }

  /**
   * The dash reads the player's capabilities once, when the AVRCP link forms.
   * Bouncing the playback state makes it read them again.
   */
  fun reannounce() {
    val current = session ?: return
    if (!active) return
    current.setPlaybackState(playbackState(PlaybackState.STATE_PAUSED))
    main.postDelayed({
      if (active && session === current) {
        track?.play()
        current.setPlaybackState(playbackState(PlaybackState.STATE_PLAYING))
      }
    }, 500)
  }

  private fun startMediaSession() {
    requestFocus()
    track = silentTrack().also {
      try {
        it.play()
      } catch (error: IllegalStateException) {
        log("silent audio failed: ${error.message}")
      }
    }
    val media = MediaSession(context, "MotoLink")
    media.setCallback(object : MediaSession.Callback() {
      override fun onPlay() = key("playPause")
      override fun onPause() = key("playPause")
      override fun onSkipToNext() = key("next")
      override fun onSkipToPrevious() = key("previous")
    }, main)
    media.setMetadata(
      MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, "MotoLink")
        .putString(MediaMetadata.METADATA_KEY_ARTIST, "Handlebar control")
        .putLong(MediaMetadata.METADATA_KEY_DURATION, 3_600_000L)
        .build()
    )
    media.setPlaybackState(playbackState(PlaybackState.STATE_PLAYING))
    media.isActive = true
    session = media
  }

  private fun stopMediaSession() {
    session?.let {
      it.isActive = false
      it.release()
    }
    session = null
    track?.let {
      try {
        it.stop()
      } catch (error: IllegalStateException) {
        // Never started.
      }
      it.release()
    }
    track = null
    abandonFocus()
  }

  private fun key(name: String) {
    emit(mapOf("type" to "key", "key" to name))
    // Keep reporting "playing" so the dash keeps sending keys.
    session?.setPlaybackState(playbackState(PlaybackState.STATE_PLAYING))
  }

  private fun playbackState(state: Int): PlaybackState = PlaybackState.Builder()
    .setActions(
      PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
        PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS
    )
    .setState(state, 0L, if (state == PlaybackState.STATE_PLAYING) 1f else 0f)
    .build()

  private fun volumeChanged() {
    if (!active) return
    val value = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
    val expected = expectedPin
    if (expected != null && value == expected) {
      // Our own re-pin, not a button.
      expectedPin = null
      lastVolume = value
      return
    }
    val steps = value - lastVolume
    lastVolume = value
    if (steps == 0) return
    // JS expects a delta on a 0..1 scale, like iOS outputVolume.
    emit(mapOf("type" to "volume", "delta" to steps.toDouble() / maxVolume))
    if (pinVolume) pin()
  }

  /**
   * Puts the volume back to mid-scale after each press. Without this the
   * rocker stops producing events once the volume reaches either end. Unlike
   * iOS this is a public API on Android.
   */
  private fun pin() {
    val target = maxVolume / 2
    if (lastVolume == target) return
    expectedPin = target
    main.postDelayed({
      if (!active) return@postDelayed
      try {
        audio.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
      } catch (error: SecurityException) {
        // Do Not Disturb can forbid volume changes.
        expectedPin = null
        log("volume re-pin refused: ${error.message}")
      }
    }, 50)
  }

  private fun requestFocus() {
    val attributes = mediaAttributes()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(attributes)
        .setOnAudioFocusChangeListener({ change -> focusChanged(change) }, main)
        .build()
      focusRequest = request
      audio.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      audio.requestAudioFocus(legacyFocusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
    }
  }

  private fun abandonFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { audio.abandonAudioFocusRequest(it) }
      focusRequest = null
    } else {
      @Suppress("DEPRECATION")
      audio.abandonAudioFocus(legacyFocusListener)
    }
  }

  private val legacyFocusListener = AudioManager.OnAudioFocusChangeListener { change -> focusChanged(change) }

  private fun focusChanged(change: Int) {
    when (change) {
      // A call or a navigation prompt ended: take the keys back.
      AudioManager.AUDIOFOCUS_GAIN -> {
        track?.play()
        session?.setPlaybackState(playbackState(PlaybackState.STATE_PLAYING))
      }
      AudioManager.AUDIOFOCUS_LOSS -> log("another app took audio focus; handlebar keys may go to it")
      else -> Unit
    }
  }

  private fun mediaAttributes(): AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
    .build()

  /** One second of 8 kHz mono 16-bit silence, looped forever. */
  private fun silentTrack(): AudioTrack {
    val sampleRate = 8000
    val samples = ShortArray(sampleRate)
    val format = AudioFormat.Builder()
      .setSampleRate(sampleRate)
      .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
      .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
      .build()
    val track = AudioTrack(
      mediaAttributes(),
      format,
      samples.size * 2,
      AudioTrack.MODE_STATIC,
      AudioManager.AUDIO_SESSION_ID_GENERATE
    )
    track.write(samples, 0, samples.size)
    track.setLoopPoints(0, samples.size, -1)
    return track
  }

  companion object {
    /** Not in the public SDK, but sent by every Android version since 4.0. */
    private const val VOLUME_CHANGED_ACTION = "android.media.VOLUME_CHANGED_ACTION"
  }
}
