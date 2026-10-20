# SPDX-License-Identifier: GPL-3.0-or-later
include $(TOPDIR)/rules.mk

PKG_VERSION:=0.1.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-3.0-or-later
PKG_MAINTAINER:=dontbass <https://github.com/dontbass>

LUCI_TITLE:=LuCI configurator and remote management for Nikki
LUCI_DEPENDS:=+luci-base +luci-app-nikki +nikki-fleet
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
