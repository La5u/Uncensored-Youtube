#!/usr/bin/env sh
set -eu

version="${1:-1.6.0}"
if ! printf '%s\n' "$version" | awk -F. '
  NR > 1 || NF < 1 || NF > 4 { exit 1 }
  {
    for (i = 1; i <= NF; i++) {
      if ($i !~ /^[0-9]+$/ || ($i + 0) > 65535) exit 1
    }
  }
'; then
  echo "Invalid version: $version (expected 1-4 numeric components)" >&2
  exit 1
fi

root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
dist="$root/dist"

mkdir -p "$dist/chromium" "$dist/firefox"
rm -rf "$dist/chromium"/* "$dist/firefox"/*

for browser in chromium firefox; do
  cp "$root/manifest.$browser.json" "$dist/$browser/manifest.json"
  sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$version\"/" "$dist/$browser/manifest.json"
  # Copy runtime formats only; editor backups and research artifacts stay local.
  (cd "$root/src" && find . -type f \( -name '*.js' -o -name '*.mjs' \
    -o -name '*.html' -o -name '*.css' -o -name '*.json' -o -name '*.png' \
    -o -name '*.wasm' -o -name '*.onnx' \) -print | while IFS= read -r file; do
    mkdir -p "$dist/$browser/src/$(dirname "$file")"
    cp "$file" "$dist/$browser/src/$file"
  done)
  cp "$root/LICENSE" "$dist/$browser/LICENSE"
  cp "$root/README.md" "$dist/$browser/README.md"
done

zip_options="-qr -1"
rm -f "$dist/uncensored-youtube-chromium-$version.zip" \
  "$dist/uncensored-youtube-firefox-$version.zip"

(cd "$dist/chromium" && zip $zip_options "../uncensored-youtube-chromium-$version.zip" .) &
chromium_zip_pid=$!
(cd "$dist/firefox" && zip $zip_options "../uncensored-youtube-firefox-$version.zip" .) &
firefox_zip_pid=$!

wait "$chromium_zip_pid"
wait "$firefox_zip_pid"

echo "Built:"
echo "  $dist/uncensored-youtube-chromium-$version.zip"
echo "  $dist/uncensored-youtube-firefox-$version.zip"
