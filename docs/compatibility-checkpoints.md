<!-- SPDX-FileCopyrightText: Eidrien -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Cube compatibility checkpoints

This candidate must remain paused with `do-not-merge` pending maintainer documentation
review and the peer limitations recorded below.
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

## Checkpoint 2: effective workspace policy

The two confirmed equivalent workspace preferences now have runtime ownership:
V-Shell's `ws-switcher-ignore-last` and `ws-switcher-wraparound` govern the
Cube equivalents while V-Shell is active. DC-A retains its own saved values.
There are no synchronization, migration or reset writes. Dynamic workspace
exclusion still affects cube geometry; static workspaces remain present.
Disabled looping clamps wrapped neighbors even during V-Shell's delayed option
cache refresh. The effective loop state also controls closed-loop face geometry.

Preferences query the actual Shell extension state over the public Extensions
D-Bus interface, including name-owner changes and already-open windows. They
hide both locally owned rows during peer ownership and derive gap sensitivity
from the effective wrap value. Local and system schema lookup follow GNOME's
extension settings lookup rules. Pending calls and peer signals are cancelled
on close. A missing V-Shell installation or absent Shell bus leaves standalone
preferences usable.

Native checkpoint tests pass on 46.0 Wayland (19 checks, including immediate
neighbor clamping), 46.0 X11, 48.7 Wayland, 50.1 Wayland and 51.0 Wayland/two
monitors (18 checks each). These runs launch the actual preferences process on
the same isolated session bus and check live visibility, gap sensitivity,
geometry policy, dynamic/static workspaces and preserved saved values. The
fixture waits for V-Shell's initial delayed profile transaction before making
its own explicit test writes. This avoids confusing peer initialization with
an integration write. Automated tests, formatting and REUSE checks pass.
System-prefix schema fallback is source-reviewed; native peer installs use
local compiled schemas. Peer-only limitations from checkpoint 1 still apply.

No further settings were consolidated. Cube desktop animation versus V-Shell
animation controls, horizontal carousel input versus workspace orientation,
workspace backgrounds versus per-face opacity/perspective, and spatial dragging
versus edge switching have distinct scopes. Their independent controls remain.

Downstream callers must use effective runtime policy rather than infer it from
the local saved GSettings key. In particular `_shouldHideEmptyWorkspace()`
includes policy ownership and the dynamic-workspace condition. Consumers reading
only the saved flag need a follow-up update; no other repository was modified.
The README's description of the two Cube rows needs maintainer review to explain
conditional V-Shell ownership. Publication remains paused pending that review.


## Checkpoint 3: sticky presentation

`StickyPresentation` filters Overview membership without changing Meta.Window
stickiness or workspace membership. Pointer polling is not added. Window,
workspace, stacking and Overview drag signals coalesce reconciliation before
redraw. The destination preview is added before obsolete duplicates are removed;
an active drag source survives workspace changes until drag completion or
cancellation. Native drop membership checks retain their original semantics.
Single-workspace secondary views remain native because they have no inactive
faces to duplicate. Disable restores the original predicates and ordinary sticky
previews, including when Overview is already open.

Desktop animations use a separate presentation path. Native Shell keeps sticky
windows in an overlay above the rotating faces. During Cube-owned animations,
that overlay's window clones are suppressed and reversible source clones are
placed on the actual active workspace face. Source actors, sticky state and
workspace membership are unchanged. Native moving-window overlays and desktop
background windows remain native. Stacking, minimized state, active workspace
changes, stick/unstick and unmanaged windows are reconciled. Cube depth separation
applies to the added clones; animation completion or teardown removes them and
restores owned instance methods and native clone visibility. With optional desktop
cube animation disabled, Shell's ordinary desktop animation is unchanged.

Validation also exposed three animation lifecycle cases handled locally:

- Older Shell stacking callbacks query current membership against a snapshot of
  clone records. Scoped instance predicates exclude missing records during the
  owned animation, avoiding a missing-record dereference after stick/unstick.
- Shell's primary-monitor completion callback can destroy every monitor group
  synchronously with reduced motion. Cube prepares the primary last so no later
  update in that loop accesses disposed secondary groups.
- V-Shell retains source actors in `_hiddenWindows` for scale restoration at
  animation teardown. Unmanaged actors are removed from that temporary list while
  the Cube-owned groups are tracked. V-Shell source is unchanged.

Native presentation regressions pass on GNOME 46.0 Wayland and X11, 48.7 Wayland,
50.1 headless Wayland, and 51.0 headless Wayland with two monitors. Each completed
presentation run executes 78 assertions across standalone Cube and V-Shell 51.4,
covering both presentation paths, live active/sticky/minimized state, desktop
progress updates, native moving-window overlays, closure during animation,
reduced-motion completion, real-pointer sticky dragging/Escape cancellation,
actor cleanup and restoration on disable/re-enable with Overview open. Both
workspace arrangements are exercised on 46.0. Animation-enabled runs explicitly
force Shell animations on despite software rendering, then disable animations for
the reduced-motion case. Virtual input devices are initialized outside Overview so
multi-monitor hot-corner pressure barriers do not toggle Overview during setup.
Progress observations inspect actual native animation actors; they are not screenshot evidence of visual smoothness.

The final ordinary spatial suite passes again on GNOME 46.0 with V-Shell and
D2D-A in both arrangements (48 assertions each) and on GNOME 51.0 with two monitors
(44 assertions). These exercise virtual-pointer dragging and native drops, not
only direct DND signal calls. A final lifecycle rerun passes 125 assertions on
46.0 and 51.0, including exact restoration of all three preview/DND methods. The peer-only errors documented above remain applicable to repeated
V-Shell rebuilds; there are no disposed-object or JavaScript errors in the final
sticky presentation runs.

GNOME 45, 47 and 49 were inspected, not executed. The inspection covers Overview
membership/removal, WorkspaceGroup records and sticky overlays, animation
completion and extension-state APIs. GNOME 45 does not export WorkspaceGroup;
the implementation discovers the native overlay through its actor records
instead of importing that class. Later Shell background-group and minimized-clone
changes retain the used record relationships. No native X11 coverage beyond 46,
hardware rendering, mixed scaling or physical gesture coverage is claimed.
The historical repeated dock-rebuild allocation stress case recorded in
`adaptive-testing.md` has not been requalified by this task; the ordinary
four-side dock detection and real spatial drag regressions pass.

Automated syntax/schema, packaging and promotion-controller checks pass, as do
all ten spatial/lifecycle/policy unit regressions, clang-format 18 and REUSE lint.
The ZIP includes every new runtime and preferences module. Resources, locales,
metadata, upstream attribution and saved schema keys are unchanged.

## Maintainer publication handoff

No new user setting, schema migration, version bump or README narrative is
included. Existing saved standalone workspace policies are preserved. README
review is needed for conditional V-Shell ownership of the two workspace policies
and active-face-only sticky presentation. Other settings overlaps were left
independent because their scopes differ. Downstream callers reading the local
saved hide-empty flag need a separate effective-policy integration update.
The promotion PR remains draft with `do-not-merge`; the seven-day quiet period
and CI requirements are unchanged. Technical validation is not approval of the
human-owned product narrative or resolution of upstream peer errors.
