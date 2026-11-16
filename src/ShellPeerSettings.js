// SPDX-FileCopyrightText: Eidrien
// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const UUID   = 'vertical-workspaces@G-dH.github.com';
const unpack = value => value?.deep_unpack?.() ?? value;

// Preferences run in another process. Query actual Shell state, not just the
// list of requested extensions, which can include failed/inactive extensions.
export class ShellPeerSettings {
  constructor(changed) {
    this._changed    = changed;
    this._cancel     = new Gio.Cancellable();
    this._generation = 0;
    this._signals    = [];
    Gio.DBusProxy.new_for_bus(
      Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null, 'org.gnome.Shell',
      '/org/gnome/Shell', 'org.gnome.Shell.Extensions', this._cancel,
      (_source, result) => {
        try {
          const proxy = Gio.DBusProxy.new_for_bus_finish(result);
          if (this._cancel.is_cancelled()) return;
          this._proxy = proxy;
          this._signals.push(
            proxy.connect('notify::g-name-owner', () => this._refresh()));
          this._signals.push(proxy.connect('g-signal', (_p, _sender, name, args) => {
            if (name === 'ExtensionStateChanged' && args.deep_unpack()[0] === UUID)
              this._refresh();
          }));
          this._refresh();
        } catch (_error) { /* Standalone preferences need no running Shell. */
        }
      });
  }
  _refresh() {
    const generation = ++this._generation;
    if (!this._proxy.get_name_owner()) {
      this._changed(null);
      return;
    }
    this._proxy.call(
      'GetExtensionInfo', new GLib.Variant('(s)', [UUID]), Gio.DBusCallFlags.NONE, 3000,
      this._cancel, (proxy, result) => {
        try {
          const [info] = proxy.call_finish(result).deep_unpack();
          if (this._cancel.is_cancelled() || generation !== this._generation) return;
          let settings = null;
          if (unpack(info.state) === 1 && unpack(info.path)) {
            const directory = Gio.File.new_for_path(`${unpack(info.path)}/schemas`);
            const defaults  = Gio.SettingsSchemaSource.get_default();
            const source    = directory.query_exists(null) ?
                 Gio.SettingsSchemaSource.new_from_directory(directory.get_path(), defaults,
                                                             false) :
                 defaults;
            const schema =
              source.lookup('org.gnome.shell.extensions.vertical-workspaces', true);
            if (schema?.has_key('ws-switcher-ignore-last') &&
                schema.has_key('ws-switcher-wraparound'))
              settings = new Gio.Settings({settings_schema: schema});
          }
          this._changed(settings);
        } catch (_error) {
          if (!this._cancel.is_cancelled() && generation === this._generation)
            this._changed(null);
        }
      });
  }
  destroy() {
    this._cancel.cancel();
    for (const id of this._signals) this._proxy.disconnect(id);
    this._signals = [];
    this._proxy = this._changed = null;
  }
}
