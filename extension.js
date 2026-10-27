//////////////////////////////////////////////////////////////////////////////////////////
//             ,-.  ,--.  ,-.  ,  , ,---.  ,-.  ;-.     ,-. .  . ,-.  ,--.              //
//             |  \ |    (   ` | /    |   /   \ |  )   /    |  | |  ) |                 //
//             |  | |-    `-.  |<     |   |   | |-'    |    |  | |-<  |-                //
//             |  / |    .   ) | \    |   \   / |      \    |  | |  ) |                 //
//             `-'  `--'  `-'  '  `   '    `-'  '       `-' `--` `-'  `--'              //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {PressureBarrier} from 'resource:///org/gnome/shell/ui/layout.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';
import {WorkspacesView, FitMode} from 'resource:///org/gnome/shell/ui/workspacesView.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as utils from './src/utils.js';
import {DragGesture} from './src/DragGesture.js';
import {Skybox} from './src/Skybox.js';
import {SpatialOverview} from './src/SpatialOverview.js';

//////////////////////////////////////////////////////////////////////////////////////////
// This extensions tweaks the positioning of workspaces in overview mode and while      //
// switching workspaces in desktop mode to make them look like cube faces.              //
//////////////////////////////////////////////////////////////////////////////////////////

const [GS_VERSION] = Config.PACKAGE_VERSION.split('.').map(s => Number(s));

// Maximum degrees the cube can be rotated up and down.
const MAX_VERTICAL_ROTATION = 50;

// Spacing to the screen sides of the vertically rotated cube.
const PADDING_V_ROTATION = 0.2;

export default class DesktopCube extends Extension {
  _lastWorkspaceWidth = 0;

  // ------------------------------------------------------------------------ public stuff

  // This function could be called after the extension is enabled, which could be done
  // from GNOME Tweaks, when you log in or when the screen is unlocked.
  enable() {

    // Store a reference to the settings object.
    this._settings = this.getSettings();

    // Remember the workspace SwipeTracker orientations we encounter before forcing the
    // optional horizontal-carousel policy. This lets us opt out or disable the extension
    // without guessing what GNOME / V-Shell wanted for each tracker.
    this._workspaceSwipeNaturalOrientations = new Map();
    this._workspaceSwipeForcedHorizontal    = new Set();

    // We will monkey-patch these methods. Let's store the original ones.
    this._patchedSwipeTrackers      = [];
    this._origUpdateWorkspacesState = WorkspacesView.prototype._updateWorkspacesState;
    this._origGetSpacing            = WorkspacesView.prototype._getSpacing;
    this._origUpdateVisibility      = WorkspacesView.prototype._updateVisibility;
    this._origPrepSwitch            = Main.wm._workspaceAnimation._prepareWorkspaceSwitch;
    this._origFinalSwitch           = Main.wm._workspaceAnimation._finishWorkspaceSwitch;
    this._origGetNeighbor           = Meta.Workspace.prototype.get_neighbor;

    // Keep the methods that were present when Desktop Cube started. If V-Shell is loaded
    // after us, it can temporarily replace our wrappers; the compatibility watcher below
    // will compose with those methods instead of assuming a fixed extension load order.
    this._initialWorkspaceViewMethods = {
      updateState: this._origUpdateWorkspacesState,
      getSpacing: this._origGetSpacing,
      updateVisibility: this._origUpdateVisibility,
    };
    this._initialWorkspaceAnimationMethods = {
      prepare: this._origPrepSwitch,
      finish: this._origFinalSwitch,
    };
    this._initialGetNeighbor = this._origGetNeighbor;

    // We will use extensionThis to refer to the extension inside the patched methods.
    const extensionThis = this;

    // Desktop Cube models workspaces as a linear sequence wrapped around a 3D object.
    // GNOME normally clamps get_neighbor() at the ends; V-Shell may replace this method
    // with its own matrix-aware implementation. Compose on top of whichever
    // implementation is active so our optional hide-empty / looping policy is shared by
    // keyboard, wheel, edge switching, and other navigation paths that ask Mutter for a
    // neighbor.
    Meta.Workspace.prototype.get_neighbor = function(direction) {
      const neighbor = extensionThis._origGetNeighbor.apply(this, [direction]);
      return extensionThis._resolveWorkspaceNeighbor(this, direction, neighbor);
    };
    this._cubeGetNeighbor = Meta.Workspace.prototype.get_neighbor;

    // -----------------------------------------------------------------------------------
    // ------------------------------- cubify the overview -------------------------------
    // -----------------------------------------------------------------------------------

    // Normally, all workspaces outside the current field-of-view are hidden. We want to
    // show all workspaces, so we patch this method. The original code is about here:
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/workspacesView.js#L420
    WorkspacesView.prototype._updateVisibility = function() {
      if (extensionThis._spatial?.active) {
        this._workspaces.forEach(w => w.show());
        return;
      }
      // Do not force workspace actors to stay visible while the app grid is taking input.
      // This is especially important with V-Shell: otherwise transformed workspace actors
      // can remain in the picking tree above app icons even though they are visually
      // hidden.
      if (extensionThis._getAppDrawerMode(this) > 0.001) {
        extensionThis._origUpdateVisibility.apply(this);
        return;
      }

      const cubeWorkspaces = new Set(extensionThis._getCubeWorkspaces(this._workspaces));
      this._workspaces.forEach((w) => {
        if (cubeWorkspaces.has(w)) {
          w.show();
        } else {
          w.hide();
        }
      });
    };

    // Usually, workspaces are placed next to each other separated by a few pixels (this
    // separation is usually computed by the method below). To create the desktop cube, we
    // have to position all workspaces on top of each other and rotate the around a pivot
    // point in the center of the cube.
    // The original arrangement of the workspaces is implemented in WorkspacesView's
    // vfunc_allocate() which cannot be monkey-patched. As a workaround, we return a
    // negative spacing in the method below...
    // The original code is about here:
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/workspacesView.js#L219
    WorkspacesView.prototype._getSpacing = function(box, fitMode, vertical) {
      // We use the "normal" workspace spacing in desktop and app-grid mode.
      const origValue =
        extensionThis._origGetSpacing.apply(this, [box, fitMode, vertical]);

      if (extensionThis._spatial?.active) return origValue;

      if (fitMode == FitMode.ALL) {
        return origValue;
      }

      // Compute the negative spacing required by the 3D arrangement. For horizontal
      // workspaces this overlaps the faces as before. For V-Shell's vertical layout we
      // intentionally keep the historical width-based value: vfunc_allocate applies that
      // value on the Y axis, leaving a controlled vertical pitch between rotated faces.
      // That is the "workspace spire" rather than an accidental width/height mismatch.
      const faceWidth    = this._workspaces[0].get_preferred_width(box.get_size()[1])[1];
      const overlapValue = -faceWidth;

      // Blend between the negative overlap-spacing / spire pitch and the normal value.
      const cubeMode = extensionThis._getCubeMode(this);
      return Util.lerp(origValue, overlapValue, cubeMode);
    };

    // This is the main method which is called whenever the workspaces need to be
    // repositioned.
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/workspacesView.js#L255
    WorkspacesView.prototype._updateWorkspacesState = function() {
      if (extensionThis._spatial?.active) {
        extensionThis._origUpdateWorkspacesState.apply(this);
        this.rotation_angle_x = 0;
        this.pivot_point_z    = 0;
        this._workspaces.forEach(w => {
          w.show();
          w.rotation_angle_y = 0;
          w.pivot_point_z    = 0;
          w.translation_x    = 0;
          w.translation_y    = 0;
          w.translation_z    = 0;
          w.set_scale(1, 1);
          w.stateAdjustment.value = 1;
          w._background.set_opacity(255);
          w._container.translation_z = 0;
          w._container.get_children().forEach(actor => {
            actor.translation_z = 0;
          });
        });
        return;
      }
      // In V-Shell's vertical layout, let the underlying implementation establish
      // visibility and workspace-mode state before Desktop Cube adds 3D transforms. We
      // also delegate during app-grid transitions for input isolation. Stock horizontal
      // cube mode keeps the upstream fast path and avoids doing two full workspace loops.
      const needsDelegatedState = extensionThis._isVerticalWorkspaceLayout() ||
        extensionThis._getAppDrawerMode(this) > 0.001;
      if (needsDelegatedState) {
        extensionThis._origUpdateWorkspacesState.apply(this);
      }

      // Hide the dynamic trailing empty workspace from the cube if requested. We keep
      // GNOME/V-Shell's actor and allocation intact; it is simply excluded from Desktop
      // Cube's face geometry and hidden while the window-picker cube is active.
      const cubeWorkspaces   = extensionThis._getCubeWorkspaces(this._workspaces);
      const cubeWorkspaceSet = new Set(cubeWorkspaces);

      // Use only the underlying implementation if fewer than two visible cube faces
      // remain.
      const faceCount = cubeWorkspaces.length;
      if (faceCount <= 1) {
        if (!needsDelegatedState) {
          extensionThis._origUpdateWorkspacesState.apply(this);
        }
        if (extensionThis._getAppDrawerMode(this) < 0.999) {
          this._workspaces.forEach(w => {
            if (!cubeWorkspaceSet.has(w)) w.hide();
          });
        }
        return;
      }

      // Here's a minor hack to improve the performance: During the transitions to / from
      // the app drawer, this._updateWorkspacesState is called twice a frame. Once from
      // the notify handler of this._fitModeAdjustment and thereafter once from the notify
      // handler of this._overviewAdjustment. As this seems not so useful (and degrades
      // performance a lot), we skip the first call. I am not aware of any cases where
      // this._fitModeAdjustment is changed without any of the over adjustments to change
      // as well...
      // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/workspacesView.js#L109
      // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/workspacesView.js#L45
      if ((new Error()).stack.includes('fitModeNotify')) {
        return;
      }

      // Compute blending state from and to the overview, from and to the app grid, and
      // from and to the desktop mode. We will use cubeMode to fold and unfold the
      // cube, overviewMode to add some depth between windows and backgrounds, and
      // appDrawerMode to attenuate the scaling effect of the active workspace.
      const appDrawerMode = extensionThis._getAppDrawerMode(this);
      const overviewMode  = extensionThis._getOverviewMode(this);
      const cubeMode      = extensionThis._getCubeMode(this);

      // At the fully-open app grid, Desktop Cube deliberately owns no workspace state.
      // The transition still unfolds smoothly because cubeMode approaches zero on the way
      // there, but once settled we leave visibility and input entirely to GNOME/V-Shell.
      if (appDrawerMode > 0.999) {
        return;
      }

      // In cube mode we need every visible face available for the 3D depth sort. The
      // underlying implementation may intentionally cull distant workspaces for
      // performance. Keep the optional trailing empty workspace out of the picking tree.
      this._workspaces.forEach(w => {
        if (cubeWorkspaceSet.has(w))
          w.show();
        else
          w.hide();
      });

      // First we need the width of a single workspace. Simply calling
      // this._workspaces[0]._background.width does not work in all cases, as this method
      // seems to be called also when the background actor is not on the stage. As a hacky
      // workaround, we store the last valid workspace width we got and use that value if
      // we cannot get a new one...
      let workspaceWidth = extensionThis._lastWorkspaceWidth;
      const bg           = cubeWorkspaces[0]._background;
      if (bg.get_stage() && bg.allocation.get_width() > 0) {
        workspaceWidth = bg.allocation.get_width();

        // Add gaps between workspaces in overview mode.
        workspaceWidth +=
          overviewMode * 2 * extensionThis._settings.get_int('workpace-separation');

        extensionThis._lastWorkspaceWidth = workspaceWidth;
      }

      // That's the angle between consecutive workspaces.
      const faceAngle = extensionThis._getFaceAngle(faceCount);

      // That's the z-distance from the cube faces to the rotation pivot.
      const centerDepth = extensionThis._getCenterDist(workspaceWidth, faceAngle);

      // Apply vertical rotation if required. This comes from the pitch value of the
      // modified SwipeTracker created by _addOverviewDragGesture() further below.
      this.pivot_point_z = -centerDepth;
      this.set_pivot_point(0.5, 0.5);
      this.rotation_angle_x = extensionThis._pitch.value * MAX_VERTICAL_ROTATION;

      // During rotations, the cube is scaled down and the windows are "exploded". If we
      // are directly facing a cube side, the strengths of both effects are approaching
      // zero. The strengths of both effects are small during horizontal rotations to make
      // workspace-switching not so obtrusive. However, during vertical rotations, the
      // effects are stronger.
      const [depthOffset, explode] = extensionThis._getExplodeFactors(
        this._scrollAdjustment.value, extensionThis._pitch.value, centerDepth,
        this._monitorIndex);

      // Now loop through the visible cube faces and compute the individual rotations.
      cubeWorkspaces.forEach((w, index) => {
        // First update the corner radii. In a vertical layout, V-Shell owns the
        // workspace state adjustment (it may use a different spread mode), so keep the
        // value established by the delegated implementation.
        if (!extensionThis._isVerticalWorkspaceLayout()) {
          w.stateAdjustment.value = overviewMode;
        }

        // Now update the rotation of the cube face. The rotation center is -centerDepth
        // units behind the front face.
        w.pivot_point_z = -centerDepth;

        // Make cube smaller during rotations.
        w.translation_z = -depthOffset;

        // The rotation angle is transitioned proportional to cubeMode^1.5. This slows
        // down the rotation a bit closer to the desktop and to the app drawer.
        w.rotation_angle_y =
          Math.pow(cubeMode, 1.5) * (-this._scrollAdjustment.value + index) * faceAngle;

        // Distance to being the active workspace in [-1...0...1].
        const dist = Math.clamp(index - this._scrollAdjustment.value, -1, 1);

        // This moves next and previous workspaces a bit to the left and right. This
        // ensures that we can actually see them if we look at the cube from the front.
        // The value is set to zero if we have five or more workspaces.
        if (faceCount <= 4) {
          w.translation_x =
            dist * overviewMode * extensionThis._settings.get_int('horizontal-stretch');
        } else {
          w.translation_x = 0;
        }

        // Update wallpaper opacity only in overview mode. "Hide wallpaper" deliberately
        // fades the per-workspace background actor to zero while leaving window clones
        // untouched, allowing V-Shell / Blur my Shell / GNOME's overview background to
        // own the surface behind the cube.
        const opacityA = extensionThis._settings.get_int('active-workpace-opacity');
        const opacityB = extensionThis._settings.get_int('inactive-workpace-opacity');
        const configuredOpacity = Util.lerp(opacityA, opacityB, Math.abs(dist));
        const targetOpacity =
          extensionThis._settings.get_boolean('hide-wallpaper') ? 0 : configuredOpacity;
        w._background.set_opacity(Util.lerp(255, targetOpacity, overviewMode));

        // Update workspace scale only in app grid mode. The 0.94 is supposed to be the
        // same value as the WORKSPACE_INACTIVE_SCALE defined here:
        // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/workspacesView.js#L21
        // As this is defined as 'const', we cannot access it here. But the exact value
        // also not really matters...
        const scale = Util.lerp(1, 0.94, Math.abs(dist) * appDrawerMode);
        w.set_scale(scale, scale);

        // Now we add some depth separation between the window clones. If the explode
        // factor becomes too small, the depth sorting becomes non-deterministic.
        if (explode > 0.001) {

          const sortedActors = w._container.layout_manager._sortedWindows;

          // Distribute the window clones translation_z values between zero and
          // explode.
          sortedActors.forEach((windowActor, j) => {
            windowActor.translation_z = explode * (j + 1) / sortedActors.length;
          });

          // Now sort the window clones according to the orthogonal distance of the actor
          // planes to the camera. This ensures proper depth sorting among the window
          // clones.
          if (sortedActors.length > 1) {
            extensionThis._depthSortWindowActors(w._container.get_children(),
                                                 this._monitorIndex);
          }
        }

        // Now we sort the children of the workspace (e.g. the background actor
        // and the container for the window clones) by their orthogonal distance to the
        // virtual camera. We add a tiny translation to the window-clone container to
        // allow for proper sorting.
        w._container.translation_z = 1;
        extensionThis._depthSortWindowActors(w.get_children(), this._monitorIndex);
      });

      // The depth-sorting of cube faces is quite simple, we sort them by increasing
      // rotation angle so that they are drawn back-to-front.
      extensionThis._depthSortCubeFaces(cubeWorkspaces);
    };

    // Retain stable references to our wrappers. V-Shell refreshes some prototype methods
    // when its settings change; _ensureCompatibilityPatches() can then rebase Desktop
    // Cube on top of the new implementation without stacking duplicate wrappers.
    this._cubeUpdateVisibility      = WorkspacesView.prototype._updateVisibility;
    this._cubeGetSpacing            = WorkspacesView.prototype._getSpacing;
    this._cubeUpdateWorkspacesState = WorkspacesView.prototype._updateWorkspacesState;


    // -----------------------------------------------------------------------------------
    // --------------------- cubify workspace-switch in desktop mode ---------------------
    // -----------------------------------------------------------------------------------

    // This override rotates the workspaces during the transition to look like cube
    // faces. The original movement of the workspaces is implemented in the setter of
    // the progress property. We do not touch this, as keeping track of this progress
    // is rather important. Instead, we listen to progress changes and tweak the
    // transformation accordingly.
    // This lambda is called in two places (further down), once for updates of the
    // progress property, once for updates during gesture swipes. The latter does not
    // trigger notify signals of the former for some reason...
    const updateMonitorGroup = (group) => {
      // Stock GNOME lays workspaces out horizontally, so Desktop Cube cancels only the
      // X translation. V-Shell's vertical layout deliberately keeps its Y placement;
      // combining that vertical pitch with the Y-axis face rotation is what forms the
      // workspace spire. Do not cancel Y here.
      group._container.translation_x = -group._container.x;

      // That's the desired angle between consecutive workspaces.
      const faceAngle = extensionThis._getFaceAngle(group._workspaceGroups.length);

      // That's the z-distance from the cube faces to the rotation pivot.
      const centerDepth =
        extensionThis._getCenterDist(group._workspaceGroups[0].width, faceAngle);

      // Apply vertical rotation if required. This comes from the pitch value of the
      // modified SwipeTracker created by _addDesktopDragGesture() further below.
      group._container.pivot_point_z = -centerDepth;
      group._container.set_pivot_point(0.5, 0.5);
      group._container.rotation_angle_x =
        extensionThis._pitch.value * MAX_VERTICAL_ROTATION;

      // During rotations, the cube is scaled down and the windows are "exploded". If we
      // are directly facing a cube side, the strengths of both effects are approaching
      // zero. The strengths of both effects are small during horizontal rotations to make
      // workspace-switching not so obtrusive. However, during vertical rotations, the
      // effects are stronger.
      const [depthOffset, explode] = extensionThis._getExplodeFactors(
        group.progress, extensionThis._pitch.value, centerDepth, group._monitor.index);

      // Rotate the individual faces.
      group._workspaceGroups.forEach((child, i) => {
        child.set_pivot_point_z(-centerDepth);
        child.set_pivot_point(0.5, 0.5);
        child.rotation_angle_y   = (i - group.progress) * faceAngle;
        child.translation_z      = -depthOffset;
        child.clip_to_allocation = false;

        // Counter only the stock horizontal placement. Vertical placement from V-Shell
        // remains intact and supplies the spire's vertical pitch.
        child.translation_x = -child.x;

        // Make cube transparent during vertical rotations.
        child._background.opacity = 255 * (1.0 - Math.abs(extensionThis._pitch.value));

        // Now we add some depth separation between the window clones. We get the stacking
        // order from the global window list. If the explode factor becomes too small, the
        // depth sorting becomes non-deterministic.
        if (explode > 0.001) {
          const windowActors = global.get_window_actors().filter(w => {
            return child._shouldShowWindow(w.meta_window);
          });

          // Distribute the window clones translation_z values between zero and
          // explode.
          windowActors.forEach((windowActor, j) => {
            const record = child._windowRecords.find(r => r.windowActor === windowActor);
            if (record) {
              record.clone.translation_z = explode * (j + 1) / windowActors.length;
            }
          });

          // Now sort the window clones and the background actor according to the
          // orthogonal distance of the actor planes to the camera. This ensures proper
          // depth sorting.
          extensionThis._depthSortWindowActors(child.get_children(),
                                               group._monitor.index);
        }
      });

      // The depth-sorting of cube faces is quite simple, we sort them by increasing
      // rotation angle.
      extensionThis._depthSortCubeFaces(group._workspaceGroups);

      // Update horizontal rotation of the background panorama during workspace switches.
      if (this._skybox) {
        this._skybox.yaw =
          2 * Math.PI * group.progress / global.workspaceManager.get_n_workspaces();
      }
    };

    // Whenever a workspace-switch is about to happen, we tweak the MonitorGroup class a
    // bit to arrange the workspaces in a cube-like fashion. We have to adjust to parts of
    // the code as the automatic transitions (e.g. when switching with key combinations)
    // are handled differently than the gesture based switches.
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/workspaceAnimation.js#L377
    Main.wm._workspaceAnimation._prepareWorkspaceSwitch = function(...params) {
      // This private fork can leave desktop-mode workspace transitions entirely to
      // GNOME / V-Shell while retaining Desktop Cube in the Overview. Keep the wrapper
      // installed so compatibility rebasing remains load-order safe, but become a pure
      // delegate when the 3D desktop animation is disabled.
      if (!extensionThis._settings.get_boolean(
            'enable-desktop-workspace-cube-animation')) {
        return extensionThis._origPrepSwitch.apply(this, params);
      }

      // Usually, GNOME Shell "skips" intermediate workspaces when switching farther
      // than one workspace. Desktop Cube wants a complete spatial sequence, so we either
      // request all workspaces (upstream behavior) or all *visible* workspaces when the
      // trailing dynamic empty workspace is hidden.
      const workspaceIndices = extensionThis._getCubeWorkspaceIndices();
      extensionThis._origPrepSwitch.apply(this,
                                          workspaceIndices ? [workspaceIndices] : []);
      this._desktopCubeAnimationActive = true;

      // Now tweak the monitor groups.
      this._switchData.monitors.forEach(m => {
        // Call the method above whenever the transition progress changes.
        m._desktopCubeProgressID =
          m.connect('notify::progress', () => updateMonitorGroup(m));

        // Call the method above whenever a gesture is active.
        const orig              = m.updateSwipeForMonitor;
        m.updateSwipeForMonitor = function(progress, baseMonitorGroup) {
          orig.apply(m, [progress, baseMonitorGroup]);
          updateMonitorGroup(m);
        };
      });

      // Make sure that the background panorama is drawn above the window group during a
      // workspace switch.
      if (extensionThis._skybox) {
        extensionThis._skybox.get_parent().remove_child(extensionThis._skybox);
        Main.uiGroup.insert_child_above(extensionThis._skybox, global.window_group);

        // If the workspaces are only on the primary monitor, the skybox would cover all
        // other non-rotating screens. Therefore, we temporarily limit its size to the
        // primary monitor's size.
        if (Meta.prefs_get_workspaces_only_on_primary()) {
          const monitor =
            global.display.get_monitor_geometry(global.display.get_primary_monitor());
          extensionThis._skybox.width  = monitor.width;
          extensionThis._skybox.height = monitor.height;
          extensionThis._skybox.x      = monitor.x;
          extensionThis._skybox.y      = monitor.y;
        }
      }
    };

    // Re-attach the background panorama to the stage once the workspace switch is done.
    Main.wm._workspaceAnimation._finishWorkspaceSwitch = function(...params) {
      // Remember whether prepare actually installed Desktop Cube's transform hooks. This
      // makes changing the setting during a transition safe: an in-flight cube animation
      // is still cleaned up even if the preference was switched off before it finished.
      const cubeAnimationActive = !!this._desktopCubeAnimationActive;

      if (cubeAnimationActive && this._switchData?.monitors) {
        this._switchData.monitors.forEach(m => {
          if (m._desktopCubeProgressID) {
            m.disconnect(m._desktopCubeProgressID);
            delete m._desktopCubeProgressID;
          }
        });
      }

      delete this._desktopCubeAnimationActive;
      const result = extensionThis._origFinalSwitch.apply(this, params);

      // Make sure that the skybox covers the entire stage again, but only if the matching
      // prepare call moved it for a Desktop Cube transition. Native transitions never
      // reparent the skybox.
      if (cubeAnimationActive && extensionThis._skybox) {
        extensionThis._skybox.get_parent().remove_child(extensionThis._skybox);
        global.stage.insert_child_below(extensionThis._skybox, null);

        if (Meta.prefs_get_workspaces_only_on_primary()) {
          extensionThis._skybox.width  = global.stage.width;
          extensionThis._skybox.height = global.stage.height;
          extensionThis._skybox.x      = global.stage.x;
          extensionThis._skybox.y      = global.stage.y;
        }
      }

      return result;
    };

    this._cubePrepSwitch  = Main.wm._workspaceAnimation._prepareWorkspaceSwitch;
    this._cubeFinalSwitch = Main.wm._workspaceAnimation._finishWorkspaceSwitch;


    // -----------------------------------------------------------------------------------
    // ------------------------- enable cube rotation by dragging ------------------------
    // -----------------------------------------------------------------------------------

    // Usually, in GNOME Shell 40+, workspaces are move horizontally. We tweaked this to
    // look like a horizontal rotation above. To store the current vertical rotation, we
    // use the adjustment below.
    this._pitch = new St.Adjustment({actor: global.stage, lower: -1, upper: 1});

    // The overview's SwipeTracker will control the _overviewAdjustment of the
    // WorkspacesDisplay. However, only horizontal swipes will update this adjustment. If
    // only our pitch adjustment is changed (e.g. the user moved the mouse only
    // vertically), the _overviewAdjustment will not change and therefore the workspaces
    // will not been redrawn. Here we force redrawing by notifying changes if the pitch
    // value changes.
    this._pitch.connect('notify::value', () => {
      if (Main.actionMode == Shell.ActionMode.OVERVIEW) {
        Main.overview._overview._controls._workspacesDisplay._overviewAdjustment.notify(
          'value');
      }
    });

    // In GNOME Shell, SwipeTrackers are used all over the place to capture swipe
    // gestures. There's one for entering the overview, one for switching workspaces in
    // desktop mode, one for switching workspaces in overview mode, one for horizontal
    // scrolling in the app drawer, and many more. The ones used for workspace-switching
    // usually do not respond to single-click dragging but only to multi-touch gestures.
    // We want to be able to rotate the cube with the left mouse button, so we add an
    // additional gesture to these two SwipeTracker instances. In this private fork the
    // input axis is configurable: horizontal carousel-style input is the default even
    // when V-Shell stacks workspaces vertically.

    // The mouse-drag velocity fix is installed only on the workspace trackers that
    // Desktop Cube actually uses. Older versions patched SwipeTracker.prototype globally,
    // which also changed app-grid trackers and violated input isolation.

    // Add single-click drag gesture to the desktop.
    if (this._settings.get_boolean('enable-desktop-dragging')) {
      this._addDesktopDragGesture();
    }

    this._settings.connect('changed::enable-desktop-dragging', () => {
      if (this._settings.get_boolean('enable-desktop-dragging')) {
        this._addDesktopDragGesture();
      } else {
        this._removeDesktopDragGesture();
      }
    });

    // Add single-click drag gesture to the panel.
    if (this._settings.get_boolean('enable-panel-dragging')) {
      this._addPanelDragGesture();
    }

    this._settings.connect('changed::enable-panel-dragging', () => {
      if (this._settings.get_boolean('enable-panel-dragging')) {
        this._addPanelDragGesture();
      } else {
        this._removePanelDragGesture();
      }
    });

    // Add single-click drag gesture to the overview.
    if (this._settings.get_boolean('enable-overview-dragging')) {
      this._addOverviewDragGesture();
    }

    this._settings.connect('changed::enable-overview-dragging', () => {
      if (this._settings.get_boolean('enable-overview-dragging')) {
        this._addOverviewDragGesture();
      } else {
        this._removeOverviewDragGesture();
      }
    });

    // Preserve Desktop Cube's horizontal carousel input only where Desktop Cube actually
    // owns the spatial model. In the Overview, the user's horizontal-input preference
    // always applies to the cube/spire. On the ordinary desktop, however, disabling the
    // cube animation hands both the visuals and the input axis back to GNOME / V-Shell.
    // This keeps touchpad swipes, single-pointer drags, and window edge-dragging aligned
    // with the animation the user is actually seeing.
    this._horizontalInputSettingsID = this._settings.connect(
      'changed::horizontal-workspace-input', () => this._syncWorkspaceInputPolicy());
    this._desktopAnimationInputSettingsID =
      this._settings.connect('changed::enable-desktop-workspace-cube-animation',
                             () => this._syncWorkspaceInputPolicy());
    this._syncWorkspaceInputPolicy();

    // Suspend every Desktop Cube overview drag path as soon as the app grid takes over.
    // Keeping the captured-event handler connected but inert avoids churn and guarantees
    // that app icons / folders receive the original event stream.
    this._appGridInputStateID = Main.overview._overview.controls._stateAdjustment.connect(
      'notify::value', () => this._syncOverviewGestureInput());
    this._syncOverviewGestureInput();

    // V-Shell can re-install its WorkspacesView / workspace-animation overrides when its
    // configuration changes. Rebase our transform wrappers whenever the overview opens,
    // and whenever V-Shell itself changes state. This removes extension-load-order as a
    // functional dependency.
    this._overviewCompatibilityID = Main.overview.connect('showing', () => {
      this._ensureCompatibilityPatches();
      this._syncWorkspaceInputPolicy();
    });
    this._extensionCompatibilityID =
      Main.extensionManager.connect('extension-state-changed', (manager, extension) => {
        if (extension.uuid === 'vertical-workspaces@G-dH.github.com') {
          // If V-Shell was enabled after Desktop Cube, its override manager may restore
          // our wrapper verbatim when V-Shell is disabled. Reset the wrapper delegates to
          // the methods we saw at startup before rebasing, avoiding a call into V-Shell's
          // closed-over state after that extension has been torn down.
          if (extension.state === 2) {
            this._origUpdateWorkspacesState =
              this._initialWorkspaceViewMethods.updateState;
            this._origGetSpacing = this._initialWorkspaceViewMethods.getSpacing;
            this._origUpdateVisibility =
              this._initialWorkspaceViewMethods.updateVisibility;
            this._origPrepSwitch  = this._initialWorkspaceAnimationMethods.prepare;
            this._origFinalSwitch = this._initialWorkspaceAnimationMethods.finish;
            this._origGetNeighbor = this._initialGetNeighbor;
          }
          this._ensureCompatibilityPatches();
          this._syncWorkspaceInputPolicy();
        }
      });
    this._ensureCompatibilityPatches();

    // Geometry / visibility settings should take effect immediately when preferences are
    // changed while the overview is open. Notify the overview adjustment to make each
    // WorkspacesView recompute its transforms without requiring a workspace gesture.
    ['hide-wallpaper', 'hide-empty-workspace', 'allow-workspace-looping',
     'last-first-gap']
      .forEach(key => this._settings.connect(`changed::${key}`, () => {
        this._queueOverviewCubeUpdate();
      }));


    // -----------------------------------------------------------------------------------
    // ---------------------------------- add the skybox ---------------------------------
    // -----------------------------------------------------------------------------------

    // This is called whenever the skybox texture setting is changed.
    const updateSkybox = () => {
      // First, delete the existing skybox.
      if (this._skybox) {
        this._skybox.destroy();
        delete this._skybox;
      }

      const file = this._settings.get_string('background-panorama');

      // Then, load a new one (if any).
      if (file != '') {
        try {
          this._skybox = new Skybox(file);

          // We add the skybox below everything.
          global.stage.insert_child_below(this._skybox, null);

          // Make sure that the skybox covers the entire stage.
          global.stage.bind_property('width', this._skybox, 'width',
                                     GObject.BindingFlags.SYNC_CREATE);
          global.stage.bind_property('height', this._skybox, 'height',
                                     GObject.BindingFlags.SYNC_CREATE);

        } catch (error) {
          utils.debug('Failed to set skybox: ' + error);
        }
      }
    };

    // Update the skybox whenever the corresponding setting is changed.
    this._settings.connect('changed::background-panorama', updateSkybox);
    updateSkybox();

    // Update vertical rotation of the background panorama.
    this._pitch.connect('notify::value', () => {
      if (this._skybox) {
        this._skybox.pitch = (this._pitch.value * MAX_VERTICAL_ROTATION) * Math.PI / 180;
      }
    });

    // Update horizontal rotation of the background panorama during workspace switches in
    // the overview.
    this._workspaceAdjustmentID =
      Main.overview._overview.controls._workspaceAdjustment.connect(
        'notify::value', () => {
          if (this._skybox) {
            this._skybox.yaw = 2 * Math.PI *
              Main.overview._overview.controls._workspaceAdjustment.value /
              global.workspaceManager.get_n_workspaces();
          }
        });


    // -----------------------------------------------------------------------------------
    // ----------------------- enable edge-drag workspace-switches -----------------------
    // -----------------------------------------------------------------------------------

    // We add two Meta.Barriers, one at each side of the stage. If the pointer hits one of
    // these with enough pressure while dragging a window, we initiate a workspace-switch.
    // The last parameter (0) is actually supposed to be a bitwise combination of
    // Shell.ActionModes. The pressure barrier will only trigger, if Main.actionMode
    // equals one of the given action modes. This works well for Shell.ActionMode.NORMAL
    // and Shell.ActionMode.OVERVIEW, however it does not work for Shell.ActionMode.NONE
    // (which actually equals zero). However, when we want the barriers to also trigger in
    // Shell.ActionMode.NONE, as this is the mode during a drag-operation in the overview.
    // Therefore, we modify the _onBarrierHit method of the pressure barrier to completely
    // ignore this parameter. Instead, we check for the correct action mode in the trigger
    // handler.
    this._pressureBarrier =
      new PressureBarrier(this._settings.get_int('edge-switch-pressure'), 1000, 0);

    // Update pressure threshold when the corresponding settings key changes.
    this._settings.connect('changed::edge-switch-pressure', () => {
      this._pressureBarrier._threshold = this._settings.get_int('edge-switch-pressure');
    });

    // This is an exact copy of the original _onBarrierHit, with only one line disabled to
    // ignore the given ActionMode.
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/layout.js#L1411
    this._pressureBarrier._onBarrierHit = function(barrier, event) {
      barrier._isHit = true;

      // If we've triggered the barrier, wait until the pointer has the
      // left the barrier hitbox until we trigger it again.
      if (this._isTriggered) return;

      if (this._eventFilter && this._eventFilter(event)) return;

      // Throw out all events not in the proper keybinding mode
      // if (!(this._actionMode & Main.actionMode)) return;

      let slide    = this._getDistanceAlongBarrier(barrier, event);
      let distance = this._getDistanceAcrossBarrier(barrier, event);

      if (distance >= this._threshold) {
        this._trigger();
        return;
      }

      // Throw out events where the cursor is move more
      // along the axis of the barrier than moving with
      // the barrier.
      if (slide > distance) return;

      this._lastTime = event.time;

      this._trimBarrierEvents();
      distance = Math.min(15, distance);

      this._barrierEvents.push([event.time, distance]);
      this._currentPressure += distance;

      if (this._currentPressure >= this._threshold) this._trigger();
    };

    // Physical Meta.Barriers really do resist the pointer. Keeping them alive on an
    // otherwise idle desktop therefore makes every configured edge feel "sticky", even
    // though our trigger handler only intends to act during a window drag. Keep the
    // PressureBarrier object resident, but create its physical edge barriers only while
    // they are actually useful: during a real Mutter move grab, or while the overview is
    // visible when overview edge switching is enabled.
    const destroyBarriers = () => {
      if (this._leftBarrier) {
        this._pressureBarrier.removeBarrier(this._leftBarrier);
        this._leftBarrier.destroy();
        this._leftBarrier = null;
      }

      if (this._rightBarrier) {
        this._pressureBarrier.removeBarrier(this._rightBarrier);
        this._rightBarrier.destroy();
        this._rightBarrier = null;
      }
    };

    const shouldCreateBarriers = () => {
      if (this._spatial?.dragging || this._spatial?.active) return false;
      const desktopDrag =
        this._draggedWindow && this._settings.get_boolean('enable-desktop-edge-switch');
      const overviewEdgeSwitching = Main.overview.visible &&
        this._settings.get_boolean('enable-overview-edge-switch');

      return desktopDrag || overviewEdgeSwitching;
    };

    // Now add the appropriate pair of physical barriers when they are needed.
    const createBarriers = () => {
      destroyBarriers();

      if (!shouldCreateBarriers()) return;

      const vertical = this._isVerticalWorkspaceLayout();
      const useHorizontalEdges =
        !vertical || this._shouldUseHorizontalWorkspaceInput(Main.overview.visible);
      const common =
        GS_VERSION <= 45 ? {display: global.display} : {backend: global.backend};

      if (!useHorizontalEdges) {
        // Axis-following mode: V-Shell's vertical workspace sequence uses the top/bottom
        // edges for window dragging, matching the physical workspace topology.
        this._leftBarrier = new Meta.Barrier({
          ...common,
          x1: 1,
          x2: global.stage.width,
          y1: 0,
          y2: 0,
          directions: Meta.BarrierDirection.POSITIVE_Y,
        });

        this._rightBarrier = new Meta.Barrier({
          ...common,
          x1: 1,
          x2: global.stage.width,
          y1: global.stage.height,
          y2: global.stage.height,
          directions: Meta.BarrierDirection.NEGATIVE_Y,
        });
      } else {
        // Carousel mode: use the widescreen-friendly left/right edges even when V-Shell
        // stacks workspaces vertically. The trigger handler below still requests the
        // correct UP/DOWN Mutter neighbor for a vertical topology; only the input surface
        // is horizontal.
        this._leftBarrier = new Meta.Barrier({
          ...common,
          x1: 0,
          x2: 0,
          y1: 1,
          y2: global.stage.height,
          directions: Meta.BarrierDirection.POSITIVE_X,
        });

        this._rightBarrier = new Meta.Barrier({
          ...common,
          x1: global.stage.width,
          x2: global.stage.width,
          y1: 1,
          y2: global.stage.height,
          directions: Meta.BarrierDirection.NEGATIVE_X,
        });
      }

      this._pressureBarrier.addBarrier(this._leftBarrier);
      this._pressureBarrier.addBarrier(this._rightBarrier);
    };

    // Keep rebuild / destroy hooks so input-axis changes and lifecycle events can update
    // the temporary barriers without restarting GNOME Shell.
    this._rebuildEdgeSwitchBarriers = createBarriers;
    this._destroyEdgeSwitchBarriers = destroyBarriers;
    this._refreshEdgeSwitchBarriers = createBarriers;

    // Re-create barriers if geometry or workspace orientation changes while they are
    // live.
    this._stageAllocationID = global.stage.connect('notify::allocation', createBarriers);
    this._workspaceLayoutID =
      global.workspace_manager.connect('notify::layout-rows', () => {
        createBarriers();
        this._syncWorkspaceSwipeOrientation();
      });

    // Overview edge switching still uses the upstream pressure-barrier model, but the
    // physical barriers now exist only while the overview itself is visible. On the
    // normal desktop, idle edges remain completely barrier-free.
    this._overviewEdgeShowingID = Main.overview.connect('showing', createBarriers);
    this._overviewEdgeHiddenID  = Main.overview.connect('hidden', createBarriers);
    this._desktopEdgeSettingID =
      this._settings.connect('changed::enable-desktop-edge-switch', createBarriers);
    this._overviewEdgeSettingID =
      this._settings.connect('changed::enable-overview-edge-switch', createBarriers);

    createBarriers();
    this._syncWorkspaceSwipeOrientation();

    // When the pressure barrier is triggered, the corresponding setting is enabled, and a
    // window is currently dragged, we move the dragged window to the adjacent workspace
    // and activate it as well.
    this._pressureBarrier.connect('trigger', () => {
      if (this._isAppGridActive()) {
        return;
      }

      const vertical  = this._isVerticalWorkspaceLayout();
      const direction = this._leftBarrier._isHit ?
        (vertical ? Meta.MotionDirection.UP : Meta.MotionDirection.LEFT) :
        (vertical ? Meta.MotionDirection.DOWN : Meta.MotionDirection.RIGHT);

      const newWorkspace =
        global.workspace_manager.get_active_workspace().get_neighbor(direction);

      if (Main.actionMode == Shell.ActionMode.NORMAL && this._draggedWindow &&
          this._settings.get_boolean('enable-desktop-edge-switch')) {
        Main.wm.actionMoveWindow(this._draggedWindow, newWorkspace);
      } else if (Main.actionMode == Shell.ActionMode.NONE && Main.overview.visible &&
                 this._settings.get_boolean('enable-overview-edge-switch')) {
        newWorkspace.activate(global.get_current_time());
      }
    });

    // Keep a reference to the currently dragged window. Mutter has separate grab-op
    // values for pointer moving, unconstrained pointer moving, and keyboard-initiated
    // moving. Window Wheel Bridge v2 intentionally uses KEYBOARD_MOVING because that is
    // the same compositor-native path as GNOME Shell's own Window Menu. Treat all three
    // as real moves so Desktop Cube's temporary edge targets work with every path.
    const isMovingGrabOp = op => op == Meta.GrabOp.MOVING ||
      op == Meta.GrabOp.MOVING_UNCONSTRAINED || op == Meta.GrabOp.KEYBOARD_MOVING;

    this._grabOpBeginID = global.display.connect('grab-op-begin', (d, win, op) => {
      if (isMovingGrabOp(op)) {
        this._draggedWindow = win;
        createBarriers();
      }
    });

    // Release the reference and remove the physical edge pressure as soon as Mutter's
    // move grab ends. This is the important v5 change for ordinary pointer movement.
    this._grabOpEndID = global.display.connect('grab-op-end', (d, win, op) => {
      if (isMovingGrabOp(op)) {
        this._draggedWindow = null;
        createBarriers();
      }
    });


    // -----------------------------------------------------------------------------------
    // ------------------- fix perspective of multi-monitor setups -----------------------
    // -----------------------------------------------------------------------------------

    // Usually, GNOME Shell uses one central perspective for all monitors combined. This
    // results in a somewhat sheared appearance of the cube on multi-monitor setups where
    // the primary monitor is not in the middle (or cubes are shown on multiple monitors).
    // With the code below, we modify the projection and view matrices for each monitor so
    // that each monitor uses its own central perspective. This seems to be possible on
    // Wayland only. On X11, there's only one set of projection and view matrices for all
    // monitors combined, so we tweak them so that the projection center is in the middle
    // of the primary monitor. So it will at least only look bad on X11 if the cube is
    // shown on all monitors...
    const updateMonitorPerspective = () => {
      // Disable the perspective fixes first...
      this._disablePerspectiveCorrection();

      // Store this so we do not have to get it too often.
      this._enablePerMonitorPerspective =
        this._settings.get_boolean('per-monitor-perspective') &&
        global.display.get_n_monitors() > 1;

      // ... and then enable them if required.
      if (this._enablePerMonitorPerspective) {
        this._enablePerspectiveCorrection();
      }
    };

    this._settings.connect('changed::per-monitor-perspective', updateMonitorPerspective);
    this._monitorsChangedID = global.backend.get_monitor_manager().connect(
      'monitors-changed', updateMonitorPerspective);

    updateMonitorPerspective();
    this._spatial = new SpatialOverview(this);
  }

  // This function could be called after the extension is uninstalled, disabled in GNOME
  // Tweaks, when you log out or when the screen locks.
  disable() {
    this._spatial?.destroy();
    this._spatial                   = null;
    this._refreshEdgeSwitchBarriers = null;

    // Restore the original behavior.
    if (WorkspacesView.prototype._updateWorkspacesState ===
        this._cubeUpdateWorkspacesState) {
      WorkspacesView.prototype._updateWorkspacesState = this._origUpdateWorkspacesState;
    }
    if (WorkspacesView.prototype._getSpacing === this._cubeGetSpacing) {
      WorkspacesView.prototype._getSpacing = this._origGetSpacing;
    }
    if (WorkspacesView.prototype._updateVisibility === this._cubeUpdateVisibility) {
      WorkspacesView.prototype._updateVisibility = this._origUpdateVisibility;
    }
    if (Main.wm._workspaceAnimation._prepareWorkspaceSwitch === this._cubePrepSwitch) {
      Main.wm._workspaceAnimation._prepareWorkspaceSwitch = this._origPrepSwitch;
    }
    if (Main.wm._workspaceAnimation._finishWorkspaceSwitch === this._cubeFinalSwitch) {
      Main.wm._workspaceAnimation._finishWorkspaceSwitch = this._origFinalSwitch;
    }
    if (Meta.Workspace.prototype.get_neighbor === this._cubeGetNeighbor) {
      Meta.Workspace.prototype.get_neighbor = this._origGetNeighbor;
    }

    if (this._appGridInputStateID) {
      Main.overview._overview.controls._stateAdjustment.disconnect(
        this._appGridInputStateID);
      this._appGridInputStateID = 0;
    }
    if (this._overviewCompatibilityID) {
      Main.overview.disconnect(this._overviewCompatibilityID);
      this._overviewCompatibilityID = 0;
    }
    if (this._extensionCompatibilityID) {
      Main.extensionManager.disconnect(this._extensionCompatibilityID);
      this._extensionCompatibilityID = 0;
    }
    if (this._horizontalInputSettingsID) {
      this._settings.disconnect(this._horizontalInputSettingsID);
      this._horizontalInputSettingsID = 0;
    }
    if (this._desktopAnimationInputSettingsID) {
      this._settings.disconnect(this._desktopAnimationInputSettingsID);
      this._desktopAnimationInputSettingsID = 0;
    }

    // Restore V-Shell / Mutter's natural workspace swipe axis before removing our custom
    // drag adapters. This avoids leaving horizontal input behind when the fork is
    // disabled.
    this._restoreWorkspaceSwipeOrientation();

    // Remove all drag-to-rotate gestures.
    this._removeDesktopDragGesture();
    this._removePanelDragGesture();
    this._removeOverviewDragGesture();

    this._patchedSwipeTrackers.forEach(
      ({tracker, originalEndGesture, originalGetBounds}) => {
        if (tracker._endGesture && tracker._endGesture._desktopCubeWrapper) {
          tracker._endGesture = originalEndGesture;
        }
        if (originalGetBounds && tracker._getBounds?._desktopCubeBoundsWrapper) {
          tracker._getBounds = originalGetBounds;
        }
      });
    this._patchedSwipeTrackers = [];

    // Clean up skybox.
    if (this._skybox) {
      this._skybox.destroy();
      this._skybox = null;
    }

    Main.overview._overview.controls._workspaceAdjustment.disconnect(
      this._workspaceAdjustmentID);

    // Clean up the edge-workspace-switching.
    global.stage.disconnect(this._stageAllocationID);
    if (this._workspaceLayoutID) {
      global.workspace_manager.disconnect(this._workspaceLayoutID);
      this._workspaceLayoutID = 0;
    }
    if (this._overviewEdgeShowingID)
      Main.overview.disconnect(this._overviewEdgeShowingID);
    if (this._overviewEdgeHiddenID) Main.overview.disconnect(this._overviewEdgeHiddenID);
    if (this._desktopEdgeSettingID) this._settings.disconnect(this._desktopEdgeSettingID);
    if (this._overviewEdgeSettingID)
      this._settings.disconnect(this._overviewEdgeSettingID);
    global.display.disconnect(this._grabOpBeginID);
    global.display.disconnect(this._grabOpEndID);

    this._destroyEdgeSwitchBarriers?.();
    this._pressureBarrier.destroy();

    this._pressureBarrier           = null;
    this._leftBarrier               = null;
    this._rightBarrier              = null;
    this._rebuildEdgeSwitchBarriers = null;
    this._destroyEdgeSwitchBarriers = null;
    this._pitch                     = null;

    // Clean up perspective correction.
    this._disablePerspectiveCorrection();
    global.backend.get_monitor_manager().disconnect(this._monitorsChangedID);

    // Make sure that the settings object is freed.
    this._workspaceSwipeNaturalOrientations = null;
    this._workspaceSwipeForcedHorizontal    = null;
    this._settings                          = null;
  }

  // ----------------------------------------------------------------------- private stuff

  // Mutter exposes vertical workspaces as a one-column layout (layout_rows === -1).
  // V-Shell uses this native layout switch, so Desktop Cube does not need a hard runtime
  // dependency on V-Shell to recognize the workspace spire configuration.
  _isVerticalWorkspaceLayout() {
    return global.workspace_manager.layout_rows === -1;
  }

  _shouldUseHorizontalWorkspaceInput(isOverview) {
    if (!this._settings?.get_boolean('horizontal-workspace-input')) {
      return false;
    }

    // The Overview is always Desktop Cube's visual domain, so its carousel preference
    // applies there regardless of how ordinary desktop workspace changes are animated.
    if (isOverview) {
      return true;
    }

    // Outside the Overview, horizontal reinterpretation only makes sense while Desktop
    // Cube also owns the transition. If GNOME / V-Shell owns the animation, follow its
    // native workspace axis instead.
    return this._settings.get_boolean('enable-desktop-workspace-cube-animation');
  }

  _getWorkspaceSwipeTrackers() {
    // Do not touch Main.overview._swipeTracker: V-Shell intentionally changes that
    // tracker's axis for entering/leaving the overview. We only own the two trackers
    // whose scalar progress actually selects a workspace.
    return [
      {
        tracker: Main.wm?._workspaceAnimation?._swipeTracker,
        isOverview: false,
      },
      {
        tracker: Main.overview?._overview?._controls?._workspacesDisplay?._swipeTracker,
        isOverview: true,
      },
    ].filter(entry => entry.tracker);
  }

  _syncWorkspaceSwipeOrientation() {
    if (!this._settings) {
      return;
    }

    this._getWorkspaceSwipeTrackers().forEach(({tracker, isOverview}) => {
      const forceHorizontal = this._shouldUseHorizontalWorkspaceInput(isOverview);
      const currentlyForced = this._workspaceSwipeForcedHorizontal.has(tracker);

      if (forceHorizontal) {
        // Record the natural axis immediately before taking ownership. If V-Shell changes
        // the tracker while we are forcing horizontal, remember that newly requested axis
        // before reasserting the carousel orientation.
        if (!currentlyForced || tracker.orientation !== Clutter.Orientation.HORIZONTAL) {
          this._workspaceSwipeNaturalOrientations.set(tracker, tracker.orientation);
        }

        if (tracker.orientation !== Clutter.Orientation.HORIZONTAL) {
          tracker.orientation = Clutter.Orientation.HORIZONTAL;
        }
        this._workspaceSwipeForcedHorizontal.add(tracker);
        return;
      }

      if (currentlyForced) {
        const natural = this._workspaceSwipeNaturalOrientations.get(tracker);
        if (natural !== undefined && tracker.orientation !== natural) {
          tracker.orientation = natural;
        }
        this._workspaceSwipeForcedHorizontal.delete(tracker);
      } else {
        // While Desktop Cube is not overriding this tracker, GNOME / V-Shell is the
        // authority. Keep our remembered value fresh so a later temporary override can
        // restore exactly what the native stack requested.
        this._workspaceSwipeNaturalOrientations.set(tracker, tracker.orientation);
      }
    });
  }

  _syncWorkspaceInputPolicy() {
    if (!this._settings) {
      return;
    }

    this._syncWorkspaceSwipeOrientation();

    if (this._desktopDragGesture) {
      this._desktopDragGesture.gesture.horizontal =
        this._shouldUseHorizontalWorkspaceInput(false);
    }
    if (this._panelDragGesture) {
      this._panelDragGesture.gesture.horizontal =
        this._shouldUseHorizontalWorkspaceInput(false);
    }
    if (this._overviewDragGesture) {
      this._overviewDragGesture.gesture.horizontal =
        this._shouldUseHorizontalWorkspaceInput(true);
    }

    this._rebuildEdgeSwitchBarriers?.();
  }

  _restoreWorkspaceSwipeOrientation() {
    if (!this._workspaceSwipeNaturalOrientations ||
        !this._workspaceSwipeForcedHorizontal) {
      return;
    }

    // Only restore trackers Desktop Cube currently owns. Trackers already yielded to
    // GNOME / V-Shell may have legitimately changed since our last observation, and
    // disabling this extension must not overwrite that newer native state.
    this._workspaceSwipeForcedHorizontal.forEach(tracker => {
      const orientation = this._workspaceSwipeNaturalOrientations.get(tracker);
      if (orientation !== undefined && tracker?.orientation !== undefined &&
          tracker.orientation !== orientation) {
        tracker.orientation = orientation;
      }
    });
    this._workspaceSwipeNaturalOrientations.clear();
    this._workspaceSwipeForcedHorizontal.clear();
  }

  _shouldHideEmptyWorkspace() {
    return this._settings?.get_boolean('hide-empty-workspace') &&
      Meta.prefs_get_dynamic_workspaces() &&
      global.workspace_manager.get_n_workspaces() > 1;
  }

  _getLastVisibleWorkspaceIndex() {
    const count = global.workspace_manager.get_n_workspaces();
    return Math.max(0, count - 1 - (this._shouldHideEmptyWorkspace() ? 1 : 0));
  }

  _getCubeWorkspaces(workspaces) {
    if (!this._shouldHideEmptyWorkspace()) {
      return workspaces;
    }

    return workspaces.slice(
      0, Math.min(workspaces.length, this._getLastVisibleWorkspaceIndex() + 1));
  }

  _getCubeWorkspaceIndices() {
    if (!this._shouldHideEmptyWorkspace()) {
      return null;
    }

    return [...Array(this._getLastVisibleWorkspaceIndex() + 1).keys()];
  }

  _workspaceDirectionDelta(direction) {
    if (direction === Meta.MotionDirection.UP ||
        direction === Meta.MotionDirection.LEFT) {
      return -1;
    }
    if (direction === Meta.MotionDirection.DOWN ||
        direction === Meta.MotionDirection.RIGHT) {
      return 1;
    }
    return 0;
  }

  _resolveWorkspaceNeighbor(workspace, direction, neighbor) {
    const hideEmpty = this._shouldHideEmptyWorkspace();
    const looping   = this._settings?.get_boolean('allow-workspace-looping');
    if (!hideEmpty && !looping) {
      return neighbor;
    }

    const delta = this._workspaceDirectionDelta(direction);
    if (delta === 0) {
      return neighbor;
    }

    const currentIndex  = workspace.index();
    const lastVisible   = this._getLastVisibleWorkspaceIndex();
    const neighborIndex = neighbor?.index?.() ?? currentIndex;

    // If the underlying implementation points at the hidden dynamic workspace, treat it
    // as the end of the visible sequence. With looping enabled, continue at workspace 0;
    // otherwise remain on the current visible workspace.
    if (neighborIndex > lastVisible) {
      return looping && delta > 0 ? global.workspace_manager.get_workspace_by_index(0) :
                                    workspace;
    }

    // GNOME's stock get_neighbor() returns the current workspace when an edge is hit.
    // V-Shell may already return a wrapped neighbor; in that case we simply preserve it.
    if (neighbor === workspace && looping) {
      if (delta < 0 && currentIndex <= 0) {
        return global.workspace_manager.get_workspace_by_index(lastVisible);
      }
      if (delta > 0 && currentIndex >= lastVisible) {
        return global.workspace_manager.get_workspace_by_index(0);
      }
    }

    return neighbor;
  }

  _queueOverviewCubeUpdate() {
    const display = Main.overview?._overview?.controls?._workspacesDisplay;
    if (display?._overviewAdjustment) {
      display._overviewAdjustment.notify('value');
    }
  }

  _isAppGridActive() {
    return Main.overview.visible &&
      Main.overview._overview.controls._stateAdjustment.value >
      ControlsState.WINDOW_PICKER + 0.001;
  }

  _syncOverviewGestureInput() {
    if (this._overviewDragGesture) {
      this._overviewDragGesture.gesture.enabled =
        !this._isAppGridActive() && !this._spatial?.dragging && !this._spatial?.active;
    }
  }

  // V-Shell refreshes several monkey-patches when its preferences change. Desktop Cube
  // used to assume that its own prototype overrides would remain installed forever,
  // making behavior depend on extension activation order. Rebase our wrappers on whatever
  // method is currently active instead. This composes with V-Shell rather than replacing
  // it.
  _ensureCompatibilityPatches() {
    const rebase = (target, symbol, wrapper, originalField) => {
      if (!target || !wrapper) {
        return;
      }

      const current = target[symbol];
      if (current !== wrapper) {
        this[originalField] = current;
        target[symbol]      = wrapper;
      }
    };

    rebase(WorkspacesView.prototype, '_updateVisibility', this._cubeUpdateVisibility,
           '_origUpdateVisibility');
    rebase(WorkspacesView.prototype, '_getSpacing', this._cubeGetSpacing,
           '_origGetSpacing');
    rebase(WorkspacesView.prototype, '_updateWorkspacesState',
           this._cubeUpdateWorkspacesState, '_origUpdateWorkspacesState');
    rebase(Meta.Workspace.prototype, 'get_neighbor', this._cubeGetNeighbor,
           '_origGetNeighbor');

    const controller = Main.wm._workspaceAnimation;
    rebase(controller, '_prepareWorkspaceSwitch', this._cubePrepSwitch,
           '_origPrepSwitch');
    rebase(controller, '_finishWorkspaceSwitch', this._cubeFinalSwitch,
           '_origFinalSwitch');

    // V-Shell may recreate or reconfigure its workspace SwipeTracker while refreshing
    // modules. Reassert this fork's input-axis policy whenever compatibility is rebased.
    this._syncWorkspaceSwipeOrientation();
  }

  // Calls inhibit_culling on the given actor and recursively on all mapped children.
  _inhibitCulling(actor) {
    if (actor.mapped) {
      actor.inhibit_culling();
      actor._culling_inhibited_by_desktop_cube = true;
      actor.get_children().forEach(c => this._inhibitCulling(c));
    }
  };

  // Calls uninhibit_culling on the given actor and recursively on all children. It will
  // only call uninhibit_culling() on those actors which were inhibited before.
  _uninhibitCulling(actor) {
    if (actor._culling_inhibited_by_desktop_cube) {
      delete actor._culling_inhibited_by_desktop_cube;
      actor.uninhibit_culling();
      actor.get_children().forEach(c => this._uninhibitCulling(c));
    }
  };

  // Returns a value between [0...1] blending between overview (0) and app grid mode (1).
  _getAppDrawerMode(workspacesView) {
    // Fit-all is a layout choice, not the app-grid state. V-Shell may leave fit
    // at SINGLE when thumbnails are disabled, even while the app grid is open.
    return Math.max(workspacesView._fitModeAdjustment.value,
                    Math.clamp(workspacesView._overviewAdjustment.value - 1, 0, 1));
  }

  // Returns a value between [0...1] blending between desktop / app drawer mode (0) and
  // overview mode (1).
  _getOverviewMode(workspacesView) {
    return Math.clamp(workspacesView._overviewAdjustment.value -
                        2 * this._getAppDrawerMode(workspacesView),
                      0, 1);
  }

  // Returns a value between [0...1]. If it's 0, the cube should be unfolded, if it's 1,
  // the cube should be drawn like, well, a cube :).
  _getCubeMode(workspacesView) {
    return 1 - this._getAppDrawerMode(workspacesView)
  }

  // Returns the angle between consecutive workspaces.
  _getFaceAngle(faceCount) {

    // Looping makes the topology explicitly circular, so the first and last visible
    // workspace must be adjacent faces. For two workspaces this naturally produces two
    // opposite sides of a flat 180° surface.
    if (this._settings.get_boolean('allow-workspace-looping')) {
      return 360.0 / faceCount;
    }

    // With this setting, our "cube" only covers 180°, if there are only two workspaces,
    // it covers 90°. This prevents the affordance that it could be possible to switch
    // from the last ot the first workspace.
    if (this._settings.get_boolean('last-first-gap')) {
      return (faceCount == 2 ? 90 : 180) / (faceCount - 1);
    }

    // Else the "cube" covers 360°.
    return 360.0 / faceCount;
  }

  // Returns the z-distance from the cube faces to the rotation pivot.
  _getCenterDist(workspaceWidth, faceAngle) {
    let centerDepth = workspaceWidth / 2;
    if (faceAngle < 180) {
      centerDepth /= Math.tan(faceAngle * 0.5 * Math.PI / 180);
    }
    return centerDepth;
  }

  // This sorts the given list of children actors (which are supposed to be attached to
  // the same parent) by increasing absolute rotation-y angle. This is used for
  // depth-sorting, as cube faces which are less rotated, are in front of others.
  _depthSortCubeFaces(actors) {
    // First create a copy of the actors list and sort it by decreasing rotation angle.
    const copy = actors.slice();
    copy.sort((a, b) => {
      return Math.abs(b.rotation_angle_y) - Math.abs(a.rotation_angle_y);
    });

    // Then sort the children actors accordingly.
    const parent = actors[0].get_parent();
    for (let i = 0; i < copy.length; i++) {
      parent.set_child_at_index(copy[i], i);
    }
  }

  // This sorts the given list of children actors (which are supposed to be attached to
  // the same parent) by increasing orthogonal distance to the camera. To do this, the
  // camera position is projected onto the plane defined by the actor and the absolute
  // distance from the camera to its projected position is computed. This is used for
  // depth-sorting a list of parallel actors.
  _depthSortWindowActors(actors, monitorIndex) {

    // Sanity check.
    if (actors.length <= 1) {
      return;
    }

    // First, compute distance of virtual camera to the front workspace plane.
    const camera = new Graphene.Point3D({
      x: global.stage.width / 2,
      y: global.stage.height / 2,
      z: global.stage.height /
        (2 * Math.tan(global.stage.perspective.fovy / 2 * Math.PI / 180))
    });

    // All actors are expected to share the same parent.
    const parent = actors[0].get_parent();

    // If the perspective is corrected for multi-monitor setups, the virtual camera is not
    // in the middle of the stage but rather in front of each monitor.
    if (this._enablePerMonitorPerspective) {

      let monitor;

      if (!Meta.is_wayland_compositor || Meta.is_wayland_compositor()) {

        // On Wayland, each monitor should have its own StageView. Therefore, the virtual
        // camera has been positioned in front of each monitor separately.
        monitor = global.display.get_monitor_geometry(monitorIndex);

      } else {

        // On X11, there's only one StageView. We move the virtual camera so that it is in
        // front of the primary monitor.
        monitor =
          global.display.get_monitor_geometry(global.display.get_primary_monitor());
      }

      camera.x = monitor.x + monitor.width / 2;
      camera.y = monitor.y + monitor.height / 2;
    }

    // Create a list of the orthogonal distances to the camera for each actor.
    const distances = actors.map((a, i) => {
      // A point on the actor plane.
      const onActor = a.apply_relative_transform_to_point(
        null, new Graphene.Point3D({x: 0, y: 0, z: 0}));

      // A point one unit above the actor plane.
      const aboveActor = a.apply_relative_transform_to_point(
        null, new Graphene.Point3D({x: 0, y: 0, z: 1000}));

      // The normal vector on the actor plane.
      const normal = new Graphene.Point3D({
        x: aboveActor.x - onActor.x,
        y: aboveActor.y - onActor.y,
        z: aboveActor.z - onActor.z,
      });

      const length =
        Math.sqrt(normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
      normal.x /= length;
      normal.y /= length;
      normal.z /= length;

      onActor.x -= camera.x;
      onActor.y -= camera.y;
      onActor.z -= camera.z;

      // Return the length of the projected vector.
      return {
        index: i,
        distance: onActor.x * normal.x + onActor.y * normal.y + onActor.z * normal.z
      };
    });

    // Sort by decreasing distance.
    distances.sort((a, b) => {
      return Math.abs(b.distance) - Math.abs(a.distance);
    });

    // Then use this to create a sorted list of actors.
    const copy = distances.map(e => {
      return actors[e.index];
    });

    // Finally, sort the children actors accordingly.
    for (let i = 0; i < copy.length; i++) {
      parent.set_child_at_index(copy[i], i);
    }
  }

  // During rotations, the cube is scaled down and the windows are "exploded". If we
  // are directly facing a cube side, the strengths of both effects are approaching
  // zero. The strengths of both effects are small during horizontal rotations to make
  // workspace-switching not so obtrusive. However, during vertical rotations, the
  // effects are stronger.
  // This method returns two values:
  // result[0]: A translation value by which the cube should be moved backwards.
  // result[1]: A translation value by which windows may be moved away from the cube.
  _getExplodeFactors(hRotation, vRotation, centerDepth, monitorIndex) {

    // These are zero if we are facing a workspace and one if we look directly at an
    // edge between adjacent workspaces or if the cube is rotated vertically
    // respectively.
    const hFactor = 1.0 - 2.0 * Math.abs(hRotation % 1 - 0.5);
    const vFactor = Math.abs(vRotation);

    // For horizontal rotations, we want to scale the cube (or rather move it backwards)
    // a tiny bit to reveal a bit of parallax. However, if we have many cube sides, this
    // looks weird, so we reduce the effect there. We use the offset which would make
    // the cube's corners stay behind the original workspace faces during he rotation.
    const monitor = global.display.get_monitor_geometry(monitorIndex);
    const cornerDist =
      Math.sqrt(Math.pow(centerDepth, 2) + Math.pow(monitor.width / 2, 2));
    const hDepthOffset =
      this._settings.get_double('window-parallax') * (cornerDist - centerDepth);

    // The explode factor is set to the hDepthOffset value to make the front-most
    // window stay at a constant depth.
    const hExplode = hDepthOffset;

    // For vertical rotations, we move the cube backwards to reveal everything. The
    // maximum explode width is set to half of the workspace size.
    const vExplode = this._settings.get_boolean('do-explode') ?
      Math.max(monitor.width, monitor.height) / 2 :
      0;
    const diameter = 2 * (vExplode + centerDepth);
    const camDist =
      monitor.height / (2 * Math.tan(global.stage.perspective.fovy / 2 * Math.PI / 180));
    const vDepthOffset =
      (1 + PADDING_V_ROTATION) * diameter * camDist / monitor.width - centerDepth;

    // Use current maximum of both values.
    const depthOffset = Math.max(hFactor * hDepthOffset, vFactor * vDepthOffset);
    const explode     = Math.max(hFactor * hExplode, vFactor * vExplode);

    // Do not explode the cube in app drawer state. The stateAdjustment is...
    // ... 0 on the desktop
    // ... 1 in the window picker
    // ... 2 in the app drawer
    const windowPickerFactor =
      Math.min(1.0, 2.0 - Main.overview._overview.controls._stateAdjustment.value);

    return [depthOffset * windowPickerFactor, explode * windowPickerFactor];
  }

  // Usually, GNOME Shell uses one central perspective for all monitors combined. This
  // results in a somewhat sheared appearance of the cube on multi-monitor setups where
  // the primary monitor is not in the middle (or cubes are shown on multiple monitors).
  // With the code below, we modify the projection and view matrices for each monitor so
  // that each monitor uses its own central perspective. This seems to be possible on
  // Wayland only. On X11, there's only one set of projection and view matrices for all
  // monitors combined, so we tweak them so that the projection center is in the middle of
  // the primary monitor. So it will at least only look bad on X11 if the cube is shown on
  // all monitors...
  _enablePerspectiveCorrection() {

    this._stageBeforeUpdateID = global.stage.connect('before-update', (stage, view) => {
      // Do nothing if neither overview or desktop switcher are shown.
      if (!Main.overview.visible && Main.wm._workspaceAnimation._switchData == null) {
        return;
      }

      // Usually, the virtual camera is positioned centered in front of the stage. We will
      // move the virtual camera around. These variables will be the new stage-relative
      // coordinates of the virtual camera.
      let cameraX, cameraY;

      if (!Meta.is_wayland_compositor || Meta.is_wayland_compositor()) {

        // On Wayland, each monitor has its own StageView. Therefore we can move the
        // virtual camera for each monitor separately.
        cameraX = view.layout.x + view.layout.width / 2;
        cameraY = view.layout.y + view.layout.height / 2;

      } else {

        // On X11, there's only one StageView. We move the virtual camera so that it is in
        // front of the current monitor.
        const currentMonitorRect =
          global.display.get_monitor_geometry(global.display.get_current_monitor());

        cameraX = currentMonitorRect.x + currentMonitorRect.width / 2;
        cameraY = currentMonitorRect.y + currentMonitorRect.height / 2;
      }

      // This is the offset to the original, centered camera position. Y is flipped due to
      // some negative scaling at some point in Mutter.
      const camOffsetX = stage.width / 2 - cameraX;
      const camOffsetY = cameraY - stage.height / 2;

      const z_near = stage.perspective.z_near;
      const z_far  = stage.perspective.z_far;

      // The code below is copied from Mutter's Clutter.
      // https://gitlab.gnome.org/GNOME/mutter/-/blob/main/clutter/clutter/clutter-stage.c#L2255
      const A = 0.57735025882720947265625;
      const B = 0.866025388240814208984375;
      const C = 0.86162912845611572265625;
      const D = 0.00872653536498546600341796875;

      const z_2d = z_near * A * B * C / D + z_near;

      // The code below is copied from Mutter's Clutter as well.
      // https://gitlab.gnome.org/GNOME/mutter/-/blob/main/clutter/clutter/clutter-stage.c#L2270
      const top    = z_near * Math.tan(stage.perspective.fovy * Math.PI / 360.0);
      const left   = -top * stage.perspective.aspect;
      const right  = top * stage.perspective.aspect;
      const bottom = -top;

      const left_2d_plane   = left / z_near * z_2d;
      const right_2d_plane  = right / z_near * z_2d;
      const bottom_2d_plane = bottom / z_near * z_2d;
      const top_2d_plane    = top / z_near * z_2d;

      const width_2d_start  = right_2d_plane - left_2d_plane;
      const height_2d_start = top_2d_plane - bottom_2d_plane;

      const width_scale  = width_2d_start / stage.width;
      const height_scale = height_2d_start / stage.height;
      // End of the copy-paste code.

      // Compute the required offset of the frustum planes at the near plane. This
      // basically updates the projection matrix according to our new camera position.
      const offsetX = camOffsetX * width_scale / z_2d * z_near;
      const offsetY = camOffsetY * height_scale / z_2d * z_near;

      // Set the new frustum.
      view.get_framebuffer().frustum(left + offsetX, right + offsetX, bottom + offsetY,
                                     top + offsetY, z_near, z_far);

      // Translate the virtual camera. This basically updates the view matrix according to
      // our new camera position.
      view.get_framebuffer().push_matrix();
      view.get_framebuffer().translate(camOffsetX * width_scale,
                                       camOffsetY * height_scale, 0);

      // If the perspective of each monitor is computed separately, the culling of GNOME
      // Shell does not work anymore as it still uses the original frustum. The only
      // workaround is to disable culling altogether. This will be bad performance-wise,
      // but I do not see an alternative.
      // If the overview is shown, we inhibit culling for the WorkspacesDisplay. If the
      // desktop-workspace-switcher is shown, we inhibit culling for all shown monitor
      // groups.
      if (Main.overview.visible) {
        this._inhibitCulling(Main.overview._overview.controls._workspacesDisplay);
      } else if (Main.wm._workspaceAnimation._switchData) {
        Main.wm._workspaceAnimation._switchData.monitors.forEach(m => {
          this._inhibitCulling(m);
        });
      }
    });

    // Revert the matrix changes before the update,
    this._stageAfterUpdateID = global.stage.connect('after-update', (stage, view) => {
      // Nothing to do if neither overview or desktop switcher are shown.
      if (!Main.overview.visible && Main.wm._workspaceAnimation._switchData == null) {
        return;
      }

      view.get_framebuffer().pop_matrix();
      view.get_framebuffer().perspective(stage.perspective.fovy, stage.perspective.aspect,
                                         stage.perspective.z_near,
                                         stage.perspective.z_far);

      // Re-enable culling for all relevant actors.
      if (Main.overview.visible) {
        this._uninhibitCulling(Main.overview._overview.controls._workspacesDisplay);
      } else if (Main.wm._workspaceAnimation._switchData) {
        Main.wm._workspaceAnimation._switchData.monitors.forEach(m => {
          this._uninhibitCulling(m);
        });
      }
    });
  }

  // Reverts the changes done with the method above.
  _disablePerspectiveCorrection() {

    if (this._stageBeforeUpdateID) {
      global.stage.disconnect(this._stageBeforeUpdateID);
      this._stageBeforeUpdateID = 0;
    }

    if (this._stageAfterUpdateID) {
      global.stage.disconnect(this._stageAfterUpdateID);
      this._stageAfterUpdateID = 0;
    }
  }

  _patchWorkspaceSwipeTracker(tracker, isOverview = false) {
    if (this._patchedSwipeTrackers.some(entry => entry.tracker === tracker)) {
      return;
    }

    const originalEndGesture = tracker._endGesture;
    const endWrapper         = function(time, distance, isTouchpad) {
      // Add a final zero-delta sample so releasing the mouse after a pause does not look
      // like a high-velocity fling. This is intentionally scoped to workspace trackers.
      this._history.append(time, 0);
      return originalEndGesture.apply(this, [time, distance, isTouchpad]);
    };
    endWrapper._desktopCubeWrapper = true;
    tracker._endGesture            = endWrapper;

    let originalGetBounds = null;
    if (isOverview && typeof tracker._getBounds === 'function') {
      originalGetBounds   = tracker._getBounds;
      const extensionThis = this;
      const boundsWrapper = function(initialProgress) {
        const bounds = originalGetBounds.apply(this, [initialProgress]);
        if (!extensionThis._shouldHideEmptyWorkspace()) {
          return bounds;
        }

        // Keep the overview SwipeTracker from landing on the trailing empty dynamic
        // workspace. This preserves GNOME's real adjustment and actor list while making
        // the hidden face unreachable through Desktop Cube's pointer/touch gesture.
        return [
          bounds[0], Math.min(bounds[1], extensionThis._getLastVisibleWorkspaceIndex())
        ];
      };
      boundsWrapper._desktopCubeBoundsWrapper = true;
      tracker._getBounds                      = boundsWrapper;
    }

    this._patchedSwipeTrackers.push({tracker, originalEndGesture, originalGetBounds});
  }

  // This creates a custom drag gesture and adds it to the given SwipeTracker. The swipe
  // tracker will now also respond to single-pointer drags. Horizontal carousel-style
  // input is the default; users can opt back into following the vertical workspace axis.
  // Orthogonal drag movement is reported via the "pitch" property. This method returns an
  // object containing the gesture, an St.Adjustment which will contain this pitch value,
  // and a connection ID which is used by _removeDragGesture() to clean up. When the
  // SwipeTracker's gesture ends, the St.Adjustment's value will be eased to zero.
  _addDragGesture(actor, tracker, mode) {
    this._patchWorkspaceSwipeTracker(tracker, mode === Shell.ActionMode.OVERVIEW);
    const gesture = new DragGesture(actor, mode);

    if (utils.shellVersionIsAtLeast(49, 'beta')) {
      gesture.connect('begin', tracker._beginTouchpadGesture.bind(tracker));
      gesture.connect('update', tracker._updateTouchpadGesture.bind(tracker));
      gesture.connect('end', tracker._endTouchpadGesture.bind(tracker));
    } else {
      gesture.connect('begin', tracker._beginGesture.bind(tracker));
      gesture.connect('update', tracker._updateGesture.bind(tracker));
      gesture.connect('end', tracker._endTouchGesture.bind(tracker));
    }

    tracker.bind_property('distance', gesture, 'distance',
                          GObject.BindingFlags.SYNC_CREATE);

    // Update the gesture's sensitivity from settings. The input axis is
    // context-sensitive: the Overview can keep Desktop Cube's horizontal carousel while
    // desktop-mode gestures follow GNOME / V-Shell whenever the cube animation is
    // disabled.
    this._settings.bind('mouse-rotation-speed', gesture, 'sensitivity',
                        Gio.SettingsBindFlags.GET);
    gesture.horizontal =
      this._shouldUseHorizontalWorkspaceInput(mode === Shell.ActionMode.OVERVIEW);

    // Connect the gesture's pitch property to the pitch adjustment.
    gesture.bind_property('pitch', this._pitch, 'value', 0);

    // Ease the pitch adjustment to zero if the SwipeTracker reports an ended gesture.
    // This ensures that the cube smoothly rotates back when released. The end-signal
    // returns a suitable duration for this, however this depends on the horizontal
    // rotation required to move the cube back. Here, we compute a duration required for
    // the vertical rotation and use the maximum of both values for the final easing.
    const gestureEndID = tracker.connect('end', (g, duration) => {
      this._pitch.remove_transition('value');
      this._pitch.ease(0, {
        duration: Math.max(500 * Math.abs(this._pitch.value), duration),
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
      });
    });

    // We return all things which are required to remove the gesture again. This can be
    // done with the _removeDragGesture() method below.
    return {
      actor: actor,
      tracker: tracker,
      gesture: gesture,
      trackerConnection: gestureEndID
    };
  }

  // Removes a single-click drag gesture created earlier via _addDragGesture(). The info
  // parameter should be the object returned by _addDragGesture().
  _removeDragGesture(info) {
    info.gesture.destroy();
    info.tracker.disconnect(info.trackerConnection);
  }

  // Calls _addDragGesture() for the SwipeTracker and actor responsible for
  // workspace-switching in desktop mode when dragging on the background.
  _addDesktopDragGesture() {
    // The SwipeTracker for switching workspaces in desktop mode is created here:
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/workspaceAnimation.js#L285
    const tracker = Main.wm._workspaceAnimation._swipeTracker;
    let actor     = Main.layoutManager._backgroundGroup;
    const mode    = Shell.ActionMode.NORMAL;

    // If not in the overview, you can usually only swipe to adjacent workspaces. This
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/swipeTracker.js#L633
    // allows us to override this behavior.
    tracker.allowLongSwipes = true;

    // We have to make the background reactive. Make sure to store the current state so
    // that we can reset it later.
    this._origBackgroundReactivity = actor.reactive;
    actor.reactive                 = true;

    this._desktopDragGesture = this._addDragGesture(actor, tracker, mode);
  }

  // Calls _addDragGesture() for the SwipeTracker and actor responsible for
  // workspace-switching in desktop mode when dragging on the panel.
  _addPanelDragGesture() {
    // The SwipeTracker for switching workspaces in desktop mode is created here:
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/workspaceAnimation.js#L285
    const tracker = Main.wm._workspaceAnimation._swipeTracker;
    const actor   = Main.panel;
    const mode    = Shell.ActionMode.NORMAL;

    // If not in the overview, you can usually only swipe to adjacent workspaces. This
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/swipeTracker.js#L633
    // allows us to override this behavior.
    tracker.allowLongSwipes = true;

    if (GS_VERSION >= 50) {
      // The panel actor itself must be reactive so it receives pointer events that land
      // on empty areas between panel children (clock, status icons, etc.). Without this,
      // those events are swallowed by the stage and never reach the DragGesture. Save the
      // current state so we can restore it on removal.
      this._origPanelReactivity = actor.reactive;
      actor.reactive            = true;

      // On GNOME 50+, the panel has a built-in Clutter.ClickGesture (the 'window-drag'
      // action) with recognize_on_press:true. This gesture fires immediately on
      // mouse-down and starts a window grab operation (begin_grab_op), which steals all
      // subsequent pointer events and prevents our DragGesture from ever seeing motion
      // events. We disable it while panel dragging is active and restore it on removal.
      if (actor._clickGesture) {
        this._origPanelClickGestureEnabled = actor._clickGesture.enabled;
        actor._clickGesture.enabled        = false;
      }
    } else {
      // On older GNOME versions, we have to prevent moving fullscreen windows when
      // dragging. The _tryDragWindow method does not exist on GNOME 50+.
      this._origPanelTryDragWindow = actor._tryDragWindow;
      actor._tryDragWindow = () => Clutter.EVENT_PROPAGATE;
    }

    this._panelDragGesture = this._addDragGesture(actor, tracker, mode);
  }

  // Calls _addDragGesture() for the SwipeTracker and actor responsible for
  // workspace-switching in overview mode.
  _addOverviewDragGesture() {
    // The SwipeTracker for switching workspaces in overview mode is created here:
    // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/workspacesView.js#L827
    const tracker = Main.overview._overview._controls._workspacesDisplay._swipeTracker;
    const actor   = Main.layoutManager.overviewGroup;
    const mode    = Shell.ActionMode.OVERVIEW;

    this._overviewDragGesture = this._addDragGesture(actor, tracker, mode);
    this._syncOverviewGestureInput();
  }

  // Calls _removeDragGesture() for the SwipeTracker and actor responsible for
  // workspace-switching in desktop mode when dragging on the background.
  _removeDesktopDragGesture() {
    if (this._desktopDragGesture) {

      // Restore original behavior.
      this._desktopDragGesture.tracker.allowLongSwipes = false;

      // Make sure to restore the original state.
      this._desktopDragGesture.actor.reactive = this._origBackgroundReactivity;

      this._removeDragGesture(this._desktopDragGesture);

      delete this._desktopDragGesture;
    }
  }

  // Calls _removeDragGesture() for the SwipeTracker and actor responsible for
  // workspace-switching in desktop mode when dragging on the panel.
  _removePanelDragGesture() {
    if (this._panelDragGesture) {

      // Restore original behavior.
      this._panelDragGesture.tracker.allowLongSwipes = false;

      if (GS_VERSION >= 50) {
        // Make sure to restore the original state.
        this._panelDragGesture.actor.reactive = this._origPanelReactivity;

        // Restore the panel's built-in window-drag click gesture if we disabled it.
        if (this._panelDragGesture.actor._clickGesture &&
            this._origPanelClickGestureEnabled !== undefined) {
          this._panelDragGesture.actor._clickGesture.enabled =
            this._origPanelClickGestureEnabled;
          delete this._origPanelClickGestureEnabled;
        }
      } else {
        // On older GNOME versions, restore the original _tryDragWindow method.
        this._panelDragGesture.actor._tryDragWindow = this._origPanelTryDragWindow;
      }

      this._removeDragGesture(this._panelDragGesture);

      delete this._panelDragGesture;
    }
  }

  // Calls _removeDragGesture() for the SwipeTracker and actor responsible for
  // workspace-switching in overview mode.
  _removeOverviewDragGesture() {
    if (this._overviewDragGesture) {
      this._removeDragGesture(this._overviewDragGesture);

      delete this._overviewDragGesture;
    }
  }
}

// This function is called once when the extension is loaded, not enabled.
function init() {
  return new Extension();
}
