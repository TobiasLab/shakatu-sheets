use gtk::{cairo, gdk, gdk::WindowTypeHint, glib::object::ObjectType, prelude::*};
use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
use tauri::Manager;

use crate::session_overlay_window::OverlayAdjustment;

pub(crate) fn configure_session_overlay(app: &tauri::AppHandle) -> tauri::Result<bool> {
    let Some(overlay) = app.get_webview_window("session-overlay") else {
        return Ok(false);
    };
    let window = overlay.gtk_window()?;
    window.connect_realize(|window| {
        if let Some(surface) = window.window() {
            unsafe {
                gdk::ffi::gdk_window_set_invalidate_handler(
                    surface.as_ptr(),
                    Some(invalidate_whole_window),
                )
            };
        }
    });
    if !gtk_layer_shell::is_supported() {
        window.set_type_hint(WindowTypeHint::Utility);
        return Ok(false);
    }
    // Tauri's hidden GTK window has not been realized yet. A layer role must be
    // assigned before realization; trying afterward causes a Wayland protocol error.
    if window.is_realized() {
        return Err(tauri::Error::Anyhow(
            std::io::Error::other(
                "Session overlay was realized before Wayland layer-shell initialization",
            )
            .into(),
        ));
    }
    // WebKit has no natural minimum size. Layer Shell uses GTK requisitions,
    // not the ordinary window geometry hints; without this the first frame can
    // remain unpainted despite receiving a valid layer configure event.
    let (width, height) = window.size();
    window.set_size_request(width, height);
    // Disable Tao's xdg-toplevel resize-border handler for this layer surface.
    // The overlay supplies its own resize handle through GTK size requests.
    window.set_resizable(false);
    window.init_layer_shell();
    window.set_namespace("shakatu-session-overlay");
    window.set_layer(Layer::Overlay);
    window.set_anchor(Edge::Top, true);
    window.set_anchor(Edge::Left, true);
    window.set_layer_shell_margin(Edge::Top, 24);
    window.set_layer_shell_margin(Edge::Left, 24);
    window.set_exclusive_zone(0);
    // Allow deliberate interaction, without taking keyboard focus on opening.
    window.set_keyboard_mode(if gtk_layer_shell::protocol_version() >= 4 {
        KeyboardMode::OnDemand
    } else {
        KeyboardMode::None
    });
    if let Some(main) = app.get_webview_window("main") {
        if let Some(main_surface) = main.gtk_window()?.window() {
            if let Some(monitor) = window.display().monitor_at_window(&main_surface) {
                window.set_monitor(&monitor);
            }
        }
    }
    // Keep the header reachable after content/scale/output changes.
    window.connect_size_allocate(|window, _| clamp_position(window));
    let weak_window = window.downgrade();
    window
        .display()
        .connect_monitor_removed(move |display, removed| {
            if let Some(window) = weak_window.upgrade() {
                if LayerShell::monitor(&window).as_ref() == Some(removed) {
                    if let Some(next) = (0..display.n_monitors())
                        .filter_map(|i| display.monitor(i))
                        .find(|monitor| monitor != removed)
                    {
                        window.set_monitor(&next);
                        clamp_position(&window);
                    }
                }
            }
        });
    Ok(true)
}

// A hover otherwise commits a new transparent buffer that declares only the
// hovered control as damaged. KDE Plasma then showed just that control and
// dropped the rest of the overlay, so every change repaints the whole surface.
unsafe extern "C" fn invalidate_whole_window(
    window: *mut gdk::ffi::GdkWindow,
    region: *mut cairo::ffi::cairo_region_t,
) {
    let mut whole = cairo::ffi::cairo_rectangle_int_t {
        x: 0,
        y: 0,
        width: gdk::ffi::gdk_window_get_width(window),
        height: gdk::ffi::gdk_window_get_height(window),
    };
    cairo::ffi::cairo_region_union_rectangle(region, &mut whole);
}

fn monitor(window: &gtk::ApplicationWindow) -> Option<gtk::gdk::Monitor> {
    LayerShell::monitor(window)
        .or_else(|| {
            window
                .window()
                .and_then(|surface| window.display().monitor_at_window(&surface))
        })
        .or_else(|| window.display().primary_monitor())
        .or_else(|| window.display().monitor(0))
}

fn clamp_position(window: &gtk::ApplicationWindow) {
    let Some(monitor) = monitor(window) else {
        return;
    };
    let bounds = monitor.geometry();
    let (width, height) = window.size();
    let fitted_width = width.min(bounds.width().max(1));
    let fitted_height = height.min(bounds.height().max(1));
    if (fitted_width, fitted_height) != (width, height) {
        window.set_size_request(fitted_width, fitted_height);
        window.resize(1, 1);
    }
    let (x, y) = clamp_offset(
        window.layer_shell_margin(Edge::Left),
        window.layer_shell_margin(Edge::Top),
        fitted_width,
        fitted_height,
        bounds.width(),
        bounds.height(),
    );
    if x != window.layer_shell_margin(Edge::Left) {
        window.set_layer_shell_margin(Edge::Left, x);
    }
    if y != window.layer_shell_margin(Edge::Top) {
        window.set_layer_shell_margin(Edge::Top, y);
    }
}

fn clamp_offset(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    screen_width: i32,
    screen_height: i32,
) -> (i32, i32) {
    (
        x.clamp(0, screen_width.saturating_sub(width).max(0)),
        y.clamp(0, screen_height.saturating_sub(height).max(0)),
    )
}

pub(crate) fn adjust(
    window: &tauri::WebviewWindow,
    action: OverlayAdjustment,
    dx: i32,
    dy: i32,
) -> Result<(), String> {
    let window = window.gtk_window().map_err(|e| e.to_string())?;
    if !window.is_layer_window() {
        return Err("This window does not use Wayland overlay placement".into());
    }
    let current_monitor = monitor(&window).ok_or("No display is available for the overlay")?;
    let bounds = current_monitor.geometry();
    let (width, height) = window.size();
    match action {
        OverlayAdjustment::Move => {
            let (x, y) = clamp_offset(
                window.layer_shell_margin(Edge::Left).saturating_add(dx),
                window.layer_shell_margin(Edge::Top).saturating_add(dy),
                width,
                height,
                bounds.width(),
                bounds.height(),
            );
            window.set_layer_shell_margin(Edge::Left, x);
            window.set_layer_shell_margin(Edge::Top, y);
        }
        OverlayAdjustment::Resize => {
            let width = width
                .saturating_add(dx)
                .clamp(320.min(bounds.width()), bounds.width());
            let height = height
                .saturating_add(dy)
                .clamp(180.min(bounds.height()), bounds.height());
            // Layer surfaces don't have compositor-provided resize borders.
            window.set_size_request(width, height);
            window.resize(1, 1);
        }
        OverlayAdjustment::NextMonitor => {
            let display = window.display();
            let count = display.n_monitors();
            if count > 1 {
                let current = (0..count)
                    .find(|&i| display.monitor(i).as_ref() == Some(&current_monitor))
                    .unwrap_or(0);
                if let Some(next) = display.monitor((current + 1) % count) {
                    window.set_monitor(&next);
                }
            }
        }
    }
    clamp_position(&window);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::clamp_offset;

    #[test]
    fn placement_keeps_overlay_reachable_on_small_or_rescaled_outputs() {
        assert_eq!(clamp_offset(1200, 700, 360, 250, 1280, 800), (920, 550));
        assert_eq!(clamp_offset(-20, -10, 360, 250, 1280, 800), (0, 0));
        assert_eq!(clamp_offset(400, 300, 360, 250, 200, 100), (0, 0));
        assert_eq!(
            clamp_offset(i32::MAX, i32::MIN, 360, 250, 1280, 800),
            (920, 0)
        );
    }
}
