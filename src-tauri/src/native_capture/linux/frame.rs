use super::*;

pub(super) fn preview_frame(
    source: &[u8],
    source_width: u32,
    source_height: u32,
    source_stride: u32,
    format: spa::param::video::VideoFormat,
    capture_id: u32,
    batch_id: u32,
) -> Result<Vec<u8>, String> {
    if source_width == 0 || source_height == 0 {
        return Err("PipeWire provided empty source dimensions.".into());
    }
    let mut output_width = source_width.min(MAX_PREVIEW_WIDTH);
    let mut output_height =
        ((source_height as u64 * output_width as u64) / source_width as u64).max(1) as u32;
    if output_height > MAX_PREVIEW_HEIGHT {
        output_height = MAX_PREVIEW_HEIGHT;
        output_width =
            ((source_width as u64 * output_height as u64) / source_height as u64).max(1) as u32;
    }
    let mut frame = allocate_frame(FrameHeader {
        kind: FRAME_KIND_PREVIEW,
        batch: BatchIdentity {
            capture_id,
            batch_id,
        },
        output_width,
        output_height,
        source_width,
        source_height,
        crop_x: 0,
        crop_y: 0,
    })?;
    let output_stride = output_width
        .checked_mul(4)
        .ok_or_else(|| "preview output stride overflowed".to_string())?;
    for y in 0..output_height {
        let source_y = y as u64 * source_height as u64 / output_height as u64;
        for x in 0..output_width {
            let source_x = x as u64 * source_width as u64 / output_width as u64;
            let input = pixel_offset(source_y as u32, source_x as u32, source_stride)?;
            let output = FRAME_HEADER_BYTES
                .checked_add(pixel_offset(y, x, output_stride)?)
                .ok_or_else(|| "preview output offset overflowed".to_string())?;
            let pixel = converted_pixel(source, input, format)?;
            frame[output..output + 4].copy_from_slice(&pixel);
        }
    }
    Ok(frame)
}

pub(super) fn crop_region_frame(
    source: &SourceFrame<'_>,
    selection: LootCaptureSettings,
    batch: BatchIdentity,
) -> Result<Vec<u8>, String> {
    if source.width != selection.source_width || source.height != selection.source_height {
        return Err(format!(
            "loot region selection requires a {}x{} source",
            selection.source_width, selection.source_height
        ));
    }
    let region = selection.pixel_region()?;
    crop_pixel_region_frame(source, region, FRAME_KIND_REGION, batch)
}

pub(super) fn crop_pixel_region_frame(
    source: &SourceFrame<'_>,
    region: crate::native_capture::geometry::PixelRegion,
    kind: u32,
    batch: BatchIdentity,
) -> Result<Vec<u8>, String> {
    let end_x = region
        .x
        .checked_add(region.width)
        .ok_or_else(|| "loot capture region horizontal bounds overflowed".to_string())?;
    let end_y = region
        .y
        .checked_add(region.height)
        .ok_or_else(|| "loot capture region vertical bounds overflowed".to_string())?;
    if end_x > source.width || end_y > source.height {
        return Err("loot capture region is outside the source bounds".into());
    }
    let mut frame = allocate_frame(FrameHeader {
        kind,
        batch,
        output_width: region.width,
        output_height: region.height,
        source_width: source.width,
        source_height: source.height,
        crop_x: region.x,
        crop_y: region.y,
    })?;
    let output_stride = region
        .width
        .checked_mul(4)
        .ok_or_else(|| "region output stride overflowed".to_string())?;

    // Validate one contiguous row, then convert it in a tight loop. Keep source padding out of IPC.
    for y in 0..region.height {
        let input = pixel_offset(region.y + y, region.x, source.stride)?;
        let row_len = output_stride as usize;
        let end = input
            .checked_add(row_len)
            .ok_or_else(|| "region source row overflowed".to_string())?;
        let source_row = source.pixels.get(input..end).ok_or_else(|| {
            "PipeWire frame data is shorter than its negotiated size.".to_string()
        })?;
        let output = FRAME_HEADER_BYTES + y as usize * row_len;
        let target = &mut frame[output..output + row_len];
        use spa::param::video::VideoFormat;
        match source.format {
            VideoFormat::RGBA => target.copy_from_slice(source_row),
            VideoFormat::RGBx => {
                target.copy_from_slice(source_row);
                for pixel in target.as_chunks_mut::<4>().0 {
                    pixel[3] = 255;
                }
            }
            VideoFormat::BGRA | VideoFormat::BGRx => {
                let opaque = source.format == VideoFormat::BGRx;
                for (pixel, output) in source_row
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .zip(target.as_chunks_mut::<4>().0)
                {
                    output.copy_from_slice(&[
                        pixel[2],
                        pixel[1],
                        pixel[0],
                        if opaque { 255 } else { pixel[3] },
                    ]);
                }
            }
            format => return Err(format!("Unsupported PipeWire video format: {format:?}")),
        }
    }
    Ok(frame)
}

/// Whether `bytes` cover every row of a 4-byte-per-pixel frame: full strides, then the last row's pixels.
pub(super) fn frame_is_complete(bytes: usize, width: u32, height: u32, stride: u32) -> bool {
    (height as usize)
        .checked_sub(1)
        .and_then(|rows| rows.checked_mul(stride as usize))
        .and_then(|rows| rows.checked_add(width as usize * 4))
        .is_some_and(|needed| bytes >= needed)
}

pub(super) fn validated_stride(stride: i32, source_width: u32) -> Result<u32, String> {
    let minimum = source_width
        .checked_mul(4)
        .ok_or_else(|| "PipeWire source row size overflowed.".to_string())?;
    if stride < 0 {
        return Err(
            "PipeWire provided a negative source stride; bottom-up frames are unsupported."
                .to_string(),
        );
    }
    let stride = if stride == 0 { minimum } else { stride as u32 };
    if stride < minimum {
        return Err(format!(
            "PipeWire source stride {stride} is smaller than the required {minimum} bytes."
        ));
    }
    Ok(stride)
}

pub(super) fn pixel_offset(y: u32, x: u32, stride: u32) -> Result<usize, String> {
    let offset = (y as u64)
        .checked_mul(stride as u64)
        .and_then(|row| {
            (x as u64)
                .checked_mul(4)
                .and_then(|column| row.checked_add(column))
        })
        .ok_or_else(|| "capture pixel offset overflowed".to_string())?;
    usize::try_from(offset).map_err(|_| "capture pixel offset exceeds platform limits".to_string())
}

pub(super) fn converted_pixel(
    source: &[u8],
    offset: usize,
    format: spa::param::video::VideoFormat,
) -> Result<[u8; 4], String> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| "PipeWire pixel offset overflowed.".to_string())?;
    let pixel = source
        .get(offset..end)
        .ok_or_else(|| "PipeWire frame data is shorter than its negotiated size.".to_string())?;
    match format {
        spa::param::video::VideoFormat::BGRA => Ok([pixel[2], pixel[1], pixel[0], pixel[3]]),
        spa::param::video::VideoFormat::BGRx => Ok([pixel[2], pixel[1], pixel[0], 255]),
        spa::param::video::VideoFormat::RGBA => Ok([pixel[0], pixel[1], pixel[2], pixel[3]]),
        spa::param::video::VideoFormat::RGBx => Ok([pixel[0], pixel[1], pixel[2], 255]),
        _ => Err(format!("Unsupported PipeWire video format: {format:?}")),
    }
}
