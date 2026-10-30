// SPDX-FileCopyrightText: Eidrien
// SPDX-License-Identifier: GPL-3.0-or-later

export const SIDES = ['top', 'right', 'bottom', 'left'];

export function oppositeSide(side) {
  const index = SIDES.indexOf(side);
  return index < 0 ? 'top' : SIDES[(index + 2) % 4];
}

export function atEdge(x, y, monitor, side, distance) {
  if (x < monitor.x || y < monitor.y || x >= monitor.x + monitor.width ||
      y >= monitor.y + monitor.height)
    return false;
  switch (side) {
    case 'left':
      return x < monitor.x + distance;
    case 'right':
      return x >= monitor.x + monitor.width - distance;
    case 'bottom':
      return y >= monitor.y + monitor.height - distance;
    default:
      return y < monitor.y + distance;
  }
}
