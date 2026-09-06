use std::time::Duration;

pub(super) const FRAME_HEADER_BYTES: usize = 40;
pub(super) const FRAME_PROTOCOL_VERSION: u32 = 3;
pub(super) const FRAME_KIND_ERROR: u32 = 0;
pub(super) const FRAME_KIND_PREVIEW: u32 = 1;
pub(super) const FRAME_KIND_REGION: u32 = 2;
pub(super) const FRAME_KIND_RARE_REGION: u32 = 3;
pub(super) const FRAME_KIND_SEARCH_REGION: u32 = 4;
pub(super) const MAX_PREVIEW_WIDTH: u32 = 640;
pub(super) const MAX_PREVIEW_HEIGHT: u32 = 360;
pub(super) const SAMPLE_FPS: u32 = 16;
pub(super) const SAMPLE_INTERVAL: Duration = Duration::from_micros(1_000_000 / SAMPLE_FPS as u64);
pub(super) const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const FRAME_ACK_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
pub(super) struct BatchIdentity {
    pub(super) capture_id: u32,
    pub(super) batch_id: u32,
}

pub(super) struct FrameHeader {
    pub(super) kind: u32,
    pub(super) batch: BatchIdentity,
    pub(super) output_width: u32,
    pub(super) output_height: u32,
    pub(super) source_width: u32,
    pub(super) source_height: u32,
    pub(super) crop_x: u32,
    pub(super) crop_y: u32,
}

pub(super) fn allocate_frame(header: FrameHeader) -> Result<Vec<u8>, String> {
    let payload_len = (header.output_width as usize)
        .checked_mul(header.output_height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "capture frame dimensions are too large".to_string())?;
    let frame_len = FRAME_HEADER_BYTES
        .checked_add(payload_len)
        .ok_or_else(|| "capture frame size overflowed".to_string())?;
    let mut frame = Vec::new();
    frame
        .try_reserve_exact(frame_len)
        .map_err(|_| "capture frame allocation failed".to_string())?;
    for value in [
        FRAME_PROTOCOL_VERSION,
        header.kind,
        header.batch.capture_id,
        header.batch.batch_id,
        header.output_width,
        header.output_height,
        header.source_width,
        header.source_height,
        header.crop_x,
        header.crop_y,
    ] {
        frame.extend_from_slice(&value.to_le_bytes());
    }
    frame.resize(frame_len, 0);
    Ok(frame)
}

pub(super) fn error_frame(error: &str) -> Vec<u8> {
    let mut frame = allocate_frame(FrameHeader {
        kind: FRAME_KIND_ERROR,
        batch: BatchIdentity {
            capture_id: 0,
            batch_id: 0,
        },
        output_width: 0,
        output_height: 0,
        source_width: 0,
        source_height: 0,
        crop_x: 0,
        crop_y: 0,
    })
    .expect("an empty protocol frame must fit in memory");
    frame.extend_from_slice(error.as_bytes());
    frame
}

#[cfg(any(target_os = "windows", test))]
pub(super) fn preview_dimensions(width: u32, height: u32) -> Result<(u32, u32), String> {
    if width == 0 || height == 0 {
        return Err("Capture source dimensions must be positive.".into());
    }
    let mut w = width.min(MAX_PREVIEW_WIDTH);
    let mut h = ((height as u64 * w as u64) / width as u64).max(1) as u32;
    if h > MAX_PREVIEW_HEIGHT {
        h = MAX_PREVIEW_HEIGHT;
        w = ((width as u64 * h as u64) / height as u64).max(1) as u32;
    }
    Ok((w, h))
}

#[cfg(any(target_os = "windows", test))]
pub(super) fn pack_rows(
    source: &[u8],
    stride: usize,
    target: &mut [u8],
    width: u32,
    height: u32,
    bgra: bool,
) -> Result<(), String> {
    let row_bytes = (width as usize)
        .checked_mul(4)
        .ok_or("Capture row size overflowed.")?;
    let target_len = row_bytes
        .checked_mul(height as usize)
        .ok_or("Capture size overflowed.")?;
    if width == 0 || height == 0 || stride < row_bytes || target.len() != target_len {
        return Err("Invalid capture row geometry.".into());
    }
    for y in 0..height as usize {
        let offset = y
            .checked_mul(stride)
            .ok_or("Capture row offset overflowed.")?;
        let end = offset
            .checked_add(row_bytes)
            .ok_or("Capture row end overflowed.")?;
        let row = source
            .get(offset..end)
            .ok_or("Capture data is shorter than its row geometry.")?;
        let output = &mut target[y * row_bytes..(y + 1) * row_bytes];
        output.copy_from_slice(row);
        if bgra {
            for pixel in output.as_chunks_mut::<4>().0 {
                pixel.swap(0, 2);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mapped_rows_preserve_channels_alpha_and_exclude_padding() {
        let source = [3, 2, 1, 4, 99, 99, 99, 99, 7, 6, 5, 8];
        let mut target = [0; 8];
        pack_rows(&source, 8, &mut target, 1, 2, true).unwrap();
        assert_eq!(target, [1, 2, 3, 4, 5, 6, 7, 8]);
        pack_rows(&source, 8, &mut target, 1, 2, false).unwrap();
        assert_eq!(target, [3, 2, 1, 4, 7, 6, 5, 8]);
        assert!(pack_rows(&source[..11], 8, &mut target, 1, 2, true).is_err());
        assert!(pack_rows(&source, 3, &mut target, 1, 2, true).is_err());
    }
    #[test]
    fn previews_preserve_aspect_and_are_bounded() {
        assert_eq!(preview_dimensions(3440, 1440).unwrap(), (640, 267));
        assert_eq!(preview_dimensions(1080, 1920).unwrap(), (202, 360));
        assert_eq!(preview_dimensions(2, 1).unwrap(), (2, 1));
        assert!(preview_dimensions(0, 1080).is_err());
    }
}
