// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"net/http"
	"strings"
)

// installScript is served at /install.sh. Usage on the router:
//
//	curl -fsSL https://panel.example.com/install.sh | sh -s -- CODE
const installScript = `#!/bin/sh
# nikki-fleet installer for OpenWrt 24.10 (opkg) and 25.12 (apk)
set -e
PANEL='__PANEL__'
REPO='__REPO__'
CODE="$1"

say() { printf '\033[1;34m[nikki-fleet]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[nikki-fleet]\033[0m %s\n' "$*" >&2; exit 1; }

[ -f /etc/openwrt_release ] || fail "это не OpenWrt"
[ -x /etc/init.d/nikki ] || fail "сначала установите Nikki: https://github.com/nikkinikki-org/OpenWrt-nikki"
command -v curl >/dev/null || fail "нужен curl"

if command -v apk >/dev/null 2>&1; then PM=apk; EXT=apk; else PM=opkg; EXT=ipk; fi
say "менеджер пакетов: $PM"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
say "загружаю последний релиз $REPO"
URLS=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -o '"browser_download_url": *"[^"]*\.'"$EXT"'"' | cut -d'"' -f4)
[ -n "$URLS" ] || fail "не нашёл пакеты .$EXT в релизе"
for u in $URLS; do
	f="$TMP/$(basename "$u")"
	case "$(basename "$u")" in
		luci-*) [ -d /www/luci-static ] || continue ;;
	esac
	curl -fsSL -o "$f" "$u"
done

say "устанавливаю пакеты"
if [ "$PM" = opkg ]; then
	opkg update >/dev/null 2>&1 || true
	opkg install "$TMP"/*.ipk
else
	apk update >/dev/null 2>&1 || true
	apk add --allow-untrusted "$TMP"/*.apk
fi

if [ -n "$CODE" ]; then
	say "подключаю роутер к панели $PANEL"
	nikki-fleet enroll "$PANEL" "$CODE"
	say "готово: роутер появится в панели через несколько секунд"
else
	say "пакеты установлены; подключение: nikki-fleet enroll $PANEL <код>"
fi
`

func (a *App) installScript(w http.ResponseWriter, r *http.Request) {
	s := strings.ReplaceAll(installScript, "__PANEL__", a.publicURL(r))
	s = strings.ReplaceAll(s, "__REPO__", a.cfg.Repo)
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte(s))
}
