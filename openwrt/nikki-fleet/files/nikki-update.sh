#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# nikki-fleet: update Nikki itself (nikki, luci-app-nikki, its translations)
# from the latest Nikki release, through the panel, with a full rollback.
#
#   nikki-update.sh <panel-url> [insecure]
#
# The mihomo core is never touched (it has its own update): only the small
# Nikki packages are installed, and only those already on the router.
#
# Safety:
#  - packages come from the panel with SHA-256 checksums and are checked;
#  - free flash is checked, and a dry run (opkg --noaction / apk --simulate)
#    must pass, so missing dependencies stop the update before anything changes;
#  - before installing, the current Nikki files, the package database entries
#    and /etc/config/nikki are saved to RAM;
#  - after installing, Nikki is restarted and mihomo must answer within 60 s;
#  - on any failure the saved files and database are put back and Nikki is
#    started as before. Settings and profiles are kept by the package manager
#    (they are conffiles) and by the backup.

set -u
PANEL="${1:-}"
INSECURE="${2:-0}"
R="${NF_ROOT:-}"
W="${NF_WORK:-/tmp/nikki-fleet-nikki}"
INIT="$R/etc/init.d/nikki"
CLI="${NF_CLI:-nikki-fleet}"
CURL="curl -fsSL --connect-timeout 15 --retry 2 -y 30 -Y 10240"
[ "$INSECURE" = 1 ] && CURL="$CURL -k"

log() { echo "[$(date +%H:%M:%S)] $*"; }
cleanup() { rm -rf "$W"; }
die() { log "ОШИБКА: $*"; cleanup; exit 1; }

api_ok() { "$CLI" api GET /version 2>/dev/null | grep -q '"version"'; }
wait_api() { i=0; while [ "$i" -lt "$1" ]; do api_ok && return 0; sleep 2; i=$((i + 2)); done; return 1; }
nikki_enabled() { [ "$(uci -q get nikki.config.enabled)" = 1 ]; }

# --- package manager helpers ----------------------------------------------
if command -v opkg >/dev/null 2>&1; then PM=opkg; elif command -v apk >/dev/null 2>&1; then PM=apk; else die "нет ни opkg, ни apk"; fi

# installed version of a package (empty if not installed)
iv() {
	if [ "$PM" = opkg ]; then
		opkg list-installed "$1" 2>/dev/null | awk -v p="$1" '$1 == p {print $3; exit}'
	else
		apk list -I "$1" 2>/dev/null | awk -v p="$1" 'index($1, p "-") == 1 { v = substr($1, length(p) + 2); if (v ~ /^[0-9]/) { print v; exit } }'
	fi
}
installed_i18n() {
	if [ "$PM" = opkg ]; then
		opkg list-installed 'luci-i18n-nikki-*' 2>/dev/null | awk '{print $1}'
	else
		apk list -I 'luci-i18n-nikki-*' 2>/dev/null | awk '{print $1}' | sed 's/-[0-9][^-]*\(-r[0-9]*\)\{0,1\}$//'
	fi
}
# opkg reports a kept, locally modified conffile under "Collected errors"; that is not a failure
opkg_errors() { sed -n '/Collected errors/,$p' "$1" | grep '^ \* ' | grep -v -e resolve_conffiles -e 'conffile will be placed'; }
# files that belong to a package, one absolute path per line
pkg_files() {
	if [ "$PM" = opkg ]; then
		opkg files "$1" 2>/dev/null | grep '^/'
	else
		apk info -qL "$1" 2>/dev/null | grep -v -e '^$' -e ':$' | sed 's#^/*#/#'
	fi
}

# --- what to install ---------------------------------------------------------
[ -n "$PANEL" ] || die "нужен адрес панели: пакеты Nikki идут через неё"
REL="$(. "$R/etc/openwrt_release" 2>/dev/null; echo "${DISTRIB_RELEASE:-}")"
ARCH="$(. "$R/etc/openwrt_release" 2>/dev/null; echo "${DISTRIB_ARCH:-}")"
case "$REL" in
	24.10*) BR=openwrt-24.10 ;;
	25.12*) BR=openwrt-25.12 ;;
	*SNAPSHOT*) BR=SNAPSHOT ;;
	*) die "OpenWrt ${REL:-?} не поддерживается (нужен 24.10 или 25.12)" ;;
esac
[ -n "$ARCH" ] || die "не удалось определить архитектуру"
CUR="$(iv nikki)"
[ -n "$CUR" ] || die "Nikki не установлен"
log "сейчас: nikki $CUR, luci-app-nikki $(iv luci-app-nikki || true) ($PM, $BR, $ARCH)"

rm -rf "$W"; mkdir -p "$W/pkg" || die "нет места в /tmp"
$CURL -o "$W/index.json" "$PANEL/dl/nikki-pkg/$BR/$ARCH/index.json" || die "панель не отдала список пакетов Nikki (обновите панель до 0.1.21+)"
jf() { jsonfilter -i "$W/index.json" -e "$1" 2>/dev/null; }
TAG="$(jf '@.tag')"
NEW="$(jf '@.packages.nikki.version')"
[ -n "$NEW" ] || die "в релизе Nikki ${TAG:-?} нет пакета nikki для $ARCH"

WANT="nikki"
[ -n "$(iv luci-app-nikki)" ] && WANT="$WANT luci-app-nikki"
for p in $(installed_i18n); do [ -n "$(jf "@.packages['$p'].version")" ] && WANT="$WANT $p"; done

TODO=""
for p in $WANT; do
	v="$(jf "@.packages['$p'].version")"
	[ -n "$v" ] && [ "$v" != "$(iv "$p")" ] && TODO="$TODO $p"
done
if [ -z "$TODO" ]; then log "уже установлена последняя версия (релиз ${TAG:-?})"; cleanup; exit 0; fi
log "обновление до релиза ${TAG:-?}:$(for p in $TODO; do printf ' %s %s→%s;' "$p" "$(iv "$p")" "$(jf "@.packages['$p'].version")"; done)"

# --- download and verify -----------------------------------------------------
FILES=""; SUM_KB=0
for p in $TODO; do
	f="$(jf "@.packages['$p'].file")"; s="$(jf "@.packages['$p'].sha256")"
	case "$f" in *[!A-Za-z0-9._~+-]*|"") die "странное имя файла в списке: $f" ;; esac
	$CURL -o "$W/pkg/$f" "$PANEL/dl/nikki-pkg/$BR/$ARCH/$f" || die "не удалось скачать $f"
	[ "$(sha256sum "$W/pkg/$f" | awk '{print $1}')" = "$s" ] || die "контрольная сумма $f не совпала — файл повреждён"
	FILES="$FILES $W/pkg/$f"
	SUM_KB=$((SUM_KB + $(wc -c < "$W/pkg/$f") / 1024 + 1))
done
log "пакеты скачаны и проверены (SHA-256)"

FREE_KB="${NF_FREE_KB:-$(df -k "$R/" 2>/dev/null | awk 'NR==2 {print $4}')}"
[ -d "$R/overlay" ] && FREE_KB="${NF_FREE_KB:-$(df -k "$R/overlay" | awk 'NR==2 {print $4}')}"
NEED_KB=$((SUM_KB * 4 + 1024))
[ "$FREE_KB" -ge "$NEED_KB" ] || die "мало места во флеш-памяти: свободно $((FREE_KB / 1024)) МБ, нужно около $((NEED_KB / 1024 + 1)) МБ"

# dry run: dependencies and conflicts are found here, before anything changes
if [ "$PM" = opkg ]; then
	# opkg's exit status also counts kept conffiles as errors: judge by the messages
	opkg install --noaction $FILES > "$W/dry.log" 2>&1; rc=0
	out="$(cat "$W/dry.log")"
	{ [ -n "$(opkg_errors "$W/dry.log")" ] || grep -qiE "cannot satisfy|incompatible|cannot find dependency" "$W/dry.log"; } && rc=1
else
	out="$(apk add --simulate --allow-untrusted $FILES 2>&1)"; rc=$?
fi
if [ "$rc" != 0 ]; then
	echo "$out" | tail -n 8
	die "проверочная установка не прошла (зависимости?) — ничего не изменено"
fi
log "проверочная установка прошла"

# --- backup -------------------------------------------------------------------
ENABLED=0; nikki_enabled && ENABLED=1
ls -1 "$R"/etc/config/*-opkg "$R"/etc/config/*.apk-new 2>/dev/null > "$W/opkg-before"
: > "$W/old.list"
for p in $TODO; do pkg_files "$p" >> "$W/old.list"; done
{
	cat "$W/old.list"
	echo /etc/config/nikki
	if [ "$PM" = opkg ]; then
		echo /usr/lib/opkg/status
		for p in $TODO; do ls -1 "$R/usr/lib/opkg/info/$p."* 2>/dev/null | sed "s#^$R##"; done
	else
		ls -1d "$R/lib/apk/db/"* 2>/dev/null | sed "s#^$R##"
	fi
} | sort -u | while read -r f; do [ -e "$R$f" ] && echo "${f#/}"; done > "$W/backup.list"
tar -czf "$W/backup.tgz" -C "$R/" -T "$W/backup.list" 2>"$W/tar.err" || { cat "$W/tar.err"; die "не удалось сохранить текущий Nikki — обновление отменено"; }
log "текущий Nikki сохранён в памяти ($(( $(wc -c < "$W/backup.tgz") / 1024 )) КБ, $(wc -l < "$W/backup.list") файлов)"

rollback() {
	log "откатываю Nikki $CUR"
	"$INIT" stop >/dev/null 2>&1
	# files the new version added that the old one did not have
	: > "$W/new.list"; for p in $TODO; do pkg_files "$p" >> "$W/new.list"; done
	sort -u "$W/old.list" > "$W/a"; sort -u "$W/new.list" > "$W/b"
	if [ -s "$W/a" ]; then grep -vxF -f "$W/a" "$W/b"; else cat "$W/b"; fi | while read -r f; do [ -f "$R$f" ] && rm -f "$R$f"; done
	# new-default conffiles (*-opkg) this attempt left behind
	ls -1 "$R"/etc/config/*-opkg "$R"/etc/config/*.apk-new 2>/dev/null | grep -vxF -f "$W/opkg-before" | while read -r f; do rm -f "$f"; done
	if tar -xzf "$W/backup.tgz" -C "$R/"; then
		rm -f "$R"/tmp/luci-indexcache* "$R"/tmp/luci-modulecache/* 2>/dev/null
		[ -x "$R/etc/init.d/rpcd" ] && "$R/etc/init.d/rpcd" reload >/dev/null 2>&1
		if [ "$ENABLED" = 1 ]; then "$INIT" start >/dev/null 2>&1; wait_api 60 || log "ВНИМАНИЕ: Nikki $CUR восстановлен, но mihomo не ответил — проверьте Nikki"; fi
		log "прежний Nikki восстановлен: nikki $(iv nikki)"
	else
		log "ВНИМАНИЕ: не удалось распаковать копию — Nikki оставлен выключенным, интернет идёт напрямую"
	fi
}

# --- install --------------------------------------------------------------------
log "устанавливаю"
if [ "$PM" = opkg ]; then
	opkg install $FILES > "$W/install.log" 2>&1; rc=0
	{ [ -n "$(opkg_errors "$W/install.log")" ] || grep -qiE "cannot satisfy" "$W/install.log"; } && rc=1
	grep -q resolve_conffiles "$W/install.log" && log "ваши настройки сохранены; новые настройки по умолчанию лежат рядом (/etc/config/nikki-opkg)"
else
	apk add --allow-untrusted $FILES > "$W/install.log" 2>&1; rc=$?
fi
tail -n 6 "$W/install.log"
if [ "$rc" != 0 ] || [ "$(iv nikki)" != "$NEW" ]; then
	log "установка не удалась"
	rollback; cleanup; exit 1
fi
rm -f "$R"/tmp/luci-indexcache* "$R"/tmp/luci-modulecache/* 2>/dev/null
[ -x "$R/etc/init.d/rpcd" ] && "$R/etc/init.d/rpcd" reload >/dev/null 2>&1
sh -n "$INIT" 2>/dev/null || { log "новый скрипт запуска Nikki повреждён"; rollback; cleanup; exit 1; }
log "пакеты установлены: nikki $(iv nikki)"

if [ "$ENABLED" = 1 ]; then
	log "перезапускаю Nikki"
	"$INIT" restart >/dev/null 2>&1
	if ! wait_api 60; then
		log "mihomo не ответил за 60 секунд после обновления Nikki"
		rollback; cleanup; exit 1
	fi
	log "mihomo работает"
else
	log "Nikki выключен — новая версия будет использована при включении"
fi
cleanup
log "готово: Nikki $NEW (релиз ${TAG:-?})"
