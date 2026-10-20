#!/bin/sh
# nikki-fleet installer for OpenWrt 24.10 (opkg) and 25.12 (apk).
#
#   wget -qO- https://raw.githubusercontent.com/dontbass/nikki-fleet/main/install.sh | sh
#   wget -qO- https://<panel>/install.sh | sh -s -- <CODE>      (from the panel: also connects the router)
#
# If Nikki is not installed, the official Nikki is installed first: from its
# own repository (nikkinikki.pages.dev) via its feed.sh/install.sh, or, when
# that site is unreachable, from the Nikki release on GitHub, or through the
# nikki-fleet panel, which mirrors these files. Set NIKKI=0 to skip Nikki.
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

# download with curl or the built-in wget (uclient-fetch); give up on dead hosts quickly
fetch() {
	if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 10 "$1"; else wget -q -T 15 -O- "$1"; fi
}
fetch_to() {
	if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 10 -o "$2" "$1"; else wget -q -T 15 -O "$2" "$1"; fi
}
reachable() {
	if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 10 -o /dev/null "$1" 2>/dev/null; else wget -q -T 8 -O /dev/null "$1" 2>/dev/null; fi
}

[ -f /etc/openwrt_release ] || fail "это не OpenWrt"
# shellcheck disable=SC1091
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

# free space (KB) on the filesystem where packages are installed
free_kb() {
	df -k /overlay 2>/dev/null | awk 'NR==2 {print $4}' | grep . || df -k / | awk 'NR==2 {print $4}'
}
need_space() {
	ns_have="$(free_kb)"
	[ -n "$ns_have" ] || return 0
	[ "$ns_have" -ge "$1" ] && return 0
	printf '\033[1;31m[nikki-fleet]\033[0m не хватает места во флеш-памяти роутера: свободно %s МБ, для %s нужно около %s МБ\n' \
		"$((ns_have / 1024))" "$2" "$(($1 / 1024))" >&2
	cat >&2 <<'EOT'
Варианты:
  1. Расширить память флешкой или SD-картой (extroot):
     https://openwrt.org/docs/guide-user/additional-software/extroot_configuration
  2. Освободить место: удалить ненужные пакеты (opkg list-installed / apk info),
     например старые прокси-клиенты или языковые пакеты LuCI.
  3. Взять роутер с флеш-памятью от 128 МБ (mihomo занимает около 55 МБ).
EOT
	exit 1
}

# 1. Nikki
case "$DISTRIB_RELEASE" in *24.10*) NBRANCH=openwrt-24.10 ;; *25.12*) NBRANCH=openwrt-25.12 ;; *) NBRANCH=SNAPSHOT ;; esac
NIKKI_PAGES="https://nikkinikki.pages.dev/$NBRANCH/$DISTRIB_ARCH/nikki"
NIKKI_TAR="nikki_${DISTRIB_ARCH}-${NBRANCH}.tar.gz"
NIKKI_GH="https://github.com/nikkinikki-org/OpenWrt-nikki/releases/latest/download/$NIKKI_TAR"

# languages of the installed LuCI, to add matching Nikki translations
luci_langs() {
	if [ "$PM" = opkg ]; then
		opkg list-installed 'luci-i18n-base-*' 2>/dev/null | cut -d ' ' -f 1 | cut -d '-' -f 4-
	else
		apk list --installed --manifest 'luci-i18n-base-*' 2>/dev/null | cut -d ' ' -f 1 | cut -d '-' -f 4-
	fi
}

# install Nikki from a release tarball (same packages as the official feed)
install_nikki_tarball() {
	it_mem=$(awk '/MemAvailable/ {print int($2 / 1024)}' /proc/meminfo)
	[ "${it_mem:-0}" -ge 60 ] || fail "мало свободной оперативной памяти для загрузки Nikki: ${it_mem} МБ, нужно около 60"
	it_dir="$TMP/nikki"
	rm -rf "$it_dir" "$TMP/nikki.tar.gz"
	mkdir -p "$it_dir"
	fetch_to "$1" "$TMP/nikki.tar.gz" || return 1
	tar -xzf "$TMP/nikki.tar.gz" -C "$it_dir" || return 1
	rm -f "$TMP/nikki.tar.gz"
	it_pkgs="mihomo-meta nikki"
	if [ -d /www/luci-static ]; then
		it_pkgs="$it_pkgs luci-app-nikki"
		for it_l in $(luci_langs); do it_pkgs="$it_pkgs luci-i18n-nikki-$it_l"; done
	fi
	it_files=""
	for it_p in $it_pkgs; do
		# shellcheck disable=SC2012
		if [ "$PM" = opkg ]; then it_f=$(ls "$it_dir/${it_p}"_*.ipk 2>/dev/null | head -1); else it_f=$(ls "$it_dir/${it_p}"-[0-9]*.apk 2>/dev/null | head -1); fi
		[ -n "$it_f" ] && it_files="$it_files $it_f"
	done
	case "$it_files" in *mihomo-meta*) ;; *) return 1 ;; esac
	if [ "$PM" = opkg ]; then
		opkg update >/dev/null 2>&1 || true
		# shellcheck disable=SC2086
		opkg install $OPKG_FORCE $it_files
	else
		apk update >/dev/null 2>&1 || true
		# shellcheck disable=SC2086
		apk add --allow-untrusted $it_files
	fi
}

# On compressed flash (ubifs/jffs2) files take about half their size, but opkg
# checks free space against the uncompressed size and refuses. mihomo is ~55 MB
# uncompressed and ~25 MB on ubifs, so there we need ~30 MB and --force-space.
OVERLAY_FS="${NF_OVERLAY_FS:-$(awk '$2 == "/overlay" {print $3; exit}' /proc/mounts 2>/dev/null)}"
NIKKI_NEED=65536
OPKG_FORCE=""
TIGHT=0
case "$OVERLAY_FS" in
	ubifs|jffs2)
		NIKKI_NEED=30720
		if [ "$(free_kb)" -lt 65536 ] 2>/dev/null; then TIGHT=1; OPKG_FORCE="--force-space"; fi
		;;
esac

if [ -x /etc/init.d/nikki ]; then
	say "Nikki уже установлен"
elif [ "${NIKKI:-1}" = 0 ]; then
	fail "Nikki не установлен (NIKKI=0 — установка пропущена)"
else
	say "Nikki не найден — устанавливаю официальный Nikki (nikkinikki-org)"
	need_space "$NIKKI_NEED" "Nikki и mihomo"
	[ "$TIGHT" = 1 ] && say "флеш сжатая ($OVERLAY_FS): mihomo займёт около 25 МБ — ставлю пакеты с учётом сжатия"
	if [ "$TIGHT" = 0 ] && reachable "$NIKKI_PAGES/index.json"; then
		say "подключаю репозиторий Nikki, чтобы он обновлялся штатно"
		run_nikki_script feed.sh "не удалось подключить репозиторий Nikki"
		say "устанавливаю Nikki и mihomo (это может занять пару минут)"
		run_nikki_script install.sh "не удалось установить Nikki"
	else
		[ "$TIGHT" = 1 ] || say "репозиторий Nikki (nikkinikki.pages.dev) недоступен"
		say "беру официальные пакеты Nikki из релиза на GitHub"
		if ! install_nikki_tarball "$NIKKI_GH"; then
			[ -n "$PANEL" ] || fail "GitHub тоже недоступен. Установите через панель nikki-fleet — она скачает пакеты сама"
			say "GitHub недоступен — загружаю пакеты Nikki через панель $PANEL"
			install_nikki_tarball "$PANEL/dl/nikki/$NIKKI_TAR" || fail "не удалось загрузить Nikki и через панель"
		fi
	fi
	[ -x /etc/init.d/nikki ] || fail "Nikki не установился — смотрите вывод выше"
	say "Nikki установлен (пока выключен — включится при первом сохранении профиля)"
fi

# 2. nikki-fleet
need_space 1024 "nikki-fleet"
say "загружаю последний релиз $REPO"
URLS=$(fetch "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | grep -o '"browser_download_url": *"[^"]*\.'"$EXT"'"' | cut -d'"' -f4 || true)
if [ -z "$URLS" ] && [ -n "$PANEL" ]; then
	say "GitHub недоступен — загружаю nikki-fleet через панель"
	URLS=$(fetch "$PANEL/dl/nikki-fleet/assets.json" | grep -o '"[^"]*\.'"$EXT"'"' | tr -d '"' | sed "s|^|$PANEL/dl/nikki-fleet/|" || true)
fi
[ -n "$URLS" ] || fail "не нашёл пакеты .$EXT в релизе (нет доступа к GitHub?)"
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
	if ! fetch_to "$u" "$TMP/$b"; then
		# shellcheck disable=SC2015
		[ -n "$PANEL" ] && fetch_to "$PANEL/dl/nikki-fleet/$b" "$TMP/$b" || fail "не удалось скачать $b"
	fi
done

say "устанавливаю nikki-fleet"
if [ "$PM" = opkg ]; then
	opkg update >/dev/null 2>&1 || true
	# --force-downgrade: older releases versioned translations by date (26.x),
	# newer ones by the app version; the release files are always the ones to keep
	opkg install --force-downgrade "$TMP"/*.ipk
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
