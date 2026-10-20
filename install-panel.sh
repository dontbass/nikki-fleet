#!/usr/bin/env bash
# nikki-fleet panel installer for Ubuntu 24.04 / 26.04 (also Debian 12/13).
#
#   wget -qO- https://raw.githubusercontent.com/dontbass/nikki-fleet/main/install-panel.sh | sudo bash -s -- --domain fleet.example.com
#
# What it does:
#   - installs the latest panel binary from GitHub releases as a systemd service
#   - installs Caddy, which gets and renews a Let's Encrypt certificate for the domain
#   - opens ports 80/443 in ufw if ufw is active
# Run it again to update the panel. Options: --help
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

REPO="dontbass/nikki-fleet"
ROOT="${NF_TEST_ROOT:-}"            # tests only: write files under this prefix
BIN="$ROOT/usr/local/bin/nikki-fleet-panel"
ENVFILE="$ROOT/etc/nikki-fleet/panel.env"
UNIT="$ROOT/etc/systemd/system/nikki-fleet-panel.service"
CADDY_DIR="$ROOT/etc/caddy"
SITE_FILE="$CADDY_DIR/nikki-fleet.caddy"

DOMAIN=""
EMAIL=""
PORT="8080"
REGISTRATION=""
USE_CADDY=1
ASSUME_YES=0
ACTION="install"

c_blue=$'\033[1;34m'; c_red=$'\033[1;31m'; c_yel=$'\033[1;33m'; c_grn=$'\033[1;32m'; c_off=$'\033[0m'
say()  { printf '%s[nikki-fleet]%s %s\n' "$c_blue" "$c_off" "$*"; }
ok()   { printf '%s[nikki-fleet]%s %s\n' "$c_grn" "$c_off" "$*"; }
warn() { printf '%s[nikki-fleet]%s %s\n' "$c_yel" "$c_off" "$*" >&2; }
die()  { printf '%s[nikki-fleet]%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }

usage() {
	cat <<'EOF'
nikki-fleet panel installer

  sudo bash install-panel.sh --domain fleet.example.com [options]

Options:
  --domain NAME        domain of the panel; its DNS A/AAAA record must point to this server
  --email ADDRESS      e-mail for Let's Encrypt notices (optional)
  --open-registration  anyone can sign up and add their own routers (default: only the admin creates users)
  --port N             local port of the panel (default 8080)
  --no-caddy           do not install Caddy: use your own reverse proxy (Nginx Proxy Manager, Traefik, …)
                       and point it to http://127.0.0.1:PORT
  -y, --yes            do not ask questions
  --update             only update the panel binary and restart it
  --uninstall          remove the panel service and binary (data in /var/lib/nikki-fleet is kept)
  -h, --help           this help
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--domain) DOMAIN="${2:-}"; shift 2 ;;
		--domain=*) DOMAIN="${1#*=}"; shift ;;
		--email) EMAIL="${2:-}"; shift 2 ;;
		--email=*) EMAIL="${1#*=}"; shift ;;
		--port) PORT="${2:-}"; shift 2 ;;
		--port=*) PORT="${1#*=}"; shift ;;
		--open-registration) REGISTRATION="open"; shift ;;
		--no-caddy) USE_CADDY=0; shift ;;
		-y|--yes) ASSUME_YES=1; shift ;;
		--update) ACTION="update"; shift ;;
		--uninstall) ACTION="uninstall"; shift ;;
		-h|--help) usage; exit 0 ;;
		*) die "неизвестный параметр: $1 (см. --help)" ;;
	esac
done

# read an answer from the terminal even when the script itself comes from a pipe
ask() {
	local prompt="$1" def="${2:-}" ans=""
	if [ "$ASSUME_YES" = 1 ] || [ ! -r /dev/tty ]; then echo "$def"; return; fi
	printf '%s' "$prompt" > /dev/tty
	read -r ans < /dev/tty || true
	echo "${ans:-$def}"
}
confirm() {
	[ "$ASSUME_YES" = 1 ] && return 0
	local a; a="$(ask "$1 [y/N] " "n")"
	case "$a" in y|Y|yes|д|Д|да) return 0 ;; *) return 1 ;; esac
}

[ "$(id -u)" = 0 ] || [ -n "$ROOT" ] || die "запустите от root: ... | sudo bash -s -- --domain ваш-домен"

# ---------- system checks ----------
check_os() {
	[ -r /etc/os-release ] || die "не удалось определить ОС"
	# shellcheck disable=SC1091
	. /etc/os-release
	case "${ID:-}:${VERSION_ID:-}" in
		ubuntu:24.04|ubuntu:26.04) ;;
		ubuntu:*|debian:12|debian:13) warn "проверено на Ubuntu 24.04/26.04, у вас ${PRETTY_NAME:-$ID $VERSION_ID} — продолжаю" ;;
		*) die "поддерживаются Ubuntu 24.04/26.04 (и Debian 12/13), у вас ${PRETTY_NAME:-неизвестная ОС}" ;;
	esac
	command -v systemctl >/dev/null || die "нужен systemd"
}

detect_arch() {
	case "$(uname -m)" in
		x86_64|amd64) echo amd64 ;;
		aarch64|arm64) echo arm64 ;;
		armv7l|armv7) echo armv7 ;;
		*) die "архитектура $(uname -m) не поддерживается" ;;
	esac
}

apt_install() {
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq
	apt-get install -y -qq "$@" >/dev/null
}

public_ips() {
	{ curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null; echo; curl -6 -fsS --max-time 5 https://api6.ipify.org 2>/dev/null; echo; } | grep -v '^$' || true
}

check_dns() {
	local resolved mine
	resolved="$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true)"
	if [ -z "$resolved" ]; then
		warn "домен $DOMAIN пока не резолвится. Создайте A-запись на IP этого сервера и подождите несколько минут."
		confirm "Продолжить всё равно? Сертификат выпустится, когда DNS заработает" || die "остановлено"
		return
	fi
	mine="$(public_ips)"
	if [ -n "$mine" ] && ! grep -qxF -f <(echo "$mine") <(echo "$resolved"); then
		warn "$DOMAIN указывает на: $(echo "$resolved" | tr '\n' ' ')"
		warn "а у этого сервера адрес: $(echo "$mine" | tr '\n' ' ')"
		warn "Let's Encrypt не выдаст сертификат, пока A-запись не укажет на этот сервер."
		confirm "Продолжить всё равно?" || die "остановлено: исправьте DNS и запустите установку снова"
	else
		ok "DNS: $DOMAIN → $(echo "$resolved" | tr '\n' ' ')"
	fi
}

check_ports() {
	local busy
	busy="$(ss -Hltnp '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v caddy || true)"
	if [ -n "$busy" ]; then
		warn "порты 80/443 уже заняты:"
		echo "$busy" >&2
		die "освободите 80/443 или запустите с --no-caddy и проксируйте свой сервер на http://127.0.0.1:$PORT"
	fi
	if ss -Hltn "( sport = :$PORT )" 2>/dev/null | grep -q . && ! systemctl is-active -q nikki-fleet-panel 2>/dev/null; then
		die "порт $PORT занят другой программой — выберите другой: --port 8090"
	fi
}

# ---------- panel ----------
install_binary() {
	local arch url tag tmp
	arch="$(detect_arch)"
	say "ищу последний релиз $REPO"
	local json
	json="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")" || die "не удалось получить список релизов с GitHub"
	tag="$(echo "$json" | grep -m1 '"tag_name"' | cut -d'"' -f4)"
	url="$(echo "$json" | grep -o "\"browser_download_url\": *\"[^\"]*nikki-fleet-panel-linux-$arch\"" | cut -d'"' -f4)"
	[ -n "$url" ] || die "в релизе $tag нет сборки панели для $arch"
	tmp="$(mktemp)"
	say "скачиваю панель $tag ($arch)"
	curl -fsSL -o "$tmp" "$url" || die "не удалось скачать $url"
	chmod 0755 "$tmp"
	"$tmp" -version >/dev/null 2>&1 || die "скачанный файл не запускается"
	mkdir -p "$(dirname "$BIN")"
	mv -f "$tmp" "$BIN"
	ok "панель $tag установлена: $BIN"
}

write_env() {
	mkdir -p "$(dirname "$ENVFILE")"
	{
		echo "# nikki-fleet panel settings — after editing: systemctl restart nikki-fleet-panel"
		echo "NF_LISTEN=127.0.0.1:$PORT"
		echo "NF_DATA=/var/lib/nikki-fleet"
		echo "NF_PUBLIC_URL=https://$DOMAIN"
		echo "NF_TRUST_PROXY=1"
		[ -n "$REGISTRATION" ] && echo "NF_REGISTRATION=$REGISTRATION"
	} > "$ENVFILE"
	chmod 0640 "$ENVFILE"
}

write_unit() {
	mkdir -p "$(dirname "$UNIT")"
	cat > "$UNIT" <<'EOF'
[Unit]
Description=nikki-fleet panel
Documentation=https://github.com/dontbass/nikki-fleet
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/nikki-fleet/panel.env
ExecStart=/usr/local/bin/nikki-fleet-panel
DynamicUser=yes
StateDirectory=nikki-fleet
Restart=always
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=yes
MemoryDenyWriteExecute=yes

[Install]
WantedBy=multi-user.target
EOF
}

# ---------- Caddy ----------
install_caddy() {
	if command -v caddy >/dev/null 2>&1; then
		ok "Caddy уже установлен: $(caddy version 2>/dev/null | cut -d' ' -f1)"
		return
	fi
	say "устанавливаю Caddy (веб-сервер с автоматическим HTTPS)"
	apt_install debian-keyring debian-archive-keyring apt-transport-https gnupg
	if curl -fsSL --max-time 20 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null \
		&& curl -fsSL --max-time 20 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list; then
		apt_install caddy
	else
		warn "официальный репозиторий Caddy недоступен — ставлю Caddy из репозитория Ubuntu"
		rm -f /etc/apt/sources.list.d/caddy-stable.list
		apt_install caddy
	fi
	command -v caddy >/dev/null || die "Caddy не установился"
}

write_caddy() {
	mkdir -p "$CADDY_DIR"
	{
		echo "# nikki-fleet panel — managed by install-panel.sh"
		echo "$DOMAIN {"
		[ -n "$EMAIL" ] && echo "	tls $EMAIL"
		echo "	encode gzip"
		echo "	reverse_proxy 127.0.0.1:$PORT {"
		echo "		# routers keep a long-poll open; stream it without buffering"
		echo "		flush_interval -1"
		echo "	}"
		echo "}"
	} > "$SITE_FILE"

	local main="$CADDY_DIR/Caddyfile"
	if [ ! -s "$main" ] || grep -q "The Caddyfile is an easy way to configure your Caddy web server" "$main"; then
		# stock Caddyfile from the package: replace it (it serves a demo page on :80)
		[ -s "$main" ] && cp -f "$main" "$main.orig"
		printf '# Caddy configuration. Sites are in separate files.\nimport %s\n' "nikki-fleet.caddy" > "$main"
	elif ! grep -q "nikki-fleet.caddy" "$main"; then
		cp -f "$main" "$main.bak.$(date +%s)"
		printf '\nimport %s\n' "nikki-fleet.caddy" >> "$main"
	fi
	if [ -z "$ROOT" ]; then
		caddy validate --config "$main" --adapter caddyfile >/dev/null 2>&1 || {
			caddy validate --config "$main" --adapter caddyfile || true
			die "ошибка в конфигурации Caddy ($main)"
		}
	fi
}

open_firewall() {
	if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
		ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
		ok "ufw: открыты порты 80 и 443"
	fi
}

wait_https() {
	say "жду выпуска сертификата Let's Encrypt для $DOMAIN (обычно до минуты)"

	for _ in $(seq 1 "${NF_HTTPS_TRIES:-45}"); do
		if curl -fsS --max-time 5 "https://$DOMAIN/api/info" >/dev/null 2>&1; then
			ok "HTTPS работает: https://$DOMAIN"
			return 0
		fi
		sleep 4
	done
	warn "HTTPS пока не отвечает. Посмотрите журнал Caddy: journalctl -u caddy -n 50"
	warn "частые причины: A-запись домена не указывает на этот сервер, порты 80/443 закрыты у хостера"
	return 1
}

wait_local() {

	for _ in $(seq 1 20); do
		curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/info" >/dev/null 2>&1 && return 0
		sleep 1
	done
	journalctl -u nikki-fleet-panel -n 30 --no-pager >&2 || true
	die "панель не запустилась (журнал выше)"
}

# ---------- actions ----------
do_uninstall() {
	systemctl disable --now nikki-fleet-panel 2>/dev/null || true
	rm -f "$UNIT" "$BIN"
	systemctl daemon-reload || true
	if [ -f "$SITE_FILE" ]; then
		rm -f "$SITE_FILE"
		sed -i '/import nikki-fleet.caddy/d' "$CADDY_DIR/Caddyfile" 2>/dev/null || true
		systemctl reload caddy 2>/dev/null || true
	fi
	ok "панель удалена. Данные остались в /var/lib/private/nikki-fleet (удалите вручную, если не нужны)"
}

do_update() {
	[ -f "$UNIT" ] || die "панель не установлена — запустите без --update"
	install_binary
	systemctl restart nikki-fleet-panel
	PORT="$(grep -oP '^NF_LISTEN=.*:\K[0-9]+' "$ENVFILE" 2>/dev/null || echo "$PORT")"
	wait_local
	ok "панель обновлена и перезапущена"
}

do_install() {
	check_os
	if [ -z "$DOMAIN" ] && [ -f "$ENVFILE" ]; then
		DOMAIN="$(grep -oP '^NF_PUBLIC_URL=https://\K.*' "$ENVFILE" || true)"
	fi
	if [ -z "$DOMAIN" ]; then
		DOMAIN="$(ask "Домен панели (например, fleet.example.com): " "")"
	fi
	DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%%/*}"
	[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "укажите домен: --domain fleet.example.com"
	[[ "$PORT" =~ ^[0-9]+$ ]] || die "неверный порт: $PORT"
	if [ -z "$EMAIL" ] && [ "$USE_CADDY" = 1 ] && [ ! -f "$SITE_FILE" ]; then
		EMAIL="$(ask "E-mail для уведомлений Let's Encrypt (Enter — пропустить): " "")"
	fi
	[ -z "$EMAIL" ] || [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "неверный e-mail: $EMAIL"
	if [ -z "$REGISTRATION" ] && [ -f "$ENVFILE" ]; then
		REGISTRATION="$(grep -oP '^NF_REGISTRATION=\K.*' "$ENVFILE" || true)"
	fi

	say "устанавливаю зависимости"
	apt_install curl ca-certificates iproute2

	if [ "$USE_CADDY" = 1 ]; then
		check_dns
		check_ports
	fi

	install_binary
	write_env
	write_unit
	systemctl daemon-reload
	systemctl enable --now nikki-fleet-panel >/dev/null 2>&1
	systemctl restart nikki-fleet-panel
	wait_local
	ok "служба nikki-fleet-panel запущена на 127.0.0.1:$PORT"

	if [ "$USE_CADDY" = 1 ]; then
		install_caddy
		write_caddy
		systemctl enable caddy >/dev/null 2>&1 || true
		systemctl reload-or-restart caddy
		open_firewall
		wait_https || true
	else
		warn "Caddy не ставился: настройте свой обратный прокси на http://127.0.0.1:$PORT для https://$DOMAIN"
	fi

	echo
	ok "Готово!"
	echo "  Панель:        https://$DOMAIN"
	echo "  Первый шаг:    откройте адрес и создайте учётную запись — она станет администратором"
	echo "  Роутеры:       «Подключить роутер» в панели → команда для SSH на роутере"
	echo "  Обновить:      wget -qO- https://raw.githubusercontent.com/$REPO/main/install-panel.sh | sudo bash -s -- --update"
	echo "  Настройки:     /etc/nikki-fleet/panel.env, затем systemctl restart nikki-fleet-panel"
	echo "  Журнал:        journalctl -u nikki-fleet-panel -f"
	echo "  Резервная копия данных: /var/lib/private/nikki-fleet"
}

case "$ACTION" in
	install) do_install ;;
	update) do_update ;;
	uninstall) do_uninstall ;;
esac
