PKG_NAME:=luci-app-webdavfs-mounts
PKG_VERSION:=0.2
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=Janlay Wu
PKG_ARCH:=all
LUCI_TITLE:=LuCI support for WebDAVFS mounts
LUCI_DEPENDS:=+curl
IPK_DEPENDS:=luci-base, curl

ifndef TOPDIR

.PHONY: all package clean

all: package

package:
	@PKG_NAME='$(PKG_NAME)' \
	PKG_VERSION='$(PKG_VERSION)' \
	PKG_RELEASE='$(PKG_RELEASE)' \
	PKG_LICENSE='$(PKG_LICENSE)' \
	PKG_MAINTAINER='$(PKG_MAINTAINER)' \
	PKG_ARCH='$(PKG_ARCH)' \
	PKG_DESCRIPTION='$(LUCI_TITLE)' \
	IPK_DEPENDS='$(IPK_DEPENDS)' \
	BUILD_DIR='$(CURDIR)/build' \
	./scripts/build-ipk.sh

clean:
	rm -rf build

else

include $(TOPDIR)/rules.mk
LUCI_PKGARCH:=$(PKG_ARCH)

define Package/luci-app-webdavfs-mounts/conffiles
/etc/config/webdav-mounts
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature

endif
