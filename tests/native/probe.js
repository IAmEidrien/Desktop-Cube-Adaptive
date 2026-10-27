// SPDX-FileCopyrightText: Eidrien
// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const wait = ms => new Promise(r => GLib.timeout_add(0, ms, () => {
  r();
  return GLib.SOURCE_REMOVE;
}));
const root = GLib.getenv('REVIEW_ROOT'), uuid = 'desktop-cube-adaptive@eidrien.local';
export default class Probe extends Extension {
  enable() {
    this.id = GLib.timeout_add(0, 3500, () => {
      this.id = 0;
      this.run().catch(e => this.save({error: String(e), stack: e.stack}));
      return GLib.SOURCE_REMOVE;
    });
  }
  disable() {
    if (this.id) GLib.source_remove(this.id);
  }
  save(data) {
    GLib.file_set_contents(`${root}/result.json`,
                           JSON.stringify({checks: this.checks, ...data}, null, 2));
  }
  async run() {
    this.checks = [];
    const check = (ok, label) => {
      if (!ok) throw Error(label);
      this.checks.push(label);
      GLib.file_set_contents(`${root}/progress.json`, JSON.stringify(this.checks));
    };
    Main.overview.hide();
    await wait(500);
    if (GLib.getenv('TEST_VSHELL')) {
      Main.extensionManager.enableExtension('vertical-workspaces@G-dH.github.com');
      await wait(1200);
      check(
        Main.extensionManager.lookup('vertical-workspaces@G-dH.github.com').state === 1,
        'V-Shell enabled');
    }
    if (GLib.getenv('TEST_DOCK')) {
      Main.extensionManager.enableExtension('dash-to-dock-adaptive@eidrien.local');
      await wait(1000);
      check(
        Main.extensionManager.lookup('dash-to-dock-adaptive@eidrien.local').state === 1,
        'D2D-A enabled');
    }
    Main.extensionManager.enableExtension(uuid);
    await wait(1200);
    const info = Main.extensionManager.lookup(uuid);
    check(info.state === 1, `Cube enabled (${info.state}: ${info.error})`);
    const cube = info.stateObj, spatial = cube._spatial, settings = cube._settings;
    check(!settings.get_boolean('spatial-overview'), 'spatial mode defaults off');
    settings.set_boolean('spatial-overview', true);
    settings.set_boolean('spatial-auto-edge', false);
    settings.set_uint('spatial-edge-delay-ms', 50);
    const client =
      Gio.Subprocess.new(['gjs', '-m', `${root}/client.js`, 'org.eidrien.CubeTest'], 0);
    let window;
    for (let i = 0; i < 40 && !window; i++) {
      await wait(100);
      window = global.get_window_actors()
                 .map(a => a.meta_window)
                 .find(w => w.get_title()?.includes('CubeTest'));
    }
    check(!!window, 'real application window exists');
    const pointer =
      (Clutter.get_default_backend?.() ?? global.stage.get_context().get_backend())
        .get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const move = (x, y) => pointer.notify_relative_motion(GLib.get_monotonic_time(),
                                                          x - global.get_pointer()[0],
                                                          y - global.get_pointer()[1]);
    move(500, 400);
    await wait(200);
    move(500, 400);
    await wait(200);
    Main.overview.hide();
    await wait(500);
    Main.overview.show();
    await wait(1100);
    const display = Main.overview._overview.controls._workspacesDisplay;
    const views = () => display._workspacesViews;
    const workspaces = () => views().find(v => v._workspaces?.length)?._workspaces;
    check(workspaces().length === 6, 'six existing Cube workspaces');
    const actors = [...workspaces()];
    const oldFit = display._fitModeAdjustment.value;
    for (const side of ['top', 'right', 'bottom', 'left']) {
      settings.set_string('spatial-edge', side);
      spatial.begin(window);
      const m = Main.layoutManager.primaryMonitor;
      const x = side === 'left' ? m.x + 1 :
        side === 'right'        ? m.x + m.width - 2 :
                                  m.x + m.width / 2;
      const y = side === 'top' ? m.y + 1 :
        side === 'bottom'      ? m.y + m.height - 2 :
                                 m.y + m.height / 2;
      spatial.motion(x, y);
      await wait(350);
      check(spatial.active, `${side} edge activates`);
      check(workspaces().every((w, i) => w === actors[i]),
            `${side} reuses existing workspace actors`);
      check(workspaces().every(w => w.visible && Math.abs(w.rotation_angle_y) < 0.01),
            `${side} workspaces flat and visible`);
      const boxes = workspaces().map(
        w => [...w.get_transformed_position(), ...w.get_transformed_size()]);
      check(boxes.every(b => b.every(Number.isFinite) && b[2] > 0 && b[3] > 0),
            `${side} valid target geometry`);
      const target = workspaces()[4];
      check(target.handleDragOver({metaWindow: window}) !== undefined,
            'native drag target remains available');
      spatial.end();
      await wait(100);
      check(!spatial.active && display._fitModeAdjustment.value === oldFit,
            `${side} cancellation restores layout`);
    }
    spatial.begin(window);
    spatial.show(0);
    await wait(300);
    const target = workspaces()[4];
    const accepted =
      target.acceptDrop({metaWindow: window}, null, 0, 0, global.get_current_time());
    check(accepted && window.get_workspace().index() === 4,
          'native drop moves window across four workspaces');
    spatial.end();
    await wait(200);
    if (Number(GLib.getenv('TEST_MONITORS')) > 1) {
      const secondary = views().find(v => v._workspacesView)?._workspacesView;
      check(!!secondary, 'secondary workspace view exists');
      const fit = secondary._fitModeAdjustment, upper = fit.upper, value = fit.value;
      spatial.begin(window);
      spatial.show(1);
      await wait(400);
      check(fit.value === 1 &&
              secondary._workspaces.every(
                w => [...w.get_transformed_position(), ...w.get_transformed_size()].every(
                  Number.isFinite)),
            'secondary native targets spread with valid geometry');
      check(secondary._workspaces[3].acceptDrop({metaWindow: window}, null, 0, 0,
                                                global.get_current_time()) &&
              window.get_monitor() === 1 && window.get_workspace().index() === 3,
            'native secondary drop changes monitor and workspace');
      spatial.end();
      await wait(200);
      check(fit.upper === upper && fit.value === value, 'secondary fit bounds restored');
      window.move_to_monitor(0);
      await wait(200);
    }
    Main.overview.hide();
    await wait(400);
    Main.overview.showApps();
    await wait(700);
    spatial.begin(window);
    check(!spatial.dragging, 'app-grid rejects spatial drag');
    Main.overview.hide();
    await wait(400);
    Main.overview.show();
    await wait(600);
    const checkDockSides = async () => {
      if (GLib.getenv('TEST_DOCK')) {
        settings.set_boolean('spatial-auto-edge', true);
        const dockInfo =
          Main.extensionManager.lookup('dash-to-dock-adaptive@eidrien.local');
        const dm =
          (await import(Gio.File.new_for_path(`${dockInfo.path}/extension.js`).get_uri()))
            .dockManager;
        check(!!dm, 'dock manager available');
        for (const [position, expected] of [[0, 'bottom'], [1, 'left'], [2, 'top'],
                                            [3, 'right']]) {
          dm.settings.set_enum('dock-position', position);
          await wait(500);
          check(spatial.edge(0) === expected,
                `dock side ${position} selects ${expected}`);
        }
      }
    };
    if (GLib.getenv('TEST_VSHELL')) {
      const vs = Main.extensionManager.lookup('vertical-workspaces@G-dH.github.com')
                   .stateObj.getSettings();
      check([4, 9].includes(vs.get_int('ws-thumbnails-position')),
            'V-Shell thumbnails remain disabled');
    }
    // Exercise the real pointer/DND path, not only direct signal/method calls.
    settings.set_boolean('spatial-auto-edge', false);
    settings.set_string('spatial-edge', 'top');
    global.workspace_manager.get_workspace_by_index(0).activate(
      global.get_current_time());
    window.change_workspace(global.workspace_manager.get_workspace_by_index(0));
    await wait(800);
    const source        = workspaces()[0]._windows.find(w => w.metaWindow === window);
    const [sx, sy]      = source.get_transformed_position(),
               [sw, sh] = source.get_transformed_size();
    move(sx + sw / 2, sy + sh / 2);
    await wait(150);
    move(sx + sw / 2, sy + sh / 2);
    await wait(150);
    pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.PRESSED);
    await wait(100);
    move(sx + sw / 2 + 55, sy + sh / 2 + 35);
    await wait(350);
    check(spatial.dragging, 'real pointer drag begins spatial tracking');
    move(Main.layoutManager.primaryMonitor.width / 2, 1);
    await wait(400);
    check(spatial.active, 'real pointer reaches activation edge');
    const destination   = workspaces()[4];
    const [tx, ty]      = destination.get_transformed_position(),
               [tw, th] = destination.get_transformed_size();
    move(tx + tw / 2, ty + th / 2);
    await wait(150);
    pointer.notify_button(GLib.get_monotonic_time(), 1, Clutter.ButtonState.RELEASED);
    await wait(900);
    check(window.get_workspace().index() === 4,
          'real pointer drop reaches distant workspace');
    check(!spatial.active && !spatial.dragging, 'real pointer drop restores Cube');
    spatial.begin(window);
    spatial.show(0);
    await wait(300);
    const beforeDynamic = global.workspace_manager.n_workspaces;
    new Gio.Settings({schema_id: 'org.gnome.mutter'})
      .set_boolean('dynamic-workspaces', true);
    await wait(400);
    check(global.workspace_manager.n_workspaces === beforeDynamic,
          'dynamic workspace collection pauses during drag');
    check(workspaces()[5].acceptDrop({metaWindow: window}, null, 0, 0,
                                     global.get_current_time()),
          'dynamic native distant drop accepts window');
    spatial.end();
    await wait(700);
    check(!spatial.active && window.get_workspace() !== null,
          'dynamic workspace collection resumes safely');
    new Gio.Settings({schema_id: 'org.gnome.mutter'})
      .set_boolean('dynamic-workspaces', false);
    await checkDockSides();
    spatial.begin(window);
    spatial.show(0);
    await wait(250);
    Main.extensionManager.disableExtension(uuid);
    await wait(200);
    check(
      !spatial.active && !spatial.dragging && !spatial._edgeTimer && !spatial._finishIdle,
      'disable clears spatial state');
    check(display._fitModeAdjustment.value === oldFit, 'disable restores fit adjustment');
    Main.extensionManager.enableExtension(uuid);
    await wait(500);
    check(info.state === 1, 're-enable succeeds');
    Main.extensionManager.disableExtension(uuid);
    client.force_exit();
    this.save({pass: true, shell: Config.PACKAGE_VERSION});
  }
}
