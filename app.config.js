// Adds the Hotspot Configuration entitlement on request.
//
// With it the app joins the dash Wi-Fi by itself. A free Apple ID cannot sign
// that entitlement, so it is off by default; without it, join the dash Wi-Fi
// once in iOS Settings and iOS rejoins it from then on.
//
//   MOTOLINK_HOTSPOT=1 npx expo prebuild --platform ios --clean
module.exports = ({ config }) => {
  if (process.env.MOTOLINK_HOTSPOT !== '1') return config;
  return {
    ...config,
    ios: {
      ...config.ios,
      entitlements: {
        ...(config.ios?.entitlements ?? {}),
        'com.apple.developer.networking.HotspotConfiguration': true,
      },
    },
  };
};
