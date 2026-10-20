# SPDX-License-Identifier: GPL-3.0-or-later
include $(TOPDIR)/rules.mk

PKG_VERSION:=0.1.3
PKG_RELEASE:=1
PKG_LICENSE:=GPL-3.0-or-later
PKG_MAINTAINER:=dontbass <https://github.com/dontbass>

LUCI_TITLE:=LuCI configurator and remote management for Nikki
LUCI_DEPENDS:=+luci-base
# runtime-only, so the SDK does not build nikki/mihomo for a script package
LUCI_EXTRA_DEPENDS:=luci-app-nikki (>=0), nikki-fleet (>=0.1.3)
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
