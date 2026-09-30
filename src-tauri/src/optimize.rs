use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader, RgbImage};
use serde::{Deserialize, Serialize};
use std::io::Cursor;

#[derive(Debug, Deserialize)]
pub struct OptimizeImageRequest {
    pub bytes: Vec<u8>,
    pub target_width: Option<u32>,
    pub target_height: Option<u32>,
    pub quality: Option<u8>,
    pub format: Option<String>,
    pub color_space: Option<String>,
    pub original_width: Option<u32>,
    pub original_height: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct OptimizeImageResponse {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub original_size: usize,
    pub optimized_size: usize,
}

pub fn optimize_image_buffer(req: OptimizeImageRequest) -> Result<OptimizeImageResponse, String> {
    let original_size = req.bytes.len();

    // Try decoding as a known image container (JPEG, PNG, etc.)
    let img: DynamicImage = if let Ok(reader) = ImageReader::new(Cursor::new(&req.bytes)).with_guessed_format() {
        reader.decode().map_err(|e| format!("decode error: {e}"))
    } else {
        // If container decoding fails, try interpreting as raw pixel bytes if dimensions are given
        if let (Some(w), Some(h)) = (req.original_width, req.original_height) {
            let cs = req.color_space.as_deref().unwrap_or("rgb").to_lowercase();
            if cs.contains("gray") && req.bytes.len() == (w * h) as usize {
                image::GrayImage::from_raw(w, h, req.bytes.clone())
                    .map(DynamicImage::ImageLuma8)
                    .ok_or_else(|| "failed to create GrayImage from raw buffer".to_string())
            } else if req.bytes.len() == (w * h * 3) as usize {
                RgbImage::from_raw(w, h, req.bytes.clone())
                    .map(DynamicImage::ImageRgb8)
                    .ok_or_else(|| "failed to create RgbImage from raw buffer".to_string())
            } else if req.bytes.len() == (w * h * 4) as usize {
                if cs.contains("cmyk") {
                    // Convert CMYK raw bytes to RGB
                    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
                    for chunk in req.bytes.chunks_exact(4) {
                        let c = chunk[0] as f32 / 255.0;
                        let m = chunk[1] as f32 / 255.0;
                        let y = chunk[2] as f32 / 255.0;
                        let k = chunk[3] as f32 / 255.0;
                        let r = (255.0 * (1.0 - c) * (1.0 - k)).round().clamp(0.0, 255.0) as u8;
                        let g = (255.0 * (1.0 - m) * (1.0 - k)).round().clamp(0.0, 255.0) as u8;
                        let b = (255.0 * (1.0 - y) * (1.0 - k)).round().clamp(0.0, 255.0) as u8;
                        rgb.push(r);
                        rgb.push(g);
                        rgb.push(b);
                    }
                    RgbImage::from_raw(w, h, rgb)
                        .map(DynamicImage::ImageRgb8)
                        .ok_or_else(|| "failed to create CMYK->RGB image".to_string())
                } else {
                    image::RgbaImage::from_raw(w, h, req.bytes.clone())
                        .map(DynamicImage::ImageRgba8)
                        .ok_or_else(|| "failed to create RgbaImage from raw buffer".to_string())
                }
            } else {
                Err(format!(
                    "unrecognized raw image buffer size {} for {}x{} ({})",
                    req.bytes.len(),
                    w,
                    h,
                    cs
                ))
            }
        } else {
            Err("failed to guess format or decode image from memory".to_string())
        }
    }?;

    let (cur_w, cur_h) = img.dimensions();
    let target_w = req.target_width.unwrap_or(cur_w).min(cur_w).max(1);
    let target_h = req.target_height.unwrap_or(cur_h).min(cur_h).max(1);

    let resized = if target_w < cur_w || target_h < cur_h {
        img.resize_exact(target_w, target_h, FilterType::Lanczos3)
    } else {
        img
    };

    let (final_w, final_h) = resized.dimensions();
    let quality = req.quality.unwrap_or(75).clamp(10, 100);
    let req_format = req.format.as_deref().unwrap_or("jpeg").to_lowercase();

    let mut out_bytes = Vec::new();
    let out_format = if req_format == "png" && resized.color().has_alpha() {
        resized
            .write_to(&mut Cursor::new(&mut out_bytes), ImageFormat::Png)
            .map_err(|e| format!("png encode error: {e}"))?;
        "png".to_string()
    } else {
        let rgb_img = resized.to_rgb8();
        let mut encoder = JpegEncoder::new_with_quality(&mut out_bytes, quality);
        encoder
            .encode(
                rgb_img.as_raw(),
                final_w,
                final_h,
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| format!("jpeg encode error: {e}"))?;
        "jpeg".to_string()
    };

    let optimized_size = out_bytes.len();

    Ok(OptimizeImageResponse {
        bytes: out_bytes,
        width: final_w,
        height: final_h,
        format: out_format,
        original_size,
        optimized_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_optimize_jpeg() {
        let mut raw_rgb = Vec::with_capacity(100 * 100 * 3);
        for y in 0..100 {
            for x in 0..100 {
                raw_rgb.push((x * 2) as u8);
                raw_rgb.push((y * 2) as u8);
                raw_rgb.push(128);
            }
        }
        let rgb_img = RgbImage::from_raw(100, 100, raw_rgb).unwrap();
        let mut jpeg_bytes = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, 90);
        encoder.encode(rgb_img.as_raw(), 100, 100, image::ExtendedColorType::Rgb8).unwrap();

        let req = OptimizeImageRequest {
            bytes: jpeg_bytes,
            target_width: Some(50),
            target_height: Some(50),
            quality: Some(60),
            format: Some("jpeg".into()),
            color_space: None,
            original_width: None,
            original_height: None,
        };

        let res = optimize_image_buffer(req).expect("should optimize jpeg");
        assert_eq!(res.width, 50);
        assert_eq!(res.height, 50);
        assert_eq!(res.format, "jpeg");
        assert!(res.bytes.len() > 0);
        assert!(res.optimized_size < res.original_size);
    }
}
