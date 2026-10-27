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

import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';
import {Workspace} from 'resource:///org/gnome/shell/ui/workspace.js';

//////////////////////////////////////////////////////////////////////////////////////////
// In GNOME Shell, SwipeTrackers are used all over the place to capture swipe gestures. //
// There's one for entering the overview, one for switching workspaces in desktop mode, //
// one for switching workspaces in overview mode, one for horizontal scrolling in the   //
// app drawer, and many more. The ones used for workspace-switching usually do not      //
// respond to single-click dragging but only to multi-touch gestures. We want to be     //
// able to rotate the cube with the left mouse button, so we add the gesture defined    //
// below to these two SwipeTracker instances (this is done by the _addDragGesture() of  //
// the extension class). The gesture is loosely based on the gesture defined here:      //
// https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/swipeTracker.js#L89    //
// It can either preserve Desktop Cube's original horizontal carousel-style input or   //
// follow the active workspace axis. The extension chooses that policy per context so //
// native desktop transitions can follow GNOME / V-Shell while the Overview stays a //
// horizontal cube carousel. Orthogonal movement is stored in the "pitch" property. //
//////////////////////////////////////////////////////////////////////////////////////////

const State = {
  INACTIVE: 0,  // The state will change to PENDING as soon as there is a mouse click.
  PENDING: 1,   // There was a click, but not enough movement to trigger the gesture.
  ACTIVE: 2     // The gesture has been triggered and is in progress.
};

// clang-format off
export var DragGesture =
  GObject.registerClass({
      Properties: {
        'distance': GObject.ParamSpec.double(
          'distance', 'distance', 'distance', GObject.ParamFlags.READWRITE, 0, Infinity, 0),
        'pitch': GObject.ParamSpec.double(
          'pitch', 'pitch', 'pitch', GObject.ParamFlags.READWRITE, -1, 1, 0),
        'enabled': GObject.ParamSpec.boolean(
          'enabled', 'enabled', 'enabled', GObject.ParamFlags.READWRITE, true),
        'horizontal': GObject.ParamSpec.boolean(
          'horizontal', 'horizontal', 'horizontal', GObject.ParamFlags.READWRITE, true),
        'sensitivity': GObject.ParamSpec.double(
          'sensitivity', 'sensitivity', 'sensitivity', GObject.ParamFlags.READWRITE, 1, 10, 1),
      },
      Signals: {
        'begin':  {param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]},
        'update': {param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]},
        'end':    {param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE]},
      },
    },
    class DragGesture extends GObject.Object {
  // clang-format on
  _init(actor, mode) {
    super._init();

    this._actor     = actor;
    this._state     = State.INACTIVE;
    this._mode      = mode;
    this.enabled    = true;
    this.horizontal = true;

    // We listen to the 'captured-event' to be able to intercept some other actions. The
    // main problem is the long-press action of the desktop background actor. This
    // swallows any click events preventing us from dragging the desktop background.
    // By connecting to 'captured-event', we have to extra-careful to propagate any
    // event we are not interested in.
    this._actorConnection1 = actor.connect('captured-event', (a, e) => {
      return this._handleEvent(e);
    });

    // Once the input is grabbed, events are delivered directly to the actor, so we have
    // also to connect to the normal "event" signal.
    this._actorConnection2 = actor.connect('event', (a, e) => {
      if (this._lastGrab) {
        return this._handleEvent(e);
      }
      return Clutter.EVENT_PROPAGATE;
    });
  }

  // Disconnects from the actor.
  destroy() {
    this._actor.disconnect(this._actorConnection1);
    this._actor.disconnect(this._actorConnection2);
  }

  // This is called on every captured event.
  _handleEvent(event) {

    // Desktop Cube can be suspended without disconnecting its captured-event handlers.
    // This is used while the app grid is active so the gesture cannot compete with app
    // icons, folders, or V-Shell's app-grid input handling.
    if (!this.enabled) {
      if (this._state != State.INACTIVE) {
        this._cancel();
      }
      return Clutter.EVENT_PROPAGATE;
    }

    // Abort if the gesture is not meant for the current action mode (e.g. either
    // Shell.ActionMode.OVERVIEW or Shell.ActionMode.NORMAL).
    if (this._mode != Main.actionMode) {
      return Clutter.EVENT_PROPAGATE;
    }

    // In the overview, we only want to switch workspaces by dragging when in
    // window-picker state.
    if (Main.actionMode == Shell.ActionMode.OVERVIEW) {
      if (Main.overview._overview.controls._stateAdjustment.value !=
          ControlsState.WINDOW_PICKER) {
        if (this._state != State.INACTIVE) {
          this._cancel();
        }
        return Clutter.EVENT_PROPAGATE;
      }
    }

    // Ignore touch events on X11. On X11, we get emulated pointer events.
    if (Meta.is_wayland_compositor && !Meta.is_wayland_compositor() &&
        (event.type() == Clutter.EventType.TOUCH_BEGIN ||
         event.type() == Clutter.EventType.TOUCH_UPDATE ||
         event.type() == Clutter.EventType.TOUCH_END)) {
      return Clutter.EVENT_PROPAGATE;
    }

    // When a mouse button is pressed or a touch event starts, we store the
    // corresponding position. The gesture is maybe triggered later, if the pointer was
    // moved a little.
    if (event.type() == Clutter.EventType.BUTTON_PRESS ||
        event.type() == Clutter.EventType.TOUCH_BEGIN) {

      const source = global.stage.get_event_actor(event);

      if (source) {

        // Here's a minor hack: In the overview, there are some draggable things like
        // window previews which "compete" with this gesture. Sometimes, the cube is
        // dragged, sometimes the window previews. So we make sure that we do only start
        // the gesture for events which originate from the given actor or from a
        // workspace's background.
        if (Main.actionMode != Shell.ActionMode.OVERVIEW || source == this._actor ||
            source.get_parent() instanceof Workspace) {
          this._clickPos = event.get_coords();
          this._state    = State.PENDING;
        }
      }

      return Clutter.EVENT_PROPAGATE;
    }

    // Abort the pending state if the pointer leaves the actor.
    if (event.type() == Clutter.EventType.LEAVE && this._state == State.PENDING) {
      this._cancel();
      return Clutter.EVENT_PROPAGATE;
    }

    // As soon as the pointer is moved a bit, the drag action becomes active.
    if (this._eventIsMotion(event)) {

      // If the mouse button is not pressed, we are not interested in the event.
      if (this._state != State.INACTIVE && event.type() == Clutter.EventType.MOTION &&
          (event.get_state() & Clutter.ModifierType.BUTTON1_MASK) == 0) {

        this._cancel();
        return Clutter.EVENT_PROPAGATE;
      }

      const currentPos = event.get_coords();

      // If we are in the pending state, the gesture may be triggered as soon as the
      // pointer is moved enough.
      if (this._state == State.PENDING) {

        const threshold = St.Settings.get().drag_threshold;

        if (Math.abs(currentPos[0] - this._clickPos[0]) > threshold ||
            Math.abs(currentPos[1] - this._clickPos[1]) > threshold) {


          // When starting a drag in desktop mode, we grab the input so that we can move
          // the pointer across windows without loosing the input events.
          if (Main.actionMode == Shell.ActionMode.NORMAL) {
            if (!this._grab()) {
              return Clutter.EVENT_PROPAGATE;
            }
          }

          this._state                  = State.ACTIVE;
          [this._lastX, this._lastY]   = currentPos;
          [this._startX, this._startY] = currentPos;
          this.pitch                   = 0;
          this.emit('begin', event.get_time(), currentPos[0], currentPos[1]);
        }

        // Even if the gesture started, we propagate the event so that any other
        // gestures may wait for long-presses are canceled properly.
        return Clutter.EVENT_PROPAGATE;
      }

      // In the active state, we report updates on each movement.
      if (this._state == State.ACTIVE) {

        // Desktop Cube was designed around horizontal carousel-like dragging. V-Shell's
        // vertical workspace layout can optionally make the gesture follow the workspace
        // axis instead. The private fork defaults to preserving horizontal input because
        // the spire still rotates around the Y axis even though its faces ascend.
        const verticalLayout   = global.workspace_manager.layout_rows === -1;
        const useVerticalInput = verticalLayout && !this.horizontal;
        let delta;

        if (useVerticalInput) {
          delta       = currentPos[1] - this._lastY;
          this._lastY = currentPos[1];
          this.pitch  = (this._startX - currentPos[0]) / global.screen_width;
        } else {
          delta       = currentPos[0] - this._lastX;
          this._lastX = currentPos[0];
          this.pitch  = (this._startY - currentPos[1]) / global.screen_height;
        }

        // Increase sensitivity.
        delta *= this.sensitivity;

        // Increase movement if the cube is rotated on its orthogonal axis.
        delta *= Util.lerp(1.0, global.workspaceManager.get_n_workspaces(),
                           Math.abs(this.pitch));

        this.emit('update', event.get_time(), -delta, this.distance);

        return Clutter.EVENT_STOP;
      }

      return Clutter.EVENT_PROPAGATE;
    }

    // As soon as the mouse button is released or the touch event ends, we quit the
    // gesture.
    if (this._eventIsRelease(event)) {

      // If the gesture was active, report an end event.
      if (this._state == State.ACTIVE) {

        this._cancel();

        this.emit('end', event.get_time(), this.distance);

        return Clutter.EVENT_STOP;
      }

      // If the gesture was in pending state, set it to inactive again.
      this._cancel();

      return Clutter.EVENT_PROPAGATE;
    }

    return Clutter.EVENT_PROPAGATE;
  }

  // This aborts any ongoing grab and resets the current state to inactive.
  _cancel() {
    if (this._lastGrab) {
      this._ungrab();
    }

    this._state = State.INACTIVE;
  }

  // Makes sure that all events from the pointing device we received last input from is
  // passed to the given actor. This is used to ensure that we do not "loose" the touch
  // buttons will dragging them around.
  _grab() {
    this._lastGrab = global.stage.grab(this._actor);
    return this._lastGrab != null;
  }

  // Releases a grab created with the method above.
  _ungrab() {
    this._lastGrab.dismiss();
    this._lastGrab = null;
  }

  // This is borrowed from here:
  // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/dnd.js#L214
  _eventIsRelease(event) {
    if (event.type() == Clutter.EventType.BUTTON_RELEASE) {
      const buttonMask = Clutter.ModifierType.BUTTON1_MASK |
        Clutter.ModifierType.BUTTON2_MASK | Clutter.ModifierType.BUTTON3_MASK;
      // We only obey the last button release from the device, other buttons may get
      // pressed / released during the drag.
      return (event.get_state() & buttonMask) == 0;
    } else if (event.type() == Clutter.EventType.TOUCH_END) {
      // For touch, we only obey the pointer emulating sequence.
      return global.display.is_pointer_emulating_sequence?.(event.get_event_sequence()) ??
        true;
    }

    return false;
  }

  // This is borrowed from here:
  // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/dnd.js#L259
  _eventIsMotion(event) {
    return event.type() == Clutter.EventType.MOTION ||
      (event.type() == Clutter.EventType.TOUCH_UPDATE &&
       (global.display.is_pointer_emulating_sequence?.(event.get_event_sequence()) ??
        true));
  }
});
