#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# nikki-fleet: replace the mihomo core with an official MetaCubeX release,
# safely on routers with little flash and RAM.
#
#   mihomo-update.sh <version|latest> [panel-url] [insecure]
#
# 1. The release is streamed through gunzip into RAM (/tmp); it must report the
#    expected version and accept the current config (mihomo -t). If RAM is short
#    while the old core runs, Nikki is stopped first (the core's memory is freed,
#    internet goes direct); if even that is not enough, the new core is written
#    straight over the old one on flash and checked there.
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
# /usr/bin/mihomo may be a symlink: replace the file it points to
[ -L "$BIN" ] && BIN="$(readlink -f "$BIN" 2>/dev/null || echo "$BIN")"
INIT="$R/etc/init.d/nikki"
RUN="$R/etc/nikki/run"
CLI="${NF_CLI:-nikki-fleet}"
W="${NF_WORK:-/tmp/nikki-fleet-mihomo}"
GH="${NF_GH:-https://github.com/MetaCubeX/mihomo}"

log() { echo "[$(date +%H:%M:%S)] $*"; }
cleanup() { rm -rf "$W"; }
STOPPED=0
die() {
	log "ОШИБКА: $*"
	cleanup
	[ "$STOPPED" = 1 ] && "$BIN" -v >/dev/null 2>&1 && { log "запускаю Nikki обратно"; "$INIT" start >/dev/null 2>&1; }
	exit 1
}
stop_nikki() {
	[ "$ENABLED" = 1 ] && [ "$STOPPED" = 0 ] || return 0
	log "останавливаю Nikki — интернет на это время идёт напрямую"
	"$INIT" stop >/dev/null 2>&1; STOPPED=1; sleep 2
}
mem_kb() { echo "${NF_MEM_KB:-$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)}"; }
# RAM held by the running core: freed when Nikki is stopped
core_rss_kb() {
	[ -n "${NF_RSS_KB:-}" ] && { echo "$NF_RSS_KB"; return; }
	t=0
	for pid in $(pidof mihomo 2>/dev/null); do
		r="$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status" 2>/dev/null)"; t=$((t + ${r:-0}))
	done
	echo "$t"
}
# file size in KB from the byte count: du reports 0 for a symlink and is not reliable on ubifs
kb() { b="$(wc -c < "$1" 2>/dev/null)"; echo $(( ${b:-0} / 1024 )); }
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

# probe_core <version>: size of the release .gz (GZ_KB) from GitHub or the panel's mirror
probe_core() {
	name="mihomo-linux-$ARCH-$1.gz"
	for url in "$GH/releases/download/$1/$name" ${PANEL:+"$PANEL/dl/mihomo/$1/$name"}; do
		GZ_KB="$($CURL -I "$url" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="content-length:" {n=$2} END {print int(n/1024)}')"
		[ "${GZ_KB:-0}" -gt 1024 ] && return 0
		log "недоступно: $url"
	done
	return 1
}

# fetch_core <version> <out-file>: GitHub first, then the panel's mirror; gunzip on the fly
fetch_core() {
	name="mihomo-linux-$ARCH-$1.gz"
	for url in "$GH/releases/download/$1/$name" ${PANEL:+"$PANEL/dl/mihomo/$1/$name"}; do
		log "загрузка $url"
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

MISSING=0
if [ ! -x "$BIN" ] || ! "$BIN" -v >/dev/null 2>&1; then
	[ -d "$(dirname "$BIN")" ] || die "нет каталога для $BIN"
	MISSING=1; log "ядра mihomo нет или оно повреждено — ставлю заново"
fi
ARCH="$(arch_asset)" || die "неизвестная архитектура роутера"
OLD_FULL="$("$BIN" -v 2>/dev/null | head -n1)"
OLD="$(echo "$OLD_FULL" | grep -o 'v[0-9][0-9.]*[0-9]' | head -n1)"
log "сейчас: ${OLD_FULL:-неизвестно} ($BIN, $(( $(kb "$BIN") / 1024 )) МБ)"
[ -n "$VER" ] && [ "$VER" != latest ] || VER="$(latest_version)"
case "$VER" in v[0-9]*) ;; *) die "не удалось узнать последнюю версию mihomo" ;; esac
[ "$MISSING" = 0 ] && [ "$VER" = "$OLD" ] && { log "уже установлена $VER — обновлять нечего"; exit 0; }
log "обновление: ${OLD:-?} → $VER ($ARCH)"

rm -rf "$W"; mkdir -p "$W" || die "нет места в /tmp"
OLD_KB="$(kb "$BIN")"; OLD_KB="${OLD_KB:-0}"
ENABLED=0; nikki_enabled && ENABLED=1
probe_core "$VER" || die "mihomo $VER недоступен ни на GitHub, ни через панель"
RAW_KB=$((GZ_KB * 29 / 10))
FS="${NF_OVERLAY_FS:-$(awk '$2 == "/overlay" {print $3; exit}' /proc/mounts 2>/dev/null)}"
FREE_KB="${NF_FREE_KB:-$(df -k "$(dirname "$BIN")" | awk 'NR==2 {print $4}')}"
# compressed filesystems keep a Go binary at roughly 45-50% of its size; keep a margin
flash_need() { case "$FS" in ubifs|jffs2) echo $(($1 * 52 / 100)) ;; *) echo "$1" ;; esac; }
OLD_FL="$(case "$FS" in ubifs|jffs2) echo $((OLD_KB * 42 / 100)) ;; *) echo "$OLD_KB" ;; esac)"
# a core that sits in the read-only firmware (/rom) frees nothing on the overlay when replaced
if [ -d "$R/overlay/upper" ] && [ "$MISSING" = 0 ] && [ ! -e "$R/overlay/upper${BIN#$R}" ]; then
	OLD_FL=0; log "текущее ядро встроено в прошивку — его замена место во флеше не освободит"
fi
NEW_FL="$(flash_need "$RAW_KB")"
[ $((FREE_KB + OLD_FL)) -ge $((NEW_FL + 1024)) ] || die "мало места во флеш-памяти: свободно $((FREE_KB / 1024)) МБ, новое ядро займёт около $((NEW_FL / 1024)) МБ (старое освободит около $((OLD_FL / 1024)) МБ)"

# RAM plan: the unpacked core is ~2.9x the .gz; while the old core runs, the config
# check (mihomo -t) also needs room, so keep a bigger margin then
MEM="$(mem_kb)"; RSS="$(core_rss_kb)"
log "релиз $((GZ_KB / 1024)) МБ (распакованный ~$((RAW_KB / 1024)) МБ), свободно RAM $((MEM / 1024)) МБ, ядро сейчас занимает $((RSS / 1024)) МБ"
if [ "$MEM" -ge $((RAW_KB + 40960)) ]; then
	PLAN=tmp
elif [ "$ENABLED" = 1 ] && [ $((MEM + RSS * 85 / 100)) -ge $((RAW_KB + 24576)) ]; then
	PLAN=tmp; stop_nikki
	log "память освобождена: $(( $(mem_kb) / 1024 )) МБ"
else
	PLAN=stream
fi

if [ "$PLAN" = tmp ]; then
	fetch_core "$VER" "$W/mihomo" || die "не удалось скачать mihomo $VER ни с GitHub, ни через панель"
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
	NEW_FL="$(flash_need "$NEW_KB")"
else
	# Too little RAM even with the core stopped: the new core is written straight to
	# flash and checked there; rollback is a re-download of the current version.
	[ -n "$OLD" ] || [ "$MISSING" = 1 ] || die "мало оперативной памяти ($((MEM / 1024)) МБ), а версия текущего ядра неизвестна — откатиться было бы нечем, обновление отменено"
	log "мало оперативной памяти даже без ядра — пишу новое ядро сразу во флеш${OLD:+, откат — повторной загрузкой $OLD}"
fi

# rollback copy of the current core: gzip in RAM if it fits, otherwise re-download later
BACKUP="${NF_BACKUP_TEST:-}"
if [ "$PLAN" = tmp ] && [ -z "$BACKUP" ] && [ "$(mem_kb)" -ge $((OLD_KB * 45 / 100 + 16384)) ]; then
	gzip -1 -c "$BIN" > "$W/old.gz" && BACKUP=ram || rm -f "$W/old.gz"
fi
[ -n "$BACKUP" ] || { [ -n "$OLD" ] && BACKUP=net; }
[ -n "$BACKUP" ] || { [ "$MISSING" = 1 ] && BACKUP=none; }
[ -n "$BACKUP" ] || die "нет способа откатиться (мало памяти и версия текущего ядра неизвестна) — обновление отменено"
case "$BACKUP" in ram) b="в памяти" ;; net) b="повторная загрузка $OLD при необходимости" ;; *) b="не нужна — прежнего ядра нет" ;; esac
log "резервная копия: $b"

if [ "$PLAN" = stream ]; then MODE=stream
elif [ "$FREE_KB" -ge $((NEW_FL + 2048)) ]; then MODE=rename
elif [ $((FREE_KB + OLD_FL)) -ge $((NEW_FL + 1024)) ]; then MODE=inplace
else die "мало места во флеш-памяти: свободно $((FREE_KB / 1024)) МБ, для замены нужно около $(((NEW_FL - OLD_FL + 1024) / 1024)) МБ"
fi
case "$MODE" in
	rename) m="рядом + переименование" ;; inplace) m="поверх старого, с короткой остановкой Nikki" ;; *) m="загрузка прямо на место старого" ;;
esac
log "флеш: свободно $((FREE_KB / 1024)) МБ (${FS:-?}), способ замены: $m"

# --- replacement -----------------------------------------------------------

restore() {
	log "восстанавливаю $OLD"
	[ "$ENABLED" = 1 ] && "$INIT" stop >/dev/null 2>&1
	rm -f "$BIN" "$BIN.new"
	if [ "$BACKUP" = ram ] && [ -f "$W/old.gz" ]; then
		gunzip -c "$W/old.gz" > "$BIN"
	elif [ "$BACKUP" = net ]; then
		fetch_core "$OLD" "$BIN"
	fi
	chmod 755 "$BIN" 2>/dev/null
	if ! "$BIN" -v >/dev/null 2>&1; then
		# never start Nikki without a working core: its firewall rules would cut the internet
		rm -f "$BIN"; "$INIT" stop >/dev/null 2>&1
		log "ВНИМАНИЕ: прежнее ядро восстановить не удалось. Nikki оставлен выключенным, интернет идёт напрямую."
		log "Повторите, когда будет связь: nikki-fleet mihomo-update — без ядра скрипт просто поставит его заново"
		return
	fi
	[ "$ENABLED" = 1 ] && "$INIT" start >/dev/null 2>&1
	if [ "$ENABLED" = 0 ] || wait_api "" 40; then
		log "прежнее ядро восстановлено"
	else
		log "ВНИМАНИЕ: прежнее ядро восстановлено, но mihomo не ответил — проверьте Nikki"
	fi
}

if [ "$MODE" = stream ]; then
	stop_nikki
	if ! fetch_core "$VER" "$BIN"; then log "загрузка прервалась"; restore; cleanup; exit 1; fi
	NEW_FULL="$("$BIN" -v 2>/dev/null | head -n1)"
	if ! echo "$NEW_FULL" | grep -q "$VER"; then log "новое ядро не запускается (${NEW_FULL:-нет вывода})"; restore; cleanup; exit 1; fi
	log "новое ядро: $NEW_FULL"
	if [ -f "$RUN/config.yaml" ] && ! "$BIN" -d "$RUN" -f "$RUN/config.yaml" -t >"$W/test.log" 2>&1; then
		tail -n 5 "$W/test.log"; log "новое ядро не принимает текущий конфиг"; restore; cleanup; exit 1
	fi
	[ -f "$RUN/config.yaml" ] && log "текущий конфиг проверен новым ядром"
elif [ "$MODE" = rename ]; then
	cp "$W/mihomo" "$BIN.new" && chmod 755 "$BIN.new" && mv -f "$BIN.new" "$BIN" || {
		rm -f "$BIN.new"; die "не удалось записать новое ядро (место?) — старое не тронуто"
	}
else
	stop_nikki
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
	if [ "$STOPPED" = 1 ]; then "$INIT" start >/dev/null 2>&1; else "$INIT" restart >/dev/null 2>&1; fi
	STOPPED=0
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
