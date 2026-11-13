# luci-app-temperature

Realtime temperature graphs for LuCI, under **Status → Realtime Graphs → Temperature**.

One card per hardware sensor, found automatically from `/sys/class/hwmon`:

- **SFP modules** (e.g. a PON / XGS-PON stick), labelled with the interface they sit in (`sfp-wan`, `sfp-lan`)
- **CPU** (limits taken from the thermal zone trip points)
- **Wi-Fi radios** (mt79xx)
- any other hwmon temperature sensor, plus fan PWM speed

Each card shows the current value, a 10-minute graph (kept in the browser while the tab is open),
min / avg / peak and the sensor's warning and critical limits. Styled only with theme colour tokens,
so it follows light/dark mode on any LuCI theme (built to the
[footstrap app styling guide](https://github.com/VizzleTF/luci-theme-footstrap/blob/main/docs/luci-app-styling-guide.md)).

Tested on a Banana Pi BPI-R4 running OpenWrt 25.12.6.

## Contents

| Path | Purpose |
|---|---|
| `htdocs/.../view/status/temperature.js` | the page |
| `root/usr/share/rpcd/ucode/luci.temperature` | ubus backend: `ubus call luci.temperature getSensors` |
| `root/usr/share/rpcd/acl.d/luci-app-temperature.json` | read-only ACL for that one method |
| `root/usr/share/luci/menu.d/luci-app-temperature.json` | adds the tab; does not touch the stock graphs |

## Package feed (apk, OpenWrt 25.12+)

Every push to `main` builds the package with the OpenWrt SDK and publishes a signed apk feed to
GitHub Pages: <https://yagop.github.io/openwrt-luci-stats/>

To use it on a router:

```sh
# trust the feed's signing key
wget -O /etc/apk/keys/luci-app-temperature-feed.pem \
  https://yagop.github.io/openwrt-luci-stats/luci-app-temperature-feed.pem

# add the feed
echo 'https://yagop.github.io/openwrt-luci-stats/packages.adb' \
  >> /etc/apk/repositories.d/customfeeds.list

apk update
apk add luci-app-temperature
```

The private signing key is stored only in the `PRIVATE_KEY` Actions secret.
