"""Makes the packaged macOS app behave like a normal Mac app.

Without an event loop macOS sees a windowless app that never answers: clicking its Dock icon does nothing and Quit
from the Dock (or Cmd+Q) is ignored. This runs a minimal Cocoa event loop on the main thread while the server runs
in a background thread:
  - clicking the Dock icon (or opening the app again from Finder) opens Tonelith in the browser,
  - Quit from the Dock, the menu bar or Cmd+Q stops the server (asking first if an export or import is running).
Needs PyObjC (pyobjc-framework-Cocoa), which is only installed for building the app.
"""
import webbrowser

import AppKit
from Foundation import NSObject

_state = dict(url="", busy=lambda: False)


class _Delegate(NSObject):
    def applicationShouldHandleReopen_hasVisibleWindows_(self, app, has_windows):
        webbrowser.open(_state["url"])
        return False

    def openBrowser_(self, sender):
        webbrowser.open(_state["url"])

    def applicationShouldTerminate_(self, app):
        if not _state["busy"]():
            return AppKit.NSTerminateNow
        app.activateIgnoringOtherApps_(True)
        alert = AppKit.NSAlert.alloc().init()
        alert.setMessageText_("Quit Tonelith?")
        alert.setInformativeText_("An export or movie import is still running and will be stopped.")
        alert.addButtonWithTitle_("Quit")
        alert.addButtonWithTitle_("Cancel")
        return AppKit.NSTerminateNow if alert.runModal() == AppKit.NSAlertFirstButtonReturn else AppKit.NSTerminateCancel


def _menu(delegate):
    """The menu bar: Tonelith > Open in Browser / Quit Tonelith."""
    bar = AppKit.NSMenu.alloc().init()
    item = AppKit.NSMenuItem.alloc().init()
    bar.addItem_(item)
    menu = AppKit.NSMenu.alloc().initWithTitle_("Tonelith")
    open_item = menu.addItemWithTitle_action_keyEquivalent_("Open in Browser", "openBrowser:", "o")
    open_item.setTarget_(delegate)
    menu.addItem_(AppKit.NSMenuItem.separatorItem())
    menu.addItemWithTitle_action_keyEquivalent_("Quit Tonelith", "terminate:", "q")
    item.setSubmenu_(menu)
    return bar


def run(url, busy):
    """Run the Cocoa event loop until the app is quit. Call on the main thread."""
    _state.update(url=url, busy=busy)
    app = AppKit.NSApplication.sharedApplication()
    delegate = _Delegate.alloc().init()
    app.setDelegate_(delegate)
    app.setActivationPolicy_(AppKit.NSApplicationActivationPolicyRegular)
    app.setMainMenu_(_menu(delegate))
    app.run()
