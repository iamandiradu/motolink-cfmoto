Pod::Spec.new do |s|
  s.name           = 'MotoLinkNative'
  s.version        = '1.0.0'
  s.summary        = 'Native transport for the CFMOTO MotoPlay dash link'
  s.description    = 'TCP listeners, H.264 encoder, RSA identity, Wi-Fi join and handlebar button capture.'
  s.author         = 'iamandiradu'
  s.homepage       = 'https://github.com/iamandiradu/motolink-cfmoto'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Network', 'NetworkExtension', 'VideoToolbox', 'CoreMedia', 'CoreVideo', 'AVFoundation', 'MediaPlayer', 'Security', 'ActivityKit', 'CoreImage', 'CoreText', 'UserNotifications', 'ReplayKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
