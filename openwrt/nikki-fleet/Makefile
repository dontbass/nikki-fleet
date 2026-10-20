# SPDX-License-Identifier: GPL-3.0-or-later
include $(TOPDIR)/rules.mk

PKG_NAME:=nikki-fleet
PKG_VERSION:=0.1.7
PKG_RELEASE:=1

PKG_LICENSE:=GPL-3.0-or-later
PKG_MAINTAINER:=dontbass <https://github.com/dontbass>

include $(INCLUDE_DIR)/package.mk

define Package/nikki-fleet
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Remote management agent and safe config tools for Nikki
  URL:=https://github.com/dontbass/nikki-fleet
  PKGARCH:=all
endef

# Runtime-only dependencies: these are scripts, so the SDK does not need to
# compile nikki/mihomo/yq just to package them (keeps CI builds fast).
EXTRA_DEPENDS:=nikki (>=0), ucode (>=0), ucode-mod-fs (>=0), curl (>=0), yq (>=0)

define Package/nikki-fleet/description
  CLI and agent for Nikki (mihomo on OpenWrt): safe profile editing with
  mihomo -t validation, backups and automatic rollback, and an outbound
  agent that connects the router to a nikki-fleet panel for remote management.
endef

define Package/nikki-fleet/conffiles
/etc/config/nikki-fleet
endef

define Build/Compile
endef

define Package/nikki-fleet/install
	$(INSTALL_DIR) $(1)/usr/bin $(1)/usr/share/ucode/nikki_fleet $(1)/etc/init.d $(1)/etc/config
	$(INSTALL_BIN) ./files/nikki-fleet $(1)/usr/bin/nikki-fleet
	$(INSTALL_DATA) ./files/ucode/nikki_fleet/ops.uc $(1)/usr/share/ucode/nikki_fleet/ops.uc
	$(INSTALL_BIN) ./files/nikki-fleet.init $(1)/etc/init.d/nikki-fleet
	$(INSTALL_CONF) ./files/nikki-fleet.conf $(1)/etc/config/nikki-fleet
endef

define Package/nikki-fleet/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/nikki-fleet restart >/dev/null 2>&1
exit 0
endef

define Package/nikki-fleet/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || { /etc/init.d/nikki-fleet stop; /etc/init.d/nikki-fleet disable; } >/dev/null 2>&1
exit 0
endef

$(eval $(call BuildPackage,nikki-fleet))
