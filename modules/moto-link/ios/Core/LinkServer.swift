import Foundation
import Network

/// TCP side of the dash link. The phone is the server: it listens on three
/// ports and the dash dials in after a probe.
///
///   10922  control        bytes are forwarded to JavaScript
///   10921  media control  bytes are forwarded to JavaScript
///   10920  media data     served here; the frame pull must not cross the bridge
final class LinkServer {
  static let controlPort: UInt16 = 10922
  static let mediaControlPort: UInt16 = 10921
  static let mediaDataPort: UInt16 = 10920

  /// Media-plane request the dash sends to pull one frame.
  private static let dataNext: Int16 = 114
  private static let mediaHeader = 8

  enum Event {
    case open(id: String, port: UInt16)
    case data(id: String, port: UInt16, bytes: Data)
    case close(id: String, port: UInt16)
    case log(String)
  }

  private let queue = DispatchQueue(label: "motolink.server")
  /// Frame pulls block while waiting for the encoder, so they get their own queue.
  private let pullQueue = DispatchQueue(label: "motolink.server.pull")
  private var listeners: [NWListener] = []
  private var connections: [String: (connection: NWConnection, port: UInt16)] = [:]
  private var nextId = 0
  private let frames: FrameQueue
  private let emit: (Event) -> Void

  init(frames: FrameQueue, emit: @escaping (Event) -> Void) {
    self.frames = frames
    self.emit = emit
  }

  private static func parameters() -> NWParameters {
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    let parameters = NWParameters(tls: nil, tcp: tcp)
    parameters.allowLocalEndpointReuse = true
    // The dash network has no internet; keep these sockets off cellular.
    parameters.requiredInterfaceType = .wifi
    return parameters
  }

  func start() throws {
    try queue.sync {
      guard listeners.isEmpty else { return }
      for port in [LinkServer.controlPort, LinkServer.mediaControlPort, LinkServer.mediaDataPort] {
        guard let endpointPort = NWEndpoint.Port(rawValue: port) else { continue }
        let listener = try NWListener(using: LinkServer.parameters(), on: endpointPort)
        listener.newConnectionHandler = { [weak self] connection in
          self?.accept(connection, port: port)
        }
        listener.stateUpdateHandler = { [weak self] state in
          if case .failed(let error) = state {
            // Usually another EasyConnect client (the official app) holds the port.
            self?.emit(.log("listener \(port) failed: \(error)"))
          }
        }
        listener.start(queue: queue)
        listeners.append(listener)
      }
    }
  }

  func stop() {
    queue.sync {
      listeners.forEach { $0.cancel() }
      listeners.removeAll()
      connections.values.forEach { $0.connection.cancel() }
      connections.removeAll()
    }
  }

  func send(id: String, data: Data) {
    queue.async {
      self.connections[id]?.connection.send(content: data, completion: .contentProcessed { _ in })
    }
  }

  func close(id: String) {
    queue.async {
      self.connections[id]?.connection.cancel()
    }
  }

  private func accept(_ connection: NWConnection, port: UInt16) {
    nextId += 1
    let id = "c\(nextId)"
    connections[id] = (connection, port)

    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        self.emit(.open(id: id, port: port))
        if port == LinkServer.mediaDataPort {
          self.readPull(connection, id: id, buffer: Data())
        } else {
          self.forward(connection, id: id, port: port)
        }
      case .failed, .cancelled:
        if self.connections.removeValue(forKey: id) != nil {
          self.emit(.close(id: id, port: port))
        }
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  private func forward(_ connection: NWConnection, id: String, port: UInt16) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, done, error in
      guard let self else { return }
      if let data, !data.isEmpty {
        self.emit(.data(id: id, port: port, bytes: data))
      }
      if done || error != nil {
        connection.cancel()
        return
      }
      self.forward(connection, id: id, port: port)
    }
  }

  /// Media data socket. Each request is an 8-byte header (int16 cmdType,
  /// uint16 bodyLen, int32 token), little-endian. The reply to a pull is not
  /// framed the same way: it is `[int32 LE size][Annex-B access unit]`.
  private func readPull(_ connection: NWConnection, id: String, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, done, error in
      guard let self else { return }
      var pending = buffer
      if let data { pending.append(data) }

      var pulls = 0
      while pending.count >= LinkServer.mediaHeader {
        let bytes = [UInt8](pending.prefix(LinkServer.mediaHeader))
        let cmdType = Int16(bitPattern: UInt16(bytes[0]) | (UInt16(bytes[1]) << 8))
        let bodyLength = Int(UInt16(bytes[2]) | (UInt16(bytes[3]) << 8))
        guard pending.count >= LinkServer.mediaHeader + bodyLength else { break }
        pending.removeFirst(LinkServer.mediaHeader + bodyLength)
        if cmdType == LinkServer.dataNext { pulls += 1 }
      }

      if done || error != nil {
        connection.cancel()
        return
      }
      if pulls == 0 {
        self.readPull(connection, id: id, buffer: pending)
        return
      }
      // Strict pull: answer, then read the next request.
      self.pullQueue.async {
        for _ in 0..<pulls {
          // No frame in time: send nothing and wait for the next request.
          guard let frame = self.frames.pop(timeout: 1.5) else { continue }
          var packet = Data(capacity: frame.count + 4)
          var size = UInt32(frame.count).littleEndian
          withUnsafeBytes(of: &size) { packet.append(contentsOf: $0) }
          packet.append(frame)
          connection.send(content: packet, completion: .contentProcessed { _ in })
        }
        self.queue.async {
          self.readPull(connection, id: id, buffer: pending)
        }
      }
    }
  }

  /// One request/reply exchange on a fresh outbound connection (the probe to
  /// dash:10930). Resolves with the first complete control frame.
  func probe(
    host: String,
    port: UInt16,
    payload: Data,
    timeout: TimeInterval,
    completion: @escaping (Result<Data, Error>) -> Void
  ) {
    guard let endpointPort = NWEndpoint.Port(rawValue: port) else {
      completion(.failure(ProbeError.failed("bad port")))
      return
    }
    let connection = NWConnection(host: NWEndpoint.Host(host), port: endpointPort, using: LinkServer.parameters())
    var finished = false
    let finish: (Result<Data, Error>) -> Void = { result in
      guard !finished else { return }
      finished = true
      connection.cancel()
      completion(result)
    }

    func read(_ buffer: Data) {
      connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, done, error in
        var pending = buffer
        if let data { pending.append(data) }
        if pending.count >= 16 {
          let b = [UInt8](pending.prefix(8))
          let total = Int(UInt32(b[4]) | (UInt32(b[5]) << 8) | (UInt32(b[6]) << 16) | (UInt32(b[7]) << 24))
          if total >= 16, pending.count >= total {
            finish(.success(pending.prefix(total)))
            return
          }
        }
        if let error {
          finish(.failure(error))
        } else if done {
          finish(.failure(ProbeError.failed("closed before reply")))
        } else {
          read(pending)
        }
      }
    }

    connection.stateUpdateHandler = { state in
      switch state {
      case .ready:
        connection.send(content: payload, completion: .contentProcessed { error in
          if let error { finish(.failure(error)) }
        })
        read(Data())
      case .failed(let error):
        finish(.failure(error))
      case .waiting(let error):
        // No route yet (not on the dash network). Fail fast; the session retries.
        finish(.failure(error))
      default:
        break
      }
    }
    connection.start(queue: queue)
    queue.asyncAfter(deadline: .now() + timeout) {
      finish(.failure(ProbeError.failed("timeout")))
    }
  }

  enum ProbeError: Error, CustomStringConvertible {
    case failed(String)
    var description: String {
      switch self {
      case .failed(let reason): return reason
      }
    }
  }
}

/// IPv4 address of the Wi-Fi interface and the likely dash address.
enum WifiAddress {
  struct Info {
    let ip: String
    let gateway: String
  }

  /// The dash is the access point, so it sits on the first host of the subnet
  /// (192.168.0.1 on the plain AP, 192.168.49.1 on a Wi-Fi Direct group).
  static func current() -> Info? {
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return nil }
    defer { freeifaddrs(list) }

    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let entry = cursor {
      defer { cursor = entry.pointee.ifa_next }
      guard
        let address = entry.pointee.ifa_addr,
        address.pointee.sa_family == sa_family_t(AF_INET),
        String(cString: entry.pointee.ifa_name) == "en0",
        let netmask = entry.pointee.ifa_netmask
      else { continue }

      let ip = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr.s_addr }
      let mask = netmask.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr.s_addr }
      let host = UInt32(bigEndian: ip)
      let network = host & UInt32(bigEndian: mask)
      return Info(ip: dotted(host), gateway: dotted(network | 1))
    }
    return nil
  }

  private static func dotted(_ value: UInt32) -> String {
    "\((value >> 24) & 0xFF).\((value >> 16) & 0xFF).\((value >> 8) & 0xFF).\(value & 0xFF)"
  }
}
