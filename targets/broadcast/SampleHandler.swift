import CoreMedia
import ImageIO
import ReplayKit

/// Screen-broadcast extension. iOS hands it every frame of the phone screen
/// while a broadcast runs, whichever app is in front. The work is in
/// MirrorSender; this class only adapts ReplayKit to it.
class SampleHandler: RPBroadcastSampleHandler {
  private let sender = MirrorSender()

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    sender.onFatal = { [weak self] reason in
      let error = NSError(
        domain: "MotoLink",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: reason]
      )
      self?.finishBroadcastWithError(error)
    }
    sender.start()
  }

  override func broadcastFinished() {
    sender.stop()
  }

  override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
    guard sampleBufferType == .video, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

    // Frames always arrive in the phone's native portrait layout. This tag says
    // how to turn them upright for the app on screen (a landscape Waze, say).
    var orientation = CGImagePropertyOrientation.up
    if let raw = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil)
      as? NSNumber,
      let tagged = CGImagePropertyOrientation(rawValue: raw.uint32Value)
    {
      // ReplayKit's tag is the rotation to apply, which is the mirror of the
      // EXIF meaning Core Image reads from the same value. Passed straight
      // through, a sideways screen comes out upside down (seen on the 450 MT),
      // so the two sideways cases are swapped. Upright and upside-down agree.
      switch tagged {
      case .left: orientation = .right
      case .right: orientation = .left
      default: orientation = tagged
      }
    }
    sender.submit(pixelBuffer, orientation: orientation)
  }
}
