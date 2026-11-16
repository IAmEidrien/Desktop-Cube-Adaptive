// SPDX-FileCopyrightText: Eidrien
// SPDX-License-Identifier: MIT

export const PEER_KEYS = {
  'hide-empty-workspace': 'ws-switcher-ignore-last',
  'allow-workspace-looping': 'ws-switcher-wraparound',
};

// Effective values only. Neither settings object is ever written.
export class WorkspacePolicy {
  constructor(local, changed) {
    this._local   = local;
    this._changed = changed;
    this._signals = [];
    this._peer    = null;
  }
  get owned() {
    return !!this._peer;
  }
  get(key) {
    return this._peer ? this._peer.get_boolean(PEER_KEYS[key]) :
                        this._local.get_boolean(key);
  }
  setPeer(peer) {
    if (peer === this._peer) return;
    for (const id of this._signals) this._peer.disconnect(id);
    this._signals = [];
    this._peer    = peer;
    if (peer)
      for (const key of Object.values(PEER_KEYS))
        this._signals.push(peer.connect(`changed::${key}`, () => this._changed()));
    this._changed();
  }
  destroy() {
    for (const id of this._signals) this._peer.disconnect(id);
    this._signals = [];
    this._peer = this._local = this._changed = null;
  }
}
