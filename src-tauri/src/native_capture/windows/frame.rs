use super::capture_error;
use crate::native_capture::{geometry::PixelRegion, protocol::*};
use windows::{
    core::{s, Interface},
    Graphics::DirectX::Direct3D11::IDirect3DDevice,
    Win32::{
        Graphics::{
            Direct3D::{
                Fxc::D3DCompile, ID3DBlob, D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0,
            },
            Direct3D11::*,
            Dxgi::{Common::*, IDXGIDevice},
        },
        System::WinRT::Direct3D11::{
            CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
        },
    },
};

const PREVIEW_SHADER: &[u8] = br#"
Texture2D<float4> source : register(t0);
RWTexture2D<float4> target : register(u0);
[numthreads(8, 8, 1)]
void main(uint3 id : SV_DispatchThreadID) {
    uint width, height, sourceWidth, sourceHeight;
    target.GetDimensions(width, height);
    source.GetDimensions(sourceWidth, sourceHeight);
    if (id.x >= width || id.y >= height) return;
    uint2 pixel = id.xy * uint2(sourceWidth, sourceHeight) / uint2(width, height);
    target[id.xy] = source.Load(int3(pixel, 0));
}
"#;

pub(super) struct Gpu {
    pub(super) device: ID3D11Device,
    pub(super) context: ID3D11DeviceContext,
    pub(super) winrt: IDirect3DDevice,
    crops: [Option<Texture>; 2],
    preview: Option<Preview>,
}
struct Texture {
    texture: ID3D11Texture2D,
    width: u32,
    height: u32,
}
struct Preview {
    source: Texture,
    source_view: ID3D11ShaderResourceView,
    output: Texture,
    output_view: ID3D11UnorderedAccessView,
    staging: Texture,
    shader: ID3D11ComputeShader,
}

pub(super) fn create_device() -> Result<IDirect3DDevice, String> {
    let mut device = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            windows::Win32::Foundation::HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[D3D_FEATURE_LEVEL_11_0]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
    }
    .map_err(|e| capture_error("creating the D3D11 capture device", e))?;
    let device = device.ok_or("D3D11 returned no capture device.")?;
    let dxgi: IDXGIDevice = device
        .cast()
        .map_err(|e| capture_error("accessing the DXGI capture device", e))?;
    unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
        .and_then(|device| device.cast())
        .map_err(|e| capture_error("creating the WinRT capture device", e))
}

impl Gpu {
    pub(super) fn from_winrt(winrt: IDirect3DDevice) -> Result<Self, String> {
        let access: IDirect3DDxgiInterfaceAccess = winrt
            .cast()
            .map_err(|e| capture_error("accessing the capture device", e))?;
        let device: ID3D11Device = unsafe { access.GetInterface() }
            .map_err(|e| capture_error("accessing the D3D11 capture device", e))?;
        let context = unsafe { device.GetImmediateContext() }
            .map_err(|e| capture_error("accessing the capture GPU context", e))?;
        Ok(Self {
            device,
            context,
            winrt,
            crops: [None, None],
            preview: None,
        })
    }

    pub(super) fn reset(&mut self) {
        self.crops = [None, None];
        self.preview = None;
        unsafe {
            self.context.ClearState();
        }
    }

    pub(super) fn crop(
        &mut self,
        source: &ID3D11Texture2D,
        region: PixelRegion,
        header: FrameHeader,
        slot: usize,
    ) -> Result<Vec<u8>, String> {
        if region.width == 0
            || region.height == 0
            || region
                .x
                .checked_add(region.width)
                .is_none_or(|end| end > header.source_width)
            || region
                .y
                .checked_add(region.height)
                .is_none_or(|end| end > header.source_height)
        {
            return Err("The capture region is outside the source bounds.".into());
        }
        let staging = &mut self.crops[slot];
        if staging
            .as_ref()
            .is_none_or(|texture| (texture.width, texture.height) != (region.width, region.height))
        {
            *staging = Some(texture(
                &self.device,
                region.width,
                region.height,
                DXGI_FORMAT_B8G8R8A8_UNORM,
                0,
            )?);
        }
        let staging = &staging
            .as_ref()
            .ok_or("Missing ROI staging texture.")?
            .texture;
        let bounds = D3D11_BOX {
            left: region.x,
            top: region.y,
            front: 0,
            right: region.x + region.width,
            bottom: region.y + region.height,
            back: 1,
        };
        unsafe {
            self.context
                .CopySubresourceRegion(staging, 0, 0, 0, 0, source, 0, Some(&bounds));
        }
        read_frame(&self.context, staging, header, true)
    }

    pub(super) fn preview(
        &mut self,
        source: &ID3D11Texture2D,
        source_width: u32,
        source_height: u32,
        batch: BatchIdentity,
    ) -> Result<Vec<u8>, String> {
        let (width, height) = preview_dimensions(source_width, source_height)?;
        if self
            .preview
            .as_ref()
            .is_none_or(|p| (p.source.width, p.source.height) != (source_width, source_height))
        {
            self.preview = Some(Preview::new(
                &self.device,
                source_width,
                source_height,
                width,
                height,
            )?);
        }
        let preview = self.preview.as_ref().ok_or("Missing preview resources.")?;
        unsafe {
            self.context.CopySubresourceRegion(
                &preview.source.texture,
                0,
                0,
                0,
                0,
                source,
                0,
                None,
            );
            self.context.CSSetShader(&preview.shader, None);
            self.context
                .CSSetShaderResources(0, Some(&[Some(preview.source_view.clone())]));
            let views = [Some(preview.output_view.clone())];
            self.context
                .CSSetUnorderedAccessViews(0, 1, Some(views.as_ptr()), None);
            self.context
                .Dispatch(width.div_ceil(8), height.div_ceil(8), 1);
            self.context.CSSetShaderResources(0, Some(&[None]));
            self.context
                .CSSetUnorderedAccessViews(0, 1, Some([None].as_ptr()), None);
            self.context
                .CopyResource(&preview.staging.texture, &preview.output.texture);
        }
        read_frame(
            &self.context,
            &preview.staging.texture,
            FrameHeader {
                kind: FRAME_KIND_PREVIEW,
                batch,
                output_width: width,
                output_height: height,
                source_width,
                source_height,
                crop_x: 0,
                crop_y: 0,
            },
            false,
        )
    }
}

fn texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    format: DXGI_FORMAT,
    bind: u32,
) -> Result<Texture, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: if bind == 0 {
            D3D11_USAGE_STAGING
        } else {
            D3D11_USAGE_DEFAULT
        },
        BindFlags: bind,
        CPUAccessFlags: if bind == 0 {
            D3D11_CPU_ACCESS_READ.0 as u32
        } else {
            0
        },
        MiscFlags: 0,
    };
    let mut result = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut result)) }
        .map_err(|e| capture_error("preparing or reading GPU pixels", e))?;
    Ok(Texture {
        texture: result.ok_or("D3D11 returned no texture.")?,
        width,
        height,
    })
}

impl Preview {
    fn new(
        device: &ID3D11Device,
        sw: u32,
        sh: u32,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let source = texture(
            device,
            sw,
            sh,
            DXGI_FORMAT_B8G8R8A8_UNORM,
            D3D11_BIND_SHADER_RESOURCE.0 as u32,
        )?;
        let output = texture(
            device,
            width,
            height,
            DXGI_FORMAT_R8G8B8A8_UNORM,
            D3D11_BIND_UNORDERED_ACCESS.0 as u32,
        )?;
        let staging = texture(device, width, height, DXGI_FORMAT_R8G8B8A8_UNORM, 0)?;
        let mut source_view = None;
        let mut output_view = None;
        let mut bytecode: Option<ID3DBlob> = None;
        let mut shader = None;
        unsafe {
            device
                .CreateShaderResourceView(&source.texture, None, Some(&mut source_view))
                .map_err(|e| capture_error("preparing or reading GPU pixels", e))?;
            device
                .CreateUnorderedAccessView(&output.texture, None, Some(&mut output_view))
                .map_err(|e| capture_error("preparing or reading GPU pixels", e))?;
            D3DCompile(
                PREVIEW_SHADER.as_ptr().cast(),
                PREVIEW_SHADER.len(),
                None,
                None,
                None,
                s!("main"),
                s!("cs_5_0"),
                0,
                0,
                &mut bytecode,
                None,
            )
            .map_err(|e| capture_error("preparing or reading GPU pixels", e))?;
            let bytecode = bytecode.ok_or("The preview shader compiler returned no bytecode.")?;
            let bytes = std::slice::from_raw_parts(
                bytecode.GetBufferPointer().cast::<u8>(),
                bytecode.GetBufferSize(),
            );
            device
                .CreateComputeShader(bytes, None, Some(&mut shader))
                .map_err(|e| capture_error("preparing or reading GPU pixels", e))?;
        }
        Ok(Self {
            source,
            source_view: source_view.ok_or("Missing preview source view.")?,
            output,
            output_view: output_view.ok_or("Missing preview output view.")?,
            staging,
            shader: shader.ok_or("Missing preview shader.")?,
        })
    }
}

fn read_frame(
    context: &ID3D11DeviceContext,
    staging: &ID3D11Texture2D,
    header: FrameHeader,
    bgra: bool,
) -> Result<Vec<u8>, String> {
    let width = header.output_width;
    let height = header.output_height;
    let mut frame = allocate_frame(header)?;
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
        .map_err(|e| capture_error("preparing or reading GPU pixels", e))?;
    // Always unmap, including invalid driver output; the slice lives only while mapped.
    let result = (|| {
        let length = (mapped.RowPitch as usize)
            .checked_mul(height as usize)
            .ok_or("Mapped capture size overflowed.")?;
        if mapped.pData.is_null()
            || mapped.RowPitch < width.checked_mul(4).ok_or("Capture row size overflowed.")?
            || length > isize::MAX as usize
        {
            return Err("D3D11 returned invalid mapped capture rows.".to_string());
        }
        let pixels = unsafe { std::slice::from_raw_parts(mapped.pData.cast::<u8>(), length) };
        pack_rows(
            pixels,
            mapped.RowPitch as usize,
            &mut frame[FRAME_HEADER_BYTES..],
            width,
            height,
            bgra,
        )
    })();
    unsafe {
        context.Unmap(staging, 0);
    }
    result?;
    Ok(frame)
}
