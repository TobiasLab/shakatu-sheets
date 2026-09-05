use tauri::{Manager, PhysicalPosition, PhysicalSize, Window};

pub(crate) fn fit(window: &Window) -> tauri::Result<()> {
    if window.is_minimized()? || window.is_maximized()? {
        return Ok(());
    }
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let margin = (16.0 * scale) as u32;
    let available_width = area.size.width.saturating_sub(margin * 2).max(1);
    let available_height = area.size.height.saturating_sub(margin * 2).max(1);
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    let border_width = outer.width.saturating_sub(inner.width);
    let border_height = outer.height.saturating_sub(inner.height);
    let width = inner
        .width
        .min(available_width.saturating_sub(border_width).max(1));
    let height = inner
        .height
        .min(available_height.saturating_sub(border_height).max(1));
    window.set_min_size(Some(PhysicalSize::new(
        ((640.0 * scale) as u32).min(width),
        ((420.0 * scale) as u32).min(height),
    )))?;
    if (width, height) != (inner.width, inner.height) {
        window.set_size(PhysicalSize::new(width, height))?;
    }
    let position = window.outer_position()?;
    let left = area.position.x.saturating_add(margin as i32);
    let top = area.position.y.saturating_add(margin as i32);
    let right = left.saturating_add(available_width.saturating_sub(width + border_width) as i32);
    let bottom = top.saturating_add(available_height.saturating_sub(height + border_height) as i32);
    let next = PhysicalPosition::new(position.x.clamp(left, right), position.y.clamp(top, bottom));
    if next != position {
        window.set_position(next)?;
    }
    Ok(())
}

pub(crate) fn configure(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let webview: &tauri::Webview = window.as_ref();
        let _ = fit(&webview.window());
    }
}
