#!/bin/bash
# Signs a built MotoLink.app, including the screen-mirroring extension inside it.
#
#   scripts/sign-ipa.sh <App.app> <identity> <app.mobileprovision> <broadcast.mobileprovision> [keychain]
#
# <identity> is a certificate name or SHA-1 hash from `security find-identity`.
# Each bundle gets the entitlements its own provisioning profile grants, so the
# signature never claims more than the profile allows.
set -euo pipefail

APP="$1"
IDENTITY="$2"
APP_PROFILE="$3"
EXTENSION_PROFILE="$4"
KEYCHAIN="${5:-}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

sign() {
  if [ -n "$KEYCHAIN" ]; then
    codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" "$@"
  else
    codesign --force --sign "$IDENTITY" "$@"
  fi
}

# Writes the Entitlements dictionary of a provisioning profile to a plist.
entitlements_of() {
  security cms -D -i "$1" > "$WORK/profile.plist" 2>/dev/null
  /usr/libexec/PlistBuddy -x -c 'Print :Entitlements' "$WORK/profile.plist" > "$2"
}

sign_frameworks_in() {
  [ -d "$1/Frameworks" ] || return 0
  find "$1/Frameworks" -depth \( -name '*.framework' -o -name '*.dylib' \) -print0 |
    while IFS= read -r -d '' item; do sign "$item"; done
}

# Inside out: nested code first, the app last.
if [ -d "$APP/PlugIns" ]; then
  for EXTENSION in "$APP"/PlugIns/*.appex; do
    [ -d "$EXTENSION" ] || continue
    entitlements_of "$EXTENSION_PROFILE" "$WORK/extension.plist"
    cp "$EXTENSION_PROFILE" "$EXTENSION/embedded.mobileprovision"
    sign_frameworks_in "$EXTENSION"
    sign --entitlements "$WORK/extension.plist" "$EXTENSION"
  done
fi

sign_frameworks_in "$APP"
entitlements_of "$APP_PROFILE" "$WORK/app.plist"
cp "$APP_PROFILE" "$APP/embedded.mobileprovision"
sign --entitlements "$WORK/app.plist" "$APP"

codesign --verify --deep --strict "$APP"
echo "signed: $APP"
