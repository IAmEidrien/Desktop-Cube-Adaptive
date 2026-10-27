//////////////////////////////////////////////////////////////////////////////////////////
//             ,-.  ,--.  ,-.  ,  , ,---.  ,-.  ;-.     ,-. .  . ,-.  ,--.              //
//             |  \ |    (   ` | /    |   /   \ |  )   /    |  | |  ) |                 //
//             |  | |-    `-.  |<     |   |   | |-'    |    |  | |-<  |-                //
//             |  / |    .   ) | \    |   \   / |      \    |  | |  ) |                 //
//             `-'  `--'  `-'  '  `   '    `-'  '       `-' `--` `-'  `--'              //
//////////////////////////////////////////////////////////////////////////////////////////

// SPDX-FileCopyrightText: Simon Schneegans <code@simonschneegans.de>
// SPDX-License-Identifier: GPL-3.0-or-later

'use strict';

import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Adw from 'gi://Adw';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {registerImageChooserButton} from './src/ImageChooserButton.js';

//////////////////////////////////////////////////////////////////////////////////////////
// For now, the preferences dialog of this extension is very simple. In the future, if  //
// we might consider to improve its layout...                                           //
//////////////////////////////////////////////////////////////////////////////////////////

export default class DesktopCubePreferences extends ExtensionPreferences {

  // -------------------------------------------------------------------- public interface

  // This function is called when the preferences window is created. We create a new
  // instance of the PreferencesDialog class each time this method is called. This way we
  // can actually open multiple settings windows and interact with all of them properly.
  fillPreferencesWindow(window) {
    // Load all of our resources.
    this._resources = Gio.Resource.load(this.path + '/resources/desktop-cube.gresource');
    Gio.resources_register(this._resources);

    // Register our custom widgets.
    registerImageChooserButton();

    // Load the user interface file.
    this._builder = new Gtk.Builder();
    this._builder.add_from_resource(`/ui/settings.ui`);

    // Make sure custom icons are found.
    Gtk.IconTheme.get_for_display(Gdk.Display.get_default()).add_resource_path('/img');

    // These are our top-level preferences pages which we will return later.
    this._pages = [
      this._builder.get_object('general-page'), this._builder.get_object('desktop-page'),
      this._builder.get_object('overview-page')
    ];

    // Store a reference to the settings object.
    this._settings = this.getSettings();

    // Bind all properties.
    this._bindAdjustment('workpace-separation');
    this._bindAdjustment('horizontal-stretch');
    this._bindAdjustment('window-parallax');
    this._bindImageChooserButton('background-panorama');
    this._bindSwitch('last-first-gap');
    this._bindSwitch('enable-desktop-dragging');
    this._bindSwitch('enable-panel-dragging');
    this._bindSwitch('enable-desktop-edge-switch');
    this._bindSwitch('enable-overview-edge-switch');
    this._bindSwitch('enable-overview-dragging');
    this._bindSwitch('do-explode');
    this._bindSwitch('per-monitor-perspective');
    this._bindAdjustment('active-workpace-opacity');
    this._bindAdjustment('inactive-workpace-opacity');
    this._bindAdjustment('edge-switch-pressure');
    this._bindAdjustment('mouse-rotation-speed');

    // Add Adaptive options which are not part of the upstream UI resource.
    // Keeping these rows programmatic lets this fork remain a drop-in package without
    // rebuilding Desktop Cube's compiled GResource archive.
    this._addForkOptions();

    // Inject the video link.
    const label    = this._builder.get_object('central-perspective-row');
    label.subtitle = label.subtitle.replace(
      '%s', '<a href="https://youtu.be/dpYyn1BXGjU">https://youtu.be/dpYyn1BXGjU</a>');

    // Add a menu to the title bar of the preferences dialog.
    this._pages[0].connect('realize', (widget) => {
      const window = widget.get_root();

      // Add the menu to the header bar.
      const menu   = this._builder.get_object('menu-button');
      const header = this._findWidgetByType(window.get_content(), Adw.HeaderBar);
      header.pack_start(menu);

      // Populate the actions.
      const group = Gio.SimpleActionGroup.new();

      const addAction = (name, uri) => {
        const action = Gio.SimpleAction.new(name, null);
        action.connect('activate', () => Gtk.show_uri(null, uri, Gdk.CURRENT_TIME));
        group.add_action(action);
      };

      // clang-format off
      addAction('homepage',      'https://github.com/IAmEidrien/Desktop-Cube-Adaptive');
      addAction('changelog',     'https://github.com/Schneegans/Desktop-Cube/blob/main/docs/changelog.md');
      addAction('translate',     'https://hosted.weblate.org/engage/desktop-cube/');
      addAction('bugs',          'https://github.com/IAmEidrien/Desktop-Cube-Adaptive/issues');
      addAction('donate-kofi',   'https://ko-fi.com/schneegans');
      addAction('donate-github', 'https://github.com/sponsors/Schneegans');
      addAction('donate-paypal', 'https://www.paypal.me/simonschneegans');
      addAction('show-sponsors', 'https://schneegans.github.io/sponsors');
      // clang-format on

      // Add the about dialog.
      const aboutAction = Gio.SimpleAction.new('about', null);
      aboutAction.connect('activate', () => {
        // The JSON report format from weblate is a bit weird. Here we extract all
        // unique names from the translation report.
        const translators = new Set();
        this._getJSONResource('/credits/translators.json').forEach(i => {
          for (const j of Object.values(i)) {
            j.forEach(k => translators.add(k[1]));
          }
        });

        const dialog = new Adw.AboutWindow({transient_for: window, modal: true});
        dialog.set_application_icon('desktop-cube-symbolic');
        dialog.set_application_name('Desktop Cube Adaptive');
        dialog.set_version(`${this.metadata.version}`);
        dialog.set_developer_name('Eidrien; upstream by Simon Schneegans');
        dialog.set_issue_url(
          'https://github.com/IAmEidrien/Desktop-Cube-Adaptive/issues');
        dialog.set_translator_credits([...translators].join('\n'));
        dialog.set_copyright('© 2023 Simon Schneegans');
        dialog.set_website('https://github.com/IAmEidrien/Desktop-Cube-Adaptive');
        dialog.set_license_type(Gtk.License.GPL_3_0);

        dialog.show();
      });
      group.add_action(aboutAction);

      window.insert_action_group('prefs', group);
    });

    window.set_search_enabled(true);

    this._pages.forEach(page => {
      window.add(page);
    });

    // As we do not have something like a destructor, we just listen for the destroy
    // signal of our general page.
    window.connect('close-request', () => {
      // Unregister our resources.
      Gio.resources_unregister(this._resources);
      this._resources = null;
    });
  }


  // ----------------------------------------------------------------------- private stuff

  // Adds settings which exist only in this fork. The upstream preferences UI is
  // shipped as a compiled GResource, so these rows are inserted at runtime.
  _addForkOptions() {
    const createSwitchRow = (settingsKey, title, subtitle) => {
      const row = new Adw.ActionRow({
        title: _(title),
        subtitle: _(subtitle),
      });

      const toggle           = new Gtk.Switch({valign: Gtk.Align.CENTER});
      row.activatable_widget = toggle;
      row.add_suffix(toggle);

      const reset = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: _('Reset to default value'),
      });
      reset.add_css_class('flat');
      row.add_suffix(reset);

      this._settings.bind(settingsKey, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
      reset.connect('clicked', () => this._settings.reset(settingsKey));

      return row;
    };

    // General: workspace looping belongs beside the existing last/first gap concept.
    // Appending it to the same group keeps the upstream resource untouched. When looping
    // is active the gap setting has no semantic meaning, so make that row insensitive.
    const lastFirstRow = this._findAncestorByType(
      this._builder.get_object('reset-last-first-gap'), Adw.ActionRow);
    const generalGroup = this._findAncestorByType(lastFirstRow, Adw.PreferencesGroup);
    const loopRow      = createSwitchRow(
      'allow-workspace-looping', 'Allow looping workspaces',
      'Continue from the last visible workspace to the first and vice versa.');
    generalGroup.add(loopRow);

    const originalGapSubtitle  = lastFirstRow.subtitle;
    const updateGapSensitivity = () => {
      const looping          = this._settings.get_boolean('allow-workspace-looping');
      lastFirstRow.sensitive = !looping;
      lastFirstRow.subtitle  = looping ?
         _('The cube is closed into a full loop while workspace looping is enabled.') :
         originalGapSubtitle;
    };
    this._settings.connect('changed::allow-workspace-looping', updateGapSensitivity);
    updateGapSensitivity();

    const horizontalInputRow = createSwitchRow(
      'horizontal-workspace-input', 'Use horizontal workspace input',
      'Use left/right input for Desktop Cube\'s workspace carousel. When the desktop cube animation is disabled, ordinary desktop switching follows GNOME / V-Shell\'s native workspace axis.');
    generalGroup.add(horizontalInputRow);

    const desktopAnimationRow = createSwitchRow(
      'enable-desktop-workspace-cube-animation',
      'Animate desktop workspace switches as a cube',
      'Apply Desktop Cube\'s 3D transform outside the Overview. Turn off to keep GNOME or V-Shell\'s native workspace transition.');
    generalGroup.add(desktopAnimationRow);

    const spatial = new Adw.PreferencesGroup({
      title: _('Spatial window dragging'),
      description: _(
        'Drag an Overview window to the selected edge to spread Cube’s existing workspaces into drop targets. Workspace thumbnails remain unchanged.')
    });
    this._pages[2].add(spatial);
    spatial.add(
      createSwitchRow('spatial-overview', 'Enable spatial window dragging',
                      'Show all existing workspaces while dragging an Overview window.'));
    spatial.add(createSwitchRow(
      'spatial-auto-edge', 'Use the edge opposite the dock',
      'Follow the dock’s effective side on each monitor; use the fallback edge when no dock is detected.'));
    const edges = ['top', 'right', 'bottom', 'left'];
    const edge  = new Adw.ComboRow({
      title: _('Fallback / manual edge'),
      model: Gtk.StringList.new([_('Top'), _('Right'), _('Bottom'), _('Left')]),
      selected: Math.max(0, edges.indexOf(this._settings.get_string('spatial-edge')))
    });
    edge.connect('notify::selected',
                 () => this._settings.set_string('spatial-edge', edges[edge.selected]));
    spatial.add(edge);
    const delay = new Adw.SpinRow({
      title: _('Edge dwell time (milliseconds)'),
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 2000,
        step_increment: 50,
        value: this._settings.get_uint('spatial-edge-delay-ms')
      })
    });
    delay.connect(
      'notify::value',
      () => this._settings.set_uint('spatial-edge-delay-ms', Math.round(delay.value)));
    spatial.add(delay);

    // Overview: place the fork options immediately before the two wallpaper-opacity
    // sliders. The rows are temporarily removed and re-added because AdwPreferencesGroup
    // exposes append/remove rather than indexed insertion.
    const activeOpacityRow = this._findAncestorByType(
      this._builder.get_object('reset-active-workpace-opacity'), Adw.ActionRow);
    const inactiveOpacityRow = this._findAncestorByType(
      this._builder.get_object('reset-inactive-workpace-opacity'), Adw.ActionRow);
    const overviewGroup =
      this._findAncestorByType(activeOpacityRow, Adw.PreferencesGroup);

    overviewGroup.remove(activeOpacityRow);
    overviewGroup.remove(inactiveOpacityRow);

    const hideEmptyRow = createSwitchRow(
      'hide-empty-workspace', 'Hide empty workspace',
      'Hide the trailing empty workspace when dynamic workspaces are enabled.');
    const hideWallpaperRow = createSwitchRow(
      'hide-wallpaper', 'Hide wallpaper',
      'Let V-Shell, Blur my Shell, or the overview background show through the cube faces.');

    overviewGroup.add(hideEmptyRow);
    overviewGroup.add(hideWallpaperRow);
    overviewGroup.add(activeOpacityRow);
    overviewGroup.add(inactiveOpacityRow);

    const updateOpacitySensitivity = () => {
      const sensitive              = !this._settings.get_boolean('hide-wallpaper');
      activeOpacityRow.sensitive   = sensitive;
      inactiveOpacityRow.sensitive = sensitive;
    };
    this._settings.connect('changed::hide-wallpaper', updateOpacitySensitivity);
    updateOpacitySensitivity();
  }

  // Connects a DesktopCubeImageChooserButton (or anything else which has a 'file'
  // property) to a settings key. It also binds the corresponding reset button.
  _bindImageChooserButton(settingsKey) {
    this._bind(settingsKey, 'file');
  }

  // Connects a Gtk.Adjustment (or anything else which has a 'value' property) to a
  // settings key. It also binds the corresponding reset button.
  _bindAdjustment(settingsKey) {
    this._bind(settingsKey, 'value');
  }

  // Connects a Gtk.Switch (or anything else which has an 'active' property) to a settings
  // key. It also binds the corresponding reset button.
  _bindSwitch(settingsKey) {
    this._bind(settingsKey, 'active');
  }

  // Connects any widget's property to a settings key. The widget must have the same ID as
  // the settings key. It also binds the corresponding reset button.
  _bind(settingsKey, property) {
    this._settings.bind(settingsKey, this._builder.get_object(settingsKey), property,
                        Gio.SettingsBindFlags.DEFAULT);

    const resetButton = this._builder.get_object('reset-' + settingsKey);
    resetButton.connect('clicked', () => {
      this._settings.reset(settingsKey);
    });
  }

  // Reads the contents of a JSON file contained in the global resources archive. The data
  // is parsed and returned as a JavaScript object / array.
  _getJSONResource(path) {
    const data   = Gio.resources_lookup_data(path, 0);
    const string = new TextDecoder().decode(data.get_data());
    return JSON.parse(string);
  }

  // Walks upward from a widget and returns the first ancestor of the given type.
  _findAncestorByType(widget, type) {
    let parent = widget?.get_parent();
    while (parent) {
      if (parent instanceof type) return parent;
      parent = parent.get_parent();
    }
    return null;
  }

  // This traverses the widget tree below the given parent recursively and returns the
  // first widget of the given type.
  _findWidgetByType(parent, type) {
    for (const child of [...parent]) {
      if (child instanceof type) return child;

      const match = this._findWidgetByType(child, type);
      if (match) return match;
    }

    return null;
  }
}
