#!/bin/sh
# nikki-fleet installer for OpenWrt 24.10 (opkg) and 25.12 (apk).
#
#   wget -qO- https://raw.githubusercontent.com/dontbass/nikki-fleet/main/install.sh | sh
#   wget -qO- https://<panel>/install.sh | sh -s -- <CODE>      (from the panel: also connects the router)
#
# If Nikki is not installed, the official Nikki is installed first using the
# scripts from https://github.com/nikkinikki-org/OpenWrt-nikki (feed + packages),
# so it keeps receiving updates from its authors. Set NIKKI=0 to skip that.
# SPDX-License-Identifier: GPL-3.0-or-later
set -e
PANEL='__PANEL__'
REPO='__REPO__'
NIKKI_RAW='https://raw.githubusercontent.com/nikkinikki-org/OpenWrt-nikki/main'
CODE="$1"
case "$PANEL" in __*) PANEL='' ;; esac
case "$REPO" in __*) REPO='dontbass/nikki-fleet' ;; esac

say() { printf '\033[1;34m[nikki-fleet]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[nikki-fleet]\033[0m %s\n' "$*" >&2; exit 1; }

# download to stdout with curl or the built-in wget (uclient-fetch)
fetch() {
	if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi
}
fetch_to() {
	if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"; else wget -qO "$2" "$1"; fi
}

[ -f /etc/openwrt_release ] || fail "это не OpenWrt"
. /etc/openwrt_release
case "$DISTRIB_RELEASE" in
	*24.10*|*25.12*|SNAPSHOT) ;;
	*) fail "нужен OpenWrt 24.10 или 25.12, у вас $DISTRIB_RELEASE" ;;
esac
[ -x /sbin/fw4 ] || fail "нужен OpenWrt с firewall4 (fw4)"
if command -v apk >/dev/null 2>&1; then PM=apk; EXT=apk; else PM=opkg; EXT=ipk; fi
say "OpenWrt $DISTRIB_RELEASE ($DISTRIB_ARCH), пакеты: $PM"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# run an official Nikki script: download first, check it, then execute
run_nikki_script() {
	fetch_to "$NIKKI_RAW/$1" "$TMP/$1" || fail "не удалось скачать $NIKKI_RAW/$1"
	grep -q "Nikki" "$TMP/$1" || fail "скачан не тот файл: $1"
	ash "$TMP/$1" || fail "$2"
}

# 1. Nikki
if [ -x /etc/init.d/nikki ]; then
	say "Nikki уже установлен"
elif [ "${NIKKI:-1}" = 0 ]; then
	fail "Nikki не установлен (NIKKI=0 — установка пропущена)"
else
	say "Nikki не найден — устанавливаю официальный Nikki (nikkinikki-org)"
	say "подключаю репозиторий Nikki, чтобы он обновлялся штатно"
	run_nikki_script feed.sh "не удалось подключить репозиторий Nikki"
	say "устанавливаю Nikki и mihomo (это может занять пару минут)"
	run_nikki_script install.sh "не удалось установить Nikki"
	[ -x /etc/init.d/nikki ] || fail "Nikki не установился — смотрите вывод выше"
	say "Nikki установлен (пока выключен — включится при первом сохранении профиля)"
fi

# 2. nikki-fleet
say "загружаю последний релиз $REPO"
URLS=$(fetch "https://api.github.com/repos/$REPO/releases/latest" | grep -o '"browser_download_url": *"[^"]*\.'"$EXT"'"' | cut -d'"' -f4)
[ -n "$URLS" ] || fail "не нашёл пакеты .$EXT в релизе"
SEEN=" "
for u in $URLS; do
	b="$(basename "$u")"
	case "$b" in
		luci-*) [ -d /www/luci-static ] || continue ;;
	esac
	# one file per package, even if a release accidentally holds two versions
	case "$b" in *.ipk) n="${b%%_*}" ;; *) n="$(echo "$b" | sed -E 's/-[0-9][^-]*(-r[0-9]+)?\.apk$//')" ;; esac
	case "$SEEN" in *" $n "*) continue ;; esac
	SEEN="$SEEN$n "
	fetch_to "$u" "$TMP/$b"
done

say "устанавливаю nikki-fleet"
if [ "$PM" = opkg ]; then
	opkg update >/dev/null 2>&1 || true
	opkg install "$TMP"/*.ipk
else
	apk update >/dev/null 2>&1 || true
	apk add --allow-untrusted "$TMP"/*.apk
fi

# 3. connect to the panel
if [ -n "$CODE" ] && [ -n "$PANEL" ]; then
	say "подключаю роутер к панели $PANEL"
	nikki-fleet enroll "$PANEL" "$CODE"
	say "готово: роутер появится в панели через несколько секунд"
elif [ -n "$CODE" ]; then
	fail "указан код, но не указан адрес панели: nikki-fleet enroll <адрес-панели> $CODE"
else
	say "готово. Конфигуратор: LuCI → Службы → Nikki → Конфигуратор"
	say "подключить к панели: LuCI → Nikki → Удалённое управление, или  nikki-fleet enroll <адрес-панели> <код>"
fi
