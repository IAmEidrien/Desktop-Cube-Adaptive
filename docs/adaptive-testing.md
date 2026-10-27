<!-- SPDX-FileCopyrightText: Eidrien -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Adaptive compatibility testing

Candidate: 35-adaptive1, tested October 27, 2026. These are isolated software-rendered
GNOME sessions with real GTK windows and virtual pointer input, not Eidrien's
physical desktop. Compatibility does not imply full support; Eidrien personally
uses GNOME 46.

| Shell | Session | Result |
| --- | --- | --- |
| 46.0 (Mutter 46.2) | Wayland | Pass, stock and V-Shell 51.3 with D2D-A |
| 46.0 (Mutter 46.2) | Xorg | Pass, stock |
| 48.7 | Wayland | Pass, stock |
| 50.1 | Wayland | Pass, stock |
| 51.0 | Wayland | Pass, stock, including two virtual monitors |

The GNOME 46 V-Shell runs cover both vertical and horizontal layouts, with
workspace thumbnails disabled (positions 4 and 9). They check effective D2D-A
placement on all four sides, reuse of existing workspace actors, edge dwell and
cancellation, native distant drops, a real pointer drag/drop across four
workspaces, app-grid isolation, disable/re-enable and restoration of fit state.
The vertical combination also passes dynamic-workspace collection pause/resume
and a distant drop while collection is paused. The two-monitor GNOME 51 run
checks secondary-view fit bounds and a native drop changing monitor and workspace.

The metadata's GNOME 45–51 range follows upstream 35. Versions 45, 47 and 49 were
not executed in this round; compatibility there is inherited/inferred. Xorg on
48, peer-extension combinations on newer Shells, physical mixed-DPI/GPU setups,
touch input and long-running suspend/resume behavior remain unverified. The
upstream multi-monitor X11 projection limitation remains.

One stress-test issue remains: repeatedly rebuilding the dock on all four sides
while the Overview stays open sometimes leaves the Cube/V-Shell window layout
with invalid allocations. Edge detection still follows the effective dock side;
the normal drag runs pass before this repeated reconfiguration. A follow-up run
with Cube disabled had finite window geometry. The exact interaction is not yet
isolated, so this candidate should also be checked when changing dock placement
on the real desktop. This is not counted as a clean pass for that stress case.

## Reproducing native checks

Use a disposable GNOME environment with GJS/GTK4, Xvfb, D-Bus and GLib tools.
Build `make zip` first. The harness isolates settings, extensions, clients and
logs under a new output directory and cleans up its compositor afterward:

```bash
python3 tests/native/run.py --version 46 --output /tmp/cube-46-test \
  --vshell /path/to/vertical-workspaces --dock /path/to/dash-to-dock-adaptive
```

Add `--axis horizontal` for the other workspace axis. Omit the peer arguments
for stock Shell; use `--xorg` for the X11 fallback. GNOME 50+ uses the headless
backend and accepts `--monitors 2`. Run each version in its own matching runtime.
Do not run against an existing desktop session. `result.json`, `progress.json`
and `shell.log` contain the results and diagnostics. Missing system services in
minimal sessions generate unrelated log warnings; passing assertions alone do
not establish that every warning is harmless on a full desktop.

The preferences smoke test uses real GTK/libadwaita widgets, resources and
bindings, with the extension registration supplied by the harness:

```bash
GSETTINGS_BACKEND=memory dbus-run-session -- xvfb-run -a \
  gjs -m tests/native/prefs.js "$PWD"
```

GNOME's private Shew typelib/library directories may need adding to
`GI_TYPELIB_PATH` and `LD_LIBRARY_PATH` in minimal environments.

Static/schema checks, policy/lifecycle regressions, promotion-controller tests,
ZIP packaging, clang-format and REUSE license checks complement the native runs.
GitHub CI performs the static/package checks; it does not run a GNOME compositor.
