use super::*;

fn header(frame: &[u8]) -> Vec<u32> {
    frame[..FRAME_HEADER_BYTES]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| u32::from_le_bytes(*bytes))
        .collect()
}

fn source_frame(
    pixels: &[u8],
    width: u32,
    height: u32,
    stride: u32,
    format: spa::param::video::VideoFormat,
) -> SourceFrame<'_> {
    SourceFrame {
        pixels,
        width,
        height,
        stride,
        format,
    }
}

fn selection_with_dimensions(
    source_width: u32,
    source_height: u32,
    ui_scale_percent: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> LootCaptureSettings {
    LootCaptureSettings {
        region: super::super::NormalizedRegion {
            x: x as f64 / source_width as f64,
            y: y as f64 / source_height as f64,
            width: width as f64 / source_width as f64,
            height: height as f64 / source_height as f64,
        },
        rare_region: None,
        rare_region_confirmed: false,
        source_width,
        source_height,
        ui_scale_percent,
    }
}

fn selection(
    source_width: u32,
    source_height: u32,
    ui_scale_percent: u32,
    x: u32,
    y: u32,
) -> LootCaptureSettings {
    let (width, height) =
        crate::native_capture::geometry::loot_region_dimensions(ui_scale_percent).unwrap();
    selection_with_dimensions(
        source_width,
        source_height,
        ui_scale_percent,
        x,
        y,
        width,
        height,
    )
}

fn search_selection(x: u32, y: u32) -> NativeCaptureSelection {
    NativeCaptureSelection::Search {
        region: NormalizedRegion {
            x: x as f64 / 3440.0,
            y: y as f64 / 1440.0,
            width: 800.0 / 3440.0,
            height: 600.0 / 1440.0,
        },
        source_width: 3440,
        source_height: 1440,
        ui_scale_percent: 80,
    }
}

#[test]
fn converts_bgra_and_encodes_the_preview_header() {
    let frame = preview_frame(
        &[3, 2, 1, 7, 6, 5, 4, 8],
        2,
        1,
        8,
        spa::param::video::VideoFormat::BGRA,
        17,
        23,
    )
    .unwrap();

    assert_eq!(
        header(&frame),
        [3, FRAME_KIND_PREVIEW, 17, 23, 2, 1, 2, 1, 0, 0]
    );
    assert_eq!(&frame[FRAME_HEADER_BYTES..], &[1, 2, 3, 7, 4, 5, 6, 8]);
}

#[test]
fn bounds_portrait_previews() {
    let source = vec![0; 1080 * 1920 * 4];
    let frame = preview_frame(
        &source,
        1080,
        1920,
        1080 * 4,
        spa::param::video::VideoFormat::BGRx,
        1,
        1,
    )
    .unwrap();

    assert_eq!(&header(&frame)[4..6], &[202, 360]);
    assert_eq!(frame.len(), FRAME_HEADER_BYTES + 202 * 360 * 4);
}

#[test]
fn converts_normalized_bounds_to_deterministic_pixels() {
    assert_eq!(
        crate::native_capture::geometry::normalized_to_pixel_region(
            NormalizedRegion {
                x: 0.25,
                y: 0.2,
                width: 0.5,
                height: 0.4,
            },
            8,
            5,
        )
        .unwrap(),
        PixelRegion {
            x: 2,
            y: 1,
            width: 4,
            height: 2,
        }
    );
    assert_eq!(
        crate::native_capture::geometry::normalized_to_pixel_region(
            NormalizedRegion {
                x: 0.1,
                y: 0.1,
                width: 0.01,
                height: 0.01,
            },
            2,
            2,
        )
        .unwrap(),
        PixelRegion {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
        }
    );
}

#[test]
fn crops_an_exact_100_percent_region_and_encodes_the_native_origin() {
    let selection = selection(1920, 1080, 100, 10, 0);
    let region = selection.pixel_region().unwrap();
    let stride = selection.source_width * 4;
    let mut source = vec![0; stride as usize * region.height as usize];
    let first = pixel_offset(0, 10, stride).unwrap();
    source[first..first + 8].copy_from_slice(&[30, 20, 10, 40, 60, 50, 40, 70]);
    let last = pixel_offset(region.height - 1, region.x + region.width - 1, stride).unwrap();
    source[last..last + 4].copy_from_slice(&[99, 88, 77, 110]);

    let frame = crop_region_frame(
        &source_frame(
            &source,
            selection.source_width,
            selection.source_height,
            stride,
            spa::param::video::VideoFormat::BGRA,
        ),
        selection,
        BatchIdentity {
            capture_id: 31,
            batch_id: 47,
        },
    )
    .unwrap();

    assert_eq!(
        header(&frame),
        [3, FRAME_KIND_REGION, 31, 47, 453, 389, 1920, 1080, 10, 0,]
    );
    assert_eq!(
        &frame[FRAME_HEADER_BYTES..FRAME_HEADER_BYTES + 8],
        &[10, 20, 30, 40, 40, 50, 60, 70]
    );
    assert_eq!(&frame[frame.len() - 4..], &[77, 88, 99, 110]);
}

#[test]
fn crops_a_rare_region_and_encodes_its_header() {
    let mut selection = selection(1920, 1080, 80, 10, 20);
    selection.rare_region = Some(NormalizedRegion {
        x: 100.0 / 1920.0,
        y: 200.0 / 1080.0,
        width: 400.0 / 1920.0,
        height: 100.0 / 1080.0,
    });
    let rare_region = selection.rare_pixel_region().unwrap().unwrap();
    let stride = selection.source_width * 4;
    let mut source = vec![0; stride as usize * 300];
    let first = pixel_offset(rare_region.y, rare_region.x, stride).unwrap();
    source[first..first + 4].copy_from_slice(&[30, 20, 10, 40]);

    let frame = crop_pixel_region_frame(
        &source_frame(
            &source,
            selection.source_width,
            selection.source_height,
            stride,
            spa::param::video::VideoFormat::BGRA,
        ),
        rare_region,
        FRAME_KIND_RARE_REGION,
        BatchIdentity {
            capture_id: 31,
            batch_id: 47,
        },
    )
    .unwrap();

    assert_eq!(
        header(&frame),
        [
            3,
            FRAME_KIND_RARE_REGION,
            31,
            47,
            400,
            100,
            1920,
            1080,
            100,
            200,
        ]
    );
    assert_eq!(
        &frame[FRAME_HEADER_BYTES..FRAME_HEADER_BYTES + 4],
        &[10, 20, 30, 40]
    );
}

#[test]
fn crops_a_search_region_and_encodes_the_kind_four_header() {
    let selection = search_selection(100, 200);
    let region = selection.search_pixel_region().unwrap();
    let stride = 3440 * 4;
    let source = vec![0; stride as usize * 800];

    let frame = crop_pixel_region_frame(
        &source_frame(
            &source,
            3440,
            1440,
            stride,
            spa::param::video::VideoFormat::BGRx,
        ),
        region,
        FRAME_KIND_SEARCH_REGION,
        BatchIdentity {
            capture_id: 41,
            batch_id: 59,
        },
    )
    .unwrap();

    assert_eq!(
        header(&frame),
        [
            3,
            FRAME_KIND_SEARCH_REGION,
            41,
            59,
            800,
            600,
            3440,
            1440,
            100,
            200
        ]
    );
}

#[test]
fn rejects_roi_allocation_for_invalid_dimensions() {
    let selection = selection_with_dimensions(1920, 1080, 100, 0, 0, 452, 389);
    let error = crop_region_frame(
        &source_frame(
            &[],
            selection.source_width,
            selection.source_height,
            selection.source_width * 4,
            spa::param::video::VideoFormat::BGRA,
        ),
        selection,
        BatchIdentity {
            capture_id: 1,
            batch_id: 1,
        },
    )
    .unwrap_err();

    assert!(error.contains("exactly 453x389"));
}

#[test]
fn validates_signed_and_padded_strides() {
    assert!(validated_stride(-16, 4)
        .unwrap_err()
        .contains("negative source stride"));
    assert!(validated_stride(15, 4)
        .unwrap_err()
        .contains("smaller than the required 16"));
    assert_eq!(validated_stride(20, 4).unwrap(), 20);
    assert_eq!(validated_stride(0, 4).unwrap(), 16);
    assert!(validated_stride(i32::MAX, u32::MAX).is_err());
}

#[test]
fn converts_all_negotiated_channel_layouts() {
    assert_eq!(
        converted_pixel(&[3, 2, 1, 4], 0, spa::param::video::VideoFormat::BGRA).unwrap(),
        [1, 2, 3, 4]
    );
    assert_eq!(
        converted_pixel(&[3, 2, 1, 4], 0, spa::param::video::VideoFormat::BGRx).unwrap(),
        [1, 2, 3, 255]
    );
    assert_eq!(
        converted_pixel(&[1, 2, 3, 4], 0, spa::param::video::VideoFormat::RGBA).unwrap(),
        [1, 2, 3, 4]
    );
    assert_eq!(
        converted_pixel(&[1, 2, 3, 4], 0, spa::param::video::VideoFormat::RGBx).unwrap(),
        [1, 2, 3, 255]
    );
}

#[test]
fn encodes_error_protocol_header_and_text() {
    let frame = error_frame("failed");

    assert_eq!(
        header(&frame),
        [3, FRAME_KIND_ERROR, 0, 0, 0, 0, 0, 0, 0, 0]
    );
    assert_eq!(&frame[FRAME_HEADER_BYTES..], b"failed");
}

fn scalar_crop(source: &SourceFrame<'_>, region: PixelRegion) -> Vec<u8> {
    let mut output = Vec::with_capacity((region.width * region.height * 4) as usize);
    for y in region.y..region.y + region.height {
        for x in region.x..region.x + region.width {
            let offset = pixel_offset(y, x, source.stride).unwrap();
            output
                .extend_from_slice(&converted_pixel(source.pixels, offset, source.format).unwrap());
        }
    }
    output
}

#[test]
fn row_conversion_matches_scalar_pixels_with_padding_and_truncation() {
    use spa::param::video::VideoFormat;
    let pixels: Vec<u8> = (0..120).map(|i| (i * 37) as u8).collect();
    let region = PixelRegion {
        x: 1,
        y: 1,
        width: 3,
        height: 2,
    };
    for format in [
        VideoFormat::RGBA,
        VideoFormat::RGBx,
        VideoFormat::BGRA,
        VideoFormat::BGRx,
    ] {
        let mut source = SourceFrame {
            pixels: &pixels,
            width: 5,
            height: 5,
            stride: 24,
            format,
        };
        let result = crop_pixel_region_frame(
            &source,
            region,
            FRAME_KIND_REGION,
            BatchIdentity {
                capture_id: 1,
                batch_id: 1,
            },
        )
        .unwrap();
        assert_eq!(&result[FRAME_HEADER_BYTES..], scalar_crop(&source, region));
        source.pixels = &pixels[..63];
        assert!(crop_pixel_region_frame(
            &source,
            region,
            FRAME_KIND_REGION,
            BatchIdentity {
                capture_id: 1,
                batch_id: 1
            }
        )
        .is_err());
    }
}

#[test]
#[ignore = "local microbenchmark: run with --release --ignored --nocapture"]
fn benchmark_crop_conversion() {
    use std::hint::black_box;
    let pixels = vec![127; 3440 * 1440 * 4];
    let region = PixelRegion {
        x: 2400,
        y: 900,
        width: 453,
        height: 389,
    };
    let source = SourceFrame {
        pixels: &pixels,
        width: 3440,
        height: 1440,
        stride: 3440 * 4,
        format: spa::param::video::VideoFormat::BGRx,
    };
    let rounds = 1000;
    let start = Instant::now();
    for _ in 0..rounds {
        black_box(scalar_crop(black_box(&source), region));
    }
    let scalar = start.elapsed();
    let start = Instant::now();
    for _ in 0..rounds {
        black_box(
            crop_pixel_region_frame(
                black_box(&source),
                region,
                FRAME_KIND_REGION,
                BatchIdentity {
                    capture_id: 1,
                    batch_id: 1,
                },
            )
            .unwrap(),
        );
    }
    let row = start.elapsed();
    eprintln!(
        "{rounds} crops: scalar={scalar:?}, row={row:?}, speedup={:.2}x",
        scalar.as_secs_f64() / row.as_secs_f64()
    );
}
