#!/usr/bin/env sh
set -eu

version="${1:-1.4.0}"
root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
dist="$root/dist"

mkdir -p "$dist/chromium" "$dist/firefox"
rm -rf "$dist/chromium"/* "$dist/firefox"/*

copy_tree() {
  src="$1"
  dest="$2"

  if cp -R -l "$src" "$dest" 2>/dev/null; then
    return
  fi

  cp -R "$src" "$dest"
}

cp "$root/manifest.chromium.json" "$dist/chromium/manifest.json"
cp "$root/manifest.firefox.json" "$dist/firefox/manifest.json"
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$version\"/" "$dist/chromium/manifest.json"
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$version\"/" "$dist/firefox/manifest.json"
copy_tree "$root/src" "$dist/chromium/src"
copy_tree "$root/src" "$dist/firefox/src"
cp "$root/LICENSE" "$dist/chromium/LICENSE"
cp "$root/LICENSE" "$dist/firefox/LICENSE"
cp "$root/README.md" "$dist/chromium/README.md"
cp "$root/README.md" "$dist/firefox/README.md"

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
