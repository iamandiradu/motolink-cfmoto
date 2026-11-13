package expo.modules.motolink

import android.net.Network
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * TCP side of the dash link. The phone is the server: it listens on three
 * ports and the dash dials in after a probe. Mirrors LinkServer.swift.
 *
 *   10922  control        bytes are forwarded to JavaScript
 *   10921  media control  bytes are forwarded to JavaScript
 *   10920  media data     served here; the frame pull must not cross the bridge
 *
 * Plain blocking java.net sockets with one thread per socket: there are at
 * most a handful of connections, and the pull on 10920 is strictly
 * request/reply, so threads are simpler and cheaper than NIO here.
 */
class LinkServer(
  private val frames: FrameQueue,
  /** The dash Wi-Fi, so the outbound probe does not leave over mobile data. */
  private val wifiNetwork: () -> Network?,
  private val emit: (Event) -> Unit
) {
  sealed class Event {
    data class Open(val id: String, val port: Int) : Event()
    class Data(val id: String, val port: Int, val bytes: ByteArray) : Event()
    data class Close(val id: String, val port: Int) : Event()
    data class Log(val message: String) : Event()
  }

  private class Connection(val socket: Socket, val port: Int) {
    /** Writes leave on their own thread: send() is called from the JS thread and must not block. */
    val writer: ExecutorService = Executors.newSingleThreadExecutor()
  }

  private val listeners = mutableListOf<ServerSocket>()
  private val connections = ConcurrentHashMap<String, Connection>()
  private val nextId = AtomicInteger(0)
  private val probeExecutor = Executors.newCachedThreadPool()

  @Synchronized
  fun start() {
    if (listeners.isNotEmpty()) return
    for (port in intArrayOf(CONTROL_PORT, MEDIA_CONTROL_PORT, MEDIA_DATA_PORT)) {
      val server = ServerSocket()
      try {
        server.reuseAddress = true
        server.bind(InetSocketAddress(port))
      } catch (error: IOException) {
        // Usually another EasyConnect client (the official app) holds the port.
        emit(Event.Log("listener $port failed: ${error.message}"))
        closeQuietly(server)
        continue
      }
      listeners.add(server)
      thread(name = "motolink-accept-$port", isDaemon = true) { acceptLoop(server, port) }
    }
  }

  @Synchronized
  fun stop() {
    listeners.forEach { closeQuietly(it) }
    listeners.clear()
    // Removed before closing, so the reader threads do not report a close
    // for connections JavaScript is tearing down itself (same as iOS).
    val open = connections.values.toList()
    connections.clear()
    open.forEach { drop(it) }
  }

  fun send(id: String, data: ByteArray) {
    val connection = connections[id] ?: return
    try {
      connection.writer.execute {
        try {
          connection.socket.getOutputStream().write(data)
        } catch (error: IOException) {
          closeQuietly(connection.socket)
        }
      }
    } catch (rejected: java.util.concurrent.RejectedExecutionException) {
      // Connection is closing; the bytes have nowhere to go.
    }
  }

  fun close(id: String) {
    connections[id]?.let { closeQuietly(it.socket) }
  }

  private fun acceptLoop(server: ServerSocket, port: Int) {
    while (!server.isClosed) {
      val socket = try {
        server.accept()
      } catch (error: IOException) {
        break
      }
      try {
        socket.tcpNoDelay = true
      } catch (error: IOException) {
        // Not fatal: only latency suffers.
      }
      val id = "c${nextId.incrementAndGet()}"
      val connection = Connection(socket, port)
      connections[id] = connection
      emit(Event.Open(id, port))
      thread(name = "motolink-conn-$id", isDaemon = true) {
        try {
          if (port == MEDIA_DATA_PORT) servePulls(socket) else forward(socket, id, port)
        } catch (error: IOException) {
          // Peer went away or the socket was closed locally.
        } finally {
          if (connections.remove(id) != null) {
            drop(connection)
            emit(Event.Close(id, port))
          }
        }
      }
    }
  }

  private fun forward(socket: Socket, id: String, port: Int) {
    val input = socket.getInputStream()
    val buffer = ByteArray(64 * 1024)
    while (true) {
      val count = input.read(buffer)
      if (count < 0) return
      if (count > 0) emit(Event.Data(id, port, buffer.copyOf(count)))
    }
  }

  /**
   * Media data socket. Each request is an 8-byte header (int16 cmdType,
   * uint16 bodyLen, int32 token), little-endian. The reply to a pull is not
   * framed the same way: it is `[int32 LE size][Annex-B access unit]`.
   * Strict pull: answer, then read the next request.
   */
  private fun servePulls(socket: Socket) {
    val input = socket.getInputStream()
    val output = socket.getOutputStream()
    val header = ByteArray(MEDIA_HEADER)
    while (true) {
      if (!readFully(input, header)) return
      val cmdType = ((header[0].toInt() and 0xFF) or ((header[1].toInt() and 0xFF) shl 8)).toShort()
      val bodyLength = (header[2].toInt() and 0xFF) or ((header[3].toInt() and 0xFF) shl 8)
      if (bodyLength > 0 && !skipFully(input, bodyLength)) return
      if (cmdType != DATA_NEXT) continue
      // No frame in time: send nothing and wait for the next request.
      val frame = frames.pop(PULL_TIMEOUT_MS) ?: continue
      writePacket(output, frame)
    }
  }

  private fun writePacket(output: OutputStream, frame: ByteArray) {
    val packet = ByteArray(frame.size + 4)
    val size = frame.size
    packet[0] = (size and 0xFF).toByte()
    packet[1] = ((size ushr 8) and 0xFF).toByte()
    packet[2] = ((size ushr 16) and 0xFF).toByte()
    packet[3] = ((size ushr 24) and 0xFF).toByte()
    System.arraycopy(frame, 0, packet, 4, size)
    output.write(packet)
    output.flush()
  }

  /**
   * One request/reply exchange on a fresh outbound connection (the probe to
   * dash:10930). Calls back with the first complete 16-byte-header control
   * frame, whose total length is the uint32 LE at offset 4.
   */
  fun probe(host: String, port: Int, payload: ByteArray, timeoutMs: Int, completion: (Result<ByteArray>) -> Unit) {
    probeExecutor.execute {
      val socket = Socket()
      val result = runCatching { probeBlocking(socket, host, port, payload, timeoutMs) }
      closeQuietly(socket)
      completion(result)
    }
  }

  private fun probeBlocking(socket: Socket, host: String, port: Int, payload: ByteArray, timeoutMs: Int): ByteArray {
    // Without this Android routes 192.168.x.x over mobile data when the dash
    // Wi-Fi has no internet and is therefore not the default network.
    wifiNetwork()?.bindSocket(socket)
    val deadline = System.currentTimeMillis() + timeoutMs
    socket.tcpNoDelay = true
    socket.connect(InetSocketAddress(host, port), timeoutMs.coerceAtLeast(1))
    val output = socket.getOutputStream()
    output.write(payload)
    output.flush()
    val input = socket.getInputStream()
    var pending = ByteArray(0)
    val buffer = ByteArray(64 * 1024)
    while (true) {
      val remaining = deadline - System.currentTimeMillis()
      if (remaining <= 0L) throw IOException("timeout")
      socket.soTimeout = remaining.toInt().coerceAtLeast(1)
      val count = try {
        input.read(buffer)
      } catch (timeout: SocketTimeoutException) {
        throw IOException("timeout")
      }
      if (count < 0) throw IOException("closed before reply")
      pending += buffer.copyOf(count)
      if (pending.size >= 16) {
        val total = (pending[4].toLong() and 0xFF) or
          ((pending[5].toLong() and 0xFF) shl 8) or
          ((pending[6].toLong() and 0xFF) shl 16) or
          ((pending[7].toLong() and 0xFF) shl 24)
        if (total > MAX_PROBE_REPLY) throw IOException("reply too large: $total")
        if (total >= 16L && pending.size.toLong() >= total) return pending.copyOf(total.toInt())
      }
    }
  }

  private fun drop(connection: Connection) {
    connection.writer.shutdownNow()
    closeQuietly(connection.socket)
  }

  companion object {
    const val CONTROL_PORT = 10922
    const val MEDIA_CONTROL_PORT = 10921
    const val MEDIA_DATA_PORT = 10920

    /** Media-plane request the dash sends to pull one frame. */
    private const val DATA_NEXT: Short = 114
    private const val MEDIA_HEADER = 8
    private const val PULL_TIMEOUT_MS = 1500L
    /** A control reply is small; refuse lengths that would only exhaust memory. */
    private const val MAX_PROBE_REPLY = 1L shl 20

    private fun readFully(input: InputStream, into: ByteArray): Boolean {
      var offset = 0
      while (offset < into.size) {
        val count = input.read(into, offset, into.size - offset)
        if (count < 0) return false
        offset += count
      }
      return true
    }

    private fun skipFully(input: InputStream, length: Int): Boolean {
      val scratch = ByteArray(minOf(length, 4096))
      var left = length
      while (left > 0) {
        val count = input.read(scratch, 0, minOf(left, scratch.size))
        if (count < 0) return false
        left -= count
      }
      return true
    }

    fun closeQuietly(closeable: java.io.Closeable?) {
      try {
        closeable?.close()
      } catch (error: IOException) {
        // Already closed.
      }
    }
  }
}
