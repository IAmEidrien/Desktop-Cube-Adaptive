// SPDX-FileCopyrightText: Eidrien
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function load(file, names, globals = {}) {
  const code = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/export (class|function|const)/g, '$1');
  return vm.runInNewContext(`(()=>{${code}; return {${names.join(',')}};})()`, globals);
}
const policy = load('src/spatialPolicy.js', ['SIDES', 'oppositeSide', 'atEdge']);
class Signals {
  handlers = new Map(); next = 1;
  connect(name, fn) {const id = this.next++; this.handlers.set(id, {name, fn}); return id;}
  disconnect(id) {assert.ok(this.handlers.delete(id));}
}
function fixture() {
  const settings = new Signals();
  const values = {'spatial-overview': true, 'spatial-auto-edge': true, 'spatial-edge': 'top', 'spatial-edge-delay-ms': 100};
  settings.get_boolean = key => values[key]; settings.get_string = key => values[key]; settings.get_uint = key => values[key];
  const overview = new Signals(), state = new Signals(), manager = new Signals(); manager.lookup = () => null;
  const layout = new Signals(); layout.monitors = [{x: -1000, y: -800, width: 1000, height: 800}, {x: 0, y: 0, width: 1200, height: 800}];
  const fit = {value: 0, remove_transition() {}, ease(value) {this.value = value;}};
  overview._overview = {controls: {_stateAdjustment: state, _workspacesDisplay: {_fitModeAdjustment: fit, queue_relayout() {}}}};
  let blocks = 0, refreshes = 0, next = 1;
  const sources = new Map(), monitors = new Set();
  const GLib = {PRIORITY_DEFAULT: 0, PRIORITY_DEFAULT_IDLE: 200, SOURCE_REMOVE: false,
    timeout_add(_priority, _ms, callback) {const id = next++; sources.set(id, callback); return id;},
    idle_add(_priority, callback) {const id = next++; sources.set(id, callback); return id;},
    source_remove(id) {assert.ok(sources.delete(id));}};
  const Main = {overview, layoutManager: layout, extensionManager: manager,
    wm: {_workspaceTracker: {blockUpdates() {blocks++;}, unblockUpdates() {blocks--;}}}};
  const owner = {_settings: settings, _isAppGridActive: () => false,
    _queueOverviewCubeUpdate() {}, _syncOverviewGestureInput() {}, _refreshEdgeSwitchBarriers() {refreshes++;}};
  const {SpatialOverview} = load('src/SpatialOverview.js', ['SpatialOverview'], {
    ...policy, Gio: {}, GLib, Main, Clutter: {AnimationMode: {EASE_OUT_QUAD: 0}},
    St: {ThemeContext: {get_for_stage: () => ({scale_factor: 1})}},
    DND: {DragMotionResult: {CONTINUE: 0}, addDragMonitor: m => monitors.add(m), removeDragMonitor: m => assert.ok(monitors.delete(m))},
    global: {stage: {}, workspace_manager: new Signals()},
  });
  const spatial = new SpatialOverview(owner);
  const fire = () => {const [id, fn] = sources.entries().next().value; sources.delete(id); fn();};
  return {spatial, owner, settings, values, fit, display: overview._overview.controls._workspacesDisplay, layout, manager, sources, monitors, fire, blocks: () => blocks, refreshes: () => refreshes};
}
test('opposite edges and negative/offset monitor boundaries are correct', () => {
  for (const [side, result] of [['top','bottom'],['right','left'],['bottom','top'],['left','right']]) assert.equal(policy.oppositeSide(side), result);
  assert.equal(policy.oppositeSide('unknown'), 'top');
  const monitor = {x: -1000, y: -800, width: 1000, height: 800};
  assert.ok(policy.atEdge(-999, -400, monitor, 'left', 24));
  assert.ok(policy.atEdge(-500, -799, monitor, 'top', 24));
  assert.equal(policy.atEdge(0, -400, monitor, 'right', 24), false);
  assert.equal(policy.atEdge(-500, -400, monitor, 'top', 24), false);
});
test('effective dock position wins over saved settings and follows each monitor', () => {
  const f = fixture();let position = 0;
  f.manager.lookup = id => id.startsWith('dash-to-dock-adaptive') ? {state: 1} : null;
  f.spatial._modules.set('dash-to-dock-adaptive@eidrien.local', {dockManager: {getDockByMonitor: i => i === 0 ? {position} : null}});
  assert.equal(f.spatial.edge(0), 'bottom');position = 1;assert.equal(f.spatial.edge(0), 'left');
  assert.equal(f.spatial.edge(1), 'top');
  f.values['spatial-auto-edge'] = false;f.values['spatial-edge'] = 'right';assert.equal(f.spatial.edge(0), 'right');f.spatial.destroy();
});
test('edge dwell cancels on leaving the zone and rejects a stale dock side', () => {
  const f = fixture();let side = 'bottom';f.spatial.dockSide = () => side;
  f.spatial.begin({});f.spatial.motion(500, 1);assert.equal(f.sources.size, 1);
  f.spatial.motion(500, 300);assert.equal(f.sources.size, 0);
  f.spatial.motion(500, 1);side = 'left';f.fire();assert.equal(f.spatial.active, false);
  f.spatial.end();assert.equal(f.monitors.size, 0);f.spatial.destroy();
});
test('spread and cancellation preserve fit state, balance tracking and remove sources', () => {
  const f = fixture();f.spatial.begin({});f.spatial.show(1);assert.equal(f.fit.value, 1);assert.equal(f.blocks(), 1);
  f.spatial.end();assert.equal(f.sources.size, 1);f.fire();
  assert.equal(f.fit.value, 0);assert.equal(f.blocks(), 0);assert.equal(f.monitors.size, 0);assert.equal(f.spatial.active, false);
  f.spatial.begin({});f.spatial.show(1);f.spatial.destroy();assert.equal(f.fit.value, 0);assert.equal(f.blocks(), 0);assert.equal(f.sources.size, 0);
});
test('disabled feature and app grid do not begin; grid entry keeps its fit-all state', () => {
  const f = fixture();f.values['spatial-overview'] = false;f.spatial.begin({});assert.equal(f.spatial.dragging, false);
  f.values['spatial-overview'] = true;f.owner._isAppGridActive = () => true;f.spatial.begin({});assert.equal(f.spatial.dragging, false);
  f.owner._isAppGridActive = () => false;f.spatial.begin({});f.spatial.show(0);
  f.owner._isAppGridActive = () => true;f.spatial.end();f.fire();assert.equal(f.fit.value, 1);f.spatial.destroy();
});
test('idle app-grid notifications do not recursively request more overview updates', () => {
  const f = fixture();let updates = 0;
  f.owner._isAppGridActive = () => true;
  f.owner._queueOverviewCubeUpdate = () => {if (++updates > 1) throw Error('recursive update'); f.spatial.end();};
  f.spatial.end();assert.equal(updates, 0);f.spatial.destroy();assert.equal(updates, 0);
});
test('secondary monitor fit bounds and a V-Shell app-grid fit policy are restored', () => {
  const f = fixture();
  const secondary = {value: 0, upper: 0, remove_transition() {}, ease(value) {this.value = value;}};
  const display = {_fitModeAdjustment: f.fit, _workspacesViews: [{_workspacesView: {_fitModeAdjustment: secondary}}],
    _getFitModeForState: () => 0, queue_relayout() {}};
  Object.assign(f.display, display);
  f.spatial.begin({});f.spatial.show(1);
  assert.equal(secondary.upper, 1);assert.equal(secondary.value, 1);
  f.owner._isAppGridActive = () => true;f.spatial.end();f.fire();
  assert.equal(f.fit.value, 0);assert.equal(secondary.value, 0);assert.equal(secondary.upper, 0);
  f.spatial.destroy();
});
