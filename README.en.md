# nikki-fleet

**Remote management for OpenWrt routers running [Nikki](https://github.com/nikkinikki-org/OpenWrt-nikki) + mihomo.**
A visual configurator inside LuCI and a web panel that routers connect to on their own — no public IP or port forwarding needed.

- **Configurator** (LuCI, panel, or a standalone HTML file): subscriptions with device headers and live node preview, drag-and-drop rules and rule-providers, per-device rules by IP, proxy groups, “where will this domain go” tester. Works on phones.
- **Safe saving**: every change is validated with `mihomo -t`, backed up (last 10 versions), applied by restarting Nikki, and **rolled back automatically** if mihomo does not come up — or if, after a remote change, the router cannot reach the panel for 3 minutes.
- **Panel**: fleet overview (model, OpenWrt, versions, uptime, traffic, subscription quota), per-router configurator, version history with rollback, backups, logs, sharing (owner / editor / viewer), audit log. Multi-tenant: each user sees only their own routers and those shared with them.

The router agent keeps an outbound HTTPS long-poll to the panel and executes a fixed whitelist of commands only.

Supported: OpenWrt 24.10 (opkg) and 25.12 (apk); packages are architecture-independent.

Quick start: run the panel with `panel/docker-compose.yml` behind an HTTPS reverse proxy, open it, create the admin account, press “Connect router” and run the shown command on the router.

See [docs/architecture.md](docs/architecture.md) (Russian) for the protocol and security model, and [docs/development.md](docs/development.md) for development.

License: GPL-3.0-or-later.
