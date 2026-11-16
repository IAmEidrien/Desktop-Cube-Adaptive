// SPDX-FileCopyrightText: Eidrien
// SPDX-License-Identifier: GPL-3.0-or-later
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {WorkspacesView} from 'resource:///org/gnome/shell/ui/workspacesView.js';

const root   = GLib.getenv('REVIEW_ROOT');
const cubeID = 'desktop-cube-adaptive@eidrien.local';
const peerID = 'vertical-workspaces@G-dH.github.com';
const wait = ms => new Promise(r => GLib.timeout_add(0, ms, () => {
  r();
  return false;
}));
export default class Probe extends Extension {
  enable() {
    GLib.timeout_add(0, 3500, () => {
      this.run().catch(e => this.save({error: String(e), stack: e.stack}));
      return false;
    });
  }
  disable() {}
  save(data) {
    GLib.file_set_contents(`${root}/result.json`,
                           JSON.stringify({checks: this.checks, ...data}));
  }
  async run() {
    this.checks = [];
    const check = (ok, label) => {
      if (!ok) throw Error(label);
      this.checks.push(label);
      GLib.file_set_contents(`${root}/progress.json`, JSON.stringify(this.checks));
    };
    const toggle = async (id, enabled) => {
      Main.extensionManager[enabled ? 'enableExtension' : 'disableExtension'](id);
      for (let n = 0; n < 100; n++) {
        const state = Main.extensionManager.lookup(id)?.state;
        if (state === (enabled ? 1 : 2)) break;
        if (state === 3) throw Error(`Extension error: ${id}`);
        await wait(50);
      }
      await wait(350);
      check(Main.extensionManager.lookup(id)?.state === (enabled ? 1 : 2),
            `${id} ${enabled ? 'enabled' : 'disabled'}`);
    };
    Main.overview.hide();
    await wait(700);
    const baseline = {
      spacing: WorkspacesView.prototype._getSpacing,
      update: WorkspacesView.prototype._updateWorkspacesState,
      visibility: WorkspacesView.prototype._updateVisibility,
      neighbor: Meta.Workspace.prototype.get_neighbor,
      prepare: Main.wm._workspaceAnimation._prepareWorkspaceSwitch,
      finish: Main.wm._workspaceAnimation._finishWorkspaceSwitch,
    };
    Gio.Subprocess.new(['gjs', '-m', `${root}/client.js`, 'org.eidrien.CubeLifecycle'],
                       0);
    await wait(700);
    const views = () =>
      Main.overview._overview.controls._workspacesDisplay._workspacesViews
        .map(v => v._workspacesView ?? v)
        .filter(v => v._workspaces);
    const visual = async () => {
      Main.overview.dash.showAppsButton.checked = false;
      Main.overview.show();
      await wait(600);
      check(views().every(v => v._workspaces.every(
                            w => [w.rotation_angle_y, w.translation_z, w.width].every(
                              Number.isFinite))),
            'finite overview geometry');
      Main.overview.dash.showAppsButton.checked = true;
      for (let n = 0;
           n < 40 && Main.overview._overview.controls._stateAdjustment.value < 1.99; n++)
        await wait(100);
      check(Main.overview._overview.controls._stateAdjustment.value > 1.9,
            'app grid opens');
      Main.overview.hide();
      await wait(600);
    };
    if (GLib.getenv('TEST_CHECKPOINT') === 'peer') {
      for (let cycle = 0; cycle < 3; cycle++) {
        await toggle(peerID, true);
        const s = Main.extensionManager.lookup(peerID).stateObj.getSettings();
        for (const p of [4, 9, 4]) {
          s.set_int('ws-thumbnails-position', p);
          await wait(400);
          await visual();
        }
        await toggle(peerID, false);
        await visual();
      }
      this.save({pass: true, shell: Config.PACKAGE_VERSION, checkpoint: 'peer-only'});
      return;
    }
    for (const order of [[peerID, cubeID], [cubeID, peerID]]) {
      for (let cycle = 0; cycle < 2; cycle++) {
        await toggle(order[0], true);
        await toggle(order[1], true);
        let cube       = Main.extensionManager.lookup(cubeID).stateObj;
        const peer     = Main.extensionManager.lookup(peerID).stateObj;
        const settings = peer.getSettings();
        for (const position of [4, 9, 4]) {
          Main.overview.show();
          await wait(300);
          settings.set_int('ws-thumbnails-position', position);
          await wait(500);
          check(WorkspacesView.prototype._getSpacing === cube._cubeGetSpacing,
                'Cube rebased immediately after V-Shell refresh');
          check(Main.overview._overview.controls._workspacesDisplay._swipeTracker
                    .orientation === Clutter.Orientation.HORIZONTAL,
                'horizontal carousel input survives peer refresh');
          await visual();
        }
        // Exercise whichever extension is disabled first in this cycle, including
        // Shell's temporary disable/re-enable of extensions above it in the stack.
        const first = cycle ? order[1] : order[0], second = cycle ? order[0] : order[1];
        await toggle(first, false);
        await visual();
        await toggle(first, true);
        await visual();
        await toggle(second, false);
        await visual();
        await toggle(first, false);
        check(WorkspacesView.prototype._getSpacing === baseline.spacing &&
                WorkspacesView.prototype._updateWorkspacesState === baseline.update &&
                WorkspacesView.prototype._updateVisibility === baseline.visibility,
              'both disabled restore native view methods');
        check(
          Meta.Workspace.prototype.get_neighbor === baseline.neighbor &&
            Main.wm._workspaceAnimation._prepareWorkspaceSwitch === baseline.prepare &&
            Main.wm._workspaceAnimation._finishWorkspaceSwitch === baseline.finish,
          'both disabled restore native navigation and animation');
        await visual();
      }
    }
    await toggle(cubeID, true);
    const cube = Main.extensionManager.lookup(cubeID).stateObj, saved = cube._settings;
    saved.set_boolean('enable-desktop-workspace-cube-animation', true);
    Main.wm._workspaceAnimation._prepareWorkspaceSwitch();
    check(!!Main.wm._workspaceAnimation._desktopCubeAnimationActive,
          'owned desktop transition starts');
    await toggle(cubeID, false);
    check(!Main.wm._workspaceAnimation._switchData &&
            !Main.wm._workspaceAnimation._desktopCubeAnimationActive,
          'disable finishes owned desktop transition');
    check(cube._settingConnections.length === 0 && !cube._peerLifecycle,
          'disable releases settings and peer lifecycle hooks');
    saved.set_boolean('enable-panel-dragging',
                      !saved.get_boolean('enable-panel-dragging'));
    saved.set_boolean('hide-wallpaper', !saved.get_boolean('hide-wallpaper'));
    await wait(200);
    check(!cube._panelDragGesture && !cube._settings,
          'saved settings cannot reactivate disposed Cube');
    await toggle(cubeID, true);
    let completed = false;
    Main.wm._workspaceAnimation.animateSwitch(0, 1, Meta.MotionDirection.RIGHT, () => {
      completed = true;
    });
    await wait(40);
    await toggle(cubeID, false);
    await wait(400);
    check(completed && !Main.wm._workspaceAnimation._switchData &&
            Main.wm._workspaceAnimation._swipeTracker.enabled,
          'in-flight native completion survives Cube disable');
    this.save({pass: true, shell: Config.PACKAGE_VERSION, checkpoint: 1});
  }
}
