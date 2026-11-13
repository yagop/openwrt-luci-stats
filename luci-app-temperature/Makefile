include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI realtime temperature graphs (CPU, SFP/PON, Wi-Fi)
LUCI_DEPENDS:=+luci-base +rpcd-mod-ucode
LUCI_PKGARCH:=all

PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
