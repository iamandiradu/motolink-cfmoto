package expo.modules.motolink

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import java.net.Inet4Address

/**
 * The dash Wi-Fi: finding it, reading its addresses, and asking Android to
 * join it.
 *
 * The process is deliberately NOT bound to the dash network
 * (bindProcessToNetwork): the dash has no internet, and binding would cut
 * Spotify, map tiles and everything else in the app. Instead the module's own
 * outbound socket (the probe) is bound to the Wi-Fi network; accepted sockets
 * already live on the interface the dash dialled in on.
 */
class WifiLink(private val context: Context, private val log: (String) -> Unit) {
  private val connectivity: ConnectivityManager
    get() = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

  /** Network handed to us by joinWifi; preferred over a scan of all networks. */
  @Volatile
  private var joined: Network? = null
  private var joinCallback: ConnectivityManager.NetworkCallback? = null

  data class Info(val ip: String, val gateway: String)

  /** The Wi-Fi network the dash is on, or null when Wi-Fi is not connected. */
  fun network(): Network? {
    val manager = connectivity
    joined?.let { candidate ->
      if (manager.getNetworkCapabilities(candidate)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true) {
        return candidate
      }
    }
    // allNetworks is deprecated for callback-based tracking, but a one-off
    // lookup is exactly what this call is for.
    @Suppress("DEPRECATION")
    val networks = manager.allNetworks
    return networks.firstOrNull { network ->
      val caps = manager.getNetworkCapabilities(network)
      caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && ipv4(manager.getLinkProperties(network)) != null
    }
  }

  /**
   * IPv4 address of the Wi-Fi interface and the likely dash address. The dash
   * is the access point; its DHCP default route names it. Without a default
   * route (a local-only network) fall back to the first host of the subnet,
   * as the iOS side does (192.168.0.1 on the plain AP, 192.168.49.1 on a
   * Wi-Fi Direct group).
   */
  fun info(): Info? {
    val network = network() ?: return null
    val properties = connectivity.getLinkProperties(network) ?: return null
    val (address, prefix) = ipv4(properties) ?: return null
    val gateway = properties.routes
      .firstOrNull { it.isDefaultRoute && it.gateway is Inet4Address && !it.gateway!!.isAnyLocalAddress }
      ?.gateway
      ?.hostAddress
    val host = toInt(address)
    val mask = if (prefix == 0) 0 else (-1 shl (32 - prefix))
    val firstHost = dotted((host and mask) or 1)
    return Info(dotted(host), gateway ?: firstHost)
  }

  /**
   * Asks Android to join the dash Wi-Fi. On API 29+ this is a
   * WifiNetworkSpecifier request: the system shows its own confirmation, and
   * the network stays up while the request is held (until the next join or
   * module teardown). Older Android has no app-side join without deprecated
   * WifiConfiguration APIs, so the rider joins once in Settings.
   */
  fun join(ssid: String, password: String, done: (Throwable?) -> Unit) {
    if (isOnSsid(ssid)) {
      done(null)
      return
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      done(IllegalStateException("Android ${Build.VERSION.RELEASE} cannot join from the app; join \"$ssid\" in Wi-Fi settings"))
      return
    }
    release()
    val specifier = WifiNetworkSpecifier.Builder()
      .setSsid(ssid)
      .apply { if (password.isNotEmpty()) setWpa2Passphrase(password) }
      .build()
    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      // The dash offers no internet; without this the request would never match.
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .setNetworkSpecifier(specifier)
      .build()
    var answered = false
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        joined = network
        log("joined Wi-Fi $ssid")
        if (!answered) {
          answered = true
          done(null)
        }
      }

      override fun onUnavailable() {
        if (!answered) {
          answered = true
          done(IllegalStateException("could not join \"$ssid\" (declined or out of range)"))
        }
      }

      override fun onLost(network: Network) {
        if (joined == network) joined = null
        log("lost Wi-Fi $ssid")
      }
    }
    joinCallback = callback
    try {
      connectivity.requestNetwork(request, callback, JOIN_TIMEOUT_MS)
    } catch (error: RuntimeException) {
      joinCallback = null
      done(error)
    }
  }

  /** Gives up the held network request, which lets Android drop the dash Wi-Fi. */
  fun release() {
    joinCallback?.let { callback ->
      try {
        connectivity.unregisterNetworkCallback(callback)
      } catch (error: IllegalArgumentException) {
        // Never registered or already released.
      }
    }
    joinCallback = null
    joined = null
  }

  /**
   * True when the current Wi-Fi already is that SSID. Android only reveals the
   * SSID to apps with location permission (the app has it for GPS); without
   * it this returns false and the join request goes ahead, which is harmless.
   */
  private fun isOnSsid(ssid: String): Boolean {
    if (network() == null) return false
    val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return false
    @Suppress("DEPRECATION")
    val current = wifi.connectionInfo?.ssid ?: return false
    return current.trim('"') == ssid
  }

  private fun ipv4(properties: LinkProperties?): Pair<Inet4Address, Int>? {
    val link = properties?.linkAddresses?.firstOrNull { it.address is Inet4Address } ?: return null
    return Pair(link.address as Inet4Address, link.prefixLength)
  }

  private fun toInt(address: Inet4Address): Int {
    val b = address.address
    return ((b[0].toInt() and 0xFF) shl 24) or ((b[1].toInt() and 0xFF) shl 16) or
      ((b[2].toInt() and 0xFF) shl 8) or (b[3].toInt() and 0xFF)
  }

  private fun dotted(value: Int): String =
    "${(value ushr 24) and 0xFF}.${(value ushr 16) and 0xFF}.${(value ushr 8) and 0xFF}.${value and 0xFF}"

  companion object {
    private const val JOIN_TIMEOUT_MS = 30_000
  }
}
