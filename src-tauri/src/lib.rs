use base64::Engine;
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, GenericImageView};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

mod comfy;
mod enhance;
mod media_tools;
mod vta;

fn db_connection(app: &AppHandle) -> Result<Connection, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let conn = Connection::open(dir.join("frameflow.sqlite3")).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
     CREATE TABLE IF NOT EXISTS projects (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       project_path TEXT NOT NULL,
       json TEXT NOT NULL,
       updated_at INTEGER NOT NULL DEFAULT (unixepoch())
     );
     CREATE TABLE IF NOT EXISTS settings (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

#[tauri::command]
fn init_database(app: AppHandle) -> Result<(), String> {
    db_connection(&app).map(|_| ())
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn list_projects(app: AppHandle) -> Result<Vec<Value>, String> {
    let conn = db_connection(&app)?;
    let mut stmt = conn
        .prepare("SELECT json FROM projects ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let json = row.map_err(|e| e.to_string())?;
        serde_json::from_str(&json).map_err(|e| e.to_string())
    })
    .collect()
}

#[tauri::command]
fn save_project(app: AppHandle, project: Value) -> Result<(), String> {
    let id = project
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "프로젝트 ID가 없습니다.".to_string())?;
    let name = project
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "프로젝트 이름이 없습니다.".to_string())?;
    let project_path = project
        .get("projectPath")
        .and_then(Value::as_str)
        .ok_or_else(|| "프로젝트 경로가 없습니다.".to_string())?;
    let json = serde_json::to_string(&project).map_err(|e| e.to_string())?;
    let conn = db_connection(&app)?;
    conn.execute(
    "INSERT INTO projects(id,name,project_path,json,updated_at) VALUES(?1,?2,?3,?4,unixepoch())
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, project_path=excluded.project_path, json=excluded.json, updated_at=unixepoch()",
    params![id, name, project_path, json]
  ).map_err(|e| e.to_string())?;
    let root = Path::new(project_path);
    if root.is_dir() {
        fs::write(
            root.join("project.frameflow.json"),
            serde_json::to_string_pretty(&project).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn delete_project(app: AppHandle, project_id: String) -> Result<(), String> {
    let conn = db_connection(&app)?;
    let project_path: String = conn
        .query_row(
            "SELECT project_path FROM projects WHERE id=?1",
            params![&project_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("삭제할 프로젝트 정보를 찾지 못했습니다: {e}"))?;
    delete_project_directory(Path::new(&project_path), &project_id)?;
    conn.execute("DELETE FROM projects WHERE id=?1", params![project_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn delete_project_directory(project_path: &Path, project_id: &str) -> Result<(), String> {
    if !project_path.exists() {
        return Ok(());
    }
    if !project_path.is_dir() {
        return Err("프로젝트 경로가 폴더가 아니므로 삭제하지 않았습니다.".into());
    }
    let root = fs::canonicalize(project_path)
        .map_err(|e| format!("프로젝트 폴더 경로를 확인하지 못했습니다: {e}"))?;
    if root.parent().and_then(Path::parent).is_none() {
        return Err("안전을 위해 드라이브 루트 또는 바로 아래 폴더는 삭제할 수 없습니다.".into());
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if fs::canonicalize(profile).ok().as_deref() == Some(root.as_path()) {
            return Err("사용자 홈 폴더는 프로젝트로 삭제할 수 없습니다.".into());
        }
    }
    let marker_path = root.join("project.frameflow.json");
    let marker_text = fs::read_to_string(&marker_path).map_err(|_| {
        "project.frameflow.json 확인 파일이 없어 프로젝트 폴더를 삭제하지 않았습니다.".to_string()
    })?;
    let marker: Value = serde_json::from_str(&marker_text)
        .map_err(|e| format!("프로젝트 확인 파일을 읽지 못해 폴더를 삭제하지 않았습니다: {e}"))?;
    if marker.get("id").and_then(Value::as_str) != Some(project_id) {
        return Err(
            "프로젝트 확인 파일의 ID가 삭제 대상과 달라 폴더를 삭제하지 않았습니다.".into(),
        );
    }
    fs::remove_dir_all(&root)
        .map_err(|e| format!("프로젝트 폴더 전체 삭제에 실패했습니다: {e}"))?;
    Ok(())
}

fn copy_directory_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory_recursive(&source_path, &destination_path)?;
        } else {
            fs::copy(&source_path, &destination_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn backup_project_folder(
    project_path: String,
    destination_dir: String,
    project_name: String,
) -> Result<String, String> {
    let source = PathBuf::from(project_path)
        .canonicalize()
        .map_err(|_| "프로젝트 폴더를 찾을 수 없습니다.".to_string())?;
    let destination_root = PathBuf::from(destination_dir)
        .canonicalize()
        .map_err(|_| "백업 저장 폴더를 찾을 수 없습니다.".to_string())?;
    if destination_root.starts_with(&source) {
        return Err("프로젝트 폴더 내부에는 백업할 수 없습니다.".to_string());
    }
    let safe_name: String = project_name
        .chars()
        .map(|ch| {
            if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let destination = destination_root.join(format!("{}-FrameFlow-Backup-{}", safe_name, stamp));
    copy_directory_recursive(&source, &destination)?;
    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command]
fn import_project_manifest(app: AppHandle, manifest_path: String) -> Result<Value, String> {
    let json = fs::read_to_string(manifest_path).map_err(|e| e.to_string())?;
    let project: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    save_project(app, project.clone())?;
    Ok(project)
}

#[tauri::command]
fn get_app_settings(app: AppHandle) -> Result<Value, String> {
    let conn = db_connection(&app)?;
    let result = conn.query_row("SELECT value FROM settings WHERE key='app'", [], |row| {
        row.get::<_, String>(0)
    });
    match result {
        Ok(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(serde_json::json!({})),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn save_app_settings(app: AppHandle, settings: Value) -> Result<(), String> {
    let conn = db_connection(&app)?;
    let json = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO settings(key,value) VALUES('app',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![json]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_restored_comfy_settings(app: AppHandle) -> Result<Value, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let path = dir.join("frameflow-comfy-restore.json");
    if !path.is_file() {
        return Ok(serde_json::json!({}));
    }
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("복원된 Comfy 설정을 읽지 못했습니다: {error}"))?;
    let settings = serde_json::from_str(&text)
        .map_err(|error| format!("복원된 Comfy 설정 형식이 올바르지 않습니다: {error}"))?;
    fs::remove_file(&path)
        .map_err(|error| format!("적용한 Comfy 복원 설정을 정리하지 못했습니다: {error}"))?;
    Ok(settings)
}

fn resolve_ffmpeg_executable(requested: &str) -> PathBuf {
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(app_dir) = current_exe.parent() {
            let bundled = app_dir.join("tools").join("ffmpeg").join(if cfg!(windows) {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            });
            if bundled.is_file() {
                return bundled;
            }
        }
    }
    let requested = requested.trim();
    PathBuf::from(if requested.is_empty() {
        if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        }
    } else {
        requested
    })
}

#[tauri::command]
fn check_ffmpeg(executable: String) -> Result<String, String> {
    let resolved = resolve_ffmpeg_executable(&executable);
    let output = std::process::Command::new(&resolved)
        .arg("-version")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let version = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("FFmpeg 사용 가능")
        .to_string();
    Ok(format!("{} · {}", version, resolved.display()))
}

fn safe_asset_token(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect()
}

#[tauri::command]
fn generate_video_assets(
    executable: String,
    video_path: String,
    project_path: String,
    file_prefix: String,
    result_id: String,
    frame_count: u32,
) -> Result<Value, String> {
    let executable = resolve_ffmpeg_executable(&executable);
    let root = Path::new(&project_path);
    let sheets = root.join("meta").join("sheets");
    fs::create_dir_all(&sheets).map_err(|error| error.to_string())?;
    let stem = format!(
        "{}-{}",
        safe_asset_token(&file_prefix),
        safe_asset_token(&result_id)
    );
    let sheet_path = sheets.join(format!("{stem}-sheet.png"));

    let samples = ((frame_count.saturating_sub(1)) / 8 + 1).max(1);
    let columns = (samples as f64).sqrt().ceil() as u32;
    let rows = (samples + columns - 1) / columns;
    let sheet_filter = format!(
        "select='not(mod(n,8))',scale=320:-2:flags=lanczos,tile={}x{}:padding=8:margin=8:color=0x17221F",
        columns, rows
    );
    let sheet = std::process::Command::new(&executable)
        .args([
            "-y",
            "-i",
            &video_path,
            "-vf",
            &sheet_filter,
            "-frames:v",
            "1",
        ])
        .arg(&sheet_path)
        .output()
        .map_err(|error| format!("프레임 시트 생성에 실패했습니다: {error}"))?;
    if !sheet.status.success() {
        return Err(format!(
            "프레임 시트 생성에 실패했습니다: {}",
            String::from_utf8_lossy(&sheet.stderr)
        ));
    }

    Ok(serde_json::json!({
        "sheetPath": sheet_path.to_string_lossy(),
        "sheetIntervalFrames": 8,
        "sheetSamples": samples
    }))
}

fn extension_context_indices(duration: f64) -> Result<(u64, Vec<(u32, u64, f64)>), String> {
    if !duration.is_finite() || duration <= 0.0 {
        return Err("확장 원본 영상의 길이를 확인할 수 없습니다.".into());
    }
    let total = (duration * 24.0).round().max(1.0) as u64;
    if total < 22 {
        return Err("비디오 확장에는 24fps 기준 최소 22프레임의 원본 영상이 필요합니다.".into());
    }
    let start = total - 22;
    Ok((
        total,
        [1_u32, 5, 10, 22]
            .into_iter()
            .map(|context| {
                let frame = start + u64::from(context - 1);
                (context, frame, frame as f64 / 24.0)
            })
            .collect(),
    ))
}

#[tauri::command]
fn generate_extension_context_frames(
    executable: String,
    video_path: String,
    project_path: String,
    cut_uid: String,
) -> Result<Value, String> {
    let metadata = probe_video(executable.clone(), video_path.clone())?;
    let duration = metadata
        .get("duration")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let (total_frames, samples) = extension_context_indices(duration)?;
    let folder = Path::new(&project_path)
        .join("meta")
        .join("extension-context")
        .join(safe_asset_token(&cut_uid));
    fs::create_dir_all(&folder).map_err(|error| format!("확장 Context 폴더 생성 실패: {error}"))?;
    let output_pattern = folder.join("context-%02d.png");
    let selector = samples
        .iter()
        .map(|(_, frame, _)| format!("eq(n\\,{frame})"))
        .collect::<Vec<_>>()
        .join("+");
    let filter = format!("fps=24,select='{selector}',scale=640:-2:flags=lanczos");
    let ffmpeg = resolve_ffmpeg_executable(&executable);
    let output = Command::new(&ffmpeg)
        .args(["-y", "-i", &video_path, "-vf", &filter, "-vsync", "0"])
        .arg(&output_pattern)
        .output()
        .map_err(|error| format!("확장 Context 프레임 추출 실패: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "확장 Context 프레임 추출 실패: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let items = samples
        .iter()
        .enumerate()
        .map(|(index, (context, frame, seconds))| {
            let path = folder.join(format!("context-{:02}.png", index + 1));
            if !path.is_file() {
                return Err(format!(
                    "Context {context:02} 프레임 파일이 생성되지 않았습니다."
                ));
            }
            Ok(serde_json::json!({
                "contextIndex": context,
                "sourceFrame": frame + 1,
                "timeSeconds": seconds,
                "path": path.to_string_lossy()
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(serde_json::json!({
        "fps": 24,
        "contextFrames": 22,
        "normalizedFrames": total_frames,
        "duration": duration,
        "samples": items
    }))
}

#[tauri::command]
fn delete_result_assets(project_path: String, paths: Vec<String>) -> Result<u32, String> {
    let root = Path::new(&project_path)
        .canonicalize()
        .map_err(|error| format!("프로젝트 폴더를 확인하지 못했습니다: {error}"))?;
    let mut checked = Vec::new();
    for value in paths {
        if value.trim().is_empty() {
            continue;
        }
        let path = Path::new(&value);
        if !path.exists() {
            continue;
        }
        let resolved = path
            .canonicalize()
            .map_err(|error| format!("삭제할 파일 경로를 확인하지 못했습니다: {error}"))?;
        if !resolved.starts_with(&root) || !resolved.is_file() {
            return Err("프로젝트 폴더 안의 결과 파일만 삭제할 수 있습니다.".into());
        }
        checked.push(resolved);
    }
    let removed = checked.len() as u32;
    for resolved in checked {
        let mut parent = resolved.parent().map(Path::to_path_buf);
        fs::remove_file(&resolved).map_err(|error| format!("결과 파일 삭제 실패: {error}"))?;
        while let Some(folder) = parent {
            if folder == root || !folder.starts_with(&root) {
                break;
            }
            if fs::remove_dir(&folder).is_err() {
                break;
            }
            parent = folder.parent().map(Path::to_path_buf);
        }
    }
    Ok(removed)
}

#[tauri::command]
fn extract_last_frame(
    executable: String,
    video_path: String,
    project_path: String,
    source_scene: u32,
    target_scene: u32,
) -> Result<String, String> {
    let executable = resolve_ffmpeg_executable(&executable);
    let output_path = Path::new(&project_path).join("flf").join(format!(
        "{target_scene:04}-0-prev-scene-{source_scene:04}.png"
    ));
    if output_path.exists() {
        fs::remove_file(&output_path).map_err(|e| e.to_string())?;
    }
    let output = std::process::Command::new(executable)
        .args([
            "-y",
            "-sseof",
            "-1.0",
            "-i",
            &video_path,
            "-map",
            "0:v:0",
            "-vf",
            "reverse",
            "-frames:v",
            "1",
            "-update",
            "1",
        ])
        .arg(&output_path)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let size = fs::metadata(&output_path)
        .map_err(|_| "FFmpeg가 마지막 프레임 파일을 생성하지 못했습니다.".to_string())?
        .len();
    if size == 0 {
        return Err("FFmpeg가 빈 마지막 프레임 파일을 생성했습니다.".to_string());
    }
    output_path
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "추출 프레임 경로를 읽을 수 없습니다.".into())
}

#[tauri::command]
fn build_project_video(
    executable: String,
    video_paths: Vec<String>,
    output_path: String,
) -> Result<String, String> {
    let executable = resolve_ffmpeg_executable(&executable);
    if video_paths.is_empty() {
        return Err("선택된 영상이 없습니다.".into());
    }
    let output = Path::new(&output_path);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let concat_path = output.with_extension("concat.txt");
    let lines = video_paths
        .iter()
        .map(|path| format!("file '{}'", path.replace('\\', "/").replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&concat_path, lines).map_err(|e| e.to_string())?;
    let result = std::process::Command::new(executable)
        .args(["-y", "-f", "concat", "-safe", "0", "-i"])
        .arg(&concat_path)
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
        ])
        .arg(output)
        .output()
        .map_err(|e| e.to_string())?;
    let _ = fs::remove_file(concat_path);
    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).to_string());
    }
    Ok(output_path)
}

fn ffprobe_executable(ffmpeg: &str) -> PathBuf {
    let path = Path::new(ffmpeg);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if path
        .file_stem()
        .and_then(|value| value.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("ffmpeg"))
    {
        return path.with_file_name(if extension.is_empty() {
            "ffprobe".to_owned()
        } else {
            format!("ffprobe.{extension}")
        });
    }
    PathBuf::from(if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    })
}

#[tauri::command]
fn probe_video(executable: String, video_path: String) -> Result<Value, String> {
    let ffmpeg = resolve_ffmpeg_executable(&executable);
    let source = Path::new(&video_path);
    if !source.is_file() {
        return Err(format!("MP4 파일을 찾을 수 없습니다: {video_path}"));
    }
    let output = std::process::Command::new(ffprobe_executable(ffmpeg.to_string_lossy().as_ref()))
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,avg_frame_rate,r_frame_rate:format=duration",
            "-of",
            "json",
            &video_path,
        ])
        .output()
        .map_err(|error| format!("FFprobe 실행 실패: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("FFprobe 결과를 해석하지 못했습니다: {error}"))?;
    let stream = value
        .get("streams")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| "MP4에서 비디오 스트림을 찾지 못했습니다.".to_string())?;
    let width = stream.get("width").and_then(Value::as_u64).unwrap_or(0);
    let height = stream.get("height").and_then(Value::as_u64).unwrap_or(0);
    let parse_rate = |name: &str| {
        stream
            .get(name)
            .and_then(Value::as_str)
            .and_then(|rate| {
                let mut parts = rate.split('/');
                let numerator = parts.next()?.parse::<f64>().ok()?;
                let denominator = parts.next().unwrap_or("1").parse::<f64>().ok()?;
                (denominator > 0.0).then_some(numerator / denominator)
            })
            .filter(|fps| fps.is_finite() && *fps > 0.0)
    };
    let fps = parse_rate("avg_frame_rate")
        .or_else(|| parse_rate("r_frame_rate"))
        .unwrap_or(24.0);
    let duration = value
        .pointer("/format/duration")
        .and_then(Value::as_str)
        .and_then(|text| text.parse::<f64>().ok())
        .unwrap_or(0.0);
    if width == 0 || height == 0 || duration <= 0.0 {
        return Err("MP4의 해상도 또는 재생시간을 확인하지 못했습니다.".into());
    }
    Ok(serde_json::json!({
        "path": video_path,
        "filename": source.file_name().and_then(|value| value.to_str()).unwrap_or("video.mp4"),
        "width": width,
        "height": height,
        "duration": duration,
        "fps": fps,
        "frameCount": (duration * fps).round() as u64,
        "megapixels": width as f64 * height as f64 / 1_000_000.0
    }))
}

#[tauri::command]
fn prepare_video_audio_reference(
    executable: String,
    video_path: String,
    output_path: String,
    width: u32,
    height: u32,
    start_seconds: Option<f64>,
    duration: f64,
    fps: u32,
) -> Result<String, String> {
    if width < 32 || height < 32 || width % 32 != 0 || height % 32 != 0 {
        return Err("Ref2VA 참조 해상도는 가로·세로 32 이상이며 32의 배수여야 합니다.".into());
    }
    if !Path::new(&video_path).is_file() {
        return Err(format!("참조 영상을 찾을 수 없습니다: {video_path}"));
    }
    let output = Path::new(&output_path);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    validate_ref2va_duration(duration)?;
    let start_seconds = start_seconds.unwrap_or(0.0);
    if !start_seconds.is_finite() || start_seconds < 0.0 {
        return Err("Ref2VA 구간 시작 시각은 0초 이상이어야 합니다.".into());
    }
    let duration = duration.to_string();
    let start_seconds = start_seconds.to_string();
    let fps = fps.clamp(1, 240).to_string();
    let scale = format!("scale={width}:{height}:flags=lanczos,fps={fps}");
    let result = std::process::Command::new(resolve_ffmpeg_executable(&executable))
        .args([
            "-y",
            "-ss",
            &start_seconds,
            "-i",
            &video_path,
            "-t",
            &duration,
            "-vf",
            &scale,
        ])
        .args(["-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18"])
        .args(["-pix_fmt", "yuv420p", "-movflags", "+faststart"])
        .arg(output)
        .output()
        .map_err(|error| format!("Ref2VA 참조 영상 전처리 실행 실패: {error}"))?;
    if !result.status.success() {
        return Err(format!(
            "Ref2VA 참조 영상 전처리 실패: {}",
            String::from_utf8_lossy(&result.stderr)
                .chars()
                .rev()
                .take(2400)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ));
    }
    Ok(output_path)
}

fn validate_ref2va_duration(duration: f64) -> Result<(), String> {
    if !duration.is_finite() || duration < 0.2 {
        return Err("Ref2VA 오디오 생성은 0.2초 이상의 영상을 지원합니다.".into());
    }
    Ok(())
}

#[tauri::command]
fn mux_video_with_audio(
    executable: String,
    video_path: String,
    audio_path: String,
    output_path: String,
) -> Result<String, String> {
    let executable = resolve_ffmpeg_executable(&executable);
    if !Path::new(&video_path).is_file() {
        return Err(format!("합성할 원본 영상을 찾을 수 없습니다: {video_path}"));
    }
    if !Path::new(&audio_path).is_file() {
        return Err(format!(
            "합성할 생성 오디오를 찾을 수 없습니다: {audio_path}"
        ));
    }
    let output = Path::new(&output_path);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let result = std::process::Command::new(executable)
        .args(["-y", "-i", &video_path, "-i", &audio_path])
        .args(["-map", "0:v:0", "-map", "1:a:0"])
        .args(["-c:v", "libx264", "-preset", "medium", "-crf", "15"])
        .args([
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            "-shortest",
        ])
        .arg(output)
        .output()
        .map_err(|error| format!("FFmpeg Video-to-Audio 합성 실행 실패: {error}"))?;
    if !result.status.success() {
        return Err(format!(
            "FFmpeg Video-to-Audio 합성 실패: {}",
            String::from_utf8_lossy(&result.stderr)
                .chars()
                .rev()
                .take(2400)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ));
    }
    Ok(output_path)
}

#[tauri::command]
fn assemble_audio_segments(
    executable: String,
    audio_paths: Vec<String>,
    durations: Vec<f64>,
    fade_seconds: f64,
    output_path: String,
) -> Result<String, String> {
    if audio_paths.is_empty() || audio_paths.len() != durations.len() {
        return Err("연결할 오디오 구간과 길이 정보가 일치하지 않습니다.".into());
    }
    if !fade_seconds.is_finite() || !(0.0..=10.0).contains(&fade_seconds) {
        return Err("오디오 페이드 길이는 0~10초여야 합니다.".into());
    }
    for (index, path) in audio_paths.iter().enumerate() {
        if !Path::new(path).is_file() {
            return Err(format!(
                "오디오 구간 {} 파일을 찾을 수 없습니다: {path}",
                index + 1
            ));
        }
        if !durations[index].is_finite() || durations[index] <= 0.0 {
            return Err(format!(
                "오디오 구간 {} 길이가 올바르지 않습니다.",
                index + 1
            ));
        }
    }
    let output = Path::new(&output_path);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut command = std::process::Command::new(resolve_ffmpeg_executable(&executable));
    command.arg("-y");
    for path in &audio_paths {
        command.args(["-i", path]);
    }
    let mut filters = Vec::with_capacity(audio_paths.len());
    for (index, duration) in durations.iter().enumerate() {
        let fade = fade_seconds.min(duration / 2.0);
        let out_start = (duration - fade).max(0.0);
        let mut chain = format!("[{index}:a]atrim=0:{duration:.6},asetpts=PTS-STARTPTS");
        if index > 0 && fade > 0.0 {
            chain.push_str(&format!(",afade=t=in:st=0:d={fade:.6}"));
        }
        if fade > 0.0 {
            chain.push_str(&format!(",afade=t=out:st={out_start:.6}:d={fade:.6}"));
        }
        chain.push_str(&format!("[a{index}]"));
        filters.push(chain);
    }
    let inputs = (0..audio_paths.len())
        .map(|index| format!("[a{index}]"))
        .collect::<String>();
    filters.push(format!(
        "{inputs}concat=n={}:v=0:a=1[outa]",
        audio_paths.len()
    ));
    let total: f64 = durations.iter().sum();
    let filter = filters.join(";");
    let result = command
        .args([
            "-filter_complex",
            &filter,
            "-map",
            "[outa]",
            "-t",
            &format!("{total:.6}"),
            "-c:a",
            "libmp3lame",
            "-b:a",
            "192k",
        ])
        .arg(output)
        .output()
        .map_err(|error| format!("오디오 구간 연결 실행 실패: {error}"))?;
    if !result.status.success() {
        return Err(format!(
            "오디오 구간 연결 실패: {}",
            String::from_utf8_lossy(&result.stderr)
                .chars()
                .rev()
                .take(2400)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ));
    }
    Ok(output_path)
}

fn video_frame_count(ffmpeg: &str, video_path: &str) -> Result<u64, String> {
    let output = std::process::Command::new(ffprobe_executable(ffmpeg))
        .args([
            "-v",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_read_frames,nb_frames",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
            video_path,
        ])
        .output()
        .map_err(|error| format!("FFprobe 실행 실패: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.trim().parse::<u64>().ok().filter(|value| *value > 0))
        .ok_or_else(|| format!("영상 프레임 수를 확인하지 못했습니다: {video_path}"))
}

#[tauri::command]
fn build_scene_video(
    executable: String,
    video_paths: Vec<String>,
    output_path: String,
    fps: u32,
    remove_boundary_frames: Option<bool>,
) -> Result<String, String> {
    let executable = resolve_ffmpeg_executable(&executable);
    if video_paths.is_empty() {
        return Err("합본에 사용할 대표 영상이 없습니다.".into());
    }
    let output = Path::new(&output_path);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut filters = Vec::with_capacity(video_paths.len() + 1);
    let remove_boundary_frames = remove_boundary_frames.unwrap_or(true);
    for (index, path) in video_paths.iter().enumerate() {
        if remove_boundary_frames && index + 1 < video_paths.len() {
            let frames = video_frame_count(executable.to_string_lossy().as_ref(), path)?;
            if frames < 2 {
                return Err(format!("마지막 프레임을 제외할 수 없는 영상입니다: {path}"));
            }
            filters.push(format!(
                "[{index}:v:0]trim=end_frame={},setpts=PTS-STARTPTS[v{index}]",
                frames - 1
            ));
        } else {
            filters.push(format!("[{index}:v:0]setpts=PTS-STARTPTS[v{index}]"));
        }
    }
    let inputs = (0..video_paths.len())
        .map(|index| format!("[v{index}]"))
        .collect::<String>();
    filters.push(format!(
        "{inputs}concat=n={}:v=1:a=0,fps={},format=yuv420p[outv]",
        video_paths.len(),
        fps.max(1)
    ));
    let mut command = std::process::Command::new(executable);
    command.arg("-y");
    for path in &video_paths {
        command.args(["-i", path]);
    }
    let result = command
        .args(["-filter_complex", &filters.join(";"), "-map", "[outv]"])
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-movflags",
            "+faststart",
        ])
        .arg(output)
        .output()
        .map_err(|error| format!("씬 합본 FFmpeg 실행 실패: {error}"))?;
    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).to_string());
    }
    Ok(output_path)
}

fn export_frame_as_png(executable: &str, source: &str, target: &Path) -> Result<(), String> {
    if Path::new(source)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
    {
        fs::copy(source, target).map_err(|error| format!("PNG 이미지 복사 실패: {error}"))?;
        return Ok(());
    }
    let output = std::process::Command::new(executable)
        .args([
            "-y",
            "-i",
            source,
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-update",
            "1",
        ])
        .arg(target)
        .output()
        .map_err(|error| format!("이미지 변환 실패: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

fn parse_rate(value: &str) -> f64 {
    let mut parts = value.split('/');
    let numerator = parts
        .next()
        .and_then(|part| part.parse::<f64>().ok())
        .unwrap_or(0.0);
    let denominator = parts
        .next()
        .and_then(|part| part.parse::<f64>().ok())
        .unwrap_or(1.0);
    if denominator == 0.0 {
        0.0
    } else {
        numerator / denominator
    }
}

#[tauri::command]
fn import_cut_video(
    executable: String,
    source_path: String,
    project_path: String,
    file_prefix: String,
) -> Result<Value, String> {
    let executable = resolve_ffmpeg_executable(&executable);
    let source = Path::new(&source_path);
    if !source.is_file() {
        return Err("업로드할 영상 파일을 찾을 수 없습니다.".into());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "mp4" | "mov" | "mkv" | "webm" | "m4v" | "avi"
    ) {
        return Err("MP4, MOV, MKV, WEBM, M4V 또는 AVI 영상만 업로드할 수 있습니다.".into());
    }
    let folder = Path::new(&project_path).join("videos").join("imported");
    fs::create_dir_all(&folder).map_err(|error| format!("업로드 영상 폴더 생성 실패: {error}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let target = folder.join(format!("{file_prefix}-upload-{stamp}.{extension}"));
    fs::copy(source, &target).map_err(|error| format!("영상 파일 복사 실패: {error}"))?;

    let probe =
        std::process::Command::new(ffprobe_executable(executable.to_string_lossy().as_ref()))
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height,avg_frame_rate,nb_frames,duration:format=duration",
                "-of",
                "json",
                target.to_string_lossy().as_ref(),
            ])
            .output()
            .map_err(|error| format!("업로드 영상 정보 확인 실패: {error}"))?;
    let metadata: Value = if probe.status.success() {
        serde_json::from_slice(&probe.stdout).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    let stream = metadata
        .pointer("/streams/0")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let width = stream.get("width").and_then(Value::as_u64).unwrap_or(0);
    let height = stream.get("height").and_then(Value::as_u64).unwrap_or(0);
    let fps = stream
        .get("avg_frame_rate")
        .and_then(Value::as_str)
        .map(parse_rate)
        .unwrap_or(0.0);
    let duration = stream
        .get("duration")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<f64>().ok())
        .or_else(|| {
            metadata
                .pointer("/format/duration")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<f64>().ok())
        })
        .unwrap_or(0.0);
    let frames = stream
        .get("nb_frames")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or_else(|| (duration * fps).round().max(0.0) as u64);
    Ok(serde_json::json!({
        "path": target.to_string_lossy(),
        "width": width,
        "height": height,
        "fps": fps,
        "duration": duration,
        "frames": frames,
        "originalName": source.file_name().and_then(|value| value.to_str()).unwrap_or("video")
    }))
}

#[tauri::command]
fn import_cut_reference_image(
    source_path: String,
    project_path: String,
    file_prefix: String,
) -> Result<Value, String> {
    let source = Path::new(&source_path);
    if !source.is_file() {
        return Err("레퍼런스 이미지 파일을 찾을 수 없습니다.".into());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "tif" | "tiff"
    ) {
        return Err("PNG, JPG, WEBP, BMP 또는 TIFF 이미지만 사용할 수 있습니다.".into());
    }
    let folder = Path::new(&project_path).join("references").join("images");
    fs::create_dir_all(&folder)
        .map_err(|error| format!("레퍼런스 이미지 폴더 생성 실패: {error}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let target = folder.join(format!("{file_prefix}-reference-{stamp}.{extension}"));
    fs::copy(source, &target).map_err(|error| format!("레퍼런스 이미지 복사 실패: {error}"))?;
    Ok(serde_json::json!({
        "path": target.to_string_lossy(),
        "originalName": source.file_name().and_then(|value| value.to_str()).unwrap_or("reference")
    }))
}

#[tauri::command]
fn import_cut_reference_audio(
    source_path: String,
    project_path: String,
    file_prefix: String,
) -> Result<Value, String> {
    let source = Path::new(&source_path);
    if !source.is_file() {
        return Err("레퍼런스 오디오 파일을 찾을 수 없습니다.".into());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "wav" | "mp3" | "flac" | "m4a" | "aac" | "ogg"
    ) {
        return Err("WAV, MP3, FLAC, M4A, AAC 또는 OGG 오디오만 사용할 수 있습니다.".into());
    }
    let folder = Path::new(&project_path).join("references").join("audio");
    fs::create_dir_all(&folder)
        .map_err(|error| format!("레퍼런스 오디오 폴더 생성 실패: {error}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let target = folder.join(format!("{file_prefix}-reference-{stamp}.{extension}"));
    fs::copy(source, &target).map_err(|error| format!("레퍼런스 오디오 복사 실패: {error}"))?;
    Ok(serde_json::json!({
        "path": target.to_string_lossy(),
        "originalName": source.file_name().and_then(|value| value.to_str()).unwrap_or("reference-audio")
    }))
}

fn safe_export_component(value: &str, fallback: &str) -> String {
    let cleaned = value
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            value if value.is_control() => '_',
            value => value,
        })
        .collect::<String>()
        .trim_matches([' ', '.'])
        .to_owned();
    if cleaned.is_empty() {
        fallback.to_owned()
    } else {
        cleaned
    }
}

fn copy_if_changed(source: &Path, target: &Path) -> Result<bool, String> {
    if !source.is_file() {
        return Err(format!(
            "원본 영상 파일을 찾을 수 없습니다: {}",
            source.display()
        ));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("내보내기 폴더 생성 실패: {error}"))?;
    }
    let source_meta = source.metadata().map_err(|error| error.to_string())?;
    let unchanged = target.metadata().ok().is_some_and(|target_meta| {
        target_meta.len() == source_meta.len()
            && target_meta.modified().ok() >= source_meta.modified().ok()
    });
    if unchanged {
        return Ok(false);
    }
    fs::copy(source, target).map_err(|error| format!("영상 복사 실패: {error}"))?;
    Ok(true)
}

#[tauri::command]
fn save_video_as(source_path: String, target_path: String) -> Result<String, String> {
    let source = Path::new(&source_path);
    let target = Path::new(&target_path);
    if source == target {
        return Ok(target_path);
    }
    copy_if_changed(source, target)?;
    Ok(target_path)
}

#[tauri::command]
fn open_media_folder(path: String) -> Result<(), String> {
    let source = Path::new(&path);
    if !source.exists() {
        return Err(format!(
            "미디어 파일을 찾지 못했습니다: {}",
            source.display()
        ));
    }

    #[cfg(target_os = "windows")]
    {
        let shell_path = windows_shell_path(source);
        let folder = if source.is_file() {
            source.parent().unwrap_or(source)
        } else {
            source
        };
        let mut command = Command::new("explorer.exe");
        if source.is_file() {
            command.arg("/select,").arg(&shell_path);
        } else {
            command.arg(&shell_path);
        }
        command
            .spawn()
            .map_err(|error| format!("탐색기에서 파일 위치 열기 실패: {error}"))?;
        focus_explorer_folder(folder);
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if source.is_file() {
            command.arg("-R");
        }
        command
            .arg(source)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Finder에서 파일 위치 열기 실패: {error}"))
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let target = if source.is_dir() {
            source
        } else {
            source
                .parent()
                .ok_or_else(|| "미디어 폴더를 찾지 못했습니다.".to_string())?
        };
        open::that(target).map_err(|error| format!("미디어 폴더 열기 실패: {error}"))
    }
}

#[cfg(target_os = "windows")]
fn focus_explorer_folder(folder: &Path) {
    use std::os::windows::process::CommandExt;

    // Explorer commonly reuses an existing process, so the PID returned by
    // explorer.exe is not a reliable window handle. Resolve the window by its
    // actual folder path through Shell.Application, restore it, then bring it
    // to the foreground after /select has finished navigating.
    const SCRIPT: &str = r#"
$target = [IO.Path]::GetFullPath($env:FRAMEFLOW_EXPLORER_FOLDER).TrimEnd('\')
$shell = New-Object -ComObject Shell.Application
$window = $null
for ($attempt = 0; $attempt -lt 12 -and $null -eq $window; $attempt++) {
  Start-Sleep -Milliseconds 150
  $window = @($shell.Windows()) | Where-Object {
    try {
      $candidate = [Uri]::UnescapeDataString(([Uri]$_.LocationURL).LocalPath).TrimEnd('\')
      [StringComparer]::OrdinalIgnoreCase.Equals($candidate, $target)
    } catch { $false }
  } | Select-Object -Last 1
}
if ($null -ne $window) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FrameFlowExplorerFocus {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
}
'@
  $handle = [IntPtr]::new([Int64]$window.HWND)
  [FrameFlowExplorerFocus]::ShowWindowAsync($handle, 9) | Out-Null
  [FrameFlowExplorerFocus]::BringWindowToTop($handle) | Out-Null
  [FrameFlowExplorerFocus]::SetForegroundWindow($handle) | Out-Null
  [FrameFlowExplorerFocus]::SwitchToThisWindow($handle, $true)
}
"#;

    let _ = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            SCRIPT,
        ])
        .env("FRAMEFLOW_EXPLORER_FOLDER", windows_shell_path(folder))
        .creation_flags(0x08000000)
        .spawn();
}

#[cfg(target_os = "windows")]
fn windows_shell_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    if let Some(local) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(local);
    }
    path.to_path_buf()
}

fn csv_cell(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[tauri::command]
fn export_scene_package(
    executable: String,
    project_path: String,
    scene_number: u32,
    scene_title: String,
    selected_results: Vec<Value>,
    alternate_results: Vec<Value>,
    include_alternates: bool,
    create_preview: bool,
) -> Result<Value, String> {
    if selected_results.is_empty() {
        return Err("씬에 내보낼 대표 영상이 없습니다.".into());
    }
    let scene_code = format!("S{:02}", scene_number);
    let export_name = format!(
        "{}_{}",
        scene_code,
        safe_export_component(&scene_title, "scene")
    );
    let root = Path::new(&project_path).join("exports").join(export_name);
    let media_dir = root.join("media");
    let alternates_dir = root.join("alternates");
    fs::create_dir_all(&media_dir).map_err(|error| error.to_string())?;

    let mut manifest_entries = Vec::new();
    let mut preview_sources = Vec::new();
    let mut changed_files = 0_u64;
    for result in &selected_results {
        let cut = result.get("cut").and_then(Value::as_u64).unwrap_or(0) as u32;
        if cut == 0 {
            return Err("대표 영상의 컷 번호가 없습니다.".into());
        }
        let source_value = result.get("path").and_then(Value::as_str).unwrap_or("");
        if source_value.is_empty() {
            return Err(format!(
                "{}-C{:03} 대표 영상의 로컬 파일 경로가 없습니다.",
                scene_code, cut
            ));
        }
        let source = Path::new(source_value);
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("mp4");
        let filename = format!("{}-C{:03}.{}", scene_code, cut, extension);
        let target = media_dir.join(&filename);
        changed_files += u64::from(copy_if_changed(source, &target)?);
        preview_sources.push(target.to_string_lossy().to_string());
        let mut entry = result.clone();
        entry["exportedFile"] = Value::String(format!("media/{filename}"));
        manifest_entries.push(entry);
    }

    let mut alternate_entries = Vec::new();
    if include_alternates {
        for (index, result) in alternate_results.iter().enumerate() {
            let cut = result.get("cut").and_then(Value::as_u64).unwrap_or(0) as u32;
            let source_value = result.get("path").and_then(Value::as_str).unwrap_or("");
            if cut == 0 || source_value.is_empty() || !Path::new(source_value).is_file() {
                continue;
            }
            let source = Path::new(source_value);
            let extension = source
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("mp4");
            let filename = format!("alternative-{:03}.{}", index + 1, extension);
            let target = alternates_dir.join(format!("C{:03}", cut)).join(&filename);
            changed_files += u64::from(copy_if_changed(source, &target)?);
            let mut entry = result.clone();
            entry["exportedFile"] = Value::String(format!("alternates/C{:03}/{filename}", cut));
            alternate_entries.push(entry);
        }
    }

    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "scene": {"number": scene_number, "code": scene_code, "title": scene_title},
        "selected": manifest_entries,
        "alternates": alternate_entries,
        "generatedAtUnixMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
    });
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    fs::write(
        root.join(format!("{}-manifest.json", scene_code)),
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("JSON manifest 저장 실패: {error}"))?;

    let mut csv = String::from(
        "order,cut,title,source_type,source_path,exported_file,resolution,duration_seconds,fps\r\n",
    );
    for (index, entry) in manifest_entries.iter().enumerate() {
        let text = |name: &str| entry.get(name).and_then(Value::as_str).unwrap_or("");
        let number = |name: &str| entry.get(name).and_then(Value::as_f64).unwrap_or(0.0);
        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{:.3},{:.3}\r\n",
            index + 1,
            entry.get("cut").and_then(Value::as_u64).unwrap_or(0),
            csv_cell(text("title")),
            csv_cell(text("sourceType")),
            csv_cell(text("path")),
            csv_cell(text("exportedFile")),
            csv_cell(text("resolution")),
            number("duration"),
            number("fps")
        ));
    }
    fs::write(root.join(format!("{}-manifest.csv", scene_code)), csv)
        .map_err(|error| format!("CSV manifest 저장 실패: {error}"))?;

    let preview = if create_preview {
        let target = root.join(format!("{}-preview.mp4", scene_code));
        let fps = selected_results
            .first()
            .and_then(|item| item.get("fps"))
            .and_then(Value::as_u64)
            .unwrap_or(24) as u32;
        Some(build_scene_video(
            executable,
            preview_sources,
            target.to_string_lossy().to_string(),
            fps.max(1),
            Some(true),
        )?)
    } else {
        None
    };

    Ok(serde_json::json!({
        "path": root.to_string_lossy(),
        "selectedCount": manifest_entries.len(),
        "alternateCount": alternate_entries.len(),
        "changedFiles": changed_files,
        "preview": preview
    }))
}

#[tauri::command]
fn prepare_cut_image_folder(
    executable: String,
    project_path: String,
    first_image_path: Option<String>,
    last_image_path: Option<String>,
) -> Result<String, String> {
    let executable = resolve_ffmpeg_executable(&executable);
    if first_image_path.as_deref().is_none_or(str::is_empty)
        && last_image_path.as_deref().is_none_or(str::is_empty)
    {
        return Err("내보낼 FIRST/LAST 이미지가 없습니다.".into());
    }
    let temp = Path::new(&project_path).join("temp");
    fs::create_dir_all(&temp).map_err(|error| format!("프로젝트 temp 폴더 생성 실패: {error}"))?;
    for name in ["first.png", "last.png"] {
        let target = temp.join(name);
        if target.exists() {
            fs::remove_file(&target)
                .map_err(|error| format!("기존 임시 이미지 삭제 실패: {error}"))?;
        }
    }
    if let Some(first) = first_image_path.filter(|value| !value.trim().is_empty()) {
        export_frame_as_png(
            executable.to_string_lossy().as_ref(),
            &first,
            &temp.join("first.png"),
        )?;
    }
    if let Some(last) = last_image_path.filter(|value| !value.trim().is_empty()) {
        export_frame_as_png(
            executable.to_string_lossy().as_ref(),
            &last,
            &temp.join("last.png"),
        )?;
    }
    open::that(&temp).map_err(|error| format!("temp 폴더 열기 실패: {error}"))?;
    temp.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "temp 폴더 경로를 읽지 못했습니다.".into())
}

#[tauri::command]
async fn download_media(url: String, target_path: String) -> Result<String, String> {
    let response = reqwest::get(url)
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let target = Path::new(&target_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(target, bytes).map_err(|e| e.to_string())?;
    Ok(target_path)
}

fn safe_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    cleaned.trim().trim_matches('.').to_string()
}

#[tauri::command]
fn create_project_structure(base_folder: String, project_name: String) -> Result<String, String> {
    let name = safe_name(&project_name);
    if name.is_empty() {
        return Err("프로젝트 이름이 올바르지 않습니다.".into());
    }
    let root = Path::new(&base_folder).join(name);
    for child in [
        "flf",
        "meta",
        "videos/test",
        "videos/final",
        "scenes",
        "exports",
    ] {
        fs::create_dir_all(root.join(child)).map_err(|e| e.to_string())?;
    }
    root.canonicalize()
        .unwrap_or(root)
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "저장 경로를 읽을 수 없습니다.".into())
}

#[tauri::command]
fn store_flf_image(
    source_path: String,
    project_path: String,
    scene_number: u32,
    frame_kind: u8,
) -> Result<String, String> {
    if frame_kind > 1 {
        return Err("프레임 종류는 First(0) 또는 Last(1)만 가능합니다.".into());
    }
    let source = Path::new(&source_path);
    let original = source
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| "원본 파일명을 읽을 수 없습니다.".to_string())?;
    let target_name = format!("{scene_number:04}-{frame_kind}-{original}");
    let target = Path::new(&project_path).join("flf").join(target_name);
    fs::create_dir_all(
        target
            .parent()
            .ok_or_else(|| "FLF 폴더 경로가 올바르지 않습니다.".to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::copy(source, &target).map_err(|e| e.to_string())?;
    target
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "저장된 FLF 경로를 읽을 수 없습니다.".into())
}

#[tauri::command]
fn store_flf_bytes(
    data: Vec<u8>,
    original_name: String,
    project_path: String,
    scene_number: u32,
    frame_kind: u8,
) -> Result<String, String> {
    if frame_kind > 1 {
        return Err("프레임 종류는 First(0) 또는 Last(1)만 가능합니다.".into());
    }
    let original = Path::new(&original_name)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "원본 파일명을 읽을 수 없습니다.".to_string())?;
    let extension = Path::new(original)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"].contains(&extension.as_str()) {
        return Err("PNG, JPG, WEBP, BMP 또는 TIFF 이미지만 사용할 수 있습니다.".into());
    }
    let target_name = format!("{scene_number:04}-{frame_kind}-{original}");
    let target = Path::new(&project_path).join("flf").join(target_name);
    fs::create_dir_all(
        target
            .parent()
            .ok_or_else(|| "FLF 폴더 경로가 올바르지 않습니다.".to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::write(&target, data).map_err(|error| error.to_string())?;
    target
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "저장된 FLF 경로를 읽을 수 없습니다.".into())
}

#[tauri::command]
fn store_meta_image(
    data: Vec<u8>,
    project_path: String,
    scene_number: u32,
) -> Result<String, String> {
    let target = Path::new(&project_path)
        .join("meta")
        .join(format!("{scene_number:04}-flf-combined.png"));
    fs::create_dir_all(
        target
            .parent()
            .ok_or_else(|| "메타 이미지 폴더 경로가 올바르지 않습니다.".to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::write(&target, data).map_err(|error| error.to_string())?;
    target
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "저장된 메타 이미지 경로를 읽을 수 없습니다.".into())
}

#[tauri::command]
fn load_image_data_url(path: String) -> Result<String, String> {
    let image_path = Path::new(&path);
    let extension = image_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        _ => return Err("지원하지 않는 이미지 형식입니다.".into()),
    };
    let bytes =
        fs::read(image_path).map_err(|error| format!("이미지 파일을 읽지 못했습니다: {error}"))?;
    if bytes.len() > 100 * 1024 * 1024 {
        return Err("100MB 이하 이미지만 미리 볼 수 있습니다.".into());
    }
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
fn ensure_image_thumbnail(source_path: String, project_path: String) -> Result<Value, String> {
    const MAX_PIXELS: f64 = 500_000.0;
    let source = Path::new(&source_path);
    if !source.is_file() {
        return Err(format!("이미지 파일을 찾을 수 없습니다: {source_path}"));
    }
    let metadata = source.metadata().map_err(|e| e.to_string())?;
    let modified = metadata
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let stem = source
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("frame")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    let cache_dir = Path::new(&project_path).join("cache").join("thumbnails");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let target = cache_dir.join(format!("{stem}-{modified}.jpg"));
    let image = image::open(source).map_err(|e| format!("썸네일 원본을 읽지 못했습니다: {e}"))?;
    let (source_width, source_height) = image.dimensions();
    if !target.is_file() {
        let pixels = source_width as f64 * source_height as f64;
        let scale = if pixels > MAX_PIXELS {
            (MAX_PIXELS / pixels).sqrt()
        } else {
            1.0
        };
        let width = ((source_width as f64 * scale).round() as u32).max(1);
        let height = ((source_height as f64 * scale).round() as u32).max(1);
        let preview = image
            .resize_exact(width, height, FilterType::Triangle)
            .to_rgb8();
        let file = fs::File::create(&target).map_err(|e| e.to_string())?;
        JpegEncoder::new_with_quality(file, 84)
            .encode_image(&preview)
            .map_err(|e| format!("썸네일 저장 실패: {e}"))?;
    }
    let preview = image::open(&target).map_err(|e| e.to_string())?;
    let (width, height) = preview.dimensions();
    Ok(serde_json::json!({
        "path": target.to_string_lossy(), "width": width, "height": height,
        "sourceWidth": source_width, "sourceHeight": source_height,
        "pixels": width as u64 * height as u64
    }))
}

#[tauri::command]
fn create_scene_structure(project_path: String, scene_number: u32) -> Result<String, String> {
    let scene_dir: PathBuf = Path::new(&project_path)
        .join("scenes")
        .join(format!("scene-{scene_number:02}"));
    for child in ["videos/test", "videos/final"] {
        fs::create_dir_all(scene_dir.join(child)).map_err(|e| e.to_string())?;
    }
    scene_dir
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "씬 저장 경로를 읽을 수 없습니다.".into())
}

#[tauri::command]
fn renumber_media_files(project_path: String, mappings: Vec<Value>) -> Result<Value, String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err("프로젝트 폴더를 찾을 수 없습니다.".into());
    }
    let pairs: Vec<(String, String)> = mappings
        .iter()
        .filter_map(|item| {
            Some((
                item.get("oldPrefix")?.as_str()?.to_owned(),
                item.get("newPrefix")?.as_str()?.to_owned(),
            ))
        })
        .filter(|(old, new)| old != new && !old.is_empty() && !new.is_empty())
        .collect();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let mut pending: Vec<(PathBuf, PathBuf, PathBuf)> = Vec::new();
    for relative in [
        "flf",
        "meta",
        "meta/previews",
        "meta/sheets",
        "videos/test",
        "videos/final",
    ] {
        let directory = root.join(relative);
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let source = entry.path();
            if !source.is_file() {
                continue;
            }
            let Some(name) = source.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let Some((old_prefix, new_prefix)) = pairs
                .iter()
                .find(|(old, _)| name.starts_with(&format!("{old}-")))
            else {
                continue;
            };
            let final_name = format!("{new_prefix}{}", &name[old_prefix.len()..]);
            let final_path = directory.join(final_name);
            let temporary =
                directory.join(format!(".frameflow-renumber-{stamp}-{}", pending.len()));
            pending.push((source, temporary, final_path));
        }
    }
    for (source, temporary, _) in &pending {
        fs::rename(source, temporary).map_err(|error| format!("임시 파일명 변경 실패: {error}"))?;
    }
    let mut changed = serde_json::Map::new();
    for (source, temporary, target) in pending {
        fs::rename(&temporary, &target)
            .map_err(|error| format!("최종 파일명 변경 실패: {error}"))?;
        changed.insert(
            source.to_string_lossy().to_string(),
            Value::String(target.to_string_lossy().to_string()),
        );
    }
    Ok(Value::Object(changed))
}

#[cfg(test)]
mod media_tests {
    use super::*;

    #[test]
    fn deletes_only_a_matching_frameflow_project_directory() {
        let root = std::env::temp_dir().join(format!(
            "frameflow-project-delete-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let project = root.join("Projects").join("Safe Project");
        fs::create_dir_all(project.join("scenes")).unwrap();
        fs::write(
            project.join("project.frameflow.json"),
            r#"{"id":"safe-project","name":"Safe Project"}"#,
        )
        .unwrap();
        fs::write(project.join("scenes").join("clip.mp4"), b"video").unwrap();

        delete_project_directory(&project, "safe-project").unwrap();

        assert!(!project.exists());
        assert!(root.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_to_delete_a_project_directory_with_a_different_id() {
        let root = std::env::temp_dir().join(format!(
            "frameflow-project-delete-guard-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let project = root.join("Projects").join("Protected Project");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("project.frameflow.json"),
            r#"{"id":"another-project"}"#,
        )
        .unwrap();

        assert!(delete_project_directory(&project, "target-project").is_err());
        assert!(project.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn explorer_paths_drop_extended_length_prefixes() {
        assert_eq!(
            windows_shell_path(Path::new(r"\\?\C:\Projects\db2")),
            PathBuf::from(r"C:\Projects\db2")
        );
        assert_eq!(
            windows_shell_path(Path::new(r"\\?\UNC\server\share\db2")),
            PathBuf::from(r"\\server\share\db2")
        );
    }

    #[test]
    fn ref2va_preprocessor_accepts_long_videos() {
        assert!(validate_ref2va_duration(0.2).is_ok());
        assert!(validate_ref2va_duration(300.0).is_ok());
        assert!(validate_ref2va_duration(3600.0).is_ok());
        assert!(validate_ref2va_duration(0.199).is_err());
        assert!(validate_ref2va_duration(f64::INFINITY).is_err());
    }

    #[test]
    fn audio_segments_fade_without_overlap_and_keep_total_duration() {
        let root = std::env::temp_dir().join(format!(
            "frameflow-audio-segments-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let ffmpeg = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../release/FrameFlow-Studio/tools/ffmpeg/ffmpeg.exe");
        let first = root.join("one.mp3");
        let second = root.join("two.mp3");
        let output = root.join("joined.mp3");
        for (path, frequency) in [(&first, "440"), (&second, "660")] {
            assert!(Command::new(&ffmpeg)
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    &format!("sine=frequency={frequency}:duration=4"),
                    "-c:a",
                    "libmp3lame"
                ])
                .arg(path)
                .status()
                .unwrap()
                .success());
        }
        assemble_audio_segments(
            ffmpeg.to_string_lossy().into_owned(),
            vec![
                first.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned(),
            ],
            vec![4.0, 4.0],
            1.0,
            output.to_string_lossy().into_owned(),
        )
        .unwrap();
        let probe = Command::new(ffprobe_executable(ffmpeg.to_string_lossy().as_ref()))
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=nokey=1:noprint_wrappers=1",
                output.to_string_lossy().as_ref(),
            ])
            .output()
            .unwrap();
        let duration = String::from_utf8_lossy(&probe.stdout)
            .trim()
            .parse::<f64>()
            .unwrap();
        assert!((duration - 8.0).abs() < 0.1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn thumbnail_cache_never_exceeds_half_megapixel() {
        let root = std::env::temp_dir().join(format!(
            "frameflow-thumb-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("large.png");
        image::RgbImage::new(2000, 1000).save(&source).unwrap();
        let result = ensure_image_thumbnail(
            source.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
        )
        .unwrap();
        assert!(result["pixels"].as_u64().unwrap() <= 500_000);
        assert_eq!(result["sourceWidth"], 2000);
        assert_eq!(result["sourceHeight"], 1000);
        assert!(Path::new(result["path"].as_str().unwrap()).is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extension_sheet_samples_context_frames_1_5_10_and_22() {
        let (total, samples) = extension_context_indices(5.0).unwrap();
        assert_eq!(total, 120);
        assert_eq!(
            samples.iter().map(|item| item.0).collect::<Vec<_>>(),
            vec![1, 5, 10, 22]
        );
        assert_eq!(
            samples.iter().map(|item| item.1).collect::<Vec<_>>(),
            vec![98, 102, 107, 119]
        );
        assert!(extension_context_indices(0.5).is_err());
    }

    #[test]
    fn stores_large_unicode_flf_image_without_loading_it_into_memory() {
        let root = std::env::temp_dir().join(format!(
            "frameflow-large-flf-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let source_dir = root.join("홍천").join("Image").join("upscale");
        let project = root.join("project");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("08.png");
        let file = fs::File::create(&source).unwrap();
        file.set_len(36 * 1024 * 1024).unwrap();
        let stored = store_flf_image(
            source.to_string_lossy().to_string(),
            project.to_string_lossy().to_string(),
            101,
            0,
        )
        .unwrap();
        let stored = Path::new(&stored);
        assert_eq!(stored.file_name().unwrap(), "0101-0-08.png");
        assert_eq!(stored.metadata().unwrap().len(), 36 * 1024 * 1024);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_eight_frame_sheet_without_gif_then_deletes_it_safely() {
        let sample = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("release")
            .join("FrameFlow-Studio")
            .join("verification")
            .join("app-visible-0001-S01-C01-test-17f.mp4");
        assert!(sample.is_file(), "verification video is missing");
        let root = std::env::temp_dir().join(format!(
            "frameflow-video-assets-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let value = generate_video_assets(
            "ffmpeg".into(),
            sample.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
            "0001-S01-C01".into(),
            "result-test".into(),
            17,
        )
        .unwrap();
        let sheet = value["sheetPath"].as_str().unwrap();
        assert!(value.get("gifPath").is_none());
        assert!(Path::new(sheet).metadata().unwrap().len() > 0);
        assert_eq!(value["sheetIntervalFrames"], 8);
        assert_eq!(value["sheetSamples"], 3);
        assert_eq!(
            delete_result_assets(root.to_string_lossy().to_string(), vec![sheet.into()]).unwrap(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn renumbers_swapped_scene_cut_prefixes_without_collision() {
        let root = std::env::temp_dir().join(format!(
            "frameflow-renumber-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let video_dir = root.join("videos/test");
        fs::create_dir_all(&video_dir).unwrap();
        fs::write(video_dir.join("0001-S01-C01-test-a.mp4"), b"a").unwrap();
        fs::write(video_dir.join("0001-S02-C01-test-b.mp4"), b"b").unwrap();
        let changed = renumber_media_files(
            root.to_string_lossy().to_string(),
            vec![
                serde_json::json!({"oldPrefix":"0001-S01-C01","newPrefix":"0001-S02-C01"}),
                serde_json::json!({"oldPrefix":"0001-S02-C01","newPrefix":"0001-S01-C01"}),
            ],
        )
        .unwrap();
        assert_eq!(changed.as_object().unwrap().len(), 2);
        assert_eq!(
            fs::read(video_dir.join("0001-S02-C01-test-a.mp4")).unwrap(),
            b"a"
        );
        assert_eq!(
            fs::read(video_dir.join("0001-S01-C01-test-b.mp4")).unwrap(),
            b"b"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn combines_scene_clips_without_each_intermediate_last_frame() {
        let verification = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("release")
            .join("FrameFlow-Studio")
            .join("verification");
        let first = verification.join("app-visible-0001-S01-C01-test-17f.mp4");
        let last = verification.join("app-visible-0001-S01-C02-test-17f.mp4");
        assert!(
            first.is_file() && last.is_file(),
            "verification videos are missing"
        );
        let root = std::env::temp_dir().join(format!(
            "frameflow-scene-combine-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let output = root.join("0001-S01-combined.mp4");
        build_scene_video(
            "ffmpeg".into(),
            vec![
                first.to_string_lossy().to_string(),
                last.to_string_lossy().to_string(),
            ],
            output.to_string_lossy().to_string(),
            16,
            Some(true),
        )
        .unwrap();
        assert_eq!(
            video_frame_count("ffmpeg", output.to_str().unwrap()).unwrap(),
            33
        );
        let untrimmed_output = root.join("0001-S01-combined-no-trim.mp4");
        build_scene_video(
            "ffmpeg".into(),
            vec![
                first.to_string_lossy().to_string(),
                last.to_string_lossy().to_string(),
            ],
            untrimmed_output.to_string_lossy().to_string(),
            16,
            Some(false),
        )
        .unwrap();
        assert_eq!(
            video_frame_count("ffmpeg", untrimmed_output.to_str().unwrap()).unwrap(),
            34
        );
        let png = root.join("first.png");
        export_frame_as_png("ffmpeg", first.to_str().unwrap(), &png).unwrap();
        assert!(png.metadata().unwrap().len() > 0);
        let png_copy = root.join("last.png");
        export_frame_as_png("ffmpeg", png.to_str().unwrap(), &png_copy).unwrap();
        assert_eq!(fs::read(&png).unwrap(), fs::read(&png_copy).unwrap());
        let imported = import_cut_video(
            "ffmpeg".into(),
            first.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
            "0001-S01-C01".into(),
        )
        .unwrap();
        assert!(Path::new(imported["path"].as_str().unwrap()).is_file());
        assert_eq!(imported["frames"], 17);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exports_selected_scene_media_without_project_id_and_writes_manifests() {
        let root = std::env::temp_dir().join(format!(
            "frameflow-scene-export-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source-minimax.mp4");
        fs::write(&source, b"representative-video").unwrap();
        let exported = export_scene_package(
            "ffmpeg".into(),
            root.to_string_lossy().to_string(),
            4,
            "빛의 폭포".into(),
            vec![serde_json::json!({
                "cut": 1,
                "title": "폭포 시작",
                "sourceType": "MINIMAX-H3",
                "path": source.to_string_lossy(),
                "resolution": "3936×864",
                "duration": 5.0,
                "fps": 24.0
            })],
            vec![],
            false,
            false,
        )
        .unwrap();
        let export_root = PathBuf::from(exported["path"].as_str().unwrap());
        assert!(export_root.join("media/S04-C001.mp4").is_file());
        assert!(export_root.join("S04-manifest.json").is_file());
        assert!(export_root.join("S04-manifest.csv").is_file());
        assert!(!export_root.join("media/0002-S04-C001.mp4").exists());
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(comfy::ComfyRuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            init_database,
            exit_app,
            list_projects,
            save_project,
            delete_project,
            backup_project_folder,
            import_project_manifest,
            get_app_settings,
            save_app_settings,
            get_restored_comfy_settings,
            check_ffmpeg,
            probe_video,
            enhance::enhance_check_runtime,
            enhance::enhance_probe,
            enhance::enhance_run,
            enhance::enhance_create_batch,
            enhance::enhance_finish_batch,
            enhance::enhance_release_previews,
            enhance::enhance_cancel,
            media_tools::media_tool_probe,
            media_tools::media_tool_run,
            media_tools::media_tool_cancel,
            media_tools::media_tool_delete,
            vta::generate_vta_frame_sheets,
            prepare_video_audio_reference,
            assemble_audio_segments,
            mux_video_with_audio,
            generate_video_assets,
            generate_extension_context_frames,
            delete_result_assets,
            extract_last_frame,
            build_project_video,
            build_scene_video,
            export_scene_package,
            prepare_cut_image_folder,
            import_cut_video,
            import_cut_reference_image,
            import_cut_reference_audio,
            save_video_as,
            open_media_folder,
            download_media,
            create_project_structure,
            create_scene_structure,
            renumber_media_files,
            store_flf_image,
            store_flf_bytes,
            store_meta_image,
            load_image_data_url,
            ensure_image_thumbnail,
            comfy::comfy_check,
            comfy::comfy_export_workflow,
            comfy::comfy_list_environments,
            comfy::comfy_list_models,
            comfy::comfy_copy_model,
            comfy::comfy_backup_environment,
            comfy::comfy_ensure_environment,
            comfy::comfy_cancel_and_stop,
            comfy::comfy_quick_cleanup,
            comfy::comfy_generate_video,
            comfy::comfy_generate_ref2va_video,
            comfy::comfy_generate_tiled_upscale,
            comfy::comfy_generate_reference_audio,
            comfy::comfy_extend_existing_video,
            comfy::comfy_generate_continuous_video,
            comfy::comfy_generate_ref2va_continuous_video,
            comfy::comfy_recover_continuous_video
        ])
        .run(tauri::generate_context!())
        .expect("error while running FrameFlow Studio");
}
