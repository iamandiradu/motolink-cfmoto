# Android

The native module `modules/moto-link` now has an Android side
(`modules/moto-link/android`, Kotlin, Expo Modules API of SDK 58). It is
registered with the Apple side in `modules/moto-link/expo-module.config.json`,
so the same JavaScript (`modules/moto-link/index.ts`) runs on both platforms.

**Status: none of the Kotlin has been compiled yet.** There is no Android SDK on
the development Mac. The first compile check is the `Build APK` workflow
(`.github/workflows/build-apk.yml`). Expect a round of fixes from its first run.

## What each function does on Android

| JS function / event | Android | State |
| --- | --- | --- |
| `getNetworkInfo` | Wi-Fi IPv4 from `LinkProperties`; gateway from the DHCP default route, otherwise the first host of the subnet (as on iOS) | Implemented |
| `joinWifi` | API 29+: `WifiNetworkSpecifier` through `requestNetwork`, held until the next join. Below API 29 it rejects with "join in Wi-Fi settings" | Implemented (API 29+) |
| `startServers` / `stopServers` | `ServerSocket`s on 10922, 10921, 10920, `SO_REUSEADDR`, `TCP_NODELAY` on accepted sockets. A port that is taken is reported through `onLog`, like iOS | Implemented |
| 10920 frame pull | Served natively: 8-byte LE headers, cmdType 114 answered with `[int32 LE size][access unit]`, 1.5 s wait, nothing sent when no frame | Implemented |
| `probe` | Fresh socket bound to the Wi-Fi `Network` (so it never leaves over mobile data); reply is the first complete 16-byte-header frame | Implemented |
| `send` / `closeConnection` | Per-connection writer thread, so JS never blocks | Implemented |
| `createIdentity` / `signHuid` | RSA-1024, `public.encoded` (X.509 SubjectPublicKeyInfo), `RSA/ECB/PKCS1Padding` ENCRYPT_MODE with the private key | Implemented |
| `configureVideo` / `restartStream` / `stopVideo` / `onVideoStats` | MediaCodec H.264, Baseline 3.1 (falls back to encoder defaults if the level is refused), no B-frames, Annex-B with 4-byte start codes, SEI dropped, SPS/PPS put in front of every keyframe. FrameQueue has the iOS keyframe-first and overflow rules | Implemented |
| `DashSurfaceView` (native view `MotoLink`) | Drawn into the encoder's input Surface with `lockHardwareCanvas()` + `View.draw()`, 1000/min(max(fps,5),22) ms apart while the dash pulls, every 500 ms while it does not | Implemented, see limits |
| `startButtonCapture` / `stopButtonCapture` / `reannounceButtons` / `onButton` | Volume: `ContentObserver` on `Settings.System` plus the `VOLUME_CHANGED_ACTION` broadcast, delta on a 0..1 scale, re-pin to mid-scale with `setStreamVolume`. Full: also a `MediaSession` (play/pause/next/previous), a silent looping `AudioTrack` and audio focus. All modes start a foreground service (type `connectedDevice`) that keeps the process alive instead of silent audio | Implemented |
| `getBluetoothOutputs` / `onAudioRoute` | `AudioManager.getDevices` filtered to A2DP, SCO, BLE headset/speaker; `AudioDeviceCallback` | Implemented |
| `requestNotificationPermission` / `notify` | `POST_NOTIFICATIONS` through Expo's permission manager on API 33+; notification opens the app | Implemented |
| `isMirroring` / `showBroadcastPicker` / `setMirrorView` / `onMirrorState` | `showBroadcastPicker` toggles: starts with the screen-capture consent dialog, then a foreground service of type `mediaProjection` owns the grant; a VirtualDisplay renders into an ImageReader, each frame is cropped/zoomed/fitted (same maths as `MirrorSender.scale`) and drawn into the same encoder. Re-sends the last frame after 400 ms of quiet; follows rotation | Implemented, least tested |

Nothing is a no-op stub. The functions that can fail softly report through
`onLog` (port taken, keep-alive service refused, volume re-pin refused, mirroring
declined).

## Known limits

- **Map tiles on the dash.** `View.draw()` records the view's display lists. Google
  Maps (react-native-maps on Android) draws into its own SurfaceView/TextureView,
  which is not part of that, so the map area comes out black on the dash. The
  phone preview is unaffected. Fix options: render the map in lite mode, snapshot
  it with `MapView.takeSnapshot` into an `Image`, or capture the whole screen
  through mirroring.
- **Why lockHardwareCanvas and not PixelCopy or a Bitmap.** PixelCopy copies the
  on-screen pixels, and the dash view is shown scaled down on the phone, so the dash
  would get a blurry picture. A software Bitmap capture throws on hardware bitmaps,
  which React Native's image pipeline uses. The hardware canvas draws the view at
  the encoder's size whatever its on-screen scale, like `drawHierarchy` on iOS.
- **Background.** The foreground service keeps sockets and buttons alive, but
  Android stops drawing views when the activity is in the background, so the dash
  picture freezes then (the last frame keeps going out). Mirroring keeps working
  in the background: it is the way to show another app.
- **Mirroring consent every time.** Android 14+ does not let a screen-capture grant
  be reused, so each start shows the system dialog. That is the same as the iOS
  broadcast sheet.
- **joinWifi.** A `WifiNetworkSpecifier` network exists only while the app holds the
  request; after an app restart JS must call `joinWifi` again, and Android shows its
  confirmation again. If the rider joins the dash Wi-Fi in Settings instead, the
  module still works: it finds the Wi-Fi network and binds the probe socket to it.
  The process is never bound to the dash network, because that would cut the
  internet for Spotify and map tiles.
- **Bluetooth names.** `AudioDeviceInfo.getProductName()` is used; on some phones
  it can be the model name rather than the name shown in Bluetooth settings.
- **Volume events.** Whether the dash's AVRCP absolute volume reaches
  `Settings.System` / `VOLUME_CHANGED_ACTION` depends on the phone's Bluetooth stack.
  Needs the bike.

## ❗ Changes needed outside the module before the APK builds and runs

1. ❗ **`app.json`: add an `android` section.** `expo prebuild` stops without a
   package name, so CI fails until this exists:
   ```json
   "android": {
     "package": "com.iamandiradu.motolink",
     "permissions": [
       "ACCESS_FINE_LOCATION",
       "ACCESS_COARSE_LOCATION",
       "CAMERA",
       "POST_NOTIFICATIONS"
     ]
   }
   ```
   The module's own manifest already adds the network, Wi-Fi, foreground service,
   notification and audio permissions, so they need not be listed. Fine location
   also lets `joinWifi` read the current SSID and skip the system dialog when
   already connected.
2. ❗ **react-native-maps needs a Google Maps API key on Android**, otherwise the
   map crashes the app as soon as it renders. Either add
   `"android": { "config": { "googleMaps": { "apiKey": "..." } } }` to `app.json`,
   or hide the Map page on Android (`Platform.OS === 'android'`) in
   `src/dash/DashScreen.tsx` and the dash page list. Even with a key, the map is
   black on the dash (see Known limits).
3. ❗ **iOS-only wording in screens**, to make platform-aware:
   - `src/app/(tabs)/buttons.tsx`: "Pair the phone with the bike in iOS Bluetooth settings".
   - `src/app/(tabs)/index.tsx`: "Tap Start, choose MotoLink, then Start Broadcast" (on Android: tap Start, then allow screen capture).
   - `src/app/(tabs)/settings.tsx`: "brings up Start Broadcast", "iOS requires your tap to start mirroring", "iOS does not let one app see what another is playing" (Android does allow it via notification listener; not implemented, so reword only).
   - `src/onboarding/WifiHelper.tsx`: "Opens the MotoLink page in iOS Settings".
   - `src/app-state/controller.ts` and `src/app-state/autoStart.ts` comments about the iOS sheet (comments only).
   - `src/protocol/session.ts` doc comment on `joinWifi` ("Asks iOS", "entitlement").
4. ❗ **Mirror presets** (`src/mirror/presets.ts`) use iOS URL schemes (`maps://`,
   `comgooglemaps://`). On Android use `geo:0,0?q=` or package intents, and note that
   Android 11+ needs `<queries>` entries for `Linking.canOpenURL` (an
   `app.json` / config-plugin change).
5. ❗ **The button mode `'off'`** maps to `keepAlive`, which on Android starts the
   foreground service with its ongoing notification. If that notification is
   unwanted when the link is idle, call `stopButtonCapture()` when disconnected.
6. ❗ **`src/protocol/control.ts`** sends `phoneModel: 'iPhone'`. With the default
   identity "Android" this is a mismatch worth aligning (use `Platform.OS` or the
   device model).
7. ❗ **`npm run prebuild`** in `package.json` is iOS-only (`--platform ios`); add an
   Android script if you want one locally.

## Testing on a phone

1. ❗ Make change 1 above (and 2), push to `master` or run the `Build APK` workflow
   by hand, and download the `apk` artifact.
2. ❗ Install `MotoLink-<n>-release.apk` (JS bundled, signed with the debug key):
   `adb install -r MotoLink-<n>-release.apk`, or open it on the phone and allow
   installs from that source. The `-debug.apk` needs Metro (`npx expo start`) and is
   only for development.
3. Without the bike: open Settings > log in the app. `startServers` should log no
   "listener ... failed" lines. On a laptop on the same Wi-Fi,
   `nc <phone-ip> 10922` should produce an `onConnectionOpen` line.
4. With the bike: scan the dash QR code; Android asks to connect to the dash Wi-Fi;
   accept. Then watch the log for the panel size and `onVideoStats` counts rising.
5. Buttons tab: each handlebar press should show a raw event (`volume` with a delta,
   or `key`). Try both "volume" and "full" modes.
6. Mirroring: tap the mirroring Start button, accept the capture dialog; the
   notification "Mirroring to the dash" appears and the dash shows the phone screen.
7. `adb logcat | grep -i motolink` shows native crashes and the service lifecycle.
