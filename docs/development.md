# Разработка

## Структура

```
configurator/            общий конфигуратор (index.html + js-yaml)
openwrt/nikki-fleet/     пакет: библиотека ops.uc, CLI/агент, служба, конфиг
openwrt/luci-app-nikki-fleet/  пакет LuCI: страницы, rpcd-плагин, ACL, меню, переводы
panel/                   панель на Go (без внешних зависимостей) + web/
scripts/sync-configurator.sh   копирует конфигуратор в panel/web и в пакет LuCI
```

После правки `configurator/index.html` запустите `./scripts/sync-configurator.sh` — CI проверяет, что копии совпадают.

## Панель

```sh
cd panel
go test ./...
go run . -listen 127.0.0.1:8080 -data /tmp/nf-data
```

## Код для роутера без роутера

`ops.uc` и CLI можно запускать на обычном Linux. Нужны `ucode` (собирается из https://github.com/jow-/ucode), `yq` и бинарник `mihomo`.

Переменные окружения:

- `NF_ROOT` — корень поддельной файловой системы (`$NF_ROOT/etc/nikki/...`, `$NF_ROOT/etc/init.d/nikki`, конфиги uci в `$NF_ROOT/etc/config`);
- `NF_MIHOMO` — путь к mihomo.

Модуль подключается по абсолютному пути `/usr/share/ucode/nikki_fleet/ops.uc`, поэтому для тестов сделайте ссылку:

```sh
sudo mkdir -p /usr/share/ucode
sudo ln -sfn "$PWD/openwrt/nikki-fleet/files/ucode/nikki_fleet" /usr/share/ucode/nikki_fleet
NF_ROOT=/tmp/nfroot NF_MIHOMO=/usr/local/bin/mihomo ucode openwrt/nikki-fleet/files/nikki-fleet status --full
```

В `/tmp/nfroot` нужны: профиль в `etc/nikki/profiles/`, скрипт-заглушка `etc/init.d/nikki` (копирует профиль в `etc/nikki/run/config.yaml` и перезапускает mihomo) и заглушка `uci` в `PATH`.

## Сборка пакетов

CI собирает `ipk` (24.10) и `apk` (25.12) через `openwrt/gh-action-sdk`. Локально — в OpenWrt SDK:

```sh
echo "src-link nikki_fleet $PWD/openwrt" >> feeds.conf
echo "src-git nikki https://github.com/nikkinikki-org/OpenWrt-nikki.git;main" >> feeds.conf
./scripts/feeds update -a && ./scripts/feeds install -a -p nikki_fleet
make package/nikki-fleet/compile package/luci-app-nikki-fleet/compile V=s
```

## Релиз

Измените версию в файле `VERSION` и закоммитьте в `main` (или запушьте тег `vX.Y.Z`) → GitHub Actions создаёт тег, собирает пакеты, бинарники панели (amd64, arm64, armv7), Docker-образ `ghcr.io/dontbass/nikki-fleet-panel` и публикует релиз. Перед тегом обновите `PKG_VERSION` в Makefile пакетов, `VERSION` в `ops.uc` и `version` в `panel/main.go`.
