// Shared between the MotoLinkNative pod (which starts/updates the activity)
// and the MotoLinkLive widget extension (which draws it). The widget target
// reaches this file through a symlink in targets/live-activity/, so there is
// exactly one definition: ActivityKit matches the app's request to the
// extension's ActivityConfiguration by this type, and two copies that drift
// apart would decode garbage or nothing at all.

#if canImport(ActivityKit)
import ActivityKit
import Foundation

@available(iOS 16.2, *)
public struct RideActivityAttributes: ActivityAttributes {
  public typealias ContentState = State

  /// Everything that changes during a ride. Kept small on purpose: the whole
  /// struct is JSON-encoded on every update and ActivityKit caps the payload
  /// at 4 KB, so only display-ready values go in (no raw telemetry).
  public struct State: Codable, Hashable {
    /// 'searching' | 'connecting' | 'onDash' | 'off'. A string rather than an
    /// enum so a new state added on the JS side decodes instead of failing
    /// the whole update; the widget shows a neutral fallback for unknown ids.
    public var linkState: String
    /// True while the phone screen is being mirrored to the dash.
    public var mirroring: Bool
    /// Nil when there is no GPS fix yet, so the widget can show a dash
    /// instead of a misleading 0.
    public var speed: Int?
    /// "km/h" or "mph"; the app owns the unit preference.
    public var speedUnit: String
    /// Already formatted ("12.4 km"), so the extension needs no locale or
    /// unit-conversion logic of its own.
    public var tripText: String
    /// Now-playing title, if any.
    public var trackTitle: String?

    public init(
      linkState: String,
      mirroring: Bool = false,
      speed: Int? = nil,
      speedUnit: String = "km/h",
      tripText: String = "",
      trackTitle: String? = nil
    ) {
      self.linkState = linkState
      self.mirroring = mirroring
      self.speed = speed
      self.speedUnit = speedUnit
      self.tripText = tripText
      self.trackTitle = trackTitle
    }
  }

  // No static attributes: nothing about a ride is fixed for its lifetime that
  // the UI needs, and an empty struct keeps request() trivially cheap.
  public init() {}
}
#endif
