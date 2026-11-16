// SPDX-FileCopyrightText: Eidrien
// SPDX-License-Identifier: MIT
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Workspace} from 'resource:///org/gnome/shell/ui/workspace.js';

export function stickyOnFace(sticky, face, active) {
  return !sticky || face === null || face === active;
}

// Only presentation actors are changed. Window stickiness, workspace membership,
// source actor visibility and native drag/drop operations remain Shell-owned.
export class StickyPresentation {
  constructor(owner) {
    this._owner     = owner;
    this._enabled   = true;
    this._signals   = [];
    this._windows   = new Map();
    this._affected  = new Set();
    this._groups    = new Map();
    this._patches   = [];
    this._dropDepth = 0;
    const policy    = this;
    const proto = Workspace.prototype, original = proto._isMyWindow;
    this._patch(proto, '_isMyWindow', function(window) {
      return original.call(this, window) &&
        (!policy._enabled || policy._dropDepth ||
         stickyOnFace(window.is_on_all_workspaces(), this.metaWorkspace?.index() ?? null,
                      global.workspace_manager.get_active_workspace_index()));
    });
    for (const name of ['handleDragOver', 'acceptDrop']) {
      const method = proto[name];
      this._patch(proto, name, function(...args) {
        policy._dropDepth++;
        try {
          return method.apply(this, args);
        } finally {
          policy._dropDepth--;
        }
      });
    }
    this._connect(global.display, 'window-created', (_d, w) => this._watch(w));
    this._connect(global.display, 'restacked', () => this.queue());
    this._connect(global.workspace_manager, 'active-workspace-changed',
                  () => this.queue());
    this._connect(Main.overview, 'shown', () => this.queue());
    this._connect(Main.overview, 'window-drag-begin', (_o, w) => {
      this._dragged = w;
    });
    const end = () => {
      this._dragged = null;
      this.queue();
    };
    this._connect(Main.overview, 'window-drag-end', end);
    this._connect(Main.overview, 'window-drag-cancelled', end);
    for (const actor of global.get_window_actors()) this._watch(actor.meta_window);
    this.queue();
  }
  _patch(object, name, wrapper) {
    const original = object[name];
    object[name]   = wrapper;
    this._patches.push({object, name, original, wrapper});
  }
  _connect(object, signal, callback) {
    this._signals.push([object, object.connect(signal, callback)]);
  }
  _watch(window) {
    if (!window || this._windows.has(window)) return;
    const changed = () => {
      if (window.is_on_all_workspaces()) this._affected.add(window);
      this.queue();
    };
    const ids = [
      window.connect('workspace-changed', changed),
      window.connect('notify::on-all-workspaces', changed),
      window.connect('notify::minimized', changed),
      window.connect('unmanaging',
                     () => {
                       for (const id of this._windows.get(window) || [])
                         window.disconnect(id);
                       // V-Shell's animation teardown restores source scales
                       // from this list. Never leave an unmanaged actor in it.
                       const actor = window.get_compositor_private();
                       for (const group of this._groups.keys())
                         if (Array.isArray(group._hiddenWindows))
                           group._hiddenWindows =
                             group._hiddenWindows.filter(a => a !== actor);
                       this._windows.delete(window);
                       this._affected.delete(window);
                       this.queue();
                     })
    ];
    this._windows.set(window, ids);
    changed();
  }
  queue() {
    if (!this._enabled || this._later) return;
    this._later = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
      this._later = 0;
      this._syncOverview();
      for (const [group, state] of this._groups) {
        state.order = global.get_window_actors();
        this.syncDesktop(group);
      }
      return GLib.SOURCE_REMOVE;
    });
  }
  _workspaces() {
    const result  = [];
    const display = Main.overview?._overview?.controls?._workspacesDisplay;
    for (const outer of display?._workspacesViews || []) {
      const view = outer._workspacesView ?? outer;
      result.push(...(view._workspaces ?? (view._workspace ? [view._workspace] : [])));
    }
    return result;
  }
  _syncOverview() {
    const workspaces = this._workspaces();
    const active     = global.workspace_manager.get_active_workspace_index();
    // Add the destination before removing obsolete previews. The entire handoff
    // happens before redraw, and an in-progress native DND source is retained.
    workspaces.sort((a, b) => (b.metaWorkspace?.index() === active) -
                      (a.metaWorkspace?.index() === active));
    for (const window of this._affected) {
      if (this._enabled &&
          (window === this._dragged ||
           (this._owner?._spatial?.dragging && window === this._owner._spatial._window)))
        continue;
      if (!window.get_compositor_private()) continue;
      for (const workspace of workspaces) {
        const present = workspace.containsMetaWindow(window),
              wanted =
                workspace._isMyWindow(window) && workspace._isOverviewWindow(window);
        if (wanted && !present) {
          workspace._doAddWindow(window);
          const added = workspace._windows.find(c => c.metaWindow === window);
          if (added) {
            added.remove_all_transitions();
            added.set_scale(1, 1);
            added.set_pivot_point(0, 0);
          }
        } else if (!wanted && present) {
          // Native removal starts a pointer-polling layout-freeze timeout. This
          // programmatic handoff needs no freeze. Use its clone/layout removal
          // primitive and release the corresponding skip-taskbar handler.
          const clone = workspace._removeWindowClone(window);
          const id    = workspace._skipTaskbarSignals?.get(window);
          if (id) window.disconnect(id);
          workspace._skipTaskbarSignals?.delete(window);
          clone?.destroy();
        }
      }
    }
  }
  track(monitors) {
    for (const group of monitors) {
      if (this._groups.has(group)) continue;
      const overlay = group.get_children().find(c => c._windowRecords && !c._workspace);
      if (!overlay) continue;
      const state = {
        overlay,
        clones: new Map(),
        hidden: new Map(),
        order: global.get_window_actors(),
        membership: []
      };
      // Older Shell versions stack by querying current membership, although its records
      // are a snapshot. Stick/unstick or new windows can otherwise make that
      // native callback dereference a record which was never created.
      for (const face of [overlay, ...group._workspaceGroups]) {
        const descriptor = Object.getOwnPropertyDescriptor(face, '_shouldShowWindow');
        const original   = face._shouldShowWindow;
        const wrapper    = function(window) {
          return original.call(this, window) &&
            this._windowRecords.some(r => r.windowActor.meta_window === window);
        };
        face._shouldShowWindow = wrapper;
        state.membership.push({face, descriptor, wrapper});
      }
      state.destroy = group.connect('destroy', () => {
        this._groups.delete(group);
        // A face may be absent (for example the excluded empty workspace).
        // Unparented clones are not owned by the destroyed monitor actor.
        for (const clone of state.clones.values())
          if (!clone.get_parent()) clone.destroy();
        state.clones.clear();
        state.hidden.clear();
      });
      this._groups.set(group, state);
      this.syncDesktop(group);
    }
  }
  _hide(state, clone) {
    if (!state.hidden.has(clone)) {
      const saved   = {visible: clone.visible};
      saved.destroy = clone.connect('destroy', () => state.hidden.delete(clone));
      state.hidden.set(clone, saved);
    }
    clone.visible = false;
  }
  syncDesktop(group, explode = null) {
    const state = this._groups.get(group);
    if (!state) return;
    if (explode !== null) state.explode = explode;
    explode       = state.explode ?? 0;
    const records = [
      ...state.overlay._windowRecords,
      ...group._workspaceGroups.flatMap(f => f._windowRecords)
    ];
    const byWindow = new Map();
    for (const record of records) {
      const window = record.windowActor.meta_window;
      if (!window || !this._windows.has(window) ||
          window === state.overlay._movingWindow ||
          window.get_window_type() === Meta.WindowType.DESKTOP)
        continue;
      if (window.is_on_all_workspaces() || state.clones.has(window)) {
        this._hide(state, record.clone);
        if (!byWindow.has(window)) byWindow.set(window, record);
      }
    }
    for (const [window, record] of byWindow) {
      const index = window.is_on_all_workspaces() ?
        global.workspace_manager.get_active_workspace_index() :
        window.get_workspace()?.index();
      const face  = group._workspaceGroups.find(f => f._workspace?.index() === index);
      let clone   = state.clones.get(window);
      if (!clone) {
        clone = new Clutter.Clone({source: record.windowActor, reactive: false});
        state.clones.set(window, clone);
      }
      clone.set_position(record.clone.x, record.clone.y);
      if (face && clone.get_parent() !== face) {
        clone.get_parent()?.remove_child(clone);
        face.add_child(clone);
      }
      clone.visible = !!face && window.showing_on_its_workspace();
    }
    for (const [window, clone] of state.clones)
      if (!byWindow.has(window)) {
        clone.destroy();
        state.clones.delete(window);
      }
    // Preserve real stacking among sticky and ordinary clones. This also uses
    // the same depth scale for both when Cube's explode effect is active.
    const ranks = new Map(state.order.map((a, i) => [a, i + 1]));
    for (const face of group._workspaceGroups) {
      const visible =
        face._windowRecords.filter(r => r.clone.visible && r.clone.get_parent() === face)
          .map(r => ({actor: r.clone, source: r.windowActor}));
      for (const [window, clone] of state.clones)
        if (clone.get_parent() === face)
          visible.push({actor: clone, source: window.get_compositor_private()});
      visible.sort((a, b) => (ranks.get(a.source) || 0) - (ranks.get(b.source) || 0));
      let below = face._background;
      for (const {actor, source} of visible) {
        actor.translation_z =
          explode * (ranks.get(source) || 0) / Math.max(1, state.order.length);
        face.set_child_above_sibling(actor, below);
        below = actor;
      }
      if (explode > 0.001)
        this._owner._depthSortWindowActors(face.get_children(), group._monitor.index);
    }
  }
  releaseDesktop() {
    for (const [group, state] of this._groups) {
      group.disconnect(state.destroy);
      for (const {face, descriptor, wrapper} of state.membership)
        if (face._shouldShowWindow === wrapper) {
          if (descriptor)
            Object.defineProperty(face, '_shouldShowWindow', descriptor);
          else
            delete face._shouldShowWindow;
        }
      for (const [clone, saved] of state.hidden) {
        clone.disconnect(saved.destroy);
        clone.visible = saved.visible;
      }
      for (const clone of state.clones.values()) clone.destroy();
      state.hidden.clear();
      state.clones.clear();
    }
    this._groups.clear();
  }
  destroy() {
    this._enabled = false;
    if (this._later) global.compositor.get_laters().remove(this._later);
    this._later = 0;
    this.releaseDesktop();
    for (const {object, name, wrapper, original} of this._patches)
      if (object[name] === wrapper) object[name] = original;
    this._syncOverview();
    for (const [object, id] of this._signals) object.disconnect(id);
    for (const [window, ids] of this._windows)
      for (const id of ids) window.disconnect(id);
    this._signals = [];
    this._windows.clear();
    this._affected.clear();
    this._patches = [];
    this._dragged = this._owner = null;
  }
}
