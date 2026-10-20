#!/bin/sh
# Copy the shared configurator into the panel and the LuCI package.
# Run after editing configurator/index.html; CI fails if copies are stale.
set -e
cd "$(dirname "$0")/.."
SRC=configurator
for DST in panel/web openwrt/luci-app-nikki-fleet/htdocs/luci-static/resources/nikki-fleet; do
	mkdir -p "$DST"
	cp "$SRC/index.html" "$DST/configurator.html"
	cp "$SRC/js-yaml.min.js" "$DST/js-yaml.min.js"
done
echo "configurator synced"
