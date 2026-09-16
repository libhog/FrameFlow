use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

static ACTIVE: Mutex<Option<(String, PathBuf)>> = Mutex::new(None);
static PREVIEWS: Mutex<Vec<(String, PathBuf)>> = Mutex::new(Vec::new());
const ADAPTER: &str = include_str!("../../scripts/neural_enhance.py");
const RESHADE_HOST: &[u8] = include_bytes!("../../assets/native/reshade/frameflow-reshade.exe");
const RESHADE_FX: &str = include_str!("../../scripts/FrameFlowColor.fx");

fn selected_runtime(
    root: &str,
    python: &str,
    nr: bool,
    reshade: bool,
    dll: &str,
) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    if !nr && !reshade {
        return Err("처리 방식을 선택해 주세요.".into());
    }
    let (root, python) = if nr {
        runtime(root, python)?
    } else {
        let interpreter = PathBuf::from(python.trim());
        if !interpreter.is_file() {
            return Err("Python 실행 파일(av · numpy 설치)을 지정해 주세요.".into());
        }
        (PathBuf::from(root), interpreter)
    };
    let dll = if dll.trim().is_empty() {
        std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("앱 경로 오류")?
            .join("tools/reshade/ReShade64.dll")
    } else {
        PathBuf::from(dll.trim())
    };
    if reshade && !dll.is_file() {
        return Err("ReShade 6.8.0 Add-on 버전의 ReShade64.dll 경로를 지정해 주세요.".into());
    }
    Ok((root, python, dll))
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn runtime(root: &str, python: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = fs::canonicalize(root.trim()).map_err(|_| "NeuralScreen 폴더를 지정해 주세요.")?;
    for name in [
        "main.py",
        "guides.py",
        "native/nvngx.dll",
        "native/nvngx_dlssnr.dll",
    ] {
        if !root.join(name).is_file() {
            return Err(format!("NeuralScreen 런타임 파일이 없습니다: {name}"));
        }
    }
    let interpreter = if !python.trim().is_empty() {
        PathBuf::from(python.trim())
    } else {
        [
            "python/python.exe",
            "runtime/python.exe",
            "python.exe",
            "python_embeded/python.exe",
            "python_embedded/python.exe",
        ]
        .iter()
        .map(|name| root.join(name))
        .find(|p| p.is_file())
        .ok_or("Python을 찾지 못했습니다. NeuralScreen의 python.exe 경로를 지정해 주세요.")?
    };
    if !interpreter.is_file() {
        return Err("Python 실행 파일을 찾지 못했습니다.".into());
    }
    Ok((root, interpreter))
}

#[tauri::command]
pub async fn enhance_check_runtime(
    runtime_dir: String,
    python_path: String,
    nr_enabled: Option<bool>,
    reshade_enabled: Option<bool>,
    reshade_path: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, python, dll) = selected_runtime(&runtime_dir, &python_path,nr_enabled.unwrap_or(true),reshade_enabled.unwrap_or(false),reshade_path.as_deref().unwrap_or(""))?;
        // File validation only. No unrequested GPU execution or runtime installation.
        Ok(json!({"pythonPath":python,"runtimeDir":root,"reshadePath":dll,"message":"필수 파일 확인 완료 · GPU 실행은 비교하기에서 확인합니다."}))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn enhance_probe(source_path: String, executable: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = Path::new(&source_path);
        let extension = source.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
        if ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"].contains(&extension.as_str()) {
            let (width,height) = image::image_dimensions(source).map_err(|e| e.to_string())?;
            return Ok(json!({"path":source_path,"filename":source.file_name().unwrap_or_default().to_string_lossy(),"width":width,"height":height,"kind":"image"}));
        }
        if !["mp4", "mov", "mkv", "webm", "avi"].contains(&extension.as_str()) { return Err("지원하지 않는 파일 형식입니다.".into()); }
        let mut info = super::probe_video(executable, source_path)?;
        info["kind"] = json!("video");
        Ok(info)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn enhance_cancel(job_id: String) -> Result<(), String> {
    let active = ACTIVE.lock().map_err(|e| e.to_string())?;
    if let Some((id, folder)) = active.as_ref() {
        if id == &job_id {
            fs::write(folder.join("cancel"), b"cancel").map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

struct ActiveGuard;
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.lock() {
            *active = None;
        }
    }
}

// Only folders created by this invocation can be removed; never user output roots.
struct ScratchGuard {
    folder: PathBuf,
    parent: PathBuf,
    retain: bool,
}
impl Drop for ScratchGuard {
    fn drop(&mut self) {
        if !self.retain {
            if let (Ok(folder), Ok(parent)) = (
                fs::canonicalize(&self.folder),
                fs::canonicalize(&self.parent),
            ) {
                if folder.parent() == Some(parent.as_path())
                    && folder
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .starts_with("enhance-")
                {
                    let _ = fs::remove_dir_all(&folder);
                    if parent.file_name().unwrap_or_default() == ".work" {
                        let _ = fs::remove_dir(&parent);
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn enhance_release_previews(tokens: Vec<String>) -> Result<(), String> {
    let mut previews = PREVIEWS.lock().map_err(|e| e.to_string())?;
    for token in tokens {
        if let Some(index) = previews.iter().position(|(id, _)| id == &token) {
            let (_, folder) = previews.remove(index);
            let parent = folder.parent().ok_or("임시 폴더 경로 오류")?.to_path_buf();
            drop(ScratchGuard {
                folder,
                parent,
                retain: false,
            });
        }
    }
    Ok(())
}

#[tauri::command]
pub fn enhance_finish_batch(folder: String, output_dir: String) -> Result<(), String> {
    let root = validate_batch(&folder, &output_dir)?;
    fs::remove_file(root.join(".frameflow-enhance-batch.json")).map_err(|e| e.to_string())?;
    // remove_dir never removes files: completed outputs are always preserved.
    let _ = fs::remove_dir(root.join(".work"));
    let _ = fs::remove_dir(root);
    Ok(())
}

#[tauri::command]
pub fn enhance_create_batch(output_dir: String) -> Result<Value, String> {
    if output_dir.trim().is_empty() {
        return Err("저장 폴더를 지정해 주세요.".into());
    }
    let base = PathBuf::from(output_dir);
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let folder = base.join(format!("enhance-{stamp}"));
    fs::create_dir(&folder).map_err(|e| e.to_string())?;
    fs::write(
        folder.join(".frameflow-enhance-batch.json"),
        b"{\"version\":1,\"type\":\"frameflow-enhance-batch\"}",
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({"path":folder}))
}

fn validate_batch(folder: &str, output_dir: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(folder).map_err(|e| e.to_string())?;
    let base = fs::canonicalize(output_dir).map_err(|e| e.to_string())?;
    let marker: Value = serde_json::from_slice(
        &fs::read(root.join(".frameflow-enhance-batch.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if root.parent() != Some(base.as_path()) || marker["type"] != "frameflow-enhance-batch" {
        return Err("현재 실행의 결과 폴더가 아닙니다.".into());
    }
    Ok(root)
}

fn publish_result(
    source: &Path,
    batch: &Path,
    original: &Path,
    job_id: &str,
) -> Result<PathBuf, String> {
    let stem: String = original
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(70)
        .collect();
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
    let target = batch.join(format!("{job_id}-{stem}-enhanced.{ext}"));
    // .work is inside the batch folder: NTFS hard links avoid duplicating large
    // videos. Other filesystems fall back to an exclusive copy.
    if fs::hard_link(source, &target).is_ok() {
        return Ok(target);
    }
    // create_new prevents same-name inputs or concurrent runs overwriting a result.
    let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| e.to_string())?;
    let copied = std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all());
    if let Err(error) = copied {
        drop(output);
        let _ = fs::remove_file(&target);
        return Err(error.to_string());
    }
    Ok(target)
}

#[tauri::command]
pub async fn enhance_run(
    app: AppHandle,
    job_id: String,
    runtime_dir: String,
    python_path: String,
    source_path: String,
    output_dir: String,
    profile: String,
    preview: bool,
    executable: String,
    batch_folder: Option<String>,
    custom_settings: Option<Value>,
    nr_enabled: Option<bool>,
    reshade_enabled: Option<bool>,
    reshade_path: Option<String>,
    reshade_settings: Option<Value>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if job_id.is_empty() || job_id.len()>80 || !job_id.chars().all(|c| c.is_ascii_alphanumeric() || c=='-') {
            return Err("잘못된 작업 ID입니다.".into());
        }
        if !["Faithful", "Natural", "Strong / Cinematic", "Custom"].contains(&profile.as_str()) { return Err("지원하지 않는 보정 프로필입니다.".into()); }
        let nr=nr_enabled.unwrap_or(true);let reshade=reshade_enabled.unwrap_or(false);
        let (root, python,dll) = selected_runtime(&runtime_dir,&python_path,nr,reshade,reshade_path.as_deref().unwrap_or(""))?;
        let source = fs::canonicalize(&source_path).map_err(|_| "입력 파일을 찾지 못했습니다.")?;
        if !source.is_file() { return Err("이미지 또는 영상 파일을 선택해 주세요.".into()); }
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
        let batch = if !preview { batch_folder.as_deref().map(|folder| validate_batch(folder, &output_dir)).transpose()? } else { None };
        let base = if let Some(batch) = &batch { batch.join(".work") }
            else if preview { app.path().app_cache_dir().map_err(|e| e.to_string())?.join("enhance-previews") }
            else { if output_dir.trim().is_empty() {return Err("저장 폴더를 지정해 주세요.".into());} PathBuf::from(&output_dir) };
        let folder = base.join(format!("enhance-{stamp}"));
        {
            let mut active = ACTIVE.lock().map_err(|e| e.to_string())?;
            if active.is_some() { return Err("이미지/영상 개선 작업이 이미 실행 중입니다.".into()); }
            fs::create_dir_all(&base).map_err(|e| e.to_string())?;
            fs::create_dir(&folder).map_err(|e| e.to_string())?;
            *active = Some((job_id.clone(), folder.clone()));
        }
        let _guard = ActiveGuard;
        let mut scratch=ScratchGuard{folder:folder.clone(),parent:base.clone(),retain:false};
        let script = folder.join("frameflow_adapter.py");
        let request = folder.join("request.json");
        fs::write(&script, ADAPTER).map_err(|e| e.to_string())?;
        if reshade {
            fs::write(folder.join("frameflow-reshade.exe"),RESHADE_HOST).map_err(|e|e.to_string())?;
            fs::write(folder.join("FrameFlowColor.fx"),RESHADE_FX).map_err(|e|e.to_string())?;
        }
        fs::write(&request, serde_json::to_vec(&json!({"runtimeDir":root,"sourcePath":source,"outputDir":folder,
            "profile":profile,"nrEnabled":nr,"reshadeEnabled":reshade,"reshadePath":dll,"reshadeSettings":reshade_settings,"customSettings":custom_settings,"preview":preview,"parentPid":std::process::id(),
            "ffmpeg":super::resolve_ffmpeg_executable(&executable)})).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let log = fs::File::create(folder.join("adapter.log")).map_err(|e| e.to_string())?;
        let mut child = hidden(Command::new(&python).arg("-u").arg(&script).arg(&request)
            .env("PYTHONIOENCODING", "utf-8").env("PYTHONDONTWRITEBYTECODE","1").stdout(Stdio::piped()).stderr(Stdio::from(log)))
            .spawn().map_err(|e| format!("NeuralScreen 어댑터 실행 실패: {e}"))?;
        let reader = BufReader::new(child.stdout.take().ok_or("처리 응답을 읽을 수 없습니다.")?);
        let mut complete = None;
        let mut error = None;
        for line in reader.lines() {
            let Ok(line) = line else { break; };
            if let Ok(mut event) = serde_json::from_str::<Value>(&line) {
                event["jobId"] = json!(&job_id);
                if event["type"] != "complete" { let _ = app.emit("frameflow-enhance-progress", &event); }
                if event["type"] == "complete" { complete = Some(event.clone()); }
                if event["type"] == "error" { error = event["message"].as_str().map(str::to_string); }
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        let log_text=fs::read_to_string(folder.join("adapter.log")).unwrap_or_default();
        let tail=log_text.chars().rev().take(2000).collect::<String>().chars().rev().collect::<String>();
        if let Some(error) = error { return Err(error); }
        if !status.success() { return Err(format!("개선 처리 실패. Python 패키지(av, numpy, cv2)와 런타임을 확인하세요.\n{tail}")); }
        let mut complete = complete.ok_or_else(|| format!("결과 파일을 확인하지 못했습니다.\n{tail}"))?;
        if let Some(batch) = batch {
            let path = complete["path"].as_str().ok_or("결과 경로가 없습니다.")?;
            let published = publish_result(Path::new(path), &batch, &source, &job_id)?;
            complete["path"] = json!(published);
            complete["batchFolder"] = json!(batch);
            complete["beforePath"]=json!(source);
        } else if preview {
            PREVIEWS.lock().map_err(|e|e.to_string())?.push((job_id.clone(),folder.clone()));
            complete["previewToken"]=json!(job_id);
            scratch.retain=true;
        } else {
            scratch.retain=true;
        }
        Ok(complete)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_missing_runtime() {
        assert!(runtime("Z:/missing-frameflow-runtime", "").is_err());
    }
    #[test]
    fn ignores_cancel_for_unknown_job() {
        assert!(enhance_cancel("unrelated".into()).is_ok());
    }
    #[test]
    fn scratch_and_preview_cleanup_preserves_outputs() {
        let base = std::env::temp_dir().join(format!(
            "frameflow-cleanup-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let batch = enhance_create_batch(base.to_string_lossy().into()).unwrap();
        let root = PathBuf::from(batch["path"].as_str().unwrap());
        let parent = root.join(".work");
        let folder = parent.join("enhance-owned");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("partial.mp4"), b"partial").unwrap();
        fs::write(root.join("final.mp4"), b"final").unwrap();
        drop(ScratchGuard {
            folder: folder.clone(),
            parent: parent.clone(),
            retain: false,
        });
        assert!(!folder.exists());
        assert!(!parent.exists());
        assert!(root.join("final.mp4").exists());
        enhance_finish_batch(root.to_string_lossy().into(), base.to_string_lossy().into()).unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        let preview = base.join("enhance-preview-owned");
        fs::create_dir(&preview).unwrap();
        fs::write(preview.join("preview.png"), b"preview").unwrap();
        PREVIEWS
            .lock()
            .unwrap()
            .push(("cleanup-test".into(), preview.clone()));
        enhance_release_previews(vec!["unknown".into(), "cleanup-test".into()]).unwrap();
        assert!(!preview.exists());
        assert!(root.join("final.mp4").exists());
        fs::remove_dir_all(&base).unwrap();
    }
    #[test]
    fn batch_results_share_folder_without_overwrites() {
        let base = std::env::temp_dir().join(format!(
            "frameflow-enhance-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let batch = enhance_create_batch(base.to_string_lossy().into()).unwrap();
        let root = PathBuf::from(batch["path"].as_str().unwrap());
        assert!(validate_batch(root.to_str().unwrap(), base.to_str().unwrap()).is_ok());
        assert!(validate_batch(root.to_str().unwrap(), root.to_str().unwrap()).is_err());
        let work = root.join(".work");
        fs::create_dir(&work).unwrap();
        let generated = work.join("enhanced.mp4");
        fs::write(&generated, b"video-fixture").unwrap();
        let a = publish_result(&generated, &root, Path::new("one/same.mp4"), "job-1").unwrap();
        let b = publish_result(&generated, &root, Path::new("two/same.mp4"), "job-2").unwrap();
        assert_eq!(a.parent(), b.parent());
        assert_ne!(a, b);
        assert_eq!(fs::read(&a).unwrap(), b"video-fixture");
        assert!(publish_result(&generated, &root, Path::new("one/same.mp4"), "job-1").is_err());
        // Only this test's explicitly created temporary fixture tree is removed.
        fs::remove_dir_all(&base).unwrap();
    }
}
