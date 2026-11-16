// SPDX-FileCopyrightText: Eidrien
// SPDX-License-Identifier: GPL-3.0-or-later
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Workspace} from 'resource:///org/gnome/shell/ui/workspace.js';

export async function runSticky({root, cubeID, peerID, toggle, check, wait}) {
  const baseline = Workspace.prototype._isMyWindow;
  const all      = GLib.getenv('TEST_VSHELL') ? [false, true] : [false];
  for (const peer of all) {
    if (peer) {
      await toggle(peerID, true);
      await wait(650);
    }
    await toggle(cubeID, true);
    const cube   = Main.extensionManager.lookup(cubeID).stateObj;
    const sticky = cube._sticky;
    const window = global.get_window_actors()
                     .map(a => a.meta_window)
                     .find(w => w.title === 'org.eidrien.CubeLifecycle');
    check(!!window, 'real sticky test window exists');
    const actor      = window.get_compositor_private();
    const visible    = actor.visible;
    const workspaces = () => sticky._workspaces().filter(
      w => w.monitorIndex === window.get_monitor() && w.metaWorkspace);
    const shown = () => workspaces().filter(w => w.containsMetaWindow(window));
    const active = () => global.workspace_manager.get_active_workspace_index();
    const until = async p => {
      for (let n = 0; n < 40 && !p(); n++) await wait(50);
    };
    const correct = () =>
      shown().length === 1 && shown()[0].metaWorkspace.index() === active();
    const seat =
      (Clutter.get_default_backend?.() ?? global.stage.get_context().get_backend())
        .get_default_seat();
    const pointer  = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    // Absolute positioning avoids a new virtual device's relative origin
    // crossing a native hot-corner pressure barrier on multi-monitor stages.
    const move = (x, y) =>
      pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    move(500, 400);
    await wait(200);
    move(500, 400);
    await wait(200);
    Main.overview.hide();
    await wait(500);
    window.stick();
    Main.overview.show();
    await wait(800);
    await until(correct);
    check(window.is_on_all_workspaces() && correct(),
          'Overview presents sticky window on active face only');
    await wait(500);
    check(Main.overview.visibleTarget &&
            Main.overview._overview.controls._stateAdjustment.value > 0.99,
          'Overview input state is settled before real sticky drag');
    const preview  = shown()[0]._windows.find(p => p.metaWindow === window);
    const [px, py] = preview.get_transformed_position();
    const [pw, ph] = preview.get_transformed_size();
    move(px + pw / 2, py + ph / 2);
    await wait(150);
    move(px + pw / 2, py + ph / 2);
    await wait(150);
    const overviewState = {
      visible: Main.overview.visible,
      target: Main.overview.visibleTarget,
      state: Main.overview._overview.controls._stateAdjustment.value,
      mode: Main.actionMode,
      sourceVisible: actor.visible,
      delegate: String(window._delegate)
    };
    const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE,
                                                 ...global.get_pointer().slice(0, 2));
    GLib.file_set_contents(`${root}/pointer-state.json`, JSON.stringify({
      px,
      py,
      pw,
      ph,
      pointer: global.get_pointer(),
      picked: String(picked),
      preview: String(preview),
      parent: String(picked?.get_parent()),
      inPreview: preview.contains(picked),
      overviewState
    }));
    pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.PRESSED);
    await wait(100);
    move(px + pw / 2 + 55, py + ph / 2 + 35);
    await until(() => sticky._dragged === window);
    check(sticky._dragged === window, 'real pointer starts sticky preview drag');
    global.workspace_manager.get_workspace_by_index((active() + 1) % 6)
      .activate(global.get_current_time());
    await wait(200);
    check(!!preview.get_parent(), 'real dragged source survives face handoff');
    keyboard.notify_key(GLib.get_monotonic_time(), 1, Clutter.KeyState.PRESSED);
    keyboard.notify_key(GLib.get_monotonic_time(), 1, Clutter.KeyState.RELEASED);
    pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED);
    await until(() => !sticky._dragged && correct());
    check(!sticky._dragged && correct() && window.is_on_all_workspaces(),
          'real Escape cancellation restores active-face presentation');

    global.workspace_manager.get_workspace_by_index(1).activate(
      global.get_current_time());
    await until(correct);
    check(correct() && window.is_on_all_workspaces(),
          'active workspace handoff preserves stickiness');
    const source = shown()[0]._windows.find(p => p.metaWindow === window);
    Main.overview.beginWindowDrag(window);
    global.workspace_manager.get_workspace_by_index(2).activate(
      global.get_current_time());
    await wait(200);
    check(!!source.get_parent(),
          'native dragged preview survives active workspace change');
    const target = workspaces().find(w => w.metaWorkspace.index() !== active());
    check(target.handleDragOver({metaWindow: window}) !== undefined,
          'native DND membership path remains callable');
    Main.overview.endWindowDrag(window);
    await until(correct);
    check(correct(), 'drag end reconciles to active face');
    window.unstick();
    await wait(200);
    check(!window.is_on_all_workspaces() &&
            shown().every(w => window.located_on_workspace(w.metaWorkspace)),
          'Overview sticky-state change uses actual membership');
    window.stick();
    await until(correct);
    check(correct(), 'Overview resticking updates presentation');
    Main.overview.hide();
    await wait(500);
    cube._settings.set_boolean('enable-desktop-workspace-cube-animation', false);
    const controller = Main.wm._workspaceAnimation;
    controller._prepareWorkspaceSwitch();
    check(!sticky._groups.size && !controller._desktopCubeAnimationActive,
          'native desktop animation keeps ordinary sticky overlay');
    controller._finishWorkspaceSwitch(controller._switchData);
    cube._settings.set_boolean('enable-desktop-workspace-cube-animation', true);
    const beforePrepare = actor.visible;
    controller._prepareWorkspaceSwitch();
    const groups = [...sticky._groups];
    check(groups.length === controller._switchData.monitors.length,
          'all cube monitors tracked');
    const primary = groups.find(([g]) => g._monitor.index === window.get_monitor());
    check(!!primary, 'sticky monitor group exists');
    const [group, state] = primary;
    const clone          = state.clones.get(window);
    check(!!clone && clone.get_parent()._workspace.index() === active(),
          'desktop sticky clone belongs to active face');
    const overlayRecord = state.overlay._windowRecords.find(r => r.windowActor === actor);
    GLib.file_set_contents(`${root}/sticky-state.json`, JSON.stringify({
      initial: visible,
      beforePrepare,
      source: actor.visible,
      overlay: !!overlayRecord,
      overlayVisible: overlayRecord?.clone.visible,
      active: active()
    }));
    check(
      overlayRecord && !overlayRecord.clone.visible && actor.visible === beforePrepare,
      'native overlay duplicate hidden without hiding source actor');
    const id = group._desktopCubeProgressID;
    controller._prepareWorkspaceSwitch();
    check(group._desktopCubeProgressID === id && state.clones.get(window) === clone,
          'repeated prepare does not duplicate hooks or clones');
    group.progress = 0.5;
    await wait(100);
    check(clone.get_parent()._workspace.index() === active(),
          'rotation progress does not float sticky window across faces');
    window.unstick();
    await wait(100);
    check(!window.is_on_all_workspaces() &&
            state.clones.get(window).get_parent()._workspace.index() ===
              window.get_workspace().index(),
          'desktop sticky-state change follows real membership');
    window.stick();
    await wait(100);
    check(state.clones.get(window).get_parent()._workspace.index() === active(),
          'desktop resticking selects active face');
    window.minimize();
    await wait(120);
    check(!state.clones.get(window).visible && !overlayRecord.clone.visible,
          'minimized sticky windows remain hidden in animation groups');
    window.unminimize();
    await wait(120);
    check(state.clones.get(window).visible && !overlayRecord.clone.visible,
          'unminimized sticky window returns only on its active face');
    // Observe actor placement after native animation progress updates. Some
    // headless backends do not emit Stage::after-paint, so inspect the real
    // presentation actors at the integration boundary instead.
    const samples      = [];
    const sync         = sticky.syncDesktop;
    sticky.syncDesktop = function(g, ...args) {
      sync.call(this, g, ...args);
      const c = this._groups.get(g)?.clones.get(window);
      if (g._monitor.index === window.get_monitor() && c?.get_parent()?._workspace)
        samples.push([active(), c.get_parent()._workspace.index(), g.progress]);
    };
    const previous = active(),
          next     = (previous + 1) % global.workspace_manager.get_n_workspaces();
    global.workspace_manager.get_workspace_by_index(next).activate(
      global.get_current_time());
    await wait(400);
    await until(() => !controller._switchData);
    let animationDone = false;
    controller.animateSwitch(previous, next, Meta.MotionDirection.RIGHT, () => {
      animationDone = true;
    });
    await until(() => animationDone);
    sticky.syncDesktop = sync;
    GLib.file_set_contents(`${root}/sticky-frames.json`, JSON.stringify(samples));
    check(samples.some(([expected, actual]) => expected === next && actual === next) &&
            samples.every(([expected, actual]) => expected === actual),
          'native desktop transition hands sticky clone to actual active face');
    check(!sticky._groups.size, 'desktop finish releases presentation actors');
    global.force_animations = false;
    const reduced = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    reduced.set_boolean('enable-animations', false);
    await wait(100);
    let reducedDone = false;
    controller.animateSwitch(previous, next, Meta.MotionDirection.RIGHT, () => {
      reducedDone = true;
    });
    await until(() => reducedDone);
    check(reducedDone && !sticky._groups.size && !controller._switchData,
          'reduced-motion completion releases every monitor safely');
    reduced.set_boolean('enable-animations', true);
    global.force_animations = true;
    await wait(100);
    controller.movingWindow = window;
    controller._prepareWorkspaceSwitch();
    const moving = [...sticky._groups.values()].find(s => s.overlay._monitor.index ===
                                                       window.get_monitor());
    check(!moving.clones.has(window) &&
            moving.overlay._windowRecords.some(r => r.windowActor === actor &&
                                                 r.clone.visible),
          'moving sticky window retains native drag overlay');
    controller._finishWorkspaceSwitch(controller._switchData);
    controller.movingWindow = null;
    Gio.Subprocess.new(['gjs', '-m', `${root}/client.js`, 'org.eidrien.CubeStickyClose'],
                       0);
    let closing;
    await until(() => {
      closing = global.get_window_actors()
                  .map(a => a.meta_window)
                  .find(w => w.title === 'org.eidrien.CubeStickyClose');
      return !!closing;
    });
    closing.stick();
    await wait(100);
    controller._prepareWorkspaceSwitch();
    closing.delete(global.get_current_time());
    await until(() => !sticky._windows.has(closing));
    await wait(100);
    check([...sticky._groups.values()].every(s => !s.clones.has(closing)),
          'closed sticky windows release animation clones');
    controller._finishWorkspaceSwitch(controller._switchData);
    Main.overview.show();
    await wait(600);
    await until(correct);
    const before = window.is_on_all_workspaces();
    await toggle(cubeID, false);
    await wait(200);
    check(Workspace.prototype._isMyWindow === baseline,
          'disable restores native preview predicate');
    check(sticky._groups.size === 0 && sticky._windows.size === 0 &&
            sticky._affected.size === 0 && !sticky._later,
          'disable releases all presentation state');
    check(window.is_on_all_workspaces() === before, 'disable preserves sticky state');
    const nativeViews = workspaces();
    check(nativeViews.every(w => w.containsMetaWindow(window)),
          'disable restores ordinary per-workspace sticky previews');
    await toggle(cubeID, true);
    await until(correct);
    check(correct(),
          're-enable while Overview is open reapplies active-face presentation');
    await toggle(cubeID, false);
    check(workspaces().every(w => w.containsMetaWindow(window)),
          'second disable restores every ordinary sticky preview');
    Main.overview.hide();
    await wait(500);
    window.unstick();
    if (peer) await toggle(peerID, false);
  }
}
