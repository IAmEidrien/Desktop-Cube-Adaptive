<!-- SPDX-FileCopyrightText: Eidrien -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Desktop Cube Adaptive

Credit fork changes to Eidrien (GitHub: IAmEidrien). Preserve upstream authorship
and licenses. Do not use a ChatGPT profile name in files, commits or metadata.

Develop and publish candidates on `testing`; `main` is the release branch.
See TESTING-WORKFLOW.md. Never bypass a paused or failed promotion.

This is a real fork of Schneegans/Desktop-Cube, with upstream ancestry retained.
Merge upstream release tags into testing through a reviewed PR; do not copy a
new upstream tree over the fork. Preserve the Adaptive UUID, settings and policy.

Before changing Shell integration, inspect the relevant GNOME Shell/Mutter
source for the versions being targeted, plus the applicable V-Shell/Dash to Dock
code. Their private APIs and monkey-patches vary by version and activation order.

Spatial dragging must reuse the existing workspace actors and native DND targets.
Do not add workspace thumbnails or enable V-Shell thumbnails. Respect workspace
orientation and the effective per-monitor dock position, with a manual fallback.
Keep the feature optional. Restore adjustments, gestures, barriers, timers and
workspace tracking on drop, cancellation, overview exit and extension disable.

Run `python3 .github/scripts/validate.py` and the repository formatting/license
checks. For geometry, picking, gestures or DND changes, also test a real isolated
GNOME Shell with a real window and virtual pointer; method-level mocks alone are
insufficient. Cover GNOME 46 with V-Shell, thumbnails disabled, both workspace
axes and D2D-A, plus the available 48/50/51 environments. State any untested
versions, session types and hardware behavior accurately.

Keep direct Git/Gitpulsar installs usable: regenerate committed resources/locales
when their sources change and compile schemas when installing. Disable the old
Cube UUID before enabling the Adaptive UUID; the GSettings schema stays shared
to preserve existing preferences.
