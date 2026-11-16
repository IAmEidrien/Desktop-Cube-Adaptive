// SPDX-FileCopyrightText: Eidrien
// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
const candidates =
  ['/usr/share/gnome-shell', GLib.getenv('GNOME_SHELL_DATADIR')].filter(Boolean);
const resource = candidates.map(p => `${p}/org.gnome.Shell.Extensions.src.gresource`)
                   .find(p => Gio.File.new_for_path(p).query_exists(null));
Gio.resources_register(Gio.Resource.load(resource));
const {ExtensionPreferences} =
  await import('resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js');
const dir = Gio.File.new_for_path(ARGV[0]), status = ARGV[1];
const metadata = JSON.parse(
  new TextDecoder().decode(dir.get_child('metadata.json').load_contents(null)[1]));
Object.assign(metadata, {dir, path: dir.get_path()});
const {default: Preferences} = await import(dir.get_child('prefs.js').get_uri());
const walk = w => {
  const result = [w];
  for (let c = w.get_first_child(); c; c = c.get_next_sibling()) result.push(...walk(c));
  return result;
};
const app = new Adw.Application({application_id: 'org.eidrien.CubePolicyPrefs'});
app.connect('activate', () => {
  const prefs                      = new Preferences(metadata);
  ExtensionPreferences.lookupByURL = () => prefs;
  const w                                = new Adw.PreferencesWindow({application: app});
  prefs.fillPreferencesWindow(w);
  w.present();
  const widgets = walk(w), find = t => widgets.find(x => x.get_title?.() === t);
  const hide = find('Hide empty workspace'), loop = find('Allow looping workspaces');
  const reset = prefs._builder.get_object('reset-last-first-gap');
  let gap     = reset;
  while (gap && !gap.get_title?.()) gap = gap.get_parent();
  const update = () => GLib.file_set_contents(
    status, JSON.stringify({hide: hide.visible, loop: loop.visible, gap: gap.sensitive}));
  for (const [o, n] of [[hide, 'visible'], [loop, 'visible'], [gap, 'sensitive']])
    o.connect(`notify::${n}`, update);
  update();
  const close = new Gio.SimpleAction({name: 'close'});
  close.connect('activate', () => {
    w.close();
    app.quit();
  });
  app.add_action(close);
});
app.run([]);
