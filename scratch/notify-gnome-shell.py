#!/usr/bin/env python3
"""
Helpers for scratch/notify-gnome-check.mjs, run against the GNOME Shell of the
current session bus (meant for the private, headless one notify-gnome-nested.sh
starts; on a real desktop the Shell refuses both calls).

  notify-gnome-shell.py shot <file.png>   a screenshot of the whole screen
  notify-gnome-shell.py click <x> <y>     a left click at (x, y), through Mutter's remote desktop API

The screenshot asks org.gnome.Shell.Screenshot, which answers only callers
that own one of a few names; on its own private bus this script takes one.
"""
import sys
import time

from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def call(dest, path, iface, method, args=None, reply=None):
    return bus.call_sync(dest, path, iface, method, args, GLib.VariantType(reply) if reply else None,
                         Gio.DBusCallFlags.NONE, -1, None)


def shot(out):
    call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName',
         GLib.Variant('(su)', ('org.gnome.SettingsDaemon.MediaKeys', 4)), '(u)')
    time.sleep(0.5)
    ok, path = call('org.gnome.Shell.Screenshot', '/org/gnome/Shell/Screenshot', 'org.gnome.Shell.Screenshot',
                    'Screenshot', GLib.Variant('(bbs)', (False, False, out)), '(bs)').unpack()
    print('screenshot', ok, path)


def click(x, y):
    (session,) = call('org.gnome.Mutter.RemoteDesktop', '/org/gnome/Mutter/RemoteDesktop',
                      'org.gnome.Mutter.RemoteDesktop', 'CreateSession', None, '(o)').unpack()
    s = lambda method, args=None: call('org.gnome.Mutter.RemoteDesktop', session,
                                       'org.gnome.Mutter.RemoteDesktop.Session', method, args)
    s('Start')
    time.sleep(0.3)
    # No screen-cast stream, so relative motion: into the top-left corner first, then to (x, y).
    s('NotifyPointerMotionRelative', GLib.Variant('(dd)', (-10000.0, -10000.0)))
    time.sleep(0.1)
    s('NotifyPointerMotionRelative', GLib.Variant('(dd)', (float(x), float(y))))
    time.sleep(0.4)
    s('NotifyPointerButton', GLib.Variant('(ib)', (0x110, True)))
    time.sleep(0.08)
    s('NotifyPointerButton', GLib.Variant('(ib)', (0x110, False)))
    time.sleep(0.3)
    s('Stop')
    print('clicked', x, y)


if __name__ == '__main__':
    if sys.argv[1] == 'shot':
        shot(sys.argv[2])
    elif sys.argv[1] == 'click':
        click(int(sys.argv[2]), int(sys.argv[3]))
    else:
        sys.exit('usage: notify-gnome-shell.py shot <file> | click <x> <y>')
