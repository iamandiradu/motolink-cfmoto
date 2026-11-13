import SwiftUI
import WidgetKit

/// Extension entry point. The bundle holds only the ride Live Activity; no
/// home-screen widget, so nothing shows up in the widget gallery.
@main
struct MotoLinkLiveBundle: WidgetBundle {
  var body: some Widget {
    RideLiveActivity()
  }
}
