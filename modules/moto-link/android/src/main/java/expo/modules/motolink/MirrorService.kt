package expo.modules.motolink

import android.app.Activity
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat

/**
 * Foreground service of type mediaProjection that owns the screen-capture
 * grant. Android 14+ only hands out a MediaProjection to a service that is
 * already in the foreground with this type, so the consent result travels
 * here first and the projection is passed to [ScreenMirror] through
 * [MirrorHub].
 */
class MirrorService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED) ?: Activity.RESULT_CANCELED
    val data = intent?.let { IntentCompat.getParcelableExtra(it, EXTRA_DATA, Intent::class.java) }
    if (resultCode != Activity.RESULT_OK || data == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    val notification = Notifications.ongoing(this, "Mirroring to the dash", "Your screen is shown on the motorcycle dash.")
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION else 0
    try {
      ServiceCompat.startForeground(this, Notifications.MIRROR_ID, notification, type)
    } catch (error: RuntimeException) {
      MirrorHub.fail("mirroring service could not start: ${error.message}")
      stopSelf()
      return START_NOT_STICKY
    }
    val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    val projection: MediaProjection? = try {
      manager.getMediaProjection(resultCode, data)
    } catch (error: RuntimeException) {
      MirrorHub.fail("screen capture refused: ${error.message}")
      null
    }
    if (projection == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    if (!MirrorHub.deliver(projection)) {
      // The module is gone (app reloading); nobody can use the grant.
      projection.stop()
      stopSelf()
    }
    return START_NOT_STICKY
  }

  companion object {
    private const val EXTRA_RESULT_CODE = "resultCode"
    private const val EXTRA_DATA = "data"

    fun start(context: Context, resultCode: Int, data: Intent) {
      val intent = Intent(context, MirrorService::class.java)
        .putExtra(EXTRA_RESULT_CODE, resultCode)
        .putExtra(EXTRA_DATA, data)
      ContextCompat.startForegroundService(context, intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, MirrorService::class.java))
    }
  }
}

/** Hand-off point between [MirrorService] and the module's [ScreenMirror]. */
object MirrorHub {
  @Volatile
  var receiver: ScreenMirror? = null

  fun deliver(projection: MediaProjection): Boolean {
    val mirror = receiver ?: return false
    mirror.attach(projection)
    return true
  }

  fun fail(message: String) {
    receiver?.log?.invoke(message)
  }
}
