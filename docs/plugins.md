# Plugins

Settings has a Plugins page. Its first integration is
[kebacc-switcher](https://github.com/kebab1337420/kebacc-switch), pinned to 2.0.1.
Install downloads the native release binary into `<dataDir>/plugins/kebacc-switcher`
and verifies its SHA-256 before making it available. Downloads can be cancelled.
Uninstall removes the managed binary and keeps the external account pools.

The plugin lists Claude, Codex and Antigravity pools. Save current login, switch
and forget call the CLI through the core process registry. These pools belong to
the external CLIs, not to Boite's isolated accounts. Switching a default login is
refused while a turn using it is running or queued; a warm driver is released
before the switch. New turns wait while the account operation is in progress.

Pool quotas show the percentages returned by the CLI. Its JSON has no reset date
per window, so the UI does not display one. Operations report failures without
forwarding arbitrary CLI output to the client.

This is a built-in integration with a managed executable, not an arbitrary plugin
loader. Set `BOITE_E2E_KEBACC_INSTALL=1` to verify the real download and uninstall
in a temporary data directory without reading or changing a login.
