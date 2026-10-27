// SPDX-FileCopyrightText: Eidrien
// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {atEdge, oppositeSide, SIDES} from './spatialPolicy.js';

const DOCKS = [
  'dash-to-dock-adaptive@eidrien.local', 'dash-to-dock@micxgx.gmail.com',
  'ubuntu-dock@ubuntu.com'
];

// The existing workspace actors are the drop targets. Cube delegates their
// geometry to the underlying GNOME/V-Shell layout during the temporary spread.
export class SpatialOverview {
  constructor(owner) {
    this._owner    = owner;
    this._settings = owner._settings;
    this._signals  = [];
    this._modules  = new Map();
    this._connect(Main.overview, 'window-drag-begin',
                  (_overview, window) => this.begin(window));
    this._connect(Main.overview, 'window-drag-end', () => this.end());
    this._connect(Main.overview, 'window-drag-cancelled', () => this.end());
    this._connect(Main.overview, 'hiding', () => this.end());
    this._connect(Main.layoutManager, 'monitors-changed', () => this.end());
    this._connect(Main.extensionManager, 'extension-state-changed',
                  () => this._loadDocks());
    this._connect(this._settings, 'changed::spatial-overview', () => this.end());
    this._connect(Main.overview._overview.controls._stateAdjustment, 'notify::value',
                  () => {
                    if (this._owner._isAppGridActive()) this.end();
                  });
    this._loadDocks();
  }

  get dragging() {
    return !!this._dragging;
  }
  get active() {
    return !!this._engaged;
  }

  _connect(object, signal, callback) {
    this._signals.push([object, object.connect(signal, callback)]);
  }

  async _loadDocks() {
    const generation = this._dockGeneration = (this._dockGeneration ?? 0) + 1;
    const modules                           = new Map();
    for (const uuid of DOCKS) {
      const info = Main.extensionManager.lookup(uuid);
      if (info?.state !== 1) continue;
      try {
        modules.set(
          uuid,
          await import(Gio.File.new_for_path(`${info.path}/extension.js`).get_uri()));
      } catch (_error) {
        // Settings and the native dash remain available as fallbacks.
      }
    }
    if (!this._destroyed && generation === this._dockGeneration) this._modules = modules;
  }

  dockSide(monitorIndex) {
    for (const uuid of DOCKS) {
      const info = Main.extensionManager.lookup(uuid);
      if (info?.state !== 1) continue;
      const manager = this._modules.get(uuid)?.dockManager;
      const dock    = manager?.getDockByMonitor?.(monitorIndex);
      if (dock && SIDES[dock.position]) return SIDES[dock.position];
      // A missing per-monitor dock is not the main dock on another monitor.
      if (manager?.getDockByMonitor) continue;
      try {
        const settings = info.stateObj?.getSettings();
        const side     = settings?.get_enum('dock-position');
        if (SIDES[side]) return SIDES[side];
      } catch (_error) { /* An unrelated extension may use another schema. */
      }
    }
    const dash    = Main.overview.dash;
    const monitor = Main.layoutManager.monitors[monitorIndex];
    if (dash?.mapped && monitor) {
      const [x, y] = dash.get_transformed_position();
      const [w, h] = dash.get_transformed_size();
      const cx = x + w / 2, cy = y + h / 2;
      if (cx >= monitor.x && cx < monitor.x + monitor.width && cy >= monitor.y &&
          cy < monitor.y + monitor.height) {
        const distances = [
          cy - monitor.y, monitor.x + monitor.width - cx, monitor.y + monitor.height - cy,
          cx - monitor.x
        ];
        return SIDES[distances.indexOf(Math.min(...distances))];
      }
    }
    return null;
  }

  edge(monitorIndex) {
    const dock =
      this._settings.get_boolean('spatial-auto-edge') && this.dockSide(monitorIndex);
    return dock ? oppositeSide(dock) : this._settings.get_string('spatial-edge');
  }

  begin(window) {
    if (this._destroyed || !this._settings.get_boolean('spatial-overview') ||
        this._owner._isAppGridActive())
      return;
    this._close();
    this._dragging = true;
    this._window   = window;
    this._owner._syncOverviewGestureInput();
    this._owner._refreshEdgeSwitchBarriers?.();
    this._monitor = {
      dragMotion: event => {
        this.motion(event.x, event.y);
        return DND.DragMotionResult.CONTINUE;
      },
    };
    DND.addDragMonitor(this._monitor);
  }

  motion(x, y) {
    if (!this._dragging) return;
    if (this._engaged) return;
    const index = Main.layoutManager.monitors.findIndex(
      m => x >= m.x && y >= m.y && x < m.x + m.width && y < m.y + m.height);
    if (index < 0) return this._cancelEdge();
    const side  = this.edge(index);
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    if (!atEdge(x, y, Main.layoutManager.monitors[index], side, 24 * scale)) {
      this._cancelEdge();
      return;
    }
    const key = `${index}:${side}`;
    if (this._edgeKey === key) return;
    this._cancelEdge();
    this._edgeKey   = key;
    this._edgeTimer = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT, this._settings.get_uint('spatial-edge-delay-ms'), () => {
        this._edgeTimer = 0;
        if (this._dragging && side === this.edge(index)) this.show(index);
        return GLib.SOURCE_REMOVE;
      });
  }

  _cancelEdge() {
    if (this._edgeTimer) GLib.source_remove(this._edgeTimer);
    this._edgeTimer = 0;
    this._edgeKey   = null;
  }

  show(monitorIndex) {
    if (!this._dragging || this._engaged || this._owner._isAppGridActive()) return;
    this._monitorIndex = monitorIndex;
    this._display      = Main.overview._overview.controls._workspacesDisplay;
    this._fit          = this._display._fitModeAdjustment;
    this._oldFit       = this._fit.value;
    const adjustments  = new Set([this._fit]);
    for (const view of this._display._workspacesViews ?? []) {
      const fit = (view._workspacesView ?? view)._fitModeAdjustment;
      if (fit) adjustments.add(fit);
    }
    this._fits             = [...adjustments].map(adjustment => ({
                                        adjustment,
                                        value: adjustment.value,
                                        upper: adjustment.upper,
                                      }));
    this._engaged          = true;
    this._workspaceTracker = Main.wm._workspaceTracker;
    this._workspaceTracker.blockUpdates();
    for (const {adjustment} of this._fits) {
      // Secondary-monitor views normally pin their independent adjustment to
      // fit-single. Temporarily allow the same native fit-all layout there.
      adjustment.remove_transition('value');
      if (adjustment.upper < 1) adjustment.upper = 1;
      adjustment.ease(1, {duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
    // Not an Overview state transition: notifying the state adjustment here
    // would tell GNOME to replace our fit-all request with WINDOW_PICKER's fit-single.
    this._display.queue_relayout();
  }

  _queueEnd() {
    if (this._finishIdle) return;
    // DND can emit end while acceptDrop still owns the picked actor.
    this._finishIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this._finishIdle = 0;
      this._close();
      return GLib.SOURCE_REMOVE;
    });
  }

  end() {
    if (!this._dragging && !this._engaged && !this._edgeTimer) return;
    if (this._engaged && !this._destroyed) {
      this._queueEnd();
      this._dragging = false;
      return;
    }
    this._close();
  }

  _close() {
    const wasEngaged = this._engaged;
    if (this._finishIdle) GLib.source_remove(this._finishIdle);
    this._finishIdle = 0;
    this._cancelEdge();
    this._dragging = false;
    if (this._monitor) DND.removeDragMonitor(this._monitor);
    this._monitor = null;
    const appGrid = this._owner._isAppGridActive();
    for (const {adjustment, value, upper} of this._fits ?? []) {
      adjustment.remove_transition('value');
      const target     = appGrid ? (this._display._getFitModeForState?.(2) ?? 1) : value;
      adjustment.value = upper === undefined ? target : Math.min(target, upper);
      if (upper !== undefined) adjustment.upper = upper;
    }
    this._fits    = null;
    this._engaged = false;
    this._fit     = null;
    this._display = null;
    if (wasEngaged) this._owner?._queueOverviewCubeUpdate();
    this._workspaceTracker?.unblockUpdates();
    this._workspaceTracker = null;
    this._window           = null;
    this._owner?._syncOverviewGestureInput();
    this._owner?._refreshEdgeSwitchBarriers?.();
  }

  destroy() {
    this._destroyed = true;
    this._dockGeneration++;
    if (this._finishIdle) GLib.source_remove(this._finishIdle);
    this._finishIdle = 0;
    for (const [object, id] of this._signals) object.disconnect(id);
    this._signals = [];
    this._close();
    this._modules.clear();
    this._owner = null;
  }
}
