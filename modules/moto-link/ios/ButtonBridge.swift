import AVFoundation
import MediaPlayer
import UIKit

/// Receives the handlebar buttons.
///
/// The dash does not send them over Wi-Fi. It sends Bluetooth AVRCP to the
/// paired phone, in two shapes:
///   - an absolute-volume change for the up/down rocker (no key event), and
///   - play/pause, next, previous transport keys.
///
/// iOS delivers transport keys only to the app that is the active audio
/// player, so this plays a silent loop and publishes now-playing info. The
/// same silent audio keeps the app running while the phone is locked.
final class ButtonBridge: NSObject {
  enum Mode: String {
    /// No button capture, only the silent audio that keeps the app running
    /// behind another app (needed while Waze is on screen).
    case keepAlive
    /// Volume rocker only. Mixes with other audio, so music keeps playing.
    case volume
    /// Rocker plus transport keys. Takes over as the now-playing app; other music pauses.
    case full
  }

  private let emit: ([String: Any]) -> Void
  private var player: AVAudioPlayer?
  private var volumeObservation: NSKeyValueObservation?
  private var lastVolume: Float = 0.5
  private var pinVolume = true
  private var expectedPin: Float?
  private var volumeView: MPVolumeView?
  private var commandTargets: [(MPRemoteCommand, Any)] = []
  private var active = false

  /// Mid-scale, so both directions always have room to move.
  private static let pinLevel: Float = 0.5

  init(emit: @escaping ([String: Any]) -> Void) {
    self.emit = emit
    super.init()
  }

  func start(mode: Mode, pinVolume: Bool) throws {
    stop()
    self.pinVolume = pinVolume

    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playback, mode: .default, options: mode == .full ? [] : [.mixWithOthers])
    try session.setActive(true)

    let player = try AVAudioPlayer(data: ButtonBridge.silentWav(seconds: 1))
    player.numberOfLoops = -1
    player.volume = 0
    player.play()
    self.player = player

    if mode == .full {
      registerCommands()
      MPNowPlayingInfoCenter.default().nowPlayingInfo = [
        MPMediaItemPropertyTitle: "MotoLink",
        MPMediaItemPropertyArtist: "Handlebar control",
        MPMediaItemPropertyPlaybackDuration: 3600,
        MPNowPlayingInfoPropertyElapsedPlaybackTime: 0,
        MPNowPlayingInfoPropertyPlaybackRate: 1.0,
      ]
    }

    lastVolume = session.outputVolume
    if mode != .keepAlive {
      volumeObservation = session.observe(\.outputVolume, options: [.new]) { [weak self] _, change in
        guard let value = change.newValue else { return }
        DispatchQueue.main.async { self?.volumeChanged(to: value) }
      }
    }
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(interrupted(_:)),
      name: AVAudioSession.interruptionNotification,
      object: session
    )
    active = true
    if pinVolume, mode != .keepAlive { DispatchQueue.main.async { self.pin() } }
  }

  func stop() {
    guard active else { return }
    active = false
    volumeObservation?.invalidate()
    volumeObservation = nil
    NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
    for (command, target) in commandTargets { command.removeTarget(target) }
    commandTargets.removeAll()
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    player?.stop()
    player = nil
    DispatchQueue.main.async {
      self.volumeView?.removeFromSuperview()
      self.volumeView = nil
    }
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
  }

  /// The dash reads the player's capabilities once, when the AVRCP link forms.
  /// Calling this after the video link is up makes it read them again.
  func reannounce() {
    guard active, let player else { return }
    player.pause()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
      guard let self, self.active else { return }
      try? AVAudioSession.sharedInstance().setActive(true)
      player.play()
    }
  }

  private func registerCommands() {
    let center = MPRemoteCommandCenter.shared()
    let bindings: [(MPRemoteCommand, String)] = [
      (center.playCommand, "playPause"),
      (center.pauseCommand, "playPause"),
      (center.togglePlayPauseCommand, "playPause"),
      (center.nextTrackCommand, "next"),
      (center.previousTrackCommand, "previous"),
    ]
    for (command, key) in bindings {
      command.isEnabled = true
      let target = command.addTarget { [weak self] _ in
        self?.emit(["type": "key", "key": key])
        // Keep reporting "playing" so the dash keeps sending keys.
        self?.player?.play()
        return .success
      }
      commandTargets.append((command, target))
    }
  }

  private func volumeChanged(to value: Float) {
    if let expected = expectedPin, abs(value - expected) < 0.01 {
      // Our own re-pin, not a button.
      expectedPin = nil
      lastVolume = value
      return
    }
    let delta = value - lastVolume
    lastVolume = value
    guard abs(delta) > 0.001 else { return }
    emit(["type": "volume", "delta": Double(delta)])
    if pinVolume { pin() }
  }

  /// Puts the volume back to mid-scale after each press. Without this the
  /// rocker stops producing events once the volume reaches either end.
  /// There is no public API to set system volume; the slider inside
  /// MPVolumeView is the long-standing way to do it.
  private func pin() {
    guard abs(lastVolume - ButtonBridge.pinLevel) > 0.01 else { return }
    if volumeView == nil {
      let view = MPVolumeView(frame: CGRect(x: -2000, y: -2000, width: 1, height: 1))
      view.alpha = 0.01
      UIApplication.shared.connectedScenes
        .compactMap { ($0 as? UIWindowScene)?.windows.first }
        .first?
        .addSubview(view)
      volumeView = view
    }
    guard let slider = volumeView?.subviews.compactMap({ $0 as? UISlider }).first else { return }
    expectedPin = ButtonBridge.pinLevel
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
      slider.value = ButtonBridge.pinLevel
    }
  }

  @objc private func interrupted(_ note: Notification) {
    guard
      let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      AVAudioSession.InterruptionType(rawValue: raw) == .ended
    else { return }
    // A call or Siri ended: take the audio session back.
    try? AVAudioSession.sharedInstance().setActive(true)
    player?.play()
  }

  /// One second of 8 kHz mono 16-bit silence as an in-memory WAV file.
  static func silentWav(seconds: Int) -> Data {
    let sampleRate: UInt32 = 8000
    let dataSize = UInt32(seconds) * sampleRate * 2
    var wav = Data()
    func append<T: FixedWidthInteger>(_ value: T) {
      var little = value.littleEndian
      withUnsafeBytes(of: &little) { wav.append(contentsOf: $0) }
    }
    wav.append(contentsOf: Array("RIFF".utf8))
    append(UInt32(36 + dataSize))
    wav.append(contentsOf: Array("WAVEfmt ".utf8))
    append(UInt32(16))
    append(UInt16(1))  // PCM
    append(UInt16(1))  // mono
    append(sampleRate)
    append(sampleRate * 2)  // byte rate
    append(UInt16(2))  // block align
    append(UInt16(16))  // bits per sample
    wav.append(contentsOf: Array("data".utf8))
    append(dataSize)
    wav.append(Data(count: Int(dataSize)))
    return wav
  }
}
