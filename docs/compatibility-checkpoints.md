<!-- SPDX-FileCopyrightText: Eidrien -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Cube compatibility checkpoints

This candidate is incomplete and must remain paused with `do-not-merge`.
The existing seven-day promotion interval and current-head validation requirements
remain unchanged. README feature descriptions are human-maintained.

1. Lifecycle: inspect and validate extension ordering, override ownership,
   reconfiguration and teardown before introducing new behavior.
2. Workspace policy: use effective V-Shell preferences without modifying either
   extension's saved settings; validate runtime and preferences ownership.
3. Sticky presentation: restrict cube presentation to the active face without
   changing actual window stickiness; validate both Shell presentation paths.

Each implementation checkpoint requires a separate commit, automated regression
checks and native validation. Results and limitations will be recorded here.

## Checkpoint 1: lifecycle

Lifecycle assertions pass on GNOME 46.0 Wayland and X11, 48.7 Wayland,
50.1 headless Wayland, and 51.0 headless Wayland (two monitors), with V-Shell
51.4 (`4612cfc`). Each lifecycle run executes 121 assertions covering both enable
orders, repeated cycles, either disable order, both workspace axes, live rebuilds,
Overview/app-grid transitions, exact restoration of native methods, settings
signal cleanup and desktop transition completion after Cube disable. A final
46.0 Wayland rerun covers the final inherited-method and delegate-reference cleanup.
The existing 48-assertion real-pointer spatial suite additionally passes on 46.0
with D2D-A and V-Shell in both horizontal and vertical arrangements.

The upstream UUID guard only suppresses V-Shell's WorkspacesView overrides for
upstream Cube in a particular horizontal Overview mode. DC-A's separate identity
leaves those V-Shell methods active. The adapter composes with them rather than
spoofing an upstream installation or disabling V-Shell functionality.

The former startup-snapshot rebasing could restore a V-Shell delegate after its
owner had been torn down. The peer lifecycle adapter now suspends Cube patches
around peer rebuilds and teardown, then composes with the resulting methods.
Animation instance methods restore their original property descriptors so a
later prototype update remains effective. Cube settings handlers are explicitly
disconnected. An in-flight Shell transition retains its native completion callback;
Cube-specific transform hooks are released without cancelling the WM operation.

**Peer-only limitation:** native V-Shell-only controls on GNOME 46 and 51 reproduce
`ReferenceError: defaultGridModes is not defined` from V-Shell's iconGrid module
and GLib missing-handler warnings during repeated rebuilds. Cube was never enabled
in those controls. Combined runs pass their behavior assertions but do not have
clean peer logs. V-Shell source is unchanged; these errors remain unresolved
outside this repository. The candidate remains paused. Versions 45, 47 and 49
have source/API inspection only, not native verification. All runs use software
rendering; hardware gesture behavior is not established by virtual input.

Validation: `python3 .github/scripts/validate.py`, the spatial/peer lifecycle
regressions, clang-format 18 and REUSE lint pass. No resources or locales changed.
