/** @type {import('@bacons/apple-targets/app.plugin').Config} */
// Widget extension that only hosts the ride Live Activity (lock screen and
// Dynamic Island). The plugin's "widget" type is also its Live Activity type.
module.exports = {
  type: 'widget',
  name: 'MotoLinkLive',
  displayName: 'MotoLink',
  bundleIdentifier: '.live',
  deploymentTarget: '16.4',
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit'],
  colors: {
    // Matches the dark tint the activity sets in code, so the placeholder the
    // system draws before the view renders does not flash a different colour.
    $widgetBackground: '#0B0F14',
    $accent: '#00AEEF',
  },
};
