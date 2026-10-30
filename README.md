<!--
SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
SPDX-FileCopyrightText: Eidrien
SPDX-License-Identifier: CC-BY-4.0
-->

# Desktop Cube Adaptive

Eidrien's adaptive desktop fork of [Desktop Cube by Simon Schneegans](https://github.com/Schneegans/Desktop-Cube).
Upstream history, authorship, translations and licenses are retained. This is a
separate extension, with UUID `desktop-cube-adaptive@eidrien.local`.

The fork preserves the previous V-Shell compatibility work: horizontal carousel
input in the Overview, workspace-axis-aware desktop navigation, optional looping,
optional hiding of the trailing empty workspace and wallpaper, and native desktop
workspace animation by default.

## Spatial window dragging

Enable **Spatial window dragging** on the **Overview** preferences page. While
dragging an Overview window, pause at the monitor edge opposite the dock. The
existing workspace faces unfold into GNOME/V-Shell's fit-all arrangement; drop
onto a distant workspace using its normal native drop target. Drop, cancellation,
Overview exit or extension disable restores Cube.

This uses the actual workspaces, with no added thumbnail strip. V-Shell's
thumbnail visibility preference is preserved. Horizontal and vertical workspace
layouts are supported. Effective per-monitor Dash to Dock Adaptive, Dash to Dock
or Ubuntu Dock placement is preferred over saved settings. The mapped native
dash is a fallback. Disable automatic edge selection to choose an edge manually;
that choice also supplies the fallback when a dock cannot be located. The dwell
delay is configurable, and the feature defaults off.

## Installation and migration

Use `testing` to try candidates, or `main` for promoted changes. Do not enable
Adaptive and the upstream/old private Cube simultaneously.

```bash
gnome-extensions disable desktop-cube@schneegans.github.com
git clone --branch testing https://github.com/IAmEidrien/Desktop-Cube-Adaptive.git \
  ~/.local/share/gnome-shell/extensions/desktop-cube-adaptive@eidrien.local
glib-compile-schemas ~/.local/share/gnome-shell/extensions/desktop-cube-adaptive@eidrien.local/schemas
```

Log out and back in, then enable **Desktop Cube Adaptive** in Extensions.
The schema/path stays `org.gnome.shell.extensions.desktop-cube`, so existing
Cube preferences are reused. Gitpulsar should track this new repository and UUID
directory; an old private snapshot checkout has different ancestry and should
not be pulled over the new fork.

Runtime resources and translations are included for direct Git installs.
Development/ZIP builds require Make, gettext, GLib development tools and zip:

```bash
make zip
gnome-extensions install --force desktop-cube-adaptive@eidrien.local.zip
```

## Testing and upstream updates

See [compatibility results](docs/adaptive-testing.md) for the tested environments
and limits. Compatibility is not a promise of full support on every combination;
Eidrien's own desktop remains GNOME 46.

Development stays on `testing`. [Promotion policy](TESTING-WORKFLOW.md) describes
the 72-hour quiet period, CI gates and `do-not-merge` pause label. The default
branch contains the trusted automation; feature candidates are first published
to testing.

A weekly/manual **Propose upstream updates** workflow checks the latest upstream
release tag, merges it into a candidate based on testing, validates it and opens
a review PR. It preserves the Adaptive metadata and stops on other conflicts.
It does not automatically merge upstream changes. Enable Actions and GitHub's
**Allow GitHub Actions to create and approve pull requests** repository option
for the proposal and promotion workflows.

Please report fork-specific issues [here](https://github.com/IAmEidrien/Desktop-Cube-Adaptive/issues).
Upstream documentation and changelogs remain under `docs/`; some describe the
original extension rather than Adaptive's defaults. The upstream multi-monitor
X11 projection limitation still applies. Upstream donations support
[Simon Schneegans](https://github.com/sponsors/Schneegans).
