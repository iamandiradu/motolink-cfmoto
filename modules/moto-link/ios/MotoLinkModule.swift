import ExpoModulesCore
import NetworkExtension
import ReplayKit
import UIKit

/// Thin native transport for the dash link. Protocol decisions live in
/// TypeScript (src/protocol); this side owns what JavaScript cannot do well:
/// sockets, the video encoder, the RSA key, Wi-Fi join and button capture.
public class MotoLinkModule: Module {
  private let frames = FrameQueue()
  private lazy var server = LinkServer(frames: frames) { [weak self] event in
    self?.forward(event)
  }
  private lazy var capturer = FrameCapturer(frames: frames)
  private lazy var buttons = ButtonBridge { [weak self] payload in
    self?.sendEvent("onButton", payload)
  }
  private var encoder: VideoEncoder?
  private var identity: RsaIdentity?
  private var statsTimer: Timer?
  /// Screen mirroring: the broadcast extension delivers ready-made frames.
  private let mirror = MirrorReceiver()
  private let mirrorLock = NSLock()
  private var mirrorActive = false
  private var isMirroring: Bool {
    mirrorLock.lock()
    defer { mirrorLock.unlock() }
    return mirrorActive
  }
  private var lastStats = FrameQueue.Stats()

  public func definition() -> ModuleDefinition {
    Name("MotoLink")

    Events("onConnectionOpen", "onConnectionData", "onConnectionClose", "onVideoStats", "onButton", "onLog", "onMirrorState")

    OnCreate {
      self.frames.onNeedKeyframe = { [weak self] in
        guard let self else { return }
        // Whoever produces the picture right now must restart it.
        if self.isMirroring {
          self.mirror.requestKeyframe()
        } else {
          self.encoder?.requestKeyframe()
        }
      }
      self.mirror.onFrame = { [weak self] data, isKeyframe in
        self?.frames.push(data, isKeyframe: isKeyframe)
      }
      self.mirror.onConnected = { [weak self] in
        self?.setMirroring(true)
      }
      self.mirror.onDisconnected = { [weak self] in
        self?.setMirroring(false)
      }
      self.mirror.start()
    }

    OnDestroy {
      self.teardownVideo()
      self.server.stop()
      self.buttons.stop()
      self.mirror.stop()
    }

    // MARK: Network

    Function("getNetworkInfo") { () -> [String: String] in
      // Empty when Wi-Fi has no IPv4 address.
      guard let info = WifiAddress.current() else { return [:] }
      return ["ip": info.ip, "gateway": info.gateway]
    }

    AsyncFunction("joinWifi") { (ssid: String, password: String, promise: Promise) in
      let configuration = NEHotspotConfiguration(ssid: ssid, passphrase: password, isWEP: false)
      // Keep the network configured so iOS rejoins it by itself after an ignition cycle.
      configuration.joinOnce = false
      NEHotspotConfigurationManager.shared.apply(configuration) { error in
        if let error = error as NSError? {
          if error.domain == NEHotspotConfigurationErrorDomain,
            error.code == NEHotspotConfigurationError.alreadyAssociated.rawValue
          {
            promise.resolve(nil)
          } else {
            promise.reject("ERR_WIFI_JOIN", error.localizedDescription)
          }
        } else {
          promise.resolve(nil)
        }
      }
    }

    AsyncFunction("startServers") {
      try self.server.start()
    }

    AsyncFunction("stopServers") {
      self.server.stop()
    }

    AsyncFunction("probe") { (host: String, port: Int, dataBase64: String, timeoutMs: Int, promise: Promise) in
      guard let payload = Data(base64Encoded: dataBase64) else {
        promise.reject("ERR_PROBE", "bad payload")
        return
      }
      self.server.probe(
        host: host,
        port: UInt16(clamping: port),
        payload: payload,
        timeout: Double(timeoutMs) / 1000
      ) { result in
        switch result {
        case .success(let reply):
          promise.resolve(reply.base64EncodedString())
        case .failure(let error):
          promise.reject("ERR_PROBE", String(describing: error))
        }
      }
    }

    Function("send") { (id: String, dataBase64: String) in
      guard let data = Data(base64Encoded: dataBase64) else { return }
      self.server.send(id: id, data: data)
    }

    Function("closeConnection") { (id: String) in
      self.server.close(id: id)
    }

    // MARK: Identity

    AsyncFunction("createIdentity") { () -> String in
      let identity = try RsaIdentity()
      self.identity = identity
      return try identity.publicKeyBase64()
    }

    AsyncFunction("signHuid") { (huid: String) -> String in
      guard let identity = self.identity else {
        throw Exception(name: "ERR_IDENTITY", description: "createIdentity was not called")
      }
      return try identity.sign(huid: huid)
    }

    // MARK: Video

    AsyncFunction("configureVideo") { (config: [String: Int]) in
      let wanted = VideoEncoder.Config(
        width: config["width"] ?? 800,
        height: config["height"] ?? 384,
        fps: config["fps"] ?? 20,
        bitrate: config["bitrate"] ?? 1_500_000,
        keyframeIntervalSec: config["keyframeIntervalSec"] ?? 5
      )
      self.mirror.setConfig(
        MirrorWire.Config(
          width: wanted.width,
          height: wanted.height,
          fps: wanted.fps,
          bitrate: wanted.bitrate,
          keyframeIntervalSec: wanted.keyframeIntervalSec
        ))
      if self.encoder?.config == wanted { return }
      self.teardownVideo()
      let encoder = try VideoEncoder(config: wanted) { [weak self] data, isKeyframe in
        // While the phone screen is mirrored, the app's own picture stays out of the stream.
        guard let self, !self.isMirroring else { return }
        self.frames.push(data, isKeyframe: isKeyframe)
      }
      self.encoder = encoder
      self.frames.reset()
      DispatchQueue.main.async {
        self.capturer.start(encoder: encoder)
        self.startStats()
      }
    }

    AsyncFunction("restartStream") {
      self.frames.reset()
    }

    AsyncFunction("stopVideo") {
      self.teardownVideo()
    }

    // MARK: Buttons

    AsyncFunction("startButtonCapture") { (mode: String, pinVolume: Bool) in
      try self.buttons.start(mode: ButtonBridge.Mode(rawValue: mode) ?? .volume, pinVolume: pinVolume)
    }.runOnQueue(.main)

    AsyncFunction("stopButtonCapture") {
      self.buttons.stop()
    }.runOnQueue(.main)

    AsyncFunction("reannounceButtons") {
      self.buttons.reannounce()
    }.runOnQueue(.main)

    // MARK: Screen mirroring

    Function("isMirroring") { () -> Bool in
      self.isMirroring
    }

    /// Opens the iOS "Screen Broadcast" sheet with this app's extension preselected.
    AsyncFunction("showBroadcastPicker") {
      let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
      picker.preferredExtension = (Bundle.main.bundleIdentifier ?? "") + ".broadcast"
      picker.showsMicrophoneButton = false
      // The picker is a button with no public "press" call; tapping its inner
      // button is the established way to open the sheet from our own control.
      for case let button as UIButton in picker.subviews {
        button.sendActions(for: .touchUpInside)
      }
    }.runOnQueue(.main)

    View(MotoLinkView.self) {
      Prop("label") { (view: MotoLinkView, value: String) in
        view.accessibilityLabel = value
      }
    }
  }

  private func setMirroring(_ active: Bool) {
    mirrorLock.lock()
    let changed = mirrorActive != active
    mirrorActive = active
    mirrorLock.unlock()
    guard changed else { return }
    // Switching source mid-stream: the dash needs a fresh keyframe from the new one.
    frames.reset()
    DispatchQueue.main.async {
      self.capturer.paused = active
    }
    sendEvent("onMirrorState", ["active": active])
  }

  private func teardownVideo() {
    let old = encoder
    encoder = nil
    DispatchQueue.main.async {
      self.capturer.stop()
      self.statsTimer?.invalidate()
      self.statsTimer = nil
      old?.invalidate()
    }
  }

  private func startStats() {
    statsTimer?.invalidate()
    statsTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      guard let self else { return }
      let stats = self.frames.snapshot()
      guard stats.sent != self.lastStats.sent || stats.dropped != self.lastStats.dropped else { return }
      self.lastStats = stats
      self.sendEvent("onVideoStats", ["framesSent": stats.sent, "framesDropped": stats.dropped])
    }
  }

  private func forward(_ event: LinkServer.Event) {
    switch event {
    case .open(let id, let port):
      sendEvent("onConnectionOpen", ["id": id, "port": Int(port)])
    case .data(let id, let port, let bytes):
      sendEvent("onConnectionData", ["id": id, "port": Int(port), "data": bytes.base64EncodedString()])
    case .close(let id, let port):
      sendEvent("onConnectionClose", ["id": id, "port": Int(port)])
    case .log(let message):
      sendEvent("onLog", ["message": message])
    }
  }
}
