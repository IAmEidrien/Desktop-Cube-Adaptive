// SPDX-FileCopyrightText: Eidrien
// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
export async function runPolicy({root, cubeID, peerID, toggle, check, wait}) {
  await toggle(cubeID, true);
  let cube    = Main.extensionManager.lookup(cubeID).stateObj;
  const local = cube._settings;
  local.set_boolean('hide-empty-workspace', false);
  local.set_boolean('allow-workspace-looping', false);
  local.set_boolean('last-first-gap', true);
  const status   = `${root}/prefs-policy.json`;
  const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
  const data     = GLib.getenv('GNOME_SHELL_DATADIR');
  const libs     = [
    '/usr/lib/gnome-shell', data?.replace(/\/share\/gnome-shell$/, '/lib/gnome-shell')
  ].filter(p => p && Gio.File.new_for_path(p).query_exists(null));
  launcher.setenv('GI_TYPELIB_PATH',
                  [
                    ...libs.flatMap(p => [`${p}/girepository-1.0`, p]),
                    GLib.getenv('GI_TYPELIB_PATH') || ''
                  ].join(':'),
                  true);
  launcher.setenv('LD_LIBRARY_PATH',
                  [...libs, GLib.getenv('LD_LIBRARY_PATH') || ''].join(':'), true);
  const process = launcher.spawnv([
    'gjs', '-m', `${root}/policyPrefs.js`,
    `${root}/data/gnome-shell/extensions/${cubeID}`, status
  ]);
  const ui = () => {
    try {
      return JSON.parse(new TextDecoder().decode(GLib.file_get_contents(status)[1]));
    } catch (_) {
      return null;
    }
  };
  const until = async predicate => {
    for (let n = 0; n < 60 && !predicate(); n++) await wait(100);
  };
  try {
    await until(() => ui()?.hide === true);
    check(ui()?.hide && ui().loop && ui().gap,
          'standalone preference rows and gap sensitivity');
    await toggle(peerID, true);
    // V-Shell initializes a delayed profile transaction (400 ms). Let that
    // finish before test writes, as a user opening its preferences would.
    await wait(650);
    const peer = Main.extensionManager.lookup(peerID).stateObj.getSettings();
    peer.set_boolean('ws-switcher-ignore-last', true);
    peer.set_boolean('ws-switcher-wraparound', true);
    Gio.Settings.sync();

    await until(() => ui()?.hide === false && ui()?.gap === false);
    check(!ui().hide && !ui().loop && !ui().gap,
          'open preferences adopt actual enabled V-Shell ownership');
    cube = Main.extensionManager.lookup(cubeID).stateObj;
    check(cube._workspacePolicy.owned &&
            cube._workspacePolicy.get('hide-empty-workspace') &&
            cube._workspacePolicy.get('allow-workspace-looping'),
          'runtime reads peer workspace policy');
    check(cube._getFaceAngle(4) === 90, 'effective looping closes cube geometry');
    const mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
    mutter.set_boolean('dynamic-workspaces', true);
    await wait(500);
    GLib.file_set_contents(`${root}/policy-state.json`, JSON.stringify({
      peerHide: peer.get_boolean('ws-switcher-ignore-last'),
      stored: Main.extensionManager.lookup(peerID).stateObj.getSettings().get_boolean(
        'ws-switcher-ignore-last'),
      peerPath: cube._workspacePolicy._peer.path,
      dynamic: Meta.prefs_get_dynamic_workspaces(),
      count: global.workspace_manager.get_n_workspaces(),
      owned: cube._workspacePolicy.owned,
      hide: cube._workspacePolicy.get('hide-empty-workspace'),
      enabled: Main.extensionManager.lookup(peerID).stateObj._enabled
    }));
    check(cube._shouldHideEmptyWorkspace() &&
            cube._getLastVisibleWorkspaceIndex() ===
              global.workspace_manager.get_n_workspaces() - 2,
          'peer hide-empty controls dynamic cube face exclusion');
    mutter.set_boolean('dynamic-workspaces', false);
    await wait(300);
    check(!cube._shouldHideEmptyWorkspace(),
          'static workspace geometry retains all workspaces');
    Main.overview.show();
    await wait(600);
    peer.set_boolean('ws-switcher-ignore-last', false);
    peer.set_boolean('ws-switcher-wraparound', false);
    const first = global.workspace_manager.get_workspace_by_index(0);
    const last  = global.workspace_manager.get_workspace_by_index(
      global.workspace_manager.get_n_workspaces() - 1);
    check(first.get_neighbor(Meta.MotionDirection.LEFT) === first &&
            last.get_neighbor(Meta.MotionDirection.RIGHT) === last,
          'effective disabled looping clamps native neighbors before peer cache refresh');
    await until(() => ui()?.gap === true);
    check(!cube._workspacePolicy.get('hide-empty-workspace') &&
            !cube._workspacePolicy.get('allow-workspace-looping') &&
            cube._getFaceAngle(4) === 60,
          'live peer changes update open Overview geometry policy');
    check(!ui().hide && ui().gap,
          'gap uses effective looping in already-open preferences');
    Main.overview.hide();
    await wait(300);
    await toggle(peerID, false);
    await until(() => ui()?.hide === true);
    cube = Main.extensionManager.lookup(cubeID).stateObj;
    check(!cube._workspacePolicy.owned &&
            !cube._workspacePolicy.get('allow-workspace-looping') && ui().hide &&
            ui().loop,
          'disable peer restores local ownership and rows');
    check(!local.get_boolean('hide-empty-workspace') &&
            !local.get_boolean('allow-workspace-looping'),
          'local saved values preserved');
    local.set_boolean('allow-workspace-looping', true);
    await until(() => ui()?.gap === false);
    check(!ui().gap, 'standalone gap sensitivity follows local saved value');
    await toggle(peerID, true);
    await until(() => ui()?.hide === false && ui()?.gap === true);
    check(local.get_boolean('allow-workspace-looping') &&
            !peer.get_boolean('ws-switcher-wraparound') &&
            !peer.get_boolean('ws-switcher-ignore-last'),
          'ownership changes do not synchronize either extension saved values');
    await toggle(cubeID, false);
    await toggle(peerID, false);
  } finally {
    const actions = Gio.DBusActionGroup.get(
      Gio.DBus.session, 'org.eidrien.CubePolicyPrefs', '/org/eidrien/CubePolicyPrefs');
    actions.activate_action('close', null);
    await wait(200);
    process.force_exit();
  }
}
