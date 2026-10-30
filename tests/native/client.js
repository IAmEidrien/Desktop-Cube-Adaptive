// SPDX-FileCopyrightText: Eidrien
// SPDX-License-Identifier: GPL-3.0-or-later
import Gtk from 'gi://Gtk?version=4.0';
const app = new Gtk.Application({application_id: ARGV[0]});
app.connect('activate', () => {
  const win = app.active_window ?? new Gtk.ApplicationWindow({
    application: app,
    title: ARGV[0],
    default_width: 400,
    default_height: 280,
  });
  win.present();
});
app.run([]);
