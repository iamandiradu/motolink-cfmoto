import ActivityKit
import SwiftUI
import WidgetKit

// MARK: - Palette

/// Brand accents are used only on a near-black ground, where both clear
/// WCAG AA for text: #00AEEF is about 8:1 and #FF3D97 about 6:1 against
/// #0B0F14. Body text stays white / light grey for the same reason.
private enum Palette {
  static let background = Color(red: 0x0B / 255, green: 0x0F / 255, blue: 0x14 / 255)
  static let blue = Color(red: 0x00 / 255, green: 0xAE / 255, blue: 0xEF / 255)
  static let pink = Color(red: 0xFF / 255, green: 0x3D / 255, blue: 0x97 / 255)
  static let primaryText = Color.white
  /// About 11:1 on the background; the system `.secondary` is avoided
  /// because it adapts to the lock screen's light mode and would wash out
  /// on our forced-dark tint.
  static let secondaryText = Color.white.opacity(0.72)
}

// MARK: - Link state presentation

/// Every state carries a distinct symbol AND a word, so it never depends on
/// colour alone (and reads the same to VoiceOver).
private struct LinkPresentation {
  let label: String
  let symbol: String
  let tint: Color

  init(_ state: RideActivityAttributes.ContentState) {
    switch state.linkState {
    case "onDash":
      if state.mirroring {
        label = "Mirroring"
        symbol = "rectangle.on.rectangle"
        tint = Palette.pink
      } else {
        label = "On dash"
        symbol = "checkmark.circle.fill"
        tint = Palette.blue
      }
    case "connecting":
      label = "Connecting"
      symbol = "arrow.triangle.2.circlepath"
      tint = Palette.blue
    case "searching":
      label = "Searching"
      symbol = "antenna.radiowaves.left.and.right"
      tint = Palette.secondaryText
    case "off":
      label = "Off"
      symbol = "xmark.circle"
      tint = Palette.secondaryText
    default:
      // A state added on the JS side before the extension knows about it.
      label = "Linking"
      symbol = "questionmark.circle"
      tint = Palette.secondaryText
    }
  }
}

private struct LinkBadge: View {
  let state: RideActivityAttributes.ContentState
  var showsText = true

  var body: some View {
    let p = LinkPresentation(state)
    HStack(spacing: 4) {
      Image(systemName: p.symbol)
        .foregroundColor(p.tint)
      if showsText {
        Text(p.label)
          .foregroundColor(Palette.primaryText)
          .lineLimit(1)
      }
    }
    .font(.subheadline.weight(.semibold))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Dash link: \(p.label)")
  }
}

private struct SpeedText: View {
  let state: RideActivityAttributes.ContentState
  let size: CGFloat

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 3) {
      // A dash rather than 0 when there is no GPS fix yet.
      Text(state.speed.map(String.init) ?? "--")
        .font(.system(size: size, weight: .bold, design: .rounded))
        .monospacedDigit()
        .foregroundColor(Palette.primaryText)
        .minimumScaleFactor(0.6)
        .lineLimit(1)
      Text(state.speedUnit)
        .font(.system(size: max(11, size * 0.3), weight: .semibold))
        .foregroundColor(Palette.secondaryText)
        .lineLimit(1)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(state.speed.map { "Speed \($0) \(state.speedUnit)" } ?? "Speed unavailable")
  }
}

private struct TripText: View {
  let state: RideActivityAttributes.ContentState

  var body: some View {
    if !state.tripText.isEmpty {
      Label(state.tripText, systemImage: "point.topleft.down.curvedto.point.bottomright.up")
        .font(.footnote.weight(.medium))
        .foregroundColor(Palette.secondaryText)
        .lineLimit(1)
        .accessibilityLabel("Trip \(state.tripText)")
    }
  }
}

private struct TrackText: View {
  let state: RideActivityAttributes.ContentState

  var body: some View {
    if let title = state.trackTitle {
      Label(title, systemImage: "music.note")
        .font(.footnote)
        .foregroundColor(Palette.secondaryText)
        .lineLimit(1)
        .accessibilityLabel("Now playing \(title)")
    }
  }
}

/// Shown when the stale date passed: the app stopped updating (killed or
/// suspended), so the numbers on screen may be old.
private struct StaleNote: View {
  var body: some View {
    Label("Paused", systemImage: "pause.circle")
      .font(.caption.weight(.semibold))
      .foregroundColor(Palette.secondaryText)
      .accessibilityLabel("Updates paused, values may be out of date")
  }
}

// MARK: - Lock screen / banner

private struct LockScreenView: View {
  let context: ActivityViewContext<RideActivityAttributes>

  var body: some View {
    let state = context.state
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 6) {
        LinkBadge(state: state)
        TripText(state: state)
        TrackText(state: state)
        if context.isStale { StaleNote() }
      }
      Spacer(minLength: 8)
      SpeedText(state: state, size: 44)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
  }
}

// MARK: - Widget

struct RideLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: RideActivityAttributes.self) { context in
      LockScreenView(context: context)
        // Forced dark tint so the brand accents keep their contrast even when
        // the lock screen is in light mode.
        .activityBackgroundTint(Palette.background)
        .activitySystemActionForegroundColor(Palette.primaryText)
        .environment(\.colorScheme, .dark)
    } dynamicIsland: { context in
      let state = context.state
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          LinkBadge(state: state)
            .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          SpeedText(state: state, size: 34)
            .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack(spacing: 12) {
            TripText(state: state)
            Spacer(minLength: 0)
            if context.isStale {
              StaleNote()
            } else {
              TrackText(state: state)
            }
          }
          .padding(.horizontal, 4)
        }
      } compactLeading: {
        // Symbol only: the compact slot is too narrow for the word, and the
        // symbol shape alone distinguishes the states.
        LinkBadge(state: state, showsText: false)
      } compactTrailing: {
        Text(state.speed.map(String.init) ?? "--")
          .font(.system(.body, design: .rounded).weight(.bold))
          .monospacedDigit()
          .foregroundColor(Palette.primaryText)
          .accessibilityLabel(state.speed.map { "Speed \($0) \(state.speedUnit)" } ?? "Speed unavailable")
      } minimal: {
        LinkBadge(state: state, showsText: false)
      }
      .keylineTint(Palette.blue)
    }
  }
}
