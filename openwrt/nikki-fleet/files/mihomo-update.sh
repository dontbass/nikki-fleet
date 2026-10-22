#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# nikki-fleet: replace the mihomo core with an official MetaCubeX release,
# safely on routers with little flash and RAM.
#
#   mihomo-update.sh <version|latest> [panel-url] [insecure]
#
# 1. The release is streamed through gunzip into RAM (/tmp); it must report the
#    expected version and accept the current config (mihomo -t).
# 2. Plenty of flash: new file next to the old one + rename, no downtime.
#    Little flash: Nikki is stopped (traffic goes direct, internet stays up),
#    the old binary is overwritten in place, Nikki is started again.
# 3. If mihomo does not come up, the previous core is restored: from a gzip
#    copy in RAM when there is room, otherwise by downloading that version again.
# Only one copy of the core is ever on flash.

set -u
VER="${1:-}"
PANEL="${2:-}"
INSECURE="${3:-0}"
R="${NF_ROOT:-}"
BIN="${NF_MIHOMO_BIN:-$R/usr/bin/mihomo}"
INIT="$R/etc/init.d/nikki"
RUN="$R/etc/nikki/run"
CLI="${NF_CLI:-nikki-fleet}"
W="${NF_WORK:-/tmp/nikki-fleet-mihomo}"
GH="${NF_GH:-https://github.com/MetaCubeX/mihomo}"

log() { echo "[$(date +%H:%M:%S)] $*"; }
cleanup() { rm -rf "$W"; }
die() { log "ОШИБКА: $*"; cleanup; exit 1; }
kb() { du -k "$1" 2>/dev/null | awk '{print $1}'; }
CURL="curl -fsSL --connect-timeout 15 --retry 2"
[ "$INSECURE" = 1 ] && CURL="$CURL -k"

nikki_enabled() { [ "$(uci -q get nikki.config.enabled)" = 1 ]; }
api_version() { "$CLI" api GET /version 2>/dev/null | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -n1; }
wait_api() { # wait_api <version> <seconds>
	i=0
	while [ "$i" -lt "$2" ]; do
		v="$(api_version)"
		[ -n "$v" ] && { [ -z "$1" ] || [ "$v" = "$1" ]; } && return 0
		sleep 2; i=$((i + 2))
	done
	return 1
}

# mihomo release asset suffix for this router
arch_asset() {
	a="${NF_ARCH:-$(. "$R/etc/openwrt_release" 2>/dev/null; echo "${DISTRIB_ARCH:-}")}"
	[ -n "$a" ] || a="$(uname -m)"
	case "$a" in
		aarch64*|arm64*) echo arm64 ;;
		arm_cortex-a*|arm_*neon*|arm_*vfpv3*|armv7*) echo armv7 ;;
		arm_arm1176*|armv6*) echo armv6 ;;
		arm_*|armv5*) echo armv5 ;;
		x86_64*) echo amd64-compatible ;;
		i386*|i486*|i586*|i686*) echo 386 ;;
		mipsel_*|mipsle*) echo mipsle-softfloat ;;
		mips64el*) echo mips64le ;;
		mips64*) echo mips64 ;;
		mips_*|mips) echo mips-softfloat ;;
		riscv64*) echo riscv64 ;;
		loongarch64*) echo loong64-abi2 ;;
		*) return 1 ;;
	esac
}

# fetch_core <version> <out-file> [ram-check]: GitHub first, then the panel's mirror; gunzip on the fly.
# With ram-check the download size is probed first: the unpacked core is ~2.8x the .gz.
fetch_core() {
	name="mihomo-linux-$ARCH-$1.gz"
	[ -n "${3:-}" ] || GZ_KB=""
	for url in "$GH/releases/download/$1/$name" ${PANEL:+"$PANEL/dl/mihomo/$1/$name"}; do
		if [ -n "${3:-}" ]; then
			GZ_KB="$($CURL -I "$url" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="content-length:" {n=$2} END {print int(n/1024)}')"
			[ "${GZ_KB:-0}" -gt 1024 ] || { log "недоступно: $url"; continue; }
			mem="${NF_MEM_KB:-$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)}"
			need=$((GZ_KB * 29 / 10 + 16384))
			[ "$mem" -ge "$need" ] || die "мало оперативной памяти: ядро займёт около $((GZ_KB * 29 / 10240)) МБ в /tmp, свободно $((mem / 1024)) МБ"
		fi
		log "загрузка $url${GZ_KB:+ ($((GZ_KB / 1024)) МБ)}"
		rm -f "$2"
		# a failed or cut download leaves gunzip with a truncated stream, so its status is enough
		if $CURL "$url" | gunzip -c > "$2" && [ -s "$2" ]; then
			chmod 755 "$2"
			return 0
		fi
		log "не получилось"
	done
	rm -f "$2"
	return 1
}

latest_version() {
	v=""
	[ -n "$PANEL" ] && v="$($CURL "$PANEL/dl/mihomo/latest.json" 2>/dev/null | sed -n 's/.*"tag": *"\(v[0-9][^"]*\)".*/\1/p')"
	[ -n "$v" ] || v="$($CURL -o /dev/null -w '%{url_effective}' "$GH/releases/latest" 2>/dev/null | sed -n 's#.*/tag/\(v[0-9][^/]*\)$#\1#p')"
	echo "$v"
}

# --- preparation -----------------------------------------------------------

[ -x "$BIN" ] || die "не найден $BIN (mihomo из пакета Nikki)"
ARCH="$(arch_asset)" || die "неизвестная архитектура роутера"
OLD_FULL="$("$BIN" -v 2>/dev/null | head -n1)"
OLD="$(echo "$OLD_FULL" | grep -o 'v[0-9][0-9.]*[0-9]' | head -n1)"
log "сейчас: ${OLD_FULL:-неизвестно}"
[ -n "$VER" ] && [ "$VER" != latest ] || VER="$(latest_version)"
case "$VER" in v[0-9]*) ;; *) die "не удалось узнать последнюю версию mihomo" ;; esac
[ "$VER" = "$OLD" ] && { log "уже установлена $VER — обновлять нечего"; exit 0; }
log "обновление: ${OLD:-?} → $VER ($ARCH)"

rm -rf "$W"; mkdir -p "$W" || die "нет места в /tmp"
OLD_KB="$(kb "$BIN")"
fetch_core "$VER" "$W/mihomo" check || die "не удалось скачать mihomo $VER ни с GitHub, ни через панель"
NEW_KB="$(kb "$W/mihomo")"
NEW_FULL="$("$W/mihomo" -v 2>/dev/null | head -n1)"
echo "$NEW_FULL" | grep -q "$VER" || die "скачанный файл не запускается на этом роутере (${NEW_FULL:-нет вывода}) — архитектура $ARCH не подходит?"
log "новое ядро: $NEW_FULL"
if [ -f "$RUN/config.yaml" ]; then
	"$W/mihomo" -d "$RUN" -f "$RUN/config.yaml" -t >"$W/test.log" 2>&1 || {
		tail -n 5 "$W/test.log"
		die "новое ядро не принимает текущий конфиг — оставляю $OLD"
	}
	log "текущий конфиг проверен новым ядром"
fi

# rollback copy of the current core: gzip in RAM if it fits, otherwise re-download later
MEM_KB="${NF_MEM_KB:-$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)}"
BACKUP="${NF_BACKUP_TEST:-}"
if [ -z "$BACKUP" ] && [ "$MEM_KB" -ge $((OLD_KB * 45 / 100 + 16384)) ]; then
	gzip -1 -c "$BIN" > "$W/old.gz" && BACKUP=ram || rm -f "$W/old.gz"
fi
[ -n "$BACKUP" ] || { [ -n "$OLD" ] && BACKUP=net; }
[ -n "$BACKUP" ] || die "нет способа откатиться (мало памяти и версия текущего ядра неизвестна) — обновление отменено"
log "резервная копия: $([ "$BACKUP" = ram ] && echo "в памяти" || echo "повторная загрузка $OLD при необходимости")"

FS="${NF_OVERLAY_FS:-$(awk '$2 == "/overlay" {print $3; exit}' /proc/mounts 2>/dev/null)}"
FREE_KB="${NF_FREE_KB:-$(df -k "$(dirname "$BIN")" | awk 'NR==2 {print $4}')}"
# compressed filesystems keep a Go binary at roughly 45-50% of its size; keep a margin
case "$FS" in ubifs|jffs2) NEW_FL=$((NEW_KB * 52 / 100)); OLD_FL=$((OLD_KB * 42 / 100)) ;; *) NEW_FL=$NEW_KB; OLD_FL=$OLD_KB ;; esac
if [ "$FREE_KB" -ge $((NEW_FL + 2048)) ]; then
	MODE=rename
elif [ $((FREE_KB + OLD_FL)) -ge $((NEW_FL + 1024)) ]; then
	MODE=inplace
else
	die "мало места во флеш-памяти: свободно $((FREE_KB / 1024)) МБ, для замены нужно около $(((NEW_FL - OLD_FL + 1024) / 1024)) МБ"
fi
log "флеш: свободно $((FREE_KB / 1024)) МБ ($FS), способ замены: $([ $MODE = rename ] && echo "рядом + переименование" || echo "поверх старого, с короткой остановкой Nikki")"

# --- replacement -----------------------------------------------------------

ENABLED=0; nikki_enabled && ENABLED=1

restore() {
	log "восстанавливаю $OLD"
	[ "$ENABLED" = 1 ] && "$INIT" stop >/dev/null 2>&1
	rm -f "$BIN" "$BIN.new"
	if [ "$BACKUP" = ram ] && [ -f "$W/old.gz" ]; then
		gunzip -c "$W/old.gz" > "$BIN"
	else
		fetch_core "$OLD" "$BIN"
	fi
	chmod 755 "$BIN" 2>/dev/null
	[ "$ENABLED" = 1 ] && "$INIT" start >/dev/null 2>&1
	if "$BIN" -v >/dev/null 2>&1 && { [ "$ENABLED" = 0 ] || wait_api "" 40; }; then
		log "прежнее ядро восстановлено"
	else
		log "ВНИМАНИЕ: прежнее ядро восстановить не удалось — переустановите Nikki: wget -qO- ${PANEL:-<панель>}/install.sh | sh"
	fi
}

if [ "$MODE" = rename ]; then
	cp "$W/mihomo" "$BIN.new" && chmod 755 "$BIN.new" && mv -f "$BIN.new" "$BIN" || {
		rm -f "$BIN.new"; die "не удалось записать новое ядро (место?) — старое не тронуто"
	}
else
	[ "$ENABLED" = 1 ] && { log "останавливаю Nikki"; "$INIT" stop >/dev/null 2>&1; sleep 1; }
	if ! cp "$W/mihomo" "$BIN"; then
		log "запись не удалась"
		restore; cleanup; exit 1
	fi
	chmod 755 "$BIN"
fi
rm -f "$W/mihomo"
log "ядро записано"

if [ "$ENABLED" = 1 ]; then
	log "запускаю Nikki"
	if [ "$MODE" = rename ]; then "$INIT" restart >/dev/null 2>&1; else "$INIT" start >/dev/null 2>&1; fi
	if ! wait_api "$VER" 60; then
		log "mihomo $VER не ответил за 60 секунд"
		restore; cleanup; exit 1
	fi
	log "mihomo $(api_version) работает"
else
	log "Nikki выключен — новое ядро будет использовано при включении"
fi
cleanup
log "готово: mihomo $VER"
