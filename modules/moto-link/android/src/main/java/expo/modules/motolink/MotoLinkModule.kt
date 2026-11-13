package expo.modules.motolink

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class VideoConfigRecord : Record {
  @Field var width: Int = 800
  @Field var height: Int = 384
  @Field var fps: Int = 20
  @Field var bitrate: Int = 1_500_000
  @Field var keyframeIntervalSec: Int = 5
}

class MirrorViewRecord : Record {
  @Field var zoom: Int = 1000
  @Field var trimTop: Int = 0
  @Field var trimBottom: Int = 0
  @Field var trimLeft: Int = 0
  @Field var trimRight: Int = 0
  @Field var fit: Int = 0
}

/**
 * Thin native transport for the dash link, Android side of
 * MotoLinkModule.swift. Protocol decisions live in TypeScript (src/protocol);
 * this side owns what JavaScript cannot do well: sockets, the video encoder,
 * the RSA key, Wi-Fi join and button capture.
 */
class MotoLinkModule : Module() {
  private val frames = FrameQueue()
  private val main = Handler(Looper.getMainLooper())
  private val capturer = FrameCapturer(frames)
  private var server: LinkServer? = null
  private var wifi: WifiLink? = null
  private var buttons: ButtonBridge? = null
  private var mirror: ScreenMirror? = null
  @Volatile
  private var encoder: VideoEncoder? = null
  @Volatile
  private var identity: RsaIdentity? = null
  @Volatile
  private var mirrorActive = false
  private var lastStats = FrameQueue.Stats(0, 0)
  private var statsRunning = false
  private var routeCallback: AudioDeviceCallback? = null

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context is not available" }

  private val audio: AudioManager
    get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  override fun definition() = ModuleDefinition {
    Name("MotoLink")

    Events(
      "onConnectionOpen",
      "onConnectionData",
      "onConnectionClose",
      "onVideoStats",
      "onButton",
      "onLog",
      "onMirrorState",
      "onAudioRoute"
    )

    OnCreate {
      val ctx = context.applicationContext
      wifi = WifiLink(ctx, this@MotoLinkModule::log)
      server = LinkServer(frames, { wifi?.network() }, this@MotoLinkModule::forward)
      buttons = ButtonBridge(ctx, { payload -> sendEvent("onButton", payload) }, this@MotoLinkModule::log)
      frames.onNeedKeyframe = {
        // Mirror and dash view draw into the same encoder, so one request covers both.
        encoder?.requestKeyframe()
      }
      val screen = ScreenMirror(ctx, { encoder }, { active -> setMirroring(active) }, this@MotoLinkModule::log)
      mirror = screen
      MirrorHub.receiver = screen
      // The bike's Bluetooth shows up as an audio output; that is the cue to offer mirroring.
      val callback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = routeChanged()
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) = routeChanged()
      }
      audio.registerAudioDeviceCallback(callback, main)
      routeCallback = callback
    }

    OnDestroy {
      teardownVideo()
      server?.stop()
      wifi?.release()
      val bridge = buttons
      main.post { bridge?.stop() }
      mirror?.stop()
      if (MirrorHub.receiver === mirror) MirrorHub.receiver = null
      routeCallback?.let { callback ->
        try {
          audio.unregisterAudioDeviceCallback(callback)
        } catch (error: RuntimeException) {
          // Context already gone.
        }
      }
      routeCallback = null
    }

    // region Network

    Function("getNetworkInfo") {
      // Empty when Wi-Fi has no IPv4 address.
      val info = wifi?.info() ?: return@Function emptyMap<String, String>()
      mapOf("ip" to info.ip, "gateway" to info.gateway)
    }

    AsyncFunction("joinWifi") { ssid: String, password: String, promise: Promise ->
      val link = wifi
      if (link == null) {
        promise.reject("ERR_WIFI_JOIN", "module not ready", null)
        return@AsyncFunction
      }
      link.join(ssid, password) { error ->
        if (error == null) promise.resolve(null) else promise.reject("ERR_WIFI_JOIN", error.message, error)
      }
    }

    AsyncFunction("startServers") {
      server?.start()
      Unit
    }

    AsyncFunction("stopServers") {
      server?.stop()
      Unit
    }

    AsyncFunction("probe") { host: String, port: Int, dataBase64: String, timeoutMs: Int, promise: Promise ->
      val payload = try {
        Base64.decode(dataBase64, Base64.DEFAULT)
      } catch (error: IllegalArgumentException) {
        promise.reject("ERR_PROBE", "bad payload", error)
        return@AsyncFunction
      }
      val link = server
      if (link == null) {
        promise.reject("ERR_PROBE", "module not ready", null)
        return@AsyncFunction
      }
      link.probe(host, port, payload, timeoutMs) { result ->
        result.fold(
          onSuccess = { reply -> promise.resolve(Base64.encodeToString(reply, Base64.NO_WRAP)) },
          onFailure = { error -> promise.reject("ERR_PROBE", error.message ?: error.toString(), error) }
        )
      }
    }

    Function("send") { id: String, dataBase64: String ->
      val data = try {
        Base64.decode(dataBase64, Base64.DEFAULT)
      } catch (error: IllegalArgumentException) {
        return@Function Unit
      }
      server?.send(id, data)
      Unit
    }

    Function("closeConnection") { id: String ->
      server?.close(id)
      Unit
    }

    // endregion

    // region Identity

    AsyncFunction("createIdentity") {
      val created = RsaIdentity()
      identity = created
      created.publicKeyBase64()
    }

    AsyncFunction("signHuid") { huid: String ->
      val current = identity ?: throw IdentityMissingException()
      current.sign(huid)
    }

    // endregion

    // region Video

    AsyncFunction("configureVideo") { config: VideoConfigRecord ->
      val wanted = VideoEncoder.Config(
        width = config.width,
        height = config.height,
        fps = config.fps,
        bitrate = config.bitrate,
        keyframeIntervalSec = config.keyframeIntervalSec
      )
      if (encoder?.config == wanted) return@AsyncFunction Unit
      teardownVideo()
      val created = VideoEncoder(wanted, { data, isKeyframe -> frames.push(data, isKeyframe) }, this@MotoLinkModule::log)
      encoder = created
      frames.reset()
      main.post {
        if (encoder === created) {
          capturer.paused = mirrorActive
          capturer.start(created)
          startStats()
        }
      }
      Unit
    }

    AsyncFunction("restartStream") {
      frames.reset()
      Unit
    }

    AsyncFunction("stopVideo") {
      teardownVideo()
      Unit
    }

    // endregion

    // region Buttons

    AsyncFunction("startButtonCapture") { mode: String, pinVolume: Boolean ->
      buttons?.start(ButtonBridge.Mode.from(mode), pinVolume)
      Unit
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stopButtonCapture") {
      buttons?.stop()
      Unit
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("reannounceButtons") {
      buttons?.reannounce()
      Unit
    }.runOnQueue(Queues.MAIN)

    // endregion

    // region Bike Bluetooth and notifications

    /** Names of the Bluetooth audio devices connected as outputs right now. */
    Function("getBluetoothOutputs") {
      bluetoothOutputs()
    }

    AsyncFunction("requestNotificationPermission") { promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        // No runtime permission before Android 13; the user can still switch notifications off.
        promise.resolve(NotificationManagerCompat.from(context).areNotificationsEnabled())
        return@AsyncFunction
      }
      val permission = Manifest.permission.POST_NOTIFICATIONS
      if (ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED) {
        promise.resolve(true)
        return@AsyncFunction
      }
      val permissions = appContext.permissions
      if (permissions == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      permissions.askForPermissions({ result ->
        promise.resolve(result[permission]?.status == PermissionsStatus.GRANTED)
      }, permission)
    }

    /** Shows a notification now. Used when the bike connects while the app is in the background. */
    AsyncFunction("notify") { title: String, body: String ->
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      // Without POST_NOTIFICATIONS on Android 13+ this is silently dropped by the system.
      manager.notify(Notifications.BIKE_ID, Notifications.bike(context, title, body))
      Unit
    }

    // endregion

    // region Screen mirroring

    Function("isMirroring") {
      mirrorActive
    }

    /** Crop, zoom and fit of the mirrored picture; thousandths, see ScreenMirror.View. */
    Function("setMirrorView") { view: MirrorViewRecord ->
      mirror?.view = ScreenMirror.View(
        zoom = view.zoom,
        trimTop = view.trimTop,
        trimBottom = view.trimBottom,
        trimLeft = view.trimLeft,
        trimRight = view.trimRight,
        fit = view.fit
      )
      Unit
    }

    /**
     * The Android counterpart of the iOS broadcast picker: toggles mirroring.
     * Starting asks for screen-capture consent (every time; Android 14+ does
     * not let a grant be reused), then MirrorService takes over.
     */
    AsyncFunction("showBroadcastPicker") {
      if (mirrorActive) {
        mirror?.stop()
        return@AsyncFunction Unit
      }
      val activity = appContext.currentActivity ?: throw NoActivityException()
      val manager = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      @Suppress("DEPRECATION")
      activity.startActivityForResult(manager.createScreenCaptureIntent(), CAPTURE_REQUEST)
      Unit
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, payload ->
      if (payload.requestCode != CAPTURE_REQUEST) return@OnActivityResult
      val data = payload.data
      if (payload.resultCode != Activity.RESULT_OK || data == null) {
        log("screen mirroring declined")
        return@OnActivityResult
      }
      try {
        MirrorService.start(context, payload.resultCode, data)
      } catch (error: RuntimeException) {
        log("mirroring service not started: ${error.message}")
      }
    }

    // endregion

    View(MotoLinkView::class) {
      Prop("label") { view, value: String ->
        view.contentDescription = value
      }
    }
  }

  private fun log(message: String) {
    sendEvent("onLog", mapOf("message" to message))
  }

  private fun routeChanged() {
    sendEvent("onAudioRoute", mapOf("outputs" to bluetoothOutputs()))
  }

  private fun bluetoothOutputs(): List<String> {
    val types = mutableSetOf(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      types.add(AudioDeviceInfo.TYPE_BLE_HEADSET)
      types.add(AudioDeviceInfo.TYPE_BLE_SPEAKER)
    }
    return try {
      audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        .filter { it.type in types }
        .map { it.productName?.toString().orEmpty() }
        .filter { it.isNotEmpty() }
        .distinct()
    } catch (error: RuntimeException) {
      emptyList()
    }
  }

  private fun setMirroring(active: Boolean) {
    if (mirrorActive == active) return
    mirrorActive = active
    // Switching source mid-stream: the dash needs a fresh keyframe from the new one.
    frames.reset()
    main.post { capturer.paused = active }
    sendEvent("onMirrorState", mapOf("active" to active))
  }

  private fun teardownVideo() {
    val old = encoder
    encoder = null
    main.post {
      capturer.stop()
      statsRunning = false
      main.removeCallbacks(statsTick)
      // Released after the capturer stopped, on the thread that draws into it.
      old?.release()
    }
  }

  private val statsTick: Runnable = object : Runnable {
    override fun run() {
      if (!statsRunning) return
      val stats = frames.snapshot()
      if (stats != lastStats) {
        lastStats = stats
        sendEvent("onVideoStats", mapOf("framesSent" to stats.sent, "framesDropped" to stats.dropped))
      }
      main.postDelayed(this, 1000)
    }
  }

  /** Main thread. */
  private fun startStats() {
    main.removeCallbacks(statsTick)
    statsRunning = true
    main.postDelayed(statsTick, 1000)
  }

  private fun forward(event: LinkServer.Event) {
    when (event) {
      is LinkServer.Event.Open -> sendEvent("onConnectionOpen", mapOf("id" to event.id, "port" to event.port))
      is LinkServer.Event.Data -> sendEvent(
        "onConnectionData",
        mapOf("id" to event.id, "port" to event.port, "data" to Base64.encodeToString(event.bytes, Base64.NO_WRAP))
      )
      is LinkServer.Event.Close -> sendEvent("onConnectionClose", mapOf("id" to event.id, "port" to event.port))
      is LinkServer.Event.Log -> log(event.message)
    }
  }

  companion object {
    private const val CAPTURE_REQUEST = 47810
  }
}

private class IdentityMissingException : CodedException("ERR_IDENTITY", "createIdentity was not called", null)

private class NoActivityException : CodedException("ERR_MIRROR", "no foreground activity to ask for screen capture", null)
