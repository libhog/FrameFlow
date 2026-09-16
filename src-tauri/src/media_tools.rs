use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    collections::VecDeque,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

pub static CANCEL_TOKENS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[tauri::command]
pub fn media_tool_cancel(job_id: String) {
    if let Some(token) = CANCEL_TOKENS.lock().unwrap().get(&job_id) {
        token.store(true, Ordering::SeqCst);
    }
}

struct Work(PathBuf);
impl Drop for Work {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
fn run(command: &mut Command, label: &str, job_id: Option<&str>) -> Result<(), String> {
    let mut child = hidden(command.stdout(Stdio::null()).stderr(Stdio::piped()))
        .spawn()
        .map_err(|e| format!("{label} 실행 실패: {e}"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("{label} 오류 출력을 열지 못했습니다."))?;
    let reader = std::thread::spawn(move || {
        let mut data = Vec::new();
        let _ = stderr.read_to_end(&mut data);
        data
    });
    loop {
        if let Some(id) = job_id {
            if let Some(cancel) = CANCEL_TOKENS.lock().unwrap().get(id) {
                if cancel.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = reader.join();
                    return Err("작업이 취소되었습니다.".into());
                }
            }
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let data = reader.join().unwrap_or_default();
            if status.success() {
                return Ok(());
            }
            let detail = String::from_utf8_lossy(&data);
            return Err(format!(
                "{label} 실패\n{}",
                detail
                    .chars()
                    .rev()
                    .take(2500)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}
fn tools_root(value: &str) -> Result<PathBuf, String> {
    let root = if value.trim().is_empty() {
        std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("앱 경로 오류")?
            .join("tools/media")
    } else {
        PathBuf::from(value.trim())
    };
    if !root.is_dir() {
        return Err("미디어 도구 폴더를 찾지 못했습니다.".into());
    }
    Ok(root)
}
fn safe_stem(path: &Path) -> String {
    path.file_stem()
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
        .take(80)
        .collect()
}
fn ffprobe(ffmpeg: &str) -> String {
    let p = Path::new(ffmpeg);
    let name = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    p.parent()
        .filter(|_| p.file_name().is_some())
        .map(|x| x.join(name).to_string_lossy().into())
        .unwrap_or_else(|| name.into())
}
fn probe_video(ffmpeg: &str, path: &Path) -> Result<(f64, u32, u32), String> {
    let output = hidden(
        Command::new(ffprobe(ffmpeg))
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height,avg_frame_rate",
                "-of",
                "json",
            ])
            .arg(path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )
    .output()
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into());
    }
    let data: Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let s = &data["streams"][0];
    let rate = s["avg_frame_rate"].as_str().unwrap_or("24/1");
    let mut n = rate.split('/').filter_map(|v| v.parse::<f64>().ok());
    let fps = n.next().unwrap_or(24.) / n.next().unwrap_or(1.).max(1e-9);
    Ok((
        fps,
        s["width"].as_u64().unwrap_or(0) as u32,
        s["height"].as_u64().unwrap_or(0) as u32,
    ))
}
fn emit(
    app: &AppHandle,
    job: &str,
    stage: &str,
    percent: u32,
    current: usize,
    total: usize,
    start: Option<SystemTime>,
) {
    let mut msg = stage.to_string();
    if total > 0 {
        msg = format!("{} ({}/{})", msg, current, total);
    }
    if let Some(s) = start {
        let elapsed = s.elapsed().unwrap_or_default().as_secs();
        msg = format!("{} - {:02}:{:02}", msg, elapsed / 60, elapsed % 60);
    }
    let _ = app.emit(
        "frameflow-media-tool-progress",
        json!({"jobId":job,"stage":msg,"percent":percent}),
    );
}

#[tauri::command]
pub async fn media_tool_probe(source_path: String, executable: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move||{
 let path=fs::canonicalize(&source_path).map_err(|_|"입력 파일을 찾지 못했습니다.")?;let ext=path.extension().and_then(|x|x.to_str()).unwrap_or("").to_lowercase();
 if ["png","jpg","jpeg","webp","bmp","tif","tiff"].contains(&ext.as_str()){let (w,h)=image::image_dimensions(&path).map_err(|e|e.to_string())?;Ok(json!({"path":path,"filename":path.file_name().unwrap_or_default().to_string_lossy(),"kind":"image","width":w,"height":h}))}
 else {let (fps,w,h)=probe_video(&executable,&path)?;Ok(json!({"path":path,"filename":path.file_name().unwrap_or_default().to_string_lossy(),"kind":"video","width":w,"height":h,"fps":fps}))}
}).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn media_tool_run(
    app: AppHandle,
    job_id: String,
    tool: String,
    model_name: String,
    source_path: String,
    output_dir: String,
    factor: f64,
    threads: usize,
    tile: u32,
    executable: String,
    tools_dir: String,
) -> Result<Value, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    CANCEL_TOKENS.lock().unwrap().insert(job_id.clone(), cancel);
    let j_id = job_id.clone();
    let res = tauri::async_runtime::spawn_blocking(move||{
  let job_id = j_id;
  let start_time = SystemTime::now();
  if tool=="upscale" && ![2.0,4.0].contains(&factor){return Err("지원하지 않는 확대 배수입니다.".into());}
  if tool=="interpolate" && (factor < 1.0 || factor > 240.0) {return Err("지원하지 않는 프레임 수입니다 (1~240).".into());}
  if CANCEL_TOKENS.lock().unwrap().get(&job_id).map(|c|c.load(Ordering::SeqCst)).unwrap_or(false) { return Err("작업이 취소되었습니다.".into()); }
  let source=fs::canonicalize(&source_path).map_err(|_|"입력 파일을 찾지 못했습니다.")?;let root=tools_root(&tools_dir)?;let output_root=PathBuf::from(output_dir.trim());fs::create_dir_all(&output_root).map_err(|e|e.to_string())?;let output_root=fs::canonicalize(output_root).map_err(|e|e.to_string())?;
  let get_python = || -> Result<std::path::PathBuf, String> {
   let envs = crate::comfy::comfy_list_environments()?;
   let python = envs.as_array().and_then(|a| a.first()).and_then(|e| e["pythonPath"].as_str()).map(std::path::PathBuf::from);
   python.ok_or_else(|| "ComfyUI Python 환경을 찾을 수 없습니다.".to_string())
  };
  let stamp=SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos();let work=app.path().app_cache_dir().map_err(|e|e.to_string())?.join(format!("media-tool-{stamp}"));fs::create_dir_all(&work).map_err(|e|e.to_string())?;let _guard=Work(work.clone());
  let image=["png","jpg","jpeg","webp","bmp","tif","tiff"].contains(&source.extension().and_then(|x|x.to_str()).unwrap_or("").to_lowercase().as_str());if tool=="interpolate"&&image{return Err("프레임 보간은 영상 파일만 지원합니다.".into());}
  let suffix=if tool=="interpolate"{format!("rife-{}fps",factor as u32)}else{format!("realesrgan-{}x",factor as u32)};let output=output_root.join(format!("{}-{suffix}-{stamp}.{}",safe_stem(&source),if image{"png"}else{"mp4"}));
  if tool=="upscale"&&image {
   emit(&app,&job_id,"RealESRGAN 처리 중",10, 0, 0, Some(start_time));
   let rgb=work.join("upscaled.png");
   if model_name == "realesrgan_py" {
       let py = get_python()?;
       let script = root.join("realesrgan.py");
       let weights = root.join("models/RealESRGAN_x2plus.pth");
       let probe = ffprobe(&executable);
       run(std::process::Command::new(py).args(["-u", &script.to_string_lossy(), "--input", &source.to_string_lossy(), "--output", &rgb.to_string_lossy(), "--weights", &weights.to_string_lossy(), "--tile", &tile.to_string(), "--ffmpeg", &executable, "--ffprobe", &probe]),"RealESRGAN (Python)",Some(&job_id))?;
   } else {
       let exe=root.join("realesrgan-ncnn-vulkan.exe");
       run(std::process::Command::new(exe).args(["-i"]).arg(&source).args(["-o"]).arg(&rgb).args(["-n","realesrgan-x4plus","-s",&(factor as u32).to_string(),"-t",&tile.to_string(),"-m"]).arg(root.join("models")).args(["-f","png"]),"RealESRGAN",Some(&job_id))?;
   }
   run(std::process::Command::new(&executable).args(["-nostdin","-v","error","-y","-i"]).arg(&rgb).args(["-i"]).arg(&source).args(["-filter_complex",&format!("[1:v]format=rgba,alphaextract,scale=iw*{}:ih*{}:flags=lanczos[a];[0:v][a]alphamerge[out]", factor as u32, factor as u32),"-map","[out]","-frames:v","1"]).arg(&output),"알파 채널 결합",Some(&job_id))?;
  }
  else {
   let frames=work.join("frames");let result=work.join("result");fs::create_dir(&frames).map_err(|e|e.to_string())?;fs::create_dir(&result).map_err(|e|e.to_string())?;emit(&app,&job_id,"프레임 추출 중",5, 0, 0, Some(start_time));
   run(Command::new(&executable).args(["-nostdin","-v","error","-y","-i"]).arg(&source).args(["-map","0:v:0","-vsync","0"]).arg(frames.join("%09d.png")),"프레임 추출",Some(&job_id))?;
   let mut inputs=fs::read_dir(&frames).map_err(|e|e.to_string())?.filter_map(Result::ok).map(|x|x.path()).collect::<Vec<_>>();inputs.sort();if inputs.len()<2{return Err("처리할 영상 프레임이 부족합니다.".into());}
   let (fps,_,_)=probe_video(&executable,&source)?;
    if tool=="upscale"{
     emit(&app,&job_id,"RealESRGAN 업스케일 준비 중",20, 0, 0, Some(start_time));
     if model_name == "realesrgan_py" {
         let py = get_python()?;
         let script = root.join("realesrgan.py");
         let weights = root.join("models/RealESRGAN_x2plus.pth");
         let probe = ffprobe(&executable);
         
         let manifest_path = work.join("manifest.json");
         let mut jobs = Vec::new();
         for file in &inputs {
             let out_file = result.join(file.file_name().unwrap());
             jobs.push(serde_json::json!([file, out_file]));
         }
         std::fs::write(&manifest_path, serde_json::to_string(&jobs).unwrap()).map_err(|e|e.to_string())?;
         
         let monitor_app = app.clone();
         let monitor_job_id = job_id.clone();
         let monitor_out_dir = result.clone();
         let total_frames = inputs.len();
         let monitor_finished=Arc::new(AtomicBool::new(false));
         let monitor_finished_worker=monitor_finished.clone();
         let monitor_thread = std::thread::spawn(move||{
             loop{
                 if monitor_finished_worker.load(Ordering::SeqCst){break;}
                 if CANCEL_TOKENS.lock().unwrap().get(&monitor_job_id).map(|c|c.load(std::sync::atomic::Ordering::SeqCst)).unwrap_or(false) { break; }
                 if let Ok(entries) = std::fs::read_dir(&monitor_out_dir){
                     let processed = entries.count();
                     emit(&monitor_app,&monitor_job_id,"RealESRGAN 처리 중 (Python)",(20+processed*70/total_frames.max(1)) as u32, processed, total_frames, Some(start_time));
                     if processed >= total_frames{break;}
                 }
                 std::thread::sleep(std::time::Duration::from_millis(500));
             }
         });

         let process_result=run(std::process::Command::new(py).args(["-u", &script.to_string_lossy(), "--manifest", &manifest_path.to_string_lossy(), "--weights", &weights.to_string_lossy(), "--tile", &tile.to_string(), "--batch", &threads.to_string(), "--ffmpeg", &executable, "--ffprobe", &probe]),"RealESRGAN (Python)",Some(&job_id));
         monitor_finished.store(true,Ordering::SeqCst);
         let _ = monitor_thread.join();
         process_result?;
     } else {
         let chunk_size = (inputs.len() + threads.max(1) - 1) / threads.max(1);let mut upscale_threads=Vec::new();let error=std::sync::Arc::new(std::sync::Mutex::new(None::<String>));let mut out_dirs=Vec::new();
         for (i,chunk) in inputs.chunks(chunk_size).enumerate(){
             let chunk_in=work.join(format!("frames_{i}"));let chunk_out=work.join(format!("result_{i}"));out_dirs.push(chunk_out.clone());std::fs::create_dir(&chunk_in).map_err(|e|e.to_string())?;std::fs::create_dir(&chunk_out).map_err(|e|e.to_string())?;
             for file in chunk{std::fs::rename(file,chunk_in.join(file.file_name().unwrap())).map_err(|e|e.to_string())?;}
             let exe=root.join("realesrgan-ncnn-vulkan.exe");let model=root.join("models");let f_str=(factor as u32).to_string();let j_id=job_id.clone();let error=error.clone();
             upscale_threads.push(std::thread::spawn(move||{if error.lock().unwrap().is_some(){return;}if CANCEL_TOKENS.lock().unwrap().get(&j_id).map(|c|c.load(std::sync::atomic::Ordering::SeqCst)).unwrap_or(false) { return; } if let Err(e)=run(std::process::Command::new(exe).args(["-i"]).arg(&chunk_in).args(["-o"]).arg(&chunk_out).args(["-n","realesrgan-x4plus","-s",&f_str,"-t",&tile.to_string(),"-m"]).arg(&model).args(["-f","png"]),"RealESRGAN",Some(&j_id)){*error.lock().unwrap()=Some(e);}}));
         }
         let monitor_app=app.clone();let monitor_job_id=job_id.clone();let monitor_error=error.clone();let monitor_out_dirs=out_dirs.clone();let total_frames=inputs.len();
         let monitor_thread=std::thread::spawn(move||{loop{if monitor_error.lock().unwrap().is_some(){break;}if CANCEL_TOKENS.lock().unwrap().get(&monitor_job_id).map(|c|c.load(std::sync::atomic::Ordering::SeqCst)).unwrap_or(false) { break; }let mut processed=0;for dir in &monitor_out_dirs{if let Ok(entries)=std::fs::read_dir(dir){processed+=entries.count();}}emit(&monitor_app,&monitor_job_id,"RealESRGAN 처리 중",(20+processed*70/total_frames.max(1)) as u32,processed,total_frames,Some(start_time));if processed>=total_frames{break;}std::thread::sleep(std::time::Duration::from_millis(500));}});
         for t in upscale_threads{t.join().map_err(|_|"업스케일 스레드 오류")?;}let _=monitor_thread.join();if let Some(err)=error.lock().unwrap().take(){return Err(err);}
         for chunk_out in out_dirs{if let Ok(entries)=std::fs::read_dir(&chunk_out){for entry in entries.filter_map(Result::ok){let _=std::fs::rename(entry.path(),result.join(entry.file_name()));}}}
     }
    }
   else {
    let rife=root.join("rife/rife-ncnn-vulkan.exe");let model=root.join("rife/rife-v4.6");
    let out_fps = factor;
    let duration = (inputs.len() - 1) as f64 / fps;
    let total = (duration * out_fps).round() as usize + 1;
    let mut out_index=1usize;let mut pending=VecDeque::new();
    for i in 0..total {
        let time = i as f64 / out_fps;
        let pos = time * fps;
        let mut pair = pos.floor() as usize;
        let mut step = pos - pos.floor();
        if pair >= inputs.len() - 1 {
            pair = inputs.len() - 2;
            step = 1.0;
        }
        let target = result.join(format!("{:09}.png", i + 1));
        if step <= 1e-4 {
            fs::copy(&inputs[pair], &target).map_err(|e|e.to_string())?;
        } else if step >= 1.0 - 1e-4 {
            fs::copy(&inputs[pair + 1], &target).map_err(|e|e.to_string())?;
        } else {
            pending.push_back((inputs[pair].clone(), inputs[pair+1].clone(), target, step));
        }
        out_index += 1;
    }
    if out_index-1 != total {return Err("보간 프레임 수가 맞지 않습니다.".into());}
    let task_count=pending.len();
    if task_count > 0 {
        let queue=Arc::new(Mutex::new(pending));let error=Arc::new(Mutex::new(None::<String>));let done=Arc::new(AtomicUsize::new(0));let mut threads_vec=Vec::new();
        for _ in 0..task_count.min(threads.max(1)){let queue=queue.clone();let error=error.clone();let done=done.clone();let rife=rife.clone();let model=model.clone();let app=app.clone();let j_id=job_id.clone();threads_vec.push(std::thread::spawn(move||loop{if error.lock().unwrap().is_some(){break;}if CANCEL_TOKENS.lock().unwrap().get(&j_id).map(|c|c.load(Ordering::SeqCst)).unwrap_or(false) { break; } let Some((a,b,target,time))=queue.lock().unwrap().pop_front()else{break};let status=run(Command::new(&rife).args(["-0"]).arg(a).args(["-1"]).arg(b).args(["-o"]).arg(target).args(["-s",&format!("{time:.9}"),"-m"]).arg(&model),"RIFE",Some(&j_id));if let Err(reason)=status{*error.lock().unwrap()=Some(reason);break;}let count=done.fetch_add(1,Ordering::SeqCst)+1;emit(&app,&j_id,"RIFE 프레임 보간 중",(10+count*80/task_count) as u32, count, task_count, Some(start_time));}));}
        for thread in threads_vec{thread.join().map_err(|_|"RIFE 작업 스레드가 중단되었습니다.".to_string())?;}if let Some(reason)=error.lock().unwrap().take(){return Err(reason);};
    }
   }
   if CANCEL_TOKENS.lock().unwrap().get(&job_id).map(|c|c.load(Ordering::SeqCst)).unwrap_or(false) { return Err("작업이 취소되었습니다.".into()); }
   emit(&app,&job_id,"영상 인코딩 중",92, 0, 0, Some(start_time));let out_fps=if tool=="interpolate"{factor}else{fps};run(Command::new(&executable).args(["-nostdin","-v","error","-y","-framerate",&format!("{out_fps:.12}") ,"-i"]).arg(result.join("%09d.png")).args(["-i"]).arg(&source).args(["-map","0:v:0","-map","1:a?","-c:v","libx264","-preset","slow","-crf","15","-pix_fmt","yuv420p","-c:a","aac","-b:a","192k","-shortest","-movflags","+faststart"]).arg(&output),"영상 인코딩",Some(&job_id))?;
  }
  if !output.is_file(){return Err("결과 파일이 생성되지 않았습니다.".into());}emit(&app,&job_id,"임시 프레임 삭제 중",98, 0, 0, Some(start_time));std::mem::drop(_guard);emit(&app,&job_id,"완료",100, 0, 0, Some(start_time));Ok(json!({"path":output,"outputDir":output_root,"filename":output.file_name().unwrap_or_default().to_string_lossy(),"kind":if image{"image"}else{"video"},"factor":factor,"tool":tool}))
 }).await.map_err(|e|e.to_string())?;
    CANCEL_TOKENS.lock().unwrap().remove(&job_id);
    res
}

#[tauri::command]
pub fn media_tool_delete(entries: Vec<Value>) -> Result<u32, String> {
    let mut checked = Vec::new();
    for entry in entries {
        let root = fs::canonicalize(entry["root"].as_str().unwrap_or(""))
            .map_err(|_| "결과 폴더를 찾지 못했습니다.")?;
        let raw = PathBuf::from(entry["path"].as_str().unwrap_or(""));
        if !raw.exists() {
            continue;
        }
        let path = fs::canonicalize(&raw).map_err(|e| e.to_string())?;
        if !path.starts_with(&root) || !path.is_file() {
            return Err("선택한 결과 폴더 안의 파일만 삭제할 수 있습니다.".into());
        }
        checked.push((root, path));
    }
    let removed = checked.len() as u32;
    for (root, path) in checked {
        let mut parent = path.parent().map(Path::to_path_buf);
        fs::remove_file(&path).map_err(|e| e.to_string())?;
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deletion_is_confined_and_prevalidated() {
        let base = std::env::temp_dir().join(format!(
            "frameflow-media-delete-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = base.join("results");
        fs::create_dir_all(root.join("nested")).unwrap();
        let inside = root.join("nested/a.mp4");
        let outside = base.join("outside.mp4");
        fs::write(&inside, b"a").unwrap();
        fs::write(&outside, b"b").unwrap();
        let bad = vec![
            json!({"root":root,"path":inside}),
            json!({"root":root,"path":outside}),
        ];
        assert!(media_tool_delete(bad).is_err());
        assert!(inside.exists() && outside.exists());
        assert_eq!(
            media_tool_delete(vec![json!({"root":root,"path":inside})]).unwrap(),
            1
        );
        assert!(!inside.exists());
        assert!(outside.exists());
        fs::remove_dir_all(base).unwrap();
    }
}
