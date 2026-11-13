/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'broadcast-upload',
  name: 'MotoLinkBroadcast',
  displayName: 'MotoLink',
  bundleIdentifier: '.broadcast',
  deploymentTarget: '16.4',
  frameworks: ['ReplayKit', 'VideoToolbox', 'CoreImage', 'Network'],
};
