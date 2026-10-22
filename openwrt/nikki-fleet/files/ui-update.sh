#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# nikki-fleet: install or update the zashboard web UI served by mihomo
# (external-ui), safely on routers with little flash.
#
#   ui-update.sh [panel-url] [insecure]
#
# The panel mirrors the latest zashboard release as a .tar.gz (busybox has tar
# but often no unzip). Without a panel, the GitHub .zip is used if unzip exists.
# The new UI is unpacked in RAM and checked; then it either goes next to the old
# one and is swapped, or — with little flash — replaces it, with the old UI kept
# in RAM to restore on failure.

set -u
PANEL="${1:-}"
INSECURE="${2:-0}"
R="${NF_ROOT:-}"
RUN="$R/etc/nikki/run"
W="${NF_WORK:-/tmp/nikki-fleet-ui}"
GH="${NF_ZGH:-https://github.com/Zephyruso/zashboard}"
ASSET="dist-no-fonts.zip"   # system fonts: smallest build, no font CDN needed

log() { echo "[$(date +%H:%M:%S)] $*"; }
cleanup() { rm -rf "$W"; }
die() { log "ОШИБКА: $*"; cleanup; exit 1; }
kb() { du -sk "$1" 2>/dev/null | awk '{print $1}'; }
CURL="curl -fsSL --connect-timeout 15 --retry 2"
[ "$INSECURE" = 1 ] && CURL="$CURL -k"

# external-ui from the running config, relative to Nikki's run directory
UI="$(sed -n 's/^external-ui:[ \t]*["'"'"']\{0,1\}\([^"'"'"' \t#]*\).*/\1/p' "$RUN/config.yaml" 2>/dev/null | head -n1)"
[ -n "$UI" ] || UI="$(uci -q get nikki.mixin.ui_path)"
[ -n "$UI" ] || die "в конфиге mihomo не задан external-ui (Nikki → Mixin → путь к UI)"
case "$UI" in /*) DIR="$R$UI" ;; *) DIR="$RUN/${UI#./}" ;; esac
case "$DIR" in "$RUN"/*|"$R"/etc/nikki/*) ;; *) die "необычный путь UI: $DIR — не трогаю" ;; esac
log "каталог UI: $DIR"

rm -rf "$W"; mkdir -p "$W/new" || die "нет места в /tmp"
TAG=""
if [ -n "$PANEL" ] && $CURL -o "$W/ui.tgz" "$PANEL/dl/zashboard/dist.tar.gz"; then
	TAG="$($CURL "$PANEL/dl/zashboard/latest.json" 2>/dev/null | sed -n 's/.*"tag": *"\([^"]*\)".*/\1/p')"
	tar -xzf "$W/ui.tgz" -C "$W/new" || die "архив повреждён"
	rm -f "$W/ui.tgz"
elif command -v unzip >/dev/null 2>&1 && $CURL -o "$W/ui.zip" "$GH/releases/latest/download/$ASSET"; then
	TAG="$($CURL -o /dev/null -w '%{url_effective}' "$GH/releases/latest" 2>/dev/null | sed -n 's#.*/tag/\([^/]*\)$#\1#p')"
	unzip -q "$W/ui.zip" -d "$W/z" || die "архив повреждён"
	rm -f "$W/ui.zip"
	if [ -d "$W/z/dist" ]; then mv "$W/z/dist"/* "$W/new"/; else mv "$W/z"/* "$W/new"/; fi
else
	die "не удалось скачать zashboard ни через панель, ни с GitHub"
fi
[ -f "$W/new/index.html" ] || die "в архиве нет index.html"
echo "${TAG:-unknown}" > "$W/new/.zashboard-version"
OLDV="$(cat "$DIR/.zashboard-version" 2>/dev/null)"
[ -n "$TAG" ] && [ "$TAG" = "$OLDV" ] && { log "уже установлена zashboard $TAG"; cleanup; exit 0; }
NEW_KB="$(kb "$W/new")"; OLD_KB=0; [ -d "$DIR" ] && OLD_KB="$(kb "$DIR")"
FREE_KB="${NF_FREE_KB:-$(df -k "$(dirname "$DIR")" | awk 'NR==2 {print $4}')}"
log "zashboard ${OLDV:-?} → ${TAG:-?}: $((NEW_KB / 1024)) МБ, свободно $((FREE_KB / 1024)) МБ"

if [ "$FREE_KB" -ge $((NEW_KB + 1024)) ]; then
	rm -rf "$DIR.new"
	cp -a "$W/new" "$DIR.new" || { rm -rf "$DIR.new"; die "не удалось записать (место?) — старый UI не тронут"; }
	rm -rf "$DIR.old"; [ -d "$DIR" ] && mv "$DIR" "$DIR.old"
	mv "$DIR.new" "$DIR" && rm -rf "$DIR.old" || { rm -rf "$DIR"; mv "$DIR.old" "$DIR"; die "не удалось переключить каталоги"; }
elif [ $((FREE_KB + OLD_KB)) -ge $((NEW_KB + 512)) ]; then
	[ -d "$DIR" ] && { tar -czf "$W/old.tgz" -C "$DIR" . || die "не удалось сохранить старый UI в памяти"; }
	rm -rf "$DIR"; mkdir -p "$DIR"
	if ! cp -a "$W/new/." "$DIR/"; then
		log "запись не удалась — возвращаю прежний UI"
		rm -rf "$DIR"; mkdir -p "$DIR"; [ -f "$W/old.tgz" ] && tar -xzf "$W/old.tgz" -C "$DIR"
		die "мало места во флеш-памяти"
	fi
else
	die "мало места во флеш-памяти: нужно около $(((NEW_KB - OLD_KB) / 1024 + 1)) МБ"
fi
cleanup
log "готово: zashboard ${TAG:-} — откройте http://<роутер>:9090/ui/"
