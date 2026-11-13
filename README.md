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

Tested on a Banana Pi BPI-R4 running OpenWrt 25.12.6. Requires OpenWrt 25.12 or later (apk).

## Installing openwrt-luci-stats

One line, either release line:

```sh
wget -qO- https://yagop.github.io/openwrt-luci-stats/subscribe.sh | sh
```

Read it first if you would rather: it is fetched, then run as root.

Or by hand, on OpenWrt 25.12 and later:

```sh
# HTTPS needs these. Stock images have them; custom builds may not.
apk add ca-bundle libustream-mbedtls

wget https://yagop.github.io/openwrt-luci-stats/yagop.pem -O /etc/apk/keys/yagop.pem
echo "https://yagop.github.io/openwrt-luci-stats/releases/25.12/$(cat /etc/apk/arch)/packages.adb" > /etc/apk/repositories.d/yagop.list

# Keep the key and the repository across a firmware upgrade.
mkdir -p /lib/upgrade/keep.d
printf '%s\n' /etc/apk/keys/yagop.pem /etc/apk/repositories.d/yagop.list > /lib/upgrade/keep.d/yagop

apk update && apk add luci-app-temperature
```

> **Do not install the .apk file directly.** `apk add ./luci-app-temperature-*.apk` writes a pin on the package's content hash into `/etc/apk/world`, and that file survives sysupgrade. The package would then never be upgraded from this feed again. Add the repository and install by name.

> **Attended Sysupgrade will not carry these packages across.** `owut` forwards no custom repositories, and the sysupgrade server's `repository_allow_list` is empty by default, which denies everything. Either exclude these packages from the `owut` run and reinstall them afterwards, or use an ordinary `sysupgrade`, which keeps the key and the repository through the `/lib/upgrade/keep.d` entry above.

> **Installing the key trusts this feed for every package name.** A key in `/etc/apk/keys` validates an index claiming any package name at all, so this feed could offer a higher version of a base package and win. Install it because you trust whoever publishes it, not because a page told you to.

## Layout

`luci-app-temperature/root/` is the package payload, laid out exactly as it installs:

| Path | Purpose |
|---|---|
| `www/luci-static/resources/view/status/temperature.js` | the page |
| `usr/share/rpcd/ucode/luci.temperature` | ubus backend: `ubus call luci.temperature getSensors` |
| `usr/share/rpcd/acl.d/luci-app-temperature.json` | read-only ACL for that one method |
| `usr/share/luci/menu.d/luci-app-temperature.json` | adds the tab; does not touch the stock graphs |
| `etc/uci-defaults/40_luci-app-temperature` | on install/upgrade: clear LuCI's menu cache, reload rpcd |

`luci-app-temperature/scripts/post-deinstall` does the same cleanup after removal.

## Releasing

The feed is built by [owfeed](https://github.com/owfeed/owfeed) (`owfeed.yml`, `owfeed.lock`) and
published to GitHub Pages on every push to `main`; pull requests run the same pipeline on throwaway
keys. **Bump `version:` in `owfeed.yml` on every change**: apk only upgrades to a higher version.

Check locally before pushing:

```sh
owfeed check    # build, sign, index and doctor on throwaway keys
```

The signing key lives only in the `OWFEED_SIGN_KEY` repository secret; the workflow passes it to
owfeed's publish job, which runs in the `feed` environment (deployable from `main` only).
