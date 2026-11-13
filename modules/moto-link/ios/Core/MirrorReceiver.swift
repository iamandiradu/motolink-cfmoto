import Foundation
import Network

/// App side of screen mirroring: accepts the broadcast extension on a loopback
/// socket and receives encoded frames from it.
final class MirrorReceiver {
  var onConnected: (() -> Void)?
  var onDisconnected: (() -> Void)?
  var onFrame: ((Data, Bool) -> Void)?

  private let queue = DispatchQueue(label: "motolink.mirror")
  private var listener: NWListener?
  private var connection: NWConnection?
  private var parser = MirrorWire.Parser()
  private var config: MirrorWire.Config?
  private var view = MirrorWire.View()

  func start() {
    queue.async {
      guard self.listener == nil, let port = NWEndpoint.Port(rawValue: MirrorWire.port) else { return }
      let tcp = NWProtocolTCP.Options()
      tcp.noDelay = true
      let parameters = NWParameters(tls: nil, tcp: tcp)
      parameters.allowLocalEndpointReuse = true
      // Only this phone's own processes may connect.
      parameters.requiredInterfaceType = .loopback
      guard let listener = try? NWListener(using: parameters, on: port) else { return }
      listener.newConnectionHandler = { [weak self] connection in
        self?.accept(connection)
      }
      listener.start(queue: self.queue)
      self.listener = listener
    }
  }

  func stop() {
    queue.async {
      self.listener?.cancel()
      self.listener = nil
      self.connection?.cancel()
      self.connection = nil
    }
  }

  /// Picture size and quality the dash asked for. Sent now if the extension is
  /// connected, and again whenever it connects.
  func setConfig(_ config: MirrorWire.Config) {
    queue.async {
      self.config = config
      self.send(.config(config))
    }
  }

  /// Crop, zoom and fit of the mirrored picture. Applies at once.
  func setView(_ view: MirrorWire.View) {
    queue.async {
      self.view = view.sanitized
      self.send(.view(self.view))
    }
  }

  func requestKeyframe() {
    queue.async {
      self.send(.keyframe)
    }
  }

  private func send(_ message: MirrorWire.Message) {
    connection?.send(content: MirrorWire.encode(message), completion: .contentProcessed { _ in })
  }

  private func accept(_ incoming: NWConnection) {
    // A new broadcast replaces an old one.
    connection?.cancel()
    connection = incoming
    parser = MirrorWire.Parser()

    incoming.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        self.send(.view(self.view))
        if let config = self.config { self.send(.config(config)) }
        self.onConnected?()
        self.read(incoming)
      case .failed, .cancelled:
        if self.connection === incoming {
          self.connection = nil
          self.onDisconnected?()
        }
      default:
        break
      }
    }
    incoming.start(queue: queue)
  }

  private func read(_ connection: NWConnection) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, done, error in
      guard let self, self.connection === connection else { return }
      if let data, !data.isEmpty {
        for message in self.parser.push(data) {
          if case .frame(let frame, let isKeyframe) = message {
            self.onFrame?(frame, isKeyframe)
          }
        }
      }
      if done || error != nil || self.parser.failed {
        connection.cancel()
        return
      }
      self.read(connection)
    }
  }
}
