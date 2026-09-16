use super::{probe_video, resolve_ffmpeg_executable};
use image::GenericImage;
use serde_json::{json, Value};
use std::{
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
};
use tauri::Manager;

fn single_sheet_layout(samples: usize, cell_width: u32) -> Result<(u32, u32), String> {
    let columns = ((samples as f64 * 280.0 / (cell_width + 8) as f64)
        .sqrt()
        .round() as u32)
        .clamp(1, samples.max(1) as u32);
    let rows = (samples as u32).div_ceil(columns);
    let width = columns as u64 * (cell_width as u64 + 8) + 8;
    let height = rows as u64 * 280 + 8;
    if width > 32768 || height > 32768 || width * height > 120_000_000 {
        return Err("전체 프레임 시트가 너무 큽니다(최대 120MP / 한 변 32768px). 영상을 더 짧게 나누어 입력해 주세요. 프레임은 임의로 생략하지 않습니다.".into());
    }
    Ok((columns, rows))
}

#[tauri::command]
pub async fn generate_vta_frame_sheets(
    app: tauri::AppHandle,
    executable: String,
    video_path: String,
) -> Result<Value, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("vta-llm-sheets");
    tauri::async_runtime::spawn_blocking(move || generate_sheets(&executable, &video_path, &root))
        .await
        .map_err(|error| error.to_string())?
}

fn generate_sheets(executable: &str, video_path: &str, root: &Path) -> Result<Value, String> {
    let source = probe_video(executable.into(), video_path.into())?;
    let duration = source["duration"].as_f64().unwrap_or(0.0);
    if !duration.is_finite() || duration < 0.2 {
        return Err("Video-to-Audio 프레임 시트는 0.2초 이상의 영상을 지원합니다.".into());
    }
    let metadata = fs::metadata(video_path).map_err(|error| error.to_string())?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (
        "vta-sheet-v1",
        fs::canonicalize(video_path).map_err(|error| error.to_string())?,
        metadata.len(),
        metadata.modified().ok(),
    )
        .hash(&mut hash);
    let source_key = format!("{:016x}", hash.finish());
    // Layout cache changes must not invalidate the user's existing LLM draft.
    let folder = root.join(format!("single-v3-{source_key}"));
    let manifest_path = folder.join("manifest.json");
    if let Ok(bytes) = fs::read(&manifest_path) {
        if let Ok(cached) = serde_json::from_slice::<Value>(&bytes) {
            if cached["pages"].as_array().is_some_and(|pages| {
                pages.len() == 1
                    && pages.iter().all(|page| {
                        page["path"]
                            .as_str()
                            .is_some_and(|path| Path::new(path).is_file())
                    })
            }) {
                return Ok(cached);
            }
        }
    }
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let width = ((source["width"].as_f64().unwrap_or(1.0)
        / source["height"].as_f64().unwrap_or(1.0)
        * 240.0
        / 2.0)
        .round() as u32
        * 2)
    .max(2);
    if width > 8192 {
        return Err("영상 가로세로 비율이 프레임 시트에 너무 넓습니다.".into());
    }
    let cell_width = width.max(360);
    let columns = (4096 / (cell_width + 8)).clamp(1, 3);
    let per_page = columns * 4;
    let font = PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(|| "C:/Windows".into()))
        .join("Fonts/arial.ttf");
    if !font.is_file() {
        return Err("프레임 번호·시간 표시에 필요한 Arial 글꼴이 없습니다.".into());
    }
    let font = font
        .to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:");
    // Select the first actual frame at/after each one-second boundary. PTS
    // remains attached to the selected frame; labels show that actual time,
    // including non-integer/VFR input rates, rather than fabricated CFR time.
    let filter = format!(
        r"setpts=PTS-STARTPTS,select='isnan(prev_selected_t)+gte(t,selected_n*1.0)',scale={width}:240:flags=lanczos,showinfo,pad={cell_width}:ih+32:(ow-iw)/2:32:color=0x152d28,drawtext=fontfile='{font}':text='FRAME %{{eif\:n+1\:d\:4}} | %{{pts\:hms}}':fontsize=18:fontcolor=white:x=8:y=7,tile={columns}x4:nb_frames={per_page}:padding=8:margin=8:color=0x152d28"
    );
    let mut command = Command::new(resolve_ffmpeg_executable(executable));
    command
        .args([
            "-hide_banner",
            "-y",
            "-i",
            video_path,
            "-an",
            "-vf",
            &filter,
            "-fps_mode",
            "vfr",
        ])
        .arg(folder.join("sheet-%03d.png"));
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .map_err(|error| format!("프레임 시트 추출 실패: {error}"))?;
    let log = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!(
            "프레임 시트 생성 실패: {}",
            log.chars()
                .rev()
                .take(1800)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ));
    }
    let timestamps: Vec<f64> = log
        .lines()
        .filter(|line| line.contains("showinfo") && line.contains("pts_time:"))
        .filter_map(|line| {
            line.split("pts_time:")
                .nth(1)?
                .split_whitespace()
                .next()?
                .parse()
                .ok()
        })
        .collect();
    if timestamps.is_empty() {
        return Err("영상에서 추출된 프레임이 없습니다.".into());
    }
    // Decode in bounded tiles, then arrange EVERY labeled frame in one image.
    // Actual selected timestamps, not container-duration estimates, determine
    // capacity so the last partial tile cannot silently drop video frames.
    let (sheet_columns, sheet_rows) = single_sheet_layout(timestamps.len(), cell_width)?;
    let sheet_width = sheet_columns * (cell_width + 8) + 8;
    let sheet_height = sheet_rows * 280 + 8;
    let mut sheet =
        image::RgbImage::from_pixel(sheet_width, sheet_height, image::Rgb([0x15, 0x2d, 0x28]));
    for (index, times) in timestamps.chunks(per_page as usize).enumerate() {
        let path = folder.join(format!("sheet-{:03}.png", index + 1));
        if !path.is_file() {
            return Err(format!(
                "프레임 시트 {} 저장을 확인하지 못했습니다.",
                index + 1
            ));
        }
        let tile = image::open(&path)
            .map_err(|error| format!("프레임 시트 읽기 실패: {error}"))?
            .to_rgb8();
        for offset in 0..times.len() as u32 {
            let frame = index as u32 * per_page + offset;
            let x = 8 + (offset % columns) * (cell_width + 8);
            let y = 8 + (offset / columns) * 280;
            if x + cell_width > tile.width() || y + 272 > tile.height() {
                return Err(
                    "프레임 시트 크기가 예상과 다릅니다. 전체 시트를 다시 생성해 주세요.".into(),
                );
            }
            let cell = image::imageops::crop_imm(&tile, x, y, cell_width, 272).to_image();
            sheet
                .copy_from(
                    &cell,
                    8 + (frame % sheet_columns) * (cell_width + 8),
                    8 + (frame / sheet_columns) * 280,
                )
                .map_err(|error| format!("전체 프레임 시트 합치기 실패: {error}"))?;
        }
    }
    let sheet_path = folder.join("sheet-all.png");
    sheet
        .save(&sheet_path)
        .map_err(|error| format!("전체 프레임 시트 저장 실패: {error}"))?;
    let pages = vec![
        json!({"path":sheet_path.to_string_lossy(),"firstFrame":1,"lastFrame":timestamps.len(),
        "startSeconds":timestamps[0],"endSeconds":timestamps[timestamps.len()-1]}),
    ];
    let result = json!({"sourceKey":source_key,"source":source,"intervalSeconds":1.0,"frameHeight":240,
        "frameWidth":width,"columns":sheet_columns,"rows":sheet_rows,"sheetWidth":sheet_width,"sheetHeight":sheet_height,
        "samples":timestamps.len(),"timestamps":timestamps,"pages":pages});
    fs::write(manifest_path, serde_json::to_vec_pretty(&result).unwrap())
        .map_err(|error| error.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vta_sheets_sample_one_second_single_image_and_preserve_source() {
        let root =
            std::env::temp_dir().join(format!("frameflow-vta-sheet-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("한글-source.mp4");
        let ffmpeg = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../release/FrameFlow-Studio/tools/ffmpeg/ffmpeg.exe");
        let status = Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=640x360:rate=30",
                "-t",
                "6.2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&source)
            .status()
            .unwrap();
        assert!(status.success());
        let before = fs::read(&source).unwrap();
        let result = generate_sheets(
            ffmpeg.to_str().unwrap(),
            source.to_str().unwrap(),
            &root.join("cache"),
        )
        .unwrap();
        assert_eq!(result["samples"], 7);
        assert_eq!(result["pages"].as_array().unwrap().len(), 1);
        assert_eq!(result["pages"][0]["lastFrame"], 7);
        assert_eq!(result["pages"][0]["endSeconds"], 6.0);
        for (index, time) in result["timestamps"].as_array().unwrap().iter().enumerate() {
            assert!((time.as_f64().unwrap() - index as f64).abs() < 0.001);
        }
        let first = image::open(result["pages"][0]["path"].as_str().unwrap()).unwrap();
        assert_eq!(
            first.height(),
            result["sheetHeight"].as_u64().unwrap() as u32
        );
        assert_eq!(first.width(), result["sheetWidth"].as_u64().unwrap() as u32);
        // The last cell is present in the assembled sheet, including its label.
        let cols = result["columns"].as_u64().unwrap() as u32;
        let tile1 = image::open(
            Path::new(result["pages"][0]["path"].as_str().unwrap())
                .parent()
                .unwrap()
                .join("sheet-001.png"),
        )
        .unwrap();
        assert_eq!(
            first
                .crop_imm(
                    8 + (6 % cols) * (result["frameWidth"].as_u64().unwrap() as u32 + 8),
                    8 + (6 / cols) * 280,
                    360,
                    272
                )
                .to_rgb8(),
            tile1
                .crop_imm(8 + (6 % 3) * 434, 8 + (6 / 3) * 280, 360, 272)
                .to_rgb8()
        );
        let label = first.crop_imm(8, 8, 360, 32).to_rgb8();
        assert!(
            label
                .pixels()
                .filter(|pixel| pixel[0] > 180 && pixel[1] > 180 && pixel[2] > 180)
                .count()
                > 100
        );
        fs::copy(
            result["pages"][0]["path"].as_str().unwrap(),
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../verification/vta-sheet-sample.png"),
        )
        .unwrap();
        assert_eq!(fs::read(&source).unwrap(), before);
        assert_eq!(
            generate_sheets(
                ffmpeg.to_str().unwrap(),
                source.to_str().unwrap(),
                &root.join("cache")
            )
            .unwrap(),
            result
        );
        // A changed file at the same path must not return a stale sheet. Also
        // verify portrait labels and actual timestamps at 29.97 fps.
        assert!(Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=180x320:rate=30000/1001",
                "-t",
                "2.2",
                "-c:v",
                "libx264"
            ])
            .arg(&source)
            .status()
            .unwrap()
            .success());
        let portrait = generate_sheets(
            ffmpeg.to_str().unwrap(),
            source.to_str().unwrap(),
            &root.join("cache"),
        )
        .unwrap();
        assert_ne!(portrait["sourceKey"], result["sourceKey"]);
        assert_eq!(portrait["samples"], 3);
        for (index, time) in portrait["timestamps"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            let delta = time.as_f64().unwrap() - index as f64;
            assert!(delta >= 0.0 && delta < 0.034);
        }
        let portrait_sheet = image::open(portrait["pages"][0]["path"].as_str().unwrap()).unwrap();
        assert_eq!(
            portrait_sheet.width(),
            portrait["sheetWidth"].as_u64().unwrap() as u32
        );
        assert_eq!(portrait["pages"].as_array().unwrap().len(), 1);
        // A minute-long reference previously needed eleven pages.
        assert!(Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x90:rate=2",
                "-t",
                "60.5",
                "-c:v",
                "libx264"
            ])
            .arg(&source)
            .status()
            .unwrap()
            .success());
        let minute = generate_sheets(
            ffmpeg.to_str().unwrap(),
            source.to_str().unwrap(),
            &root.join("cache"),
        )
        .unwrap();
        assert_eq!(minute["samples"], 61);
        assert_eq!(minute["pages"].as_array().unwrap().len(), 1);
        assert_eq!(minute["pages"][0]["endSeconds"], 60.0);
        let all = image::open(minute["pages"][0]["path"].as_str().unwrap()).unwrap();
        let cols = minute["columns"].as_u64().unwrap() as u32;
        let last = all
            .crop_imm(8 + (60 % cols) * 434, 8 + (60 / cols) * 280, 360, 32)
            .to_rgb8();
        assert!(
            last.pixels()
                .filter(|pixel| pixel[0] > 180 && pixel[1] > 180 && pixel[2] > 180)
                .count()
                > 100
        );
        fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn single_sheet_dimensions_are_bounded_without_dropping_samples() {
        for (count, width) in [(1, 360), (104, 1062), (121, 432), (298, 360)] {
            let (cols, rows) = single_sheet_layout(count, width).unwrap();
            assert!(cols * rows >= count as u32);
        }
        assert!(single_sheet_layout(298, 8192).is_err());
    }
}
