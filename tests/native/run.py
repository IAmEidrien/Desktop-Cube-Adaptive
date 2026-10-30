#!/usr/bin/env python3
# SPDX-FileCopyrightText: Eidrien
# SPDX-License-Identifier: GPL-3.0-or-later
"""Run an isolated real Shell. Requires GNOME, GJS/GTK4, Xvfb and D-Bus.

Use inside the chosen GNOME test environment, never an existing desktop session.
All settings, extensions and logs are isolated under --output; no host session
is replaced. Optional peer checkouts must already match the selected Shell.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--version', default='46')
parser.add_argument('--vshell', type=Path)
parser.add_argument('--dock', type=Path)
parser.add_argument('--axis', choices=['vertical', 'horizontal'], default='vertical')
parser.add_argument('--xorg', action='store_true')
parser.add_argument('--monitors', type=int, default=1)
args = parser.parse_args()
if args.monitors < 1 or (args.monitors > 1 and (args.xorg or int(args.version) < 50)):
    parser.error('Multiple virtual monitors require the GNOME 50+ headless backend')

source = Path(__file__).resolve().parent
repo = source.parents[1]
root = args.output.resolve()
root.mkdir(parents=True, exist_ok=False)
for part in ['config', 'data', 'cache', 'runtime']:
    (root / part).mkdir(mode=0o700)
extensions = root / 'data/gnome-shell/extensions'
extensions.mkdir(parents=True)


def copy_extension(checkout, uuid):
    target = extensions / uuid
    shutil.copytree(checkout, target, ignore=shutil.ignore_patterns(
        '.git', '*.zip', 'tests', '__pycache__'))
    if (target / 'schemas').exists():
        subprocess.run(['glib-compile-schemas', '--strict', str(target / 'schemas')], check=True)


copy_extension(repo, 'desktop-cube-adaptive@eidrien.local')
setup = []
if args.vshell:
    copy_extension(args.vshell, 'vertical-workspaces@G-dH.github.com')
    setup.append(['gsettings', '--schemadir', str(extensions / 'vertical-workspaces@G-dH.github.com/schemas'),
                  'set', 'org.gnome.shell.extensions.vertical-workspaces', 'ws-thumbnails-position',
                  '4' if args.axis == 'vertical' else '9'])
if args.dock:
    copy_extension(args.dock, 'dash-to-dock-adaptive@eidrien.local')
    for key in ['show-trash', 'show-mounts']:
        setup.append(['gsettings', '--schemadir', str(extensions / 'dash-to-dock-adaptive@eidrien.local/schemas'),
                      'set', 'org.gnome.shell.extensions.dash-to-dock', key, 'false'])
probe = extensions / 'cube-probe@eidrien.local'
probe.mkdir()
(probe / 'metadata.json').write_text(json.dumps({
    'uuid': probe.name, 'name': 'Cube native test', 'description': 'Isolated test',
    'shell-version': [args.version],
}))
shutil.copy(source / 'probe.js', probe / 'extension.js')
shutil.copy(source / 'client.js', root / 'client.js')
env = dict(os.environ, REVIEW_ROOT=str(root), TEST_MONITORS=str(args.monitors),
           TEST_VSHELL='1' if args.vshell else '', TEST_DOCK='1' if args.dock else '',
           LIBGL_ALWAYS_SOFTWARE='1', GALLIUM_DRIVER='llvmpipe',
           XDG_CONFIG_HOME=str(root / 'config'), XDG_DATA_HOME=str(root / 'data'),
           XDG_CACHE_HOME=str(root / 'cache'), XDG_RUNTIME_DIR=str(root / 'runtime'),
           XDG_SESSION_TYPE='x11' if args.xorg else 'wayland', XDG_CURRENT_DESKTOP='GNOME',
           GSETTINGS_BACKEND='dconf', GTK_A11Y='none',
           DBUS_SYSTEM_BUS_ADDRESS=f'unix:path={root}/runtime/system-bus')
if args.xorg:
    flags = ['--x11', '--replace', '--sm-disable']
elif int(args.version) < 50:
    flags = ['--nested', '--wayland', '--no-x11', '--sm-disable']
else:
    flags = ['--headless', *(['--virtual-monitor=1280x800'] * args.monitors), '--no-x11']
setup += [
    ['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', '["cube-probe@eidrien.local"]'],
    ['gsettings', 'set', 'org.gnome.shell', 'disabled-extensions', '[]'],
    ['gsettings', 'set', 'org.gnome.shell', 'disable-extension-version-validation', 'true'],
    ['gsettings', 'set', 'org.gnome.shell', 'welcome-dialog-last-shown-version', args.version],
    ['gsettings', 'set', 'org.gnome.mutter', 'dynamic-workspaces', 'false'],
    ['gsettings', 'set', 'org.gnome.mutter', 'workspaces-only-on-primary', 'false'],
    ['gsettings', 'set', 'org.gnome.desktop.wm.preferences', 'num-workspaces', '6'],
]
# argv arrays avoid interpreting checkout/output paths as shell code.
(root / 'setup.json').write_text(json.dumps(setup))
(root / 'flags.json').write_text(json.dumps(flags))
(root / 'session.py').write_text('''import json, os, subprocess
from pathlib import Path
root = Path(os.environ['REVIEW_ROOT'])
for command in json.loads((root / 'setup.json').read_text()):
    subprocess.run(command, check=True)
os.execvp('gnome-shell', ['gnome-shell', *json.loads((root / 'flags.json').read_text())])
''')
session = '''set -eu
dbus-daemon --session --address="$DBUS_SYSTEM_BUS_ADDRESS" --nofork > "$REVIEW_ROOT/system-bus.log" 2>&1 &
bus_pid=$!
trap 'kill "$bus_pid" 2>/dev/null || true' EXIT
dbus-run-session -- xvfb-run -a -s '-screen 0 1280x800x24 +extension GLX' python3 "$REVIEW_ROOT/session.py"
'''
with (root / 'shell.log').open('w') as log:
    process = subprocess.Popen(['bash', '-c', session], env=env, stdout=log,
                               stderr=subprocess.STDOUT, start_new_session=True)
    try:
        for _ in range(120):
            if (root / 'result.json').exists():
                result = json.loads((root / 'result.json').read_text())
                print(json.dumps(result), flush=True)
                if not result.get('pass'):
                    raise RuntimeError(f'Native probe failed; see {root}')
                break
            if process.poll() is not None:
                raise RuntimeError(f'Shell exited; see {root}')
            time.sleep(1)
        else:
            raise TimeoutError(str(root))
    finally:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except ProcessLookupError:
            pass
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
