#!/usr/bin/env sh
set -eu

version="${1:-0.1.0}"
root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
dist="$root/dist"

mkdir -p "$dist/chromium" "$dist/firefox"
rm -rf "$dist/chromium"/* "$dist/firefox"/*

cp "$root/manifest.chromium.json" "$dist/chromium/manifest.json"
cp "$root/manifest.firefox.json" "$dist/firefox/manifest.json"
cp -R "$root/src" "$dist/chromium/src"
cp -R "$root/src" "$dist/firefox/src"
cp "$root/LICENSE" "$dist/chromium/LICENSE"
cp "$root/LICENSE" "$dist/firefox/LICENSE"
cp "$root/README.md" "$dist/chromium/README.md"
cp "$root/README.md" "$dist/firefox/README.md"

(cd "$dist/chromium" && zip -qr "../uncensored-youtube-chromium-$version.zip" .)
(cd "$dist/firefox" && zip -qr "../uncensored-youtube-firefox-$version.zip" .)

echo "Built:"
echo "  $dist/uncensored-youtube-chromium-$version.zip"
echo "  $dist/uncensored-youtube-firefox-$version.zip"
