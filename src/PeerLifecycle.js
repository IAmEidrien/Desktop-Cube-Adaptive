// SPDX-FileCopyrightText: Eidrien
// SPDX-License-Identifier: MIT

// Bracket peer rebuilds without changing peer files or registering another
// settings observer which could run before the peer has finished rebuilding.
export class PeerLifecycle {
  constructor(peer, before, after) {
    this._entries = [];
    this._depth   = 0;
    this._before  = before;
    this._after   = after;
    for (const name
           of ['_updateOverrides', '_repairOverrides', '_activateVShell', 'disable']) {
      if (typeof peer[name] !== 'function') continue;
      const original   = peer[name];
      const descriptor = Object.getOwnPropertyDescriptor(peer, name);
      const lease      = this;
      const wrapper    = function(...args) {
        if (!lease._before) return original.apply(this, args);
        const outer = lease._depth++ === 0;
        try {
          if (outer) lease._before(name);
          return original.apply(this, args);
        } finally {
          lease._depth--;
          if (outer) lease._after?.(name);
        }
      };
      peer[name] = wrapper;
      this._entries.push({peer, name, original, descriptor, wrapper});
    }
  }

  destroy() {
    this._before = this._after = null;
    for (const {peer, name, descriptor, wrapper} of this._entries) {
      if (peer[name] !== wrapper) continue;
      if (descriptor)
        Object.defineProperty(peer, name, descriptor);
      else
        delete peer[name];
    }
    this._entries = [];
  }
}
