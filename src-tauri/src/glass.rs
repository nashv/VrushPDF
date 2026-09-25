//! The macOS window material: system Liquid Glass behind a transparent webview.
//!
//! The window is created transparent with an overlay title bar (see
//! `tauri.macos.conf.json`), so whatever sits beneath the webview shows through
//! wherever the page paints nothing. The frontend keeps the document area
//! opaque and leaves the toolbar, tab strip and side panels translucent, which
//! is where this material is meant to be seen.

use std::ffi::c_void;

use objc2::runtime::AnyClass;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSGlassEffectView, NSWindow, NSWindowButton, NSWindowOrderingMode,
    NSWindowStyleMask,
};
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::WebviewWindow;

/// The toolbar's first row (`--toolbar-h` under glass in app.css). The traffic
/// lights are centred on it; the row's `padding-left` leaves them room.
const ROW_HEIGHT: f64 = 52.0;
/// Inset of the close button from the window's left edge.
const LIGHTS_LEFT: f64 = 20.0;

pub fn install(window: &WebviewWindow) {
    if let Ok(ns_window) = window.ns_window() {
        place_traffic_lights(ns_window);
    }
    if install_glass(window) {
        return;
    }
    // Before macOS 26 there is no glass; the sidebar vibrancy material is the
    // closest thing, and without *something* back there the transparent
    // window would show the desktop through the chrome unfrosted.
    let _ = window.set_effects(
        EffectsBuilder::new()
            .effect(Effect::Sidebar)
            .state(EffectState::FollowsWindowActiveState)
            .build(),
    );
}

/// Puts an `NSGlassEffectView` under the webview, filling the content view.
/// False if the class does not exist (pre-26) or the window has no view yet.
fn install_glass(window: &WebviewWindow) -> bool {
    // Checked by name at runtime: the binary is built against a newer SDK than
    // `minimumSystemVersion`, and messaging a missing class would abort.
    if AnyClass::get(c"NSGlassEffectView").is_none() {
        return false;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    let Ok(ns_window) = window.ns_window() else {
        return false;
    };
    // SAFETY: Tauri hands back the live NSWindow backing this webview window,
    // and we are on the main thread, which the marker above proves.
    let ns_window: &NSWindow = unsafe { &*ns_window.cast() };
    let Some(content) = ns_window.contentView() else {
        return false;
    };

    let glass = NSGlassEffectView::new(mtm);
    glass.setFrame(content.bounds());
    glass.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    // The window's own corner mask does the rounding.
    glass.setCornerRadius(0.0);
    // Below every sibling, the webview included.
    content.addSubview_positioned_relativeTo(&glass, NSWindowOrderingMode::Below, None);
    true
}

/// Centres the traffic lights on the toolbar row.
///
/// `trafficLightPosition` in the config cannot do this here: tao reapplies it
/// from its content view's `drawRect:`, which a view covered by the webview
/// and the glass never gets, so the lights stayed at AppKit's default, above
/// the row. AppKit also re-lays the title bar out on resize, focus change and
/// leaving full screen, so `lib.rs` calls this again after each of those.
pub fn place_traffic_lights(ns_window: *mut c_void) {
    if MainThreadMarker::new().is_none() {
        return;
    }
    // SAFETY: a live NSWindow from Tauri, used on the main thread.
    let window: &NSWindow = unsafe { &*ns_window.cast() };
    // In full screen the lights live in the menu-bar reveal, not the window.
    if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return;
    }
    let buttons = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .map(|kind| window.standardWindowButton(kind));
    let [Some(close), Some(minimize), Some(zoom)] = buttons else {
        return;
    };
    // SAFETY: plain getters; the views are the window's own title bar, alive
    // for as long as the window is, and we are on the main thread.
    let Some(title_bar) = (unsafe { close.superview() }) else {
        return;
    };
    let Some(container) = (unsafe { title_bar.superview() }) else {
        return;
    };

    // Grow the title bar strip to the row's height, still pinned to the top.
    let mut strip = container.frame();
    strip.size.height = ROW_HEIGHT;
    strip.origin.y = window.frame().size.height - ROW_HEIGHT;
    container.setFrame(strip);
    let mut bar = title_bar.frame();
    bar.origin.y = 0.0;
    bar.size.height = ROW_HEIGHT;
    title_bar.setFrame(bar);

    // Keep AppKit's own spacing between the three.
    let spacing = minimize.frame().origin.x - close.frame().origin.x;
    for (i, button) in [close, minimize, zoom].iter().enumerate() {
        let mut origin = button.frame().origin;
        origin.x = LIGHTS_LEFT + i as f64 * spacing;
        origin.y = ((ROW_HEIGHT - button.frame().size.height) / 2.0).round();
        button.setFrameOrigin(origin);
    }
}
