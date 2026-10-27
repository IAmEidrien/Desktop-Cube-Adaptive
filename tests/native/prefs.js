// SPDX-FileCopyrightText: Eidrien
// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const resource =
  Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource');
Gio.resources_register(resource);
const {ExtensionPreferences} =
  await import('resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js');
const dir      = Gio.File.new_for_path(ARGV[0]);
const metadata = JSON.parse(
  new TextDecoder().decode(dir.get_child('metadata.json').load_contents(null)[1]));
Object.assign(metadata, {dir, path: dir.get_path()});
const {default: Preferences} = await import(dir.get_child('prefs.js').get_uri());
const app = new Adw.Application({application_id: 'local.eidrien.CubePreferencesTest'});
app.connect('activate', () => {
  try {
    const prefs = new Preferences(metadata);
    // Supply the registration normally provided by the preferences service.
    // Widgets, settings bindings, resources and translations stay real.
    ExtensionPreferences.lookupByURL = () => prefs;
    const window = new Adw.PreferencesWindow({application: app});
    prefs.fillPreferencesWindow(window);
    if (prefs._pages.length !== 3) throw Error('Missing preferences pages');
    window.present();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
      print('PASS: native preferences build, present and close');
      window.close();
      return GLib.SOURCE_REMOVE;
    });
  } catch (error) {
    console.error(error);
    System.exit(1);
  }
});
app.run([]);
