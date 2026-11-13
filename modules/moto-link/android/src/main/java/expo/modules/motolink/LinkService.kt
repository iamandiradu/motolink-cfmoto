package expo.modules.motolink

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Foreground service that keeps the process (and so the dash link and button
 * capture) alive while another app is on screen. This replaces the silent
 * audio loop iOS needs for the same purpose.
 *
 * Type connectedDevice: the app holds a link to an external device (the
 * dash). Android 14+ requires a declared type; this one is satisfied by the
 * normal CHANGE_WIFI_STATE permission, no runtime prompt.
 */
class LinkService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = Notifications.ongoing(this, "Linked to the dash", "Keeps the dash picture and handlebar buttons running.")
    try {
      ServiceCompat.startForeground(this, Notifications.LINK_ID, notification, foregroundType())
    } catch (error: RuntimeException) {
      // Android 12+ refuses foreground starts from the background
      // (ForegroundServiceStartNotAllowedException); nothing to keep alive then.
      stopSelf()
    }
    return START_NOT_STICKY
  }

  private fun foregroundType(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0

  companion object {
    fun start(context: Context, log: (String) -> Unit) {
      try {
        ContextCompat.startForegroundService(context, Intent(context, LinkService::class.java))
      } catch (error: RuntimeException) {
        log("keep-alive service not started: ${error.message}")
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, LinkService::class.java))
    }
  }
}

/** Notification channels and builders shared by the services and notify(). */
object Notifications {
  const val LINK_ID = 4101
  const val MIRROR_ID = 4102
  const val BIKE_ID = 4103
  private const val ONGOING_CHANNEL = "motolink.link"
  private const val BIKE_CHANNEL = "motolink.bike"

  private fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.createNotificationChannel(
      NotificationChannel(ONGOING_CHANNEL, "Dash link", NotificationManager.IMPORTANCE_LOW)
    )
    manager.createNotificationChannel(
      NotificationChannel(BIKE_CHANNEL, "Bike", NotificationManager.IMPORTANCE_HIGH)
    )
  }

  private fun openApp(context: Context): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  fun ongoing(context: Context, title: String, body: String): Notification {
    ensureChannels(context)
    return NotificationCompat.Builder(context, ONGOING_CHANNEL)
      .setSmallIcon(R.drawable.motolink_notification)
      .setContentTitle(title)
      .setContentText(body)
      .setOngoing(true)
      .setContentIntent(openApp(context))
      .build()
  }

  fun bike(context: Context, title: String, body: String): Notification {
    ensureChannels(context)
    return NotificationCompat.Builder(context, BIKE_CHANNEL)
      .setSmallIcon(R.drawable.motolink_notification)
      .setContentTitle(title)
      .setContentText(body)
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setContentIntent(openApp(context))
      .build()
  }
}
