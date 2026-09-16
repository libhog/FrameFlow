use reqwest::{multipart, Client};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;

const WORKFLOW_JSON: &str = include_str!("../resources/api_video_wan2_2_14B_flf2v.json");
const MINIMAX_WORKFLOW_JSON: &str = include_str!("../resources/api_video_minimax_h3_i2v.json");
const MINIMAX_REF2VA_AUDIO_WORKFLOW_JSON: &str =
    include_str!("../resources/api_video_minimax_h3_ref2va_audio.json");
const MINIMAX_REF2VA_VIDEO_WORKFLOW_JSON: &str =
    include_str!("../resources/api_video_minimax_h3_ref2va_video.json");
const MINIMAX_CONTEXT_WORKFLOW_JSON: &str =
    include_str!("../resources/api_video_minimax_h3_context_loop.json");
const FRAMEFLOW_H3_CONDITIONING_BANK_PY: &str =
    include_str!("../resources/frameflow_h3_conditioning_bank.py");
const FRAMEFLOW_RTX_VSR_CPU_PY: &str = include_str!("../resources/frameflow_rtx_vsr_cpu.py");
const FPS: u32 = 16;
const MINIMAX_FPS: u32 = 24;
const MINIMAX_REF2VA_MAX_FRAMES: u32 = 3600;
const MINIMAX_FL2VA_DEFAULT_MODEL: &str = "minimax_h3_fl2va_pruned_int8_convrot.safetensors";
const MINIMAX_REF2VA_DEFAULT_MODEL: &str = "minimax_h3_ref2va_pruned_int8_convrot.safetensors";
const MINIMAX_FL2VA_INT4_MODEL: &str = "minimaxH3INT4Convrot_fl2vaPrunedInt4.safetensors";
const MINIMAX_REF2VA_INT4_MODEL: &str = "minimaxH3INT4Convrot_ref2vPrunedInt4.safetensors";
const MINIMAX_FL2VA_W4A8_MODEL: &str = "minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors";
const MINIMAX_REF2VA_W4A8_MODEL: &str = "minimax_h3_ref2va_pruned-w4a8_convrot_pruned.safetensors";
const MINIMAX_TURBO_V4_8STEP_LORA: &str =
    "minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors";
// Invalidate pending TEST clip submissions before stopping the Comfy server.
static CONTEXT_TEST_CANCEL_EPOCH: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextLoopShotInput {
    last_image_path: String,
    prompt: String,
    duration: f64,
    seed: Option<u64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowExportRequest {
    kind: String,
    target_path: String,
    first_image_path: Option<String>,
    last_image_path: Option<String>,
    source_video_path: Option<String>,
    #[serde(default)]
    reference_images: Vec<String>,
    #[serde(default)]
    reference_videos: Vec<String>,
    prompt: String,
    width: u32,
    height: u32,
    length: Option<u32>,
    duration: f64,
    seed: Option<u64>,
    minimax_profile: Option<String>,
    minimax_model_mode: Option<String>,
    latent_upscale_mode: Option<String>,
    background_music: Option<bool>,
    ref_image_size: Option<String>,
}

#[derive(Default)]
pub struct ComfyRuntimeState {
    child: Mutex<Option<Child>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInstallation {
    id: String,
    name: String,
    #[serde(default)]
    install_path: String,
    #[serde(default)]
    source_id: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    launch_args: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    comfy_version_tag: String,
    #[serde(default)]
    comfy_version: Value,
}

fn installation_comfy_version(item: &DesktopInstallation) -> String {
    item.comfy_version
        .get("baseTag")
        .and_then(Value::as_str)
        .or_else(|| item.comfy_version.get("commit").and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if item.comfy_version_tag.trim().is_empty() {
                &item.version
            } else {
                &item.comfy_version_tag
            }
        })
        .to_string()
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    #[serde(default)]
    input_dir: String,
    #[serde(default)]
    output_dir: String,
}

fn desktop_config_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        env::var_os("APPDATA").map(|value| PathBuf::from(value).join("Comfy Desktop"))
    }
    #[cfg(target_os = "macos")]
    {
        env::var_os("HOME").map(|value| {
            PathBuf::from(value)
                .join("Library")
                .join("Application Support")
                .join("Comfy Desktop")
        })
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| env::var_os("HOME").map(|value| PathBuf::from(value).join(".config")))
            .map(|value| value.join("Comfy Desktop"))
    }
}

fn desktop_installations() -> Result<Vec<DesktopInstallation>, String> {
    let config = desktop_config_dir()
        .ok_or_else(|| "사용자 Comfy Desktop 설정 폴더를 찾지 못했습니다.".to_string())?;
    let path = config.join("installations.json");
    let text = fs::read_to_string(&path).map_err(|error| {
        format!(
            "Comfy Desktop 설치 목록을 읽지 못했습니다 ({}): {error}",
            path.display()
        )
    })?;
    let list: Vec<DesktopInstallation> = serde_json::from_str(&text)
        .map_err(|error| format!("Comfy Desktop 설치 목록 형식이 올바르지 않습니다: {error}"))?;
    Ok(list
        .into_iter()
        .filter(|item| {
            item.source_id != "cloud" && item.status == "installed" && !item.install_path.is_empty()
        })
        .filter(|item| environment_python(Path::new(&item.install_path)).is_some())
        .collect())
}

fn desktop_settings() -> DesktopSettings {
    desktop_config_dir()
        .and_then(|path| fs::read_to_string(path.join("settings.json")).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn environment_python(root: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let candidates = [
        root.join("ComfyUI")
            .join(".venv")
            .join("Scripts")
            .join("python.exe"),
        root.join("standalone-env").join("python.exe"),
    ];
    #[cfg(not(target_os = "windows"))]
    let candidates = [
        root.join("ComfyUI")
            .join(".venv")
            .join("bin")
            .join("python"),
        root.join("standalone-env").join("bin").join("python"),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

fn ensure_frameflow_h3_context_loop_fork(item: &DesktopInstallation) -> Result<bool, String> {
    let plugin_dir = PathBuf::from(&item.install_path)
        .join("ComfyUI")
        .join("custom_nodes")
        .join("ComfyUI-MiniMaxH3-Contex-Loop-FrameFlow");
    let plugin_file = plugin_dir.join("__init__.py");
    let current = fs::read_to_string(&plugin_file).ok();
    if current.as_deref() == Some(FRAMEFLOW_H3_CONDITIONING_BANK_PY) {
        return Ok(false);
    }
    fs::create_dir_all(&plugin_dir).map_err(|error| {
        format!(
            "FrameFlow H3 Context Loop 포크 폴더를 만들지 못했습니다 ({}): {error}",
            plugin_dir.display()
        )
    })?;
    fs::write(&plugin_file, FRAMEFLOW_H3_CONDITIONING_BANK_PY).map_err(|error| {
        format!(
            "FrameFlow H3 Context Loop 포크를 설치하지 못했습니다 ({}): {error}",
            plugin_file.display()
        )
    })?;
    Ok(true)
}

fn ensure_frameflow_rtx_vsr_cpu_node(item: &DesktopInstallation) -> Result<bool, String> {
    let plugin_dir = PathBuf::from(&item.install_path)
        .join("ComfyUI")
        .join("custom_nodes")
        .join("FrameFlow-RTX-VSR-CPU");
    let plugin_file = plugin_dir.join("__init__.py");
    let current = fs::read_to_string(&plugin_file).ok();
    if current.as_deref() == Some(FRAMEFLOW_RTX_VSR_CPU_PY) {
        return Ok(false);
    }
    fs::create_dir_all(&plugin_dir).map_err(|error| {
        format!(
            "FrameFlow RTX VSR 노드 폴더를 만들지 못했습니다 ({}): {error}",
            plugin_dir.display()
        )
    })?;
    fs::write(&plugin_file, FRAMEFLOW_RTX_VSR_CPU_PY).map_err(|error| {
        format!(
            "FrameFlow RTX VSR 노드를 설치하지 못했습니다 ({}): {error}",
            plugin_file.display()
        )
    })?;
    Ok(true)
}

fn environment_json(item: &DesktopInstallation, running_name: Option<&str>) -> Value {
    let root = PathBuf::from(&item.install_path);
    let python = environment_python(&root).unwrap_or_default();
    let model_config = desktop_config_dir()
        .map(|path| {
            path.join("instance-model-paths")
                .join(format!("{}.yaml", item.id))
        })
        .filter(|path| path.is_file());
    json!({
        "id": item.id,
        "name": item.name,
        "installPath": item.install_path,
        "pythonPath": python,
        "launchArgs": item.launch_args,
        "modelConfigPath": model_config,
        "running": running_name.is_some_and(|name| name.eq_ignore_ascii_case(&item.name)),
    })
}

fn port_from_url(base: &str) -> u16 {
    reqwest::Url::parse(base)
        .ok()
        .and_then(|url| url.port_or_known_default())
        .unwrap_or(8188)
}

fn running_environment_name(base: &str) -> Option<String> {
    let port = port_from_url(base);
    desktop_config_dir()
        .and_then(|path| {
            fs::read_to_string(path.join("port-locks").join(format!("port-{port}.json"))).ok()
        })
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            value
                .get("installationName")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
}

fn split_launch_args(value: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for character in value.chars() {
        match (quote, character) {
            (Some(open), value) if value == open => quote = None,
            (None, '\'' | '"') => quote = Some(character),
            (None, value) if value.is_whitespace() => {
                if !current.is_empty() {
                    result.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(character),
        }
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}

fn engine_launch_args(value: &str, use_ck_attention: bool) -> Vec<String> {
    let mut args = split_launch_args(value);
    if use_ck_attention {
        // These argparse options are mutually exclusive. MiniMax-H3 uses the
        // explicit ModelAttentionBackend node as well, so make the process
        // default agree with the workflow and avoid a Sage/Flash conflict.
        args.retain(|arg| {
            !matches!(
                arg.as_str(),
                "--use-split-cross-attention"
                    | "--use-quad-cross-attention"
                    | "--use-pytorch-cross-attention"
                    | "--use-sage-attention"
                    | "--use-flash-attention"
                    | "--use-ck-attention"
            )
        });
        args.push("--use-ck-attention".into());
    }
    args
}

fn select_environment<'a>(
    list: &'a [DesktopInstallation],
    preferred_name: &str,
    running_name: Option<&str>,
) -> Option<&'a DesktopInstallation> {
    let preferred = preferred_name.trim();
    if !preferred.is_empty() {
        if let Some(item) = list
            .iter()
            .find(|item| item.name.eq_ignore_ascii_case(preferred))
        {
            return Some(item);
        }
    }
    if let Some(running) = running_name {
        if let Some(item) = list
            .iter()
            .find(|item| item.name.eq_ignore_ascii_case(running))
        {
            return Some(item);
        }
    }
    list.first()
}

fn kill_port_locked_environment(base: &str, expected_name: &str) -> Result<(), String> {
    let port = port_from_url(base);
    let Some(config) = desktop_config_dir() else {
        return Ok(());
    };
    let lock_path = config.join("port-locks").join(format!("port-{port}.json"));
    let Ok(text) = fs::read_to_string(lock_path) else {
        return Ok(());
    };
    let value: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let name = value
        .get("installationName")
        .and_then(Value::as_str)
        .unwrap_or("");
    let pid = value.get("pid").and_then(Value::as_u64).unwrap_or(0);
    if pid == 0 || !name.eq_ignore_ascii_case(expected_name) {
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn listening_pid_for_port(base: &str) -> Option<u32> {
    let url = reqwest::Url::parse(base).ok()?;
    let host = url.host_str()?;
    if !matches!(host, "127.0.0.1" | "localhost" | "::1") {
        return None;
    }
    let port = url.port_or_known_default().unwrap_or(8188);
    let output = Command::new("netstat")
        .args(["-ano", "-p", "TCP"])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().find_map(|line| {
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if columns.len() < 5
            || !columns[1].ends_with(&format!(":{port}"))
            || !columns[3].eq_ignore_ascii_case("LISTENING")
        {
            return None;
        }
        columns[4].parse::<u32>().ok().filter(|pid| *pid > 0)
    })
}

#[cfg(target_os = "windows")]
fn kill_listening_process(base: &str) -> Result<Option<u32>, String> {
    let Some(pid) = listening_pid_for_port(base) else {
        return Ok(None);
    };
    let output = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .map_err(|error| format!("ComfyUI 프로세스 종료 명령을 실행하지 못했습니다: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(format!(
            "ComfyUI 프로세스(PID {pid}) 종료에 실패했습니다{}",
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ));
    }
    Ok(Some(pid))
}

fn spawn_environment(
    item: &DesktopInstallation,
    base: &str,
    show_console: bool,
    use_ck_attention: bool,
) -> Result<Child, String> {
    let root = PathBuf::from(&item.install_path);
    let python = environment_python(&root)
        .ok_or_else(|| format!("{} 환경의 Python을 찾지 못했습니다.", item.name))?;
    let main = root.join("ComfyUI").join("main.py");
    if !main.is_file() {
        return Err(format!(
            "{} 환경의 ComfyUI/main.py를 찾지 못했습니다.",
            item.name
        ));
    }
    let settings = desktop_settings();
    let mut command = Command::new(python);
    command
        .current_dir(&root)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .arg("-s")
        .arg("ComfyUI/main.py")
        .args(["--feature-flag", "show_signin_button=true"]);
    command.args(engine_launch_args(&item.launch_args, use_ck_attention));
    if let Some(config) = desktop_config_dir()
        .map(|path| {
            path.join("instance-model-paths")
                .join(format!("{}.yaml", item.id))
        })
        .filter(|path| path.is_file())
    {
        command.arg("--extra-model-paths-config").arg(config);
    }
    if !settings.input_dir.is_empty() {
        command.arg("--input-directory").arg(settings.input_dir);
    }
    if !settings.output_dir.is_empty() {
        command.arg("--output-directory").arg(settings.output_dir);
    }
    let port = port_from_url(base);
    if port != 8188 {
        command.arg("--port").arg(port.to_string());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if show_console {
            // CREATE_NEW_CONSOLE: Comfy의 Python stdout/stderr를 사용자가 직접 볼 수 있다.
            // GUI 부모의 표준 핸들을 상속하면 tqdm 출력이 Invalid argument로 실패하므로
            // stdio를 지정하지 않고 Windows가 새 콘솔 핸들을 만들게 한다.
            command.creation_flags(0x00000010);
        } else {
            // CREATE_NO_WINDOW: 일반 사용 시 불필요한 콘솔 창을 숨긴다.
            command.creation_flags(0x08000000);
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if show_console {
            command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
        } else {
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
        }
    }
    command
        .spawn()
        .map_err(|error| format!("{} 환경을 실행하지 못했습니다: {error}", item.name))
}

fn normalize_base_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    if !(value.starts_with("http://") || value.starts_with("https://")) {
        return Err("ComfyUI 주소는 http:// 또는 https://로 시작해야 합니다.".into());
    }
    Ok(value.to_owned())
}

fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|error| error.to_string())
}

async fn response_json(response: reqwest::Response, action: &str) -> Result<Value, String> {
    let status = response.status();
    let text = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "{action} 실패 ({status}): {}",
            text.chars().take(800).collect::<String>()
        ));
    }
    serde_json::from_str(&text)
        .map_err(|error| format!("{action} 응답을 해석하지 못했습니다: {error}"))
}

fn uploaded_image_name(value: &Value) -> Result<String, String> {
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "업로드 응답에 이미지 이름이 없습니다.".to_string())?;
    let subfolder = value
        .get("subfolder")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_matches('/');
    Ok(if subfolder.is_empty() {
        name.to_owned()
    } else {
        format!("{subfolder}/{name}")
    })
}

async fn upload_image(
    http: &Client,
    base: &str,
    source_path: &str,
    role: &str,
) -> Result<String, String> {
    let source = Path::new(source_path);
    if !source.is_file() {
        return Err(format!(
            "{role} Frame 이미지 파일을 찾을 수 없습니다: {source_path}"
        ));
    }
    let bytes =
        fs::read(source).map_err(|error| format!("{role} Frame을 읽지 못했습니다: {error}"))?;
    let original = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("frame.png");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let filename = format!("frameflow-{nonce}-{role}-{original}");
    let part = multipart::Part::bytes(bytes).file_name(filename);
    let form = multipart::Form::new()
        .part("image", part)
        .text("type", "input")
        .text("overwrite", "true");
    let response = http
        .post(format!("{base}/upload/image"))
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("{role} Frame 업로드 실패: {error}"))?;
    uploaded_image_name(&response_json(response, &format!("{role} Frame 업로드")).await?)
}

async fn upload_input_media(
    http: &Client,
    base: &str,
    source_path: &str,
    role: &str,
) -> Result<String, String> {
    let source = Path::new(source_path);
    if !source.is_file() {
        return Err(format!("{role} 파일을 찾을 수 없습니다: {source_path}"));
    }
    let bytes =
        fs::read(source).map_err(|error| format!("{role} 파일을 읽지 못했습니다: {error}"))?;
    let original = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("reference.mp4");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let filename = format!("frameflow-{nonce}-{role}-{original}");
    // ComfyUI's upload endpoint stores every supported input asset in the shared
    // input directory. LoadVideo classifies the uploaded file by its extension.
    let part = multipart::Part::bytes(bytes).file_name(filename);
    let form = multipart::Form::new()
        .part("image", part)
        .text("type", "input")
        .text("overwrite", "true");
    let response = http
        .post(format!("{base}/upload/image"))
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("{role} 업로드 실패: {error}"))?;
    uploaded_image_name(&response_json(response, &format!("{role} 업로드")).await?)
}

fn set_input(workflow: &mut Value, node: &str, key: &str, value: Value) -> Result<(), String> {
    let inputs = workflow
        .get_mut(node)
        .and_then(|value| value.get_mut("inputs"))
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("워크플로 노드 {node}의 inputs를 찾지 못했습니다."))?;
    inputs.insert(key.to_owned(), value);
    Ok(())
}

fn build_workflow(
    first: &str,
    last: &str,
    prompt: &str,
    width: u32,
    height: u32,
    length: u32,
    prefix: &str,
    seed: Option<u64>,
) -> Result<Value, String> {
    if prompt.trim().is_empty() {
        return Err("영문 프롬프트를 입력해 주세요.".into());
    }
    if width < 64 || height < 64 {
        return Err("영상 해상도는 가로·세로 64px 이상이어야 합니다.".into());
    }
    if length < 5 || (length - 1) % 4 != 0 {
        return Err("WAN 프레임 수는 4n+1 형식이어야 합니다.".into());
    }
    let mut workflow: Value = serde_json::from_str(WORKFLOW_JSON)
        .map_err(|error| format!("내장 Comfy 워크플로를 읽지 못했습니다: {error}"))?;
    set_input(&mut workflow, "6", "text", json!(prompt.trim()))?;
    // 사용자 요구사항: negative prompt는 어떤 경우에도 ComfyUI에 전달하지 않는다.
    set_input(&mut workflow, "7", "text", json!(""))?;
    set_input(&mut workflow, "67", "width", json!(width))?;
    set_input(&mut workflow, "67", "height", json!(height))?;
    set_input(&mut workflow, "67", "length", json!(length))?;
    set_input(&mut workflow, "60", "fps", json!(FPS))?;
    set_input(&mut workflow, "68", "image", json!(first))?;
    set_input(&mut workflow, "62", "image", json!(last))?;
    set_input(&mut workflow, "61", "filename_prefix", json!(prefix))?;
    if let Some(seed) = seed {
        set_input(&mut workflow, "57", "noise_seed", json!(seed))?;
    }
    Ok(workflow)
}

fn minimax_frame_length(duration: f64) -> u32 {
    let raw = (duration.max(0.2) * MINIMAX_FPS as f64).round().max(5.0) as u32;
    raw + (5 + 17 - raw % 17) % 17
}

fn normalize_minimax_profile(profile: Option<&str>) -> &'static str {
    match profile.unwrap_or("turbo-8") {
        "turbo-8" => "turbo-8",
        "speed-4" => "speed-4",
        "turbo-10" => "turbo-10",
        "hybrid-8-4" => "hybrid-8-4",
        "quality-20" => "quality-20",
        _ => "turbo-8",
    }
}

fn normalize_minimax_model_mode(mode: Option<&str>) -> &'static str {
    match mode {
        Some("int4") => "int4",
        Some("w4a8" | "int4-w4a8" | "low-vram") => "w4a8",
        _ => "default",
    }
}

fn minimax_model_name(kind: &str, mode: &str) -> &'static str {
    match (kind, normalize_minimax_model_mode(Some(mode))) {
        ("ref2va", "int4") => MINIMAX_REF2VA_INT4_MODEL,
        (_, "int4") => MINIMAX_FL2VA_INT4_MODEL,
        ("ref2va", "w4a8") => MINIMAX_REF2VA_W4A8_MODEL,
        (_, "w4a8") => MINIMAX_FL2VA_W4A8_MODEL,
        ("ref2va", _) => MINIMAX_REF2VA_DEFAULT_MODEL,
        _ => MINIMAX_FL2VA_DEFAULT_MODEL,
    }
}

fn apply_minimax_model_mode(
    workflow: &mut Value,
    loader_node: &str,
    kind: &str,
    mode: &str,
) -> Result<(), String> {
    let model_name = minimax_model_name(kind, mode);
    // ComfyUI core v0.34+ reads asym_w4a8_int8 metadata through UNETLoader.
    // Keep the workflow loader stable and only switch the selected checkpoint.
    set_input(workflow, loader_node, "unet_name", json!(model_name))?;
    Ok(())
}

fn normalize_latent_upscale_mode(mode: Option<&str>) -> &'static str {
    match mode.unwrap_or("off") {
        "quarter-to-one" => "quarter-to-one",
        "half-to-one" => "half-to-one",
        "two-thirds-to-one" => "two-thirds-to-one",
        "one-to-two" => "one-to-two",
        "one-to-four" => "one-to-four",
        _ => "off",
    }
}

fn align_minimax_dimension(value: f64) -> u32 {
    ((value / 32.0).round().max(2.0) as u32) * 32
}

fn latent_upscale_dimensions(width: u32, height: u32, mode: &str) -> (u32, u32, u32, u32) {
    match normalize_latent_upscale_mode(Some(mode)) {
        "quarter-to-one" => (
            align_minimax_dimension(width as f64 / 4.0),
            align_minimax_dimension(height as f64 / 4.0),
            width,
            height,
        ),
        "half-to-one" => (
            align_minimax_dimension(width as f64 / 2.0),
            align_minimax_dimension(height as f64 / 2.0),
            width,
            height,
        ),
        "two-thirds-to-one" => (
            align_minimax_dimension(width as f64 * 2.0 / 3.0),
            align_minimax_dimension(height as f64 * 2.0 / 3.0),
            width,
            height,
        ),
        "one-to-two" => (
            width,
            height,
            align_minimax_dimension(width as f64 * 2.0),
            align_minimax_dimension(height as f64 * 2.0),
        ),
        "one-to-four" => (
            width,
            height,
            align_minimax_dimension(width as f64 * 4.0),
            align_minimax_dimension(height as f64 * 4.0),
        ),
        _ => (width, height, width, height),
    }
}

fn apply_minimax_latent_upscale(
    workflow: &mut Value,
    mode: &str,
    width: u32,
    height: u32,
    profile: &str,
    variant: &str,
    attention_node: &str,
    decode_nodes: &[&str],
) -> Result<(u32, u32), String> {
    let mode = normalize_latent_upscale_mode(Some(mode));
    let (first_width, first_height, target_width, target_height) =
        latent_upscale_dimensions(width, height, mode);
    if mode == "off" {
        return Ok((target_width, target_height));
    }
    if target_width > 8192 || target_height > 8192 {
        return Err(format!("잠재 업스케일 목표 해상도 {target_width}×{target_height}는 노드 최대값 8192px을 넘습니다."));
    }
    set_input(workflow, "8", "width", json!(first_width))?;
    set_input(workflow, "8", "height", json!(first_height))?;
    let mut target_conditioning = workflow
        .get("8")
        .cloned()
        .ok_or_else(|| "MiniMax-H3 conditioning 노드 8을 찾지 못했습니다.".to_string())?;
    target_conditioning["inputs"]["width"] = json!(target_width);
    target_conditioning["inputs"]["height"] = json!(target_height);
    let turbo_4 = if variant == "fl2va" {
        "minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors"
    } else {
        "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"
    };
    let quality = normalize_minimax_profile(Some(profile)) == "quality-20";
    let root = workflow
        .as_object_mut()
        .ok_or_else(|| "MiniMax-H3 워크플로 루트가 객체가 아닙니다.".to_string())?;
    root.insert("108".into(), target_conditioning);
    if let Some(wait_for) = root
        .get_mut("19")
        .and_then(|node| node.pointer_mut("/inputs/wait_for"))
    {
        *wait_for = json!(["108", 0]);
    } else if let Some(wait_for) = root
        .get_mut("17")
        .and_then(|node| node.pointer_mut("/inputs/wait_for"))
    {
        *wait_for = json!(["108", 0]);
    }
    if !quality {
        root.insert("128".into(), json!({"class_type":"LoraLoaderModelOnly","inputs":{"model":[attention_node,0],"lora_name":turbo_4,"strength_model":1.0}}));
    }
    let second_model = if quality {
        json!([attention_node, 0])
    } else {
        json!(["128", 0])
    };
    let sigmas = if quality {
        "0.9231, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000"
    } else {
        "0.9035, 0.6316, 0.3158, 0.0000"
    };
    root.insert(
        "120".into(),
        json!({"class_type":"LTXVSeparateAVLatent","inputs":{"av_latent":["13",1]}}),
    );
    root.insert("121".into(), json!({"class_type":"MinimaxH3LatentUpscaler3D","inputs":{"latent":["120",0],"model_name":"minimax_h3_latent_upscaler_3d_bf16.safetensors","mode":"target dimensions","mode.width":target_width,"mode.height":target_height,"align":32,"enable_temporal_chunking":false,"force_unload":true,"device":"cuda","precision":"bf16"}}));
    root.insert("122".into(), json!({"class_type":"LTXVConcatAVLatent","inputs":{"video_latent":["121",0],"audio_latent":["120",1]}}));
    root.insert(
        "124".into(),
        json!({"class_type":"KSamplerSelect","inputs":{"sampler_name":"euler"}}),
    );
    root.insert(
        "125".into(),
        json!({"class_type":"ManualSigmas","inputs":{"sigmas":sigmas}}),
    );
    root.insert("126".into(), json!({"class_type":"BasicGuider","inputs":{"model":second_model,"conditioning":["108",0]}}));
    root.insert("127".into(), json!({"class_type":"SamplerCustomAdvanced","inputs":{"noise":["9",0],"guider":["126",0],"sampler":["124",0],"sigmas":["125",0],"latent_image":["122",0]}}));
    for node in decode_nodes {
        if let Some(samples) = root
            .get_mut(*node)
            .and_then(|value| value.pointer_mut("/inputs/samples"))
        {
            *samples = json!(["127", 0]);
        }
    }
    Ok((target_width, target_height))
}

fn normalize_non_diegetic_music(prompt: &str, background_music: bool) -> String {
    let trimmed = prompt.trim();
    if background_music {
        return trimmed.to_string();
    }
    let lower = trimmed.to_lowercase();
    if let Some(index) = lower.rfind("non_diegetic_music:") {
        format!(
            "{}\n\nnon_diegetic_music:\nN/A",
            trimmed[..index].trim_end()
        )
    } else {
        format!("{trimmed}\n\nnon_diegetic_music:\nN/A")
    }
}

fn apply_minimax_sampling_profile(
    workflow: &mut Value,
    profile: &str,
    variant: &str,
    attention_node: &str,
) -> Result<(), String> {
    let profile = normalize_minimax_profile(Some(profile));
    let turbo_4 = if variant == "fl2va" {
        "minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors"
    } else {
        "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"
    };
    let pdd_file = if variant == "fl2va" {
        "MiniMax-H3-FL2VA-Acc-8Step.safetensors"
    } else {
        "MiniMax-H3-Ref2VA-Acc-8Step.safetensors"
    };
    let conditioning = workflow
        .pointer("/12/inputs/conditioning")
        .cloned()
        .ok_or_else(|| "MiniMax-H3 conditioning 연결을 찾지 못했습니다.".to_string())?;
    let latent = workflow
        .pointer("/13/inputs/latent_image")
        .cloned()
        .ok_or_else(|| "MiniMax-H3 latent 연결을 찾지 못했습니다.".to_string())?;
    let root = workflow
        .as_object_mut()
        .ok_or_else(|| "MiniMax-H3 워크플로 루트가 객체가 아닙니다.".to_string())?;

    match profile {
        "quality-20" => {
            root.remove("7");
            root.insert(
                "10".into(),
                json!({"class_type":"KSamplerSelect","inputs":{"sampler_name":"res_multistep"}}),
            );
            root.insert("11".into(), json!({"class_type":"BasicScheduler","inputs":{"model":[attention_node,0],"scheduler":"simple","steps":20,"denoise":1.0}}));
            root.insert("12".into(), json!({"class_type":"BasicGuider","inputs":{"model":[attention_node,0],"conditioning":conditioning}}));
            root.insert("13".into(), json!({"class_type":"SamplerCustomAdvanced","inputs":{"noise":["9",0],"guider":["12",0],"sampler":["10",0],"sigmas":["11",0],"latent_image":latent}}));
        }
        "speed-4" => {
            root.insert("7".into(), json!({"class_type":"LoraLoaderModelOnly","inputs":{"model":[attention_node,0],"lora_name":turbo_4,"strength_model":1.0}}));
            let video_shift = if variant == "fl2va" { 6.0 } else { 12.0 };
            root.insert("50".into(), json!({"class_type":"MiniMaxH3SigmaShift","inputs":{"model":["7",0],"shift_video":video_shift,"shift_audio":3.0}}));
            root.remove("51");
            root.insert(
                "10".into(),
                json!({"class_type":"KSamplerSelect","inputs":{"sampler_name":"euler"}}),
            );
            root.insert("11".into(), json!({"class_type":"BasicScheduler","inputs":{"model":["50",0],"scheduler":"simple","steps":4,"denoise":1.0}}));
            root.insert("12".into(), json!({"class_type":"BasicGuider","inputs":{"model":["50",0],"conditioning":conditioning}}));
            root.insert("13".into(), json!({"class_type":"SamplerCustomAdvanced","inputs":{"noise":["9",0],"guider":["12",0],"sampler":["10",0],"sigmas":["11",0],"latent_image":latent}}));
        }
        "hybrid-8-4" => {
            root.insert("7".into(), json!({"class_type":"LoraLoaderModelOnly","inputs":{"model":[attention_node,0],"lora_name":turbo_4,"strength_model":1.0}}));
            root.insert("50".into(), json!({"class_type":"MiniMaxH3SigmaShift","inputs":{"model":[attention_node,0],"shift_video":12.0,"shift_audio":3.0}}));
            root.insert("51".into(), json!({"class_type":"MiniMaxH3PDDAccApply","inputs":{"model":["50",0],"pdd_file":pdd_file,"nfe":"8","lora_strength":1.0,"head_strength":1.0,"on_off_grid":"error","partition":"","enabled":true,"partition_check":"error"}}));
            root.insert(
                "52".into(),
                json!({"class_type":"KSamplerSelect","inputs":{"sampler_name":"euler"}}),
            );
            root.insert("53".into(), json!({"class_type":"BasicGuider","inputs":{"model":["51",0],"conditioning":conditioning}}));
            root.insert("54".into(), json!({"class_type":"SamplerCustomAdvanced","inputs":{"noise":["9",0],"guider":["53",0],"sampler":["52",0],"sigmas":["51",1],"latent_image":latent}}));
            root.insert(
                "10".into(),
                json!({"class_type":"KSamplerSelect","inputs":{"sampler_name":"euler"}}),
            );
            root.insert("11".into(), json!({"class_type":"ManualSigmas","inputs":{"sigmas":"0.9035, 0.6316, 0.3158, 0.0000"}}));
            root.insert("12".into(), json!({"class_type":"BasicGuider","inputs":{"model":["7",0],"conditioning":conditioning}}));
            root.insert("13".into(), json!({"class_type":"SamplerCustomAdvanced","inputs":{"noise":["9",0],"guider":["12",0],"sampler":["10",0],"sigmas":["11",0],"latent_image":["54",0]}}));
        }
        "turbo-8" => {
            root.insert("7".into(), json!({"class_type":"LoraLoaderModelOnly","inputs":{"model":[attention_node,0],"lora_name":MINIMAX_TURBO_V4_8STEP_LORA,"strength_model":1.0}}));
            root.insert("50".into(), json!({"class_type":"MiniMaxH3SigmaShift","inputs":{"model":["7",0],"shift_video":12.0,"shift_audio":5.0}}));
            root.remove("51");
            root.insert(
                "10".into(),
                json!({"class_type":"KSamplerSelect","inputs":{"sampler_name":"euler"}}),
            );
            root.insert("11".into(), json!({"class_type":"BasicScheduler","inputs":{"model":["50",0],"scheduler":"beta","steps":8,"denoise":1.0}}));
            root.insert("12".into(), json!({"class_type":"BasicGuider","inputs":{"model":["50",0],"conditioning":conditioning}}));
            root.insert("13".into(), json!({"class_type":"SamplerCustomAdvanced","inputs":{"noise":["9",0],"guider":["12",0],"sampler":["10",0],"sigmas":["11",0],"latent_image":latent}}));
        }
        _ => {
            root.insert("7".into(), json!({"class_type":"LoraLoaderModelOnly","inputs":{"model":[attention_node,0],"lora_name":MINIMAX_TURBO_V4_8STEP_LORA,"strength_model":1.0}}));
            root.insert(
                "10".into(),
                json!({"class_type":"KSamplerSelect","inputs":{"sampler_name":"res_multistep"}}),
            );
            root.insert("11".into(), json!({"class_type":"BasicScheduler","inputs":{"model":["7",0],"scheduler":"simple","steps":10,"denoise":1.0}}));
            root.insert("12".into(), json!({"class_type":"BasicGuider","inputs":{"model":["7",0],"conditioning":conditioning}}));
            root.insert("13".into(), json!({"class_type":"SamplerCustomAdvanced","inputs":{"noise":["9",0],"guider":["12",0],"sampler":["10",0],"sigmas":["11",0],"latent_image":latent}}));
        }
    }
    Ok(())
}

fn build_minimax_workflow(
    first: &str,
    last: &str,
    prompt: &str,
    width: u32,
    height: u32,
    duration: f64,
    prefix: &str,
    seed: Option<u64>,
    profile: &str,
    model_mode: &str,
    background_music: bool,
    latent_upscale_mode: &str,
) -> Result<(Value, u32), String> {
    if prompt.trim().is_empty() {
        return Err("영문 프롬프트를 입력해 주세요.".into());
    }
    if width < 64 || height < 64 || width % 32 != 0 || height % 32 != 0 {
        return Err("Minimax-H3 해상도는 가로·세로 64px 이상인 32의 배수여야 합니다.".into());
    }
    let length = minimax_frame_length(duration);
    let mut workflow: Value = serde_json::from_str(MINIMAX_WORKFLOW_JSON)
        .map_err(|error| format!("내장 Minimax-H3 워크플로를 읽지 못했습니다: {error}"))?;
    apply_minimax_model_mode(&mut workflow, "3", "fl2va", model_mode)?;
    workflow
        .as_object_mut()
        .ok_or_else(|| "Minimax-H3 워크플로 루트가 객체가 아닙니다.".to_string())?
        .insert(
            "18".into(),
            json!({
                "inputs": {
                    "model": ["3", 0],
                    "attention": "comfy kitchen attention"
                },
                "class_type": "ModelAttentionBackend",
                "_meta": {"title": "ModelAttentionBackend — COMFY KITCHEN ATTENTION"}
            }),
        );
    workflow
        .as_object_mut()
        .ok_or_else(|| "Minimax-H3 워크플로 루트가 객체가 아닙니다.".to_string())?
        .insert(
            "19".into(),
            json!({
                "inputs": {
                    "value": ["8", 0],
                    "clip": ["4", 0],
                    "wait_for": ["8", 1]
                },
                "class_type": "DenoTextEncoderUnload",
                "_meta": {"title": "Unload MiniMax-H3 text encoder before sampling"}
            }),
        );
    set_input(&mut workflow, "12", "conditioning", json!(["19", 0]))?;
    set_input(&mut workflow, "1", "image", json!(first))?;
    set_input(&mut workflow, "2", "image", json!(last))?;
    set_input(
        &mut workflow,
        "8",
        "prompt",
        json!(normalize_non_diegetic_music(prompt, background_music)),
    )?;
    set_input(&mut workflow, "8", "width", json!(width))?;
    set_input(&mut workflow, "8", "height", json!(height))?;
    set_input(&mut workflow, "8", "length", json!(length))?;
    set_input(&mut workflow, "9", "noise_seed", json!(seed.unwrap_or(1)))?;
    set_input(&mut workflow, "17", "filename_prefix", json!(prefix))?;
    apply_minimax_sampling_profile(&mut workflow, profile, "fl2va", "18")?;
    apply_minimax_latent_upscale(
        &mut workflow,
        latent_upscale_mode,
        width,
        height,
        profile,
        "fl2va",
        "18",
        &["14", "15"],
    )?;
    Ok((workflow, length))
}

fn build_minimax_ref2va_audio_workflow(
    video: &str,
    prompt: &str,
    width: u32,
    height: u32,
    duration: f64,
    prefix: &str,
    seed: Option<u64>,
    profile: &str,
    model_mode: &str,
    background_music: bool,
    latent_upscale_mode: &str,
) -> Result<(Value, u32), String> {
    if prompt.trim().is_empty() {
        return Err("오디오 연출 프롬프트를 입력해 주세요.".into());
    }
    if width < 32 || height < 32 || width % 32 != 0 || height % 32 != 0 {
        return Err("Video-to-Audio 해상도는 가로·세로 32px 이상이며 32의 배수여야 합니다.".into());
    }
    if !duration.is_finite() || duration < 0.2 {
        return Err("Video-to-Audio 영상 길이는 0.2초 이상이어야 합니다.".into());
    }
    let length = minimax_frame_length(duration);
    if length > MINIMAX_REF2VA_MAX_FRAMES {
        return Err(format!(
            "Video-to-Audio Ref2VA 구간이 너무 깁니다: {length}프레임. 각 구간을 149초 이하로 나눠 주세요."
        ));
    }
    let mut workflow: Value =
        serde_json::from_str(MINIMAX_REF2VA_AUDIO_WORKFLOW_JSON).map_err(|error| {
            format!("내장 MiniMax-H3 Ref2VA 오디오 워크플로를 읽지 못했습니다: {error}")
        })?;
    apply_minimax_model_mode(&mut workflow, "3", "ref2va", model_mode)?;
    let trimmed_prompt = prompt.trim();
    let official_sections = [
        "subject_definitions:",
        "summary:",
        "retention_analysis:",
        "detailed_description:",
        "overall_soundscape:",
        "non_diegetic_music:",
    ];
    let model_prompt = if official_sections
        .iter()
        .all(|section| trimmed_prompt.contains(section))
    {
        trimmed_prompt.to_string()
    } else {
        format!(
            "subject_definitions:\n<Video 1> is the silent visual reference for the target soundtrack. Its original audio is not copied or referenced.\n\nsummary:\n[reference generation] Generate a new soundtrack synchronized to the visible timeline of <Video 1>.\n\nretention_analysis:\n<Video 1> (visual timeline and timing): fully_preserved - visible events, scene changes, rhythm, and intensity guide the target soundtrack.\n\ndetailed_description:\n[Shot 1] Follow the visible actions and transitions of <Video 1>. Do not generate dialogue unless explicitly requested.\n\noverall_soundscape:\nGenerate ambience and physical sound effects supported by visible events in <Video 1>. User sound direction: {}\n\nnon_diegetic_music:\n{}",
            trimmed_prompt,
            if background_music { trimmed_prompt } else { "N/A" }
        )
    };
    workflow
        .as_object_mut()
        .ok_or_else(|| "Ref2VA 워크플로 루트가 객체가 아닙니다.".to_string())?
        .insert(
            "16".into(),
            json!({
                "inputs": {"model": ["3", 0], "attention": "comfy kitchen attention"},
                "class_type": "ModelAttentionBackend",
                "_meta": {"title": "ModelAttentionBackend — COMFY KITCHEN ATTENTION"}
            }),
        );
    workflow
        .as_object_mut()
        .ok_or_else(|| "Ref2VA 워크플로 루트가 객체가 아닙니다.".to_string())?
        .insert(
            "17".into(),
            json!({
                "inputs": {"value": ["8", 0], "clip": ["4", 0], "wait_for": ["8", 1]},
                "class_type": "DenoTextEncoderUnload",
                "_meta": {"title": "Unload MiniMax-H3 Ref2VA text encoder before sampling"}
            }),
        );
    set_input(&mut workflow, "1", "file", json!(video))?;
    set_input(
        &mut workflow,
        "8",
        "prompt",
        json!(normalize_non_diegetic_music(
            &model_prompt,
            background_music
        )),
    )?;
    set_input(&mut workflow, "8", "width", json!(width))?;
    set_input(&mut workflow, "8", "height", json!(height))?;
    set_input(&mut workflow, "8", "length", json!(length))?;
    set_input(&mut workflow, "9", "noise_seed", json!(seed.unwrap_or(1)))?;
    set_input(&mut workflow, "12", "conditioning", json!(["17", 0]))?;
    set_input(&mut workflow, "15", "filename_prefix", json!(prefix))?;
    apply_minimax_sampling_profile(&mut workflow, profile, "ref2va", "16")?;
    apply_minimax_latent_upscale(
        &mut workflow,
        latent_upscale_mode,
        width,
        height,
        profile,
        "ref2va",
        "16",
        &["14"],
    )?;
    Ok((workflow, length))
}

fn has_ref2va_sections(prompt: &str) -> bool {
    [
        "subject_definitions:",
        "summary:",
        "retention_analysis:",
        "detailed_description:",
        "overall_soundscape:",
        "non_diegetic_music:",
    ]
    .iter()
    .all(|section| prompt.contains(section))
}

fn build_minimax_ref2va_video_workflow(
    images: &[String],
    videos: &[String],
    prompt: &str,
    width: u32,
    height: u32,
    duration: f64,
    prefix: &str,
    seed: Option<u64>,
    ref_image_size: &str,
    profile: &str,
    model_mode: &str,
    background_music: bool,
    latent_upscale_mode: &str,
) -> Result<(Value, u32), String> {
    if images.is_empty() && videos.is_empty() {
        return Err("Ref2VA에는 레퍼런스 이미지 또는 영상이 하나 이상 필요합니다.".into());
    }
    if images.len() > 9 || videos.len() > 3 {
        return Err("Ref2VA는 이미지 최대 9개, 영상 최대 3개까지 지원합니다.".into());
    }
    let trimmed = prompt.trim();
    if !has_ref2va_sections(trimmed) {
        return Err("Ref2VA 프롬프트에 공식 6개 섹션이 모두 필요합니다.".into());
    }
    if width < 64 || height < 64 || width % 32 != 0 || height % 32 != 0 {
        return Err(
            "Minimax-H3 Ref2VA 해상도는 가로·세로 64px 이상인 32의 배수여야 합니다.".into(),
        );
    }
    let length = minimax_frame_length(duration);
    if length > MINIMAX_REF2VA_MAX_FRAMES {
        return Err(format!("Ref2VA 영상이 너무 깁니다: {length}프레임"));
    }
    let mut workflow: Value =
        serde_json::from_str(MINIMAX_REF2VA_VIDEO_WORKFLOW_JSON).map_err(|error| {
            format!("내장 MiniMax-H3 Ref2VA 영상 워크플로를 읽지 못했습니다: {error}")
        })?;
    apply_minimax_model_mode(&mut workflow, "3", "ref2va", model_mode)?;
    let root = workflow
        .as_object_mut()
        .ok_or_else(|| "Ref2VA 영상 워크플로 루트가 객체가 아닙니다.".to_string())?;
    root.insert(
        "18".into(),
        json!({"inputs":{"model":["3",0],"attention":"comfy kitchen attention"},"class_type":"ModelAttentionBackend","_meta":{"title":"ModelAttentionBackend — COMFY KITCHEN ATTENTION"}}),
    );
    root.insert(
        "19".into(),
        json!({"inputs":{"value":["8",0],"clip":["4",0],"wait_for":["8",1]},"class_type":"DenoTextEncoderUnload","_meta":{"title":"Unload MiniMax-H3 Ref2VA text encoder before sampling"}}),
    );
    for (index, image) in images.iter().enumerate() {
        let node = format!("{}", 100 + index);
        root.insert(
            node,
            json!({"class_type":"LoadImage","inputs":{"image":image}}),
        );
    }
    for (index, video) in videos.iter().enumerate() {
        let load = format!("{}", 200 + index * 2);
        let components = format!("{}", 201 + index * 2);
        root.insert(
            load.clone(),
            json!({"class_type":"LoadVideo","inputs":{"file":video}}),
        );
        root.insert(
            components,
            json!({"class_type":"GetVideoComponents","inputs":{"video":[load,0]}}),
        );
    }
    let _ = root;
    for index in 0..images.len() {
        set_input(
            &mut workflow,
            "8",
            &format!("ref_images.ref_image_{index}"),
            json!([format!("{}", 100 + index), 0]),
        )?;
    }
    for index in 0..videos.len() {
        set_input(
            &mut workflow,
            "8",
            &format!("ref_videos.ref_video_{index}"),
            json!([format!("{}", 201 + index * 2), 0]),
        )?;
    }
    set_input(
        &mut workflow,
        "8",
        "prompt",
        json!(normalize_non_diegetic_music(trimmed, background_music)),
    )?;
    set_input(&mut workflow, "8", "width", json!(width))?;
    set_input(&mut workflow, "8", "height", json!(height))?;
    set_input(&mut workflow, "8", "length", json!(length))?;
    set_input(
        &mut workflow,
        "8",
        "ref_image_size",
        json!(if ref_image_size == "max" {
            "max"
        } else {
            "match"
        }),
    )?;
    set_input(&mut workflow, "9", "noise_seed", json!(seed.unwrap_or(1)))?;
    set_input(&mut workflow, "12", "conditioning", json!(["19", 0]))?;
    set_input(&mut workflow, "17", "filename_prefix", json!(prefix))?;
    apply_minimax_sampling_profile(&mut workflow, profile, "ref2va", "18")?;
    apply_minimax_latent_upscale(
        &mut workflow,
        latent_upscale_mode,
        width,
        height,
        profile,
        "ref2va",
        "18",
        &["14", "15"],
    )?;
    Ok((workflow, length))
}

fn build_minimax_context_workflow(
    first: &str,
    last_images: &[String],
    shots: &[ContextLoopShotInput],
    width: u32,
    height: u32,
    run_name: &str,
    is_test: bool,
    profile: &str,
    model_mode: &str,
    background_music: bool,
) -> Result<(Value, u32), String> {
    if shots.is_empty() || shots.len() != last_images.len() {
        return Err("연속 영상에는 FIRST와 하나 이상의 LAST/프롬프트가 필요합니다.".into());
    }
    if shots.len() > 128 {
        return Err("연속 영상은 한 번에 최대 128개 컷까지 지원합니다.".into());
    }
    if width < 64 || height < 64 || width % 32 != 0 || height % 32 != 0 {
        return Err(
            "Minimax-H3 연속 영상 해상도는 가로·세로 64px 이상인 32의 배수여야 합니다.".into(),
        );
    }
    if shots.iter().any(|shot| shot.prompt.trim().is_empty()) {
        return Err("모든 컷에 영문 프롬프트를 입력해 주세요.".into());
    }

    let mut workflow: Value =
        serde_json::from_str(MINIMAX_CONTEXT_WORKFLOW_JSON).map_err(|error| {
            format!("내장 Minimax-H3 Context Loop 워크플로를 읽지 못했습니다: {error}")
        })?;
    apply_minimax_model_mode(&mut workflow, "1", "fl2va", model_mode)?;

    // Keep the exact model catalogue values used by FrameFlow's verified
    // single-cut MiniMax-H3 workflow.  The official example ships with
    // author-specific subfolders and a different Qwen quantization.
    set_input(
        &mut workflow,
        "2",
        "clip_name",
        json!("qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"),
    )?;
    set_input(
        &mut workflow,
        "3",
        "vae_name",
        json!("minimax_h3_video_vae_fp16.safetensors"),
    )?;
    set_input(
        &mut workflow,
        "4",
        "vae_name",
        json!("minimax_h3_audio_vae_fp32.safetensors"),
    )?;
    let profile = normalize_minimax_profile(Some(profile));
    if profile == "hybrid-8-4" {
        return Err("PDD 하이브리드 계열은 전용 Context Loop sampler와 호환되지 않습니다. 연속 영상에서는 Turbo 8step·10step 또는 품질우선 20step을 선택해 주세요.".into());
    }
    let context_steps = match profile {
        "quality-20" => 20,
        "turbo-8" => 8,
        "speed-4" => 4,
        _ => 10,
    };
    if profile == "quality-20" {
        workflow.as_object_mut().unwrap().remove("2000");
        set_input(&mut workflow, "5", "model", json!(["1941", 0]))?;
    } else {
        let context_lora = if profile == "speed-4" {
            "minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors"
        } else {
            MINIMAX_TURBO_V4_8STEP_LORA
        };
        workflow.as_object_mut().unwrap().insert(
            "2000".into(),
            json!({
                "inputs": {
                    "model": ["1941", 0],
                    "lora_name": context_lora,
                    "strength_model": 1.0
                },
                "class_type": "LoraLoaderModelOnly",
                "_meta": {"title": "FrameFlow MiniMax-H3 Turbo LoRA"}
            }),
        );
        set_input(&mut workflow, "5", "model", json!(["2000", 0]))?;
        if profile == "turbo-8" {
            set_input(&mut workflow, "5", "shift_audio", json!(5.0))?;
            set_input(&mut workflow, "122", "sampler_name", json!("euler"))?;
            set_input(&mut workflow, "123", "scheduler", json!("beta"))?;
        } else if profile == "speed-4" {
            set_input(&mut workflow, "5", "shift_video", json!(6.0))?;
            set_input(&mut workflow, "5", "shift_audio", json!(3.0))?;
            set_input(&mut workflow, "122", "sampler_name", json!("euler"))?;
            set_input(&mut workflow, "123", "scheduler", json!("simple"))?;
        }
    }

    set_input(&mut workflow, "1945", "image", json!(first))?;
    let mut target_node_ids = Vec::with_capacity(last_images.len());
    for (index, image) in last_images.iter().enumerate() {
        let node_id = format!("21{:03}", index + 1);
        workflow.as_object_mut().unwrap().insert(
            node_id.clone(),
            json!({
                "inputs": {"image": image},
                "class_type": "LoadImage",
                "_meta": {"title": format!("LAST {}", index + 1)}
            }),
        );
        target_node_ids.push(node_id);
    }

    let plan_shots: Vec<Value> = shots
        .iter()
        .enumerate()
        .map(|(index, shot)| {
            json!({
                "id": format!("cut_{:03}", index + 1),
                "prompt": normalize_non_diegetic_music(&shot.prompt, background_music),
                "length": minimax_frame_length(shot.duration),
                "seed": shot.seed.unwrap_or((index + 1) as u64).to_string(),
                "continuation_mode": "latent_guide",
                // Carry both generated video and audio context. The FrameFlow
                // fork activates Context Loop's cond_audio-compatible engine.
                "generated_continuity": "on"
            })
        })
        .collect();
    let plan = json!({
        "defaults": {"duration_seconds": 5, "steps": context_steps},
        "shots": plan_shots
    });
    let total_frames = shots
        .iter()
        .map(|shot| minimax_frame_length(shot.duration))
        .sum();

    // Encode all prompts first in one node, then all image keyframes. This
    // prevents the 15 GB text encoder and the 20 GB diffusion model from being
    // alternately loaded once per cut.
    let mut prefetch_inputs = serde_json::Map::new();
    prefetch_inputs.insert("clip".into(), json!(["2", 0]));
    prefetch_inputs.insert("vae".into(), json!(["3", 0]));
    prefetch_inputs.insert("width".into(), json!(width));
    prefetch_inputs.insert("height".into(), json!(height));
    prefetch_inputs.insert("first_frame".into(), json!(["1945", 0]));
    for (index, shot) in shots.iter().enumerate() {
        prefetch_inputs.insert(
            format!("prompt_{}", index + 1),
            json!(normalize_non_diegetic_music(&shot.prompt, background_music)),
        );
        prefetch_inputs.insert(
            format!("length_{}", index + 1),
            json!(minimax_frame_length(shot.duration)),
        );
        prefetch_inputs.insert(
            format!("last_frame_{}", index + 1),
            json!([target_node_ids[index], 0]),
        );
    }
    workflow.as_object_mut().unwrap().insert(
        "22000".into(),
        json!({
            "inputs": Value::Object(prefetch_inputs),
            "class_type": "FrameFlowH3ConditioningPrefetch",
            "_meta": {"title": "FrameFlow H3 conditioning prefetch"}
        }),
    );
    workflow.as_object_mut().unwrap().insert(
        "22001".into(),
        json!({
            "inputs": {
                "state": ["1702", 0],
                "bank": ["22002", 0]
            },
            "class_type": "FrameFlowH3ConditioningSelect",
            "_meta": {"title": "FrameFlow H3 conditioning selector"}
        }),
    );
    // Prefetch owns the only text-encoding pass for the complete scene. Once
    // all cut conditionings and visual anchors are stored in the bank, unload
    // that exact CLIP/text encoder before the recursive video sampler starts.
    // The custom bank passes through unchanged; diffusion models and VAEs are
    // deliberately not touched by this targeted Deno node.
    workflow.as_object_mut().unwrap().insert(
        "22002".into(),
        json!({
            "inputs": {
                "value": ["22000", 0],
                "clip": ["2", 0],
                "wait_for": ["22000", 1]
            },
            "class_type": "DenoTextEncoderUnload",
            "_meta": {"title": "Unload MiniMax-H3 text encoder after scene prefetch"}
        }),
    );
    set_input(&mut workflow, "1703", "conditioning", json!(["22001", 0]))?;
    set_input(&mut workflow, "1703", "latent", json!(["22001", 1]))?;
    // Generated continuity can carry an audio latent from the preceding clip.
    // Chain Context must receive the H3 Audio VAE before it can conform that
    // audio to the next clip's timeline.
    set_input(&mut workflow, "1703", "audio_vae", json!(["4", 0]))?;
    for unused in ["110", "1946", "1947", "1948"] {
        workflow.as_object_mut().unwrap().remove(unused);
    }

    set_input(
        &mut workflow,
        "1700",
        "plan_json",
        json!(serde_json::to_string_pretty(&plan).unwrap()),
    )?;
    set_input(&mut workflow, "1700", "run_name", json!(run_name))?;
    set_input(
        &mut workflow,
        "1700",
        "generation_fingerprint",
        json!(format!("frameflow-{run_name}")),
    )?;
    set_input(&mut workflow, "1700", "width", json!(width))?;
    set_input(&mut workflow, "1700", "height", json!(height))?;
    set_input(&mut workflow, "1700", "context_length", json!(22))?;
    set_input(&mut workflow, "1700", "default_steps", json!(context_steps))?;
    set_input(
        &mut workflow,
        "1700",
        "continuation_mode",
        json!("latent_guide"),
    )?;
    // ChainPolicy accepts high-level presets. `guide` selects its 22-frame
    // continuation preset, while Plan and every shot retain `latent_guide`.
    // Generated audio continuity is now carried through the same chain.
    set_input(&mut workflow, "1952", "incoming_transition", json!("guide"))?;
    set_input(&mut workflow, "1952", "generated_continuity", json!("on"))?;
    set_input(&mut workflow, "1944", "enabled", json!(false))?;
    set_input(
        &mut workflow,
        "1706",
        "filename",
        json!("frameflow_context_loop"),
    )?;
    set_input(&mut workflow, "1706", "copy_to_output", json!(false))?;
    if is_test {
        // Match tnew.json's KSamplerSelect without changing its independent
        // scheduler, step count, or the normal continuous-generation sampler.
        set_input(&mut workflow, "122", "sampler_name", json!("euler"))?;
        // Keep the sampled AV latent intact. Both decoders must wait for
        // cleanup, but full-size chains keep their original graph unchanged.
        workflow.as_object_mut().unwrap().insert(
            "22003".into(),
            json!({
                "inputs": {
                    "any_input": ["124", 0],
                    "empty_cache": true,
                    "gc_collect": true,
                    "unload_all_models": true
                },
                "class_type": "VRAM_Debug",
                "_meta": {"title": "Clean VRAM before VAE Decode (continuous TEST only)"}
            }),
        );
        for decoder in ["130", "131"] {
            set_input(&mut workflow, decoder, "samples", json!(["22003", 0]))?;
        }
    }
    Ok((workflow, total_frames))
}

fn build_minimax_ref2va_context_workflow(
    images: &[String],
    videos: &[String],
    audios: &[String],
    shots: &[ContextLoopShotInput],
    width: u32,
    height: u32,
    run_name: &str,
    is_test: bool,
    profile: &str,
    model_mode: &str,
    background_music: bool,
    ref_image_size: &str,
) -> Result<(Value, u32), String> {
    if images.is_empty() && videos.is_empty() && audios.is_empty() {
        return Err(
            "Ref2VA 연속 씬에는 이미지·영상·오디오 레퍼런스가 하나 이상 필요합니다.".into(),
        );
    }
    if images.len() > 9 || videos.len() > 3 || audios.len() > 3 {
        return Err("Ref2VA 연속 씬은 이미지 9개, 영상 3개, 오디오 3개까지 지원합니다.".into());
    }
    if shots
        .iter()
        .any(|shot| !has_ref2va_sections(shot.prompt.trim()))
    {
        return Err("Ref2VA 연속 씬의 모든 컷에 공식 6섹션 영문 프롬프트가 필요합니다.".into());
    }

    // Reuse the verified Context Loop graph, then replace its FL2VA
    // conditioning bank with a reference-aware bank. The chain, checkpoint,
    // 22-frame latent continuation and per-clip submission remain identical.
    let placeholders = vec!["unused-ref2va-target.png".to_string(); shots.len()];
    let (mut workflow, total_frames) = build_minimax_context_workflow(
        "unused-ref2va-first.png",
        &placeholders,
        shots,
        width,
        height,
        run_name,
        is_test,
        profile,
        model_mode,
        background_music,
    )?;
    apply_minimax_model_mode(&mut workflow, "1", "ref2va", model_mode)?;
    if workflow.get("2000").is_some() {
        let ref_lora = if normalize_minimax_profile(Some(profile)) == "speed-4" {
            "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"
        } else {
            MINIMAX_TURBO_V4_8STEP_LORA
        };
        set_input(&mut workflow, "2000", "lora_name", json!(ref_lora))?;
        if normalize_minimax_profile(Some(profile)) == "speed-4" {
            set_input(&mut workflow, "5", "shift_video", json!(12.0))?;
        }
    }
    let root = workflow
        .as_object_mut()
        .ok_or_else(|| "Ref2VA 연속 워크플로 루트가 객체가 아닙니다.".to_string())?;
    root.remove("1945");
    root.retain(|node, _| !node.starts_with("21"));

    let mut prefetch_inputs = serde_json::Map::new();
    prefetch_inputs.insert("clip".into(), json!(["2", 0]));
    prefetch_inputs.insert("vae".into(), json!(["3", 0]));
    prefetch_inputs.insert("audio_vae".into(), json!(["4", 0]));
    prefetch_inputs.insert("width".into(), json!(width));
    prefetch_inputs.insert("height".into(), json!(height));
    prefetch_inputs.insert(
        "ref_image_size".into(),
        json!(if ref_image_size == "max" {
            "max"
        } else {
            "match"
        }),
    );
    for (index, shot) in shots.iter().enumerate() {
        prefetch_inputs.insert(
            format!("prompt_{}", index + 1),
            json!(normalize_non_diegetic_music(&shot.prompt, background_music)),
        );
        prefetch_inputs.insert(
            format!("length_{}", index + 1),
            json!(minimax_frame_length(shot.duration)),
        );
    }
    for (index, image) in images.iter().enumerate() {
        let node = format!("230{:02}", index + 1);
        root.insert(
            node.clone(),
            json!({"class_type":"LoadImage","inputs":{"image":image}}),
        );
        prefetch_inputs.insert(format!("ref_image_{}", index + 1), json!([node, 0]));
    }
    for (index, video) in videos.iter().enumerate() {
        let load = format!("231{:02}", index + 1);
        let parts = format!("232{:02}", index + 1);
        root.insert(
            load.clone(),
            json!({"class_type":"LoadVideo","inputs":{"file":video}}),
        );
        root.insert(
            parts.clone(),
            json!({"class_type":"GetVideoComponents","inputs":{"video":[load,0]}}),
        );
        prefetch_inputs.insert(
            format!("ref_video_{}", index + 1),
            json!([parts.clone(), 0]),
        );
        // A video's embedded soundtrack is deliberately not registered as an
        // implicit <Audio N>: standalone audio files own the stable UI labels.
        // Users who need the soundtrack as a reference add it explicitly.
    }
    for (index, audio) in audios.iter().enumerate() {
        let node = format!("233{:02}", index + 1);
        root.insert(
            node.clone(),
            json!({"class_type":"LoadAudio","inputs":{"audio":audio}}),
        );
        prefetch_inputs.insert(format!("ref_audio_{}", index + 1), json!([node, 0]));
    }
    root.insert(
        "22000".into(),
        json!({
            "inputs": Value::Object(prefetch_inputs),
            "class_type": "FrameFlowH3Ref2VAConditioningPrefetch",
            "_meta": {"title": "FrameFlow Ref2VA conditioning prefetch"}
        }),
    );
    Ok((workflow, total_frames))
}

fn build_minimax_existing_video_workflow(
    source_video: &str,
    first_image: Option<&str>,
    last_image: Option<&str>,
    shot: &ContextLoopShotInput,
    width: u32,
    height: u32,
    run_name: &str,
    profile: &str,
    model_mode: &str,
    background_music: bool,
) -> Result<(Value, u32), String> {
    let shots = vec![shot.clone()];
    let placeholders = vec!["unused-extension-target.png".to_string()];
    let (mut workflow, total_frames) = build_minimax_context_workflow(
        "unused-extension-first.png",
        &placeholders,
        &shots,
        width,
        height,
        run_name,
        false,
        profile,
        model_mode,
        background_music,
    )?;

    // Existing-video continuation is a prompt-only Ref2VA conditioning path.
    // The source movie is not a long-lived reference: ExternalVideo imports
    // only its normalized final 22 frames into scene 1's latent context and
    // optionally prepends the normalized original during final assembly.
    apply_minimax_model_mode(&mut workflow, "1", "ref2va", model_mode)?;
    if workflow.get("2000").is_some() && normalize_minimax_profile(Some(profile)) == "speed-4" {
        set_input(
            &mut workflow,
            "2000",
            "lora_name",
            json!("minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"),
        )?;
        set_input(&mut workflow, "5", "shift_video", json!(12.0))?;
    }
    let root = workflow
        .as_object_mut()
        .ok_or_else(|| "기존 영상 확장 워크플로 루트가 객체가 아닙니다.".to_string())?;
    root.remove("1945");
    root.retain(|node, _| !node.starts_with("21"));
    for node in ["22000", "22001", "22002"] {
        root.remove(node);
    }
    root.insert(
        "110".into(),
        json!({
            "class_type": "MiniMaxH3ReferenceToVideo",
            "inputs": {
                "clip": ["2", 0],
                "vae": ["3", 0],
                "audio_vae": ["4", 0],
                "prompt": ["1702", 4],
                "width": ["1702", 8],
                "height": ["1702", 9],
                "length": ["1702", 6],
                "ref_image_size": "match"
            },
            "_meta": {"title": "MiniMax H3 extension conditioning"}
        }),
    );
    if let (Some(first), Some(last)) = (first_image, last_image) {
        root.insert(
            "24002".into(),
            json!({"class_type":"LoadImage","inputs":{"image":first},"_meta":{"title":"Internal source final frame"}}),
        );
        root.insert(
            "24003".into(),
            json!({"class_type":"LoadImage","inputs":{"image":last},"_meta":{"title":"Optional extension LAST"}}),
        );
        root.insert(
            "110".into(),
            json!({
                "class_type": "MiniMaxH3ImageToVideo",
                "inputs": {
                    "clip": ["2", 0],
                    "vae": ["3", 0],
                    "prompt": ["1702", 4],
                    "width": ["1702", 8],
                    "height": ["1702", 9],
                    "length": ["1702", 6],
                    "first_frame": ["24002", 0],
                    "last_frame": ["24003", 0]
                },
                "_meta": {"title": "Extension with optional LAST target"}
            }),
        );
    }
    root.insert(
        "22002".into(),
        json!({
            "class_type": "DenoTextEncoderUnload",
            "inputs": {
                "value": ["110", 0],
                "clip": ["2", 0],
                "wait_for": ["110", 1]
            },
            "_meta": {"title": "Unload H3 text encoder before extension sampling"}
        }),
    );
    root.insert(
        "24000".into(),
        json!({
            "class_type": "LoadVideo",
            "inputs": {"file": source_video},
            "_meta": {"title": "Source video to extend"}
        }),
    );
    root.insert(
        "24001".into(),
        json!({
            "class_type": "MiniMaxH3ChainExternalVideo",
            "inputs": {
                "plan": ["1700", 0],
                "source_fps": 24.0,
                "prepend_original": true,
                "source_video": ["24000", 0]
            },
            "_meta": {"title": "Use final 22 frames of selected video"}
        }),
    );
    set_input(
        &mut workflow,
        "1701",
        "external_context",
        json!(["24001", 0]),
    )?;
    set_input(&mut workflow, "1703", "conditioning", json!(["22002", 0]))?;
    set_input(&mut workflow, "1703", "latent", json!(["110", 1]))?;
    set_input(&mut workflow, "1703", "audio_vae", json!(["4", 0]))?;
    set_input(
        &mut workflow,
        "1706",
        "filename",
        json!("frameflow_video_extension"),
    )?;
    set_input(&mut workflow, "1706", "copy_to_output", json!(false))?;
    Ok((workflow, total_frames))
}

fn context_test_clip_workflow(
    workflow: &Value,
    clip: usize,
    count: usize,
) -> Result<Value, String> {
    if clip == 0 || clip > count {
        return Err("연속 TEST 클립 범위가 잘못되었습니다.".into());
    }
    let mut current = workflow.clone();
    // Keep the entire plan, run identity, seeds and conditioning bank stable.
    // Start restores the predecessor's saved context/AV tensors from disk.
    for node in ["1951", "1701"] {
        set_input(&mut current, node, "start_clip", json!(clip))?;
        set_input(&mut current, node, "scene_range", json!(clip.to_string()))?;
        set_input(&mut current, node, "verify_resume_history", json!(true))?;
    }
    if clip < count {
        // Disabled Review is an OUTPUT_NODE and depends on SegmentSave. Its
        // completion means the video and checkpoint were durably saved. Do
        // not recurse or assemble partial movies after intermediate clips.
        current.as_object_mut().unwrap().remove("1705");
        current.as_object_mut().unwrap().remove("1706");
    }
    Ok(current)
}

async fn run_context_test_clips(
    http: &Client,
    base: &str,
    client_id: &str,
    workflow: &Value,
    count: usize,
    cancellation: &AtomicU64,
    epoch: u64,
    poll_interval: Duration,
    mut progress: impl FnMut(usize, &str, &str),
) -> Result<
    (
        String,
        (String, String, String),
        Vec<String>,
        Vec<(String, String, String)>,
    ),
    String,
> {
    let check_cancelled = || {
        if cancellation.load(Ordering::SeqCst) != epoch {
            Err("연속 TEST 작업이 취소되어 다음 클립을 제출하지 않습니다.".to_string())
        } else {
            Ok(())
        }
    };
    let mut prompt_ids = Vec::with_capacity(count);
    let mut segment_refs = Vec::with_capacity(count);
    for clip in 1..=count {
        check_cancelled()?;
        let current = context_test_clip_workflow(workflow, clip, count)?;
        progress(clip, "submitting", "");
        check_cancelled()?;
        let response = http
            .post(format!("{base}/prompt"))
            .json(&json!({"prompt": current, "client_id": client_id}))
            .send()
            .await
            .map_err(|error| format!("연속 TEST C{clip:02} 제출 실패: {error}"))?;
        let queued = response_json(response, &format!("연속 TEST C{clip:02} 제출")).await?;
        let prompt_id = queued
            .get("prompt_id")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("ComfyUI가 prompt_id를 반환하지 않았습니다: {queued}"))?
            .to_string();
        prompt_ids.push(prompt_id.clone());
        progress(clip, "running", &prompt_id);
        loop {
            check_cancelled()?;
            tokio::time::sleep(poll_interval).await;
            check_cancelled()?;
            let response = http
                .get(format!("{base}/history/{prompt_id}"))
                .send()
                .await
                .map_err(|error| format!("연속 TEST C{clip:02} 상태 확인 실패: {error}"))?;
            let history = response_json(response, "연속 TEST 클립 완료 확인").await?;
            let Some(entry) = history.get(&prompt_id) else {
                continue;
            };
            if entry.pointer("/status/status_str").and_then(Value::as_str) == Some("error") {
                return Err(format!(
                    "연속 TEST C{clip:02}/{count} 실패: {}. 다음 클립은 제출하지 않습니다.",
                    comfy_execution_error(entry)
                ));
            }
            // Do not advance on a preview/partial output: wait for execution
            // completion, including SegmentSave and the final Assemble node.
            if entry.pointer("/status/completed").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            check_cancelled()?;
            if clip == count {
                if let Some(segment) = entry
                    .pointer("/outputs/1704")
                    .and_then(find_context_final_video_ref)
                {
                    segment_refs.push(segment);
                }
                let video = entry
                    .pointer("/outputs/1706")
                    .and_then(find_context_final_video_ref)
                    .ok_or_else(|| {
                        "연속 TEST 마지막 클립은 완료됐지만 합본 영상이 없습니다.".to_string()
                    })?;
                progress(clip, "completed", &prompt_id);
                return Ok((prompt_id, video, prompt_ids, segment_refs));
            }
            let expected = format!("review bypassed for clip {clip}");
            let saved = entry
                .pointer("/outputs/1944/text")
                .and_then(Value::as_array)
                .is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item.as_str() == Some(expected.as_str()))
                });
            if !saved {
                return Err(format!("연속 TEST C{clip:02} 체크포인트 저장 완료를 확인하지 못했습니다. 다음 클립은 제출하지 않습니다."));
            }
            if let Some(segment) = entry
                .pointer("/outputs/1704")
                .and_then(find_context_final_video_ref)
            {
                segment_refs.push(segment);
            }
            progress(clip, "completed", &prompt_id);
            // No /free here: retain the shared scene conditioning bank so the
            // next prompt can reuse it without re-encoding every text prompt.
            break;
        }
    }
    Err("연속 TEST에 생성할 클립이 없습니다.".into())
}

fn collect_context_video_refs(value: &Value, refs: &mut Vec<(i32, String, String, String)>) {
    match value {
        Value::Object(map) => {
            if let Some(filename) = map.get("filename").and_then(Value::as_str) {
                let extension = Path::new(filename)
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                if ["mp4", "webm", "mov", "mkv"]
                    .iter()
                    .any(|item| extension.eq_ignore_ascii_case(item))
                {
                    let subfolder = map
                        .get("subfolder")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let kind = map
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("output")
                        .to_string();
                    let key = format!("{}\\{}", subfolder, filename).to_lowercase();
                    let score = if key.contains("frameflow_context_loop") {
                        200
                    } else {
                        0
                    } + if key.contains("\\final\\") || key.contains("/final/") {
                        100
                    } else {
                        0
                    } - if key.contains("\\segments\\") || key.contains("/segments/") {
                        20
                    } else {
                        0
                    };
                    refs.push((score, filename.to_string(), subfolder, kind));
                }
            }
            for child in map.values() {
                collect_context_video_refs(child, refs);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_context_video_refs(child, refs);
            }
        }
        _ => {}
    }
}

fn find_context_final_video_ref(value: &Value) -> Option<(String, String, String)> {
    let mut refs = Vec::new();
    collect_context_video_refs(value, &mut refs);
    refs.into_iter()
        .max_by_key(|item| item.0)
        .map(|(_, filename, subfolder, kind)| (filename, subfolder, kind))
}

async fn download_comfy_output(
    http: &Client,
    base: &str,
    filename: &str,
    subfolder: &str,
    kind: &str,
    output_path: &str,
) -> Result<PathBuf, String> {
    let extension = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("mp4");
    let target = PathBuf::from(output_path).with_extension(extension);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("연속 영상 폴더를 만들지 못했습니다: {error}"))?;
    }
    let response = http
        .get(format!("{base}/view"))
        .query(&[
            ("filename", filename),
            ("subfolder", subfolder),
            ("type", kind),
        ])
        .send()
        .await
        .map_err(|error| format!("ComfyUI 연속 영상 다운로드 실패: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "ComfyUI 연속 영상 다운로드 실패: HTTP {}",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("ComfyUI 연속 영상 읽기 실패: {error}"))?;
    fs::write(&target, bytes)
        .map_err(|error| format!("연속 영상을 저장하지 못했습니다: {error}"))?;
    Ok(target)
}

fn recover_local_context_output(
    job_id: &str,
    output_path: &str,
) -> Result<Option<PathBuf>, String> {
    let queued_at = job_id
        .split('-')
        .find_map(|part| {
            (part.len() >= 13)
                .then(|| part.parse::<u64>().ok())
                .flatten()
        })
        .unwrap_or_default();
    let local = std::env::var("LOCALAPPDATA")
        .map_err(|_| "LOCALAPPDATA 경로를 확인할 수 없습니다.".to_string())?;
    let root = PathBuf::from(local)
        .join("Comfy-Desktop")
        .join("ComfyUI-Shared")
        .join("output")
        .join("h3_chains");
    if !root.is_dir() {
        return Ok(None);
    }
    let mut candidates = Vec::new();
    for entry in
        fs::read_dir(&root).map_err(|error| format!("Comfy 연속 영상 폴더 확인 실패: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Comfy 연속 영상 항목 확인 실패: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let run_stamp = name
            .strip_prefix("frameflow_context_")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or_default()
            .saturating_mul(1000);
        if queued_at > 0 && run_stamp < queued_at {
            continue;
        }
        let candidate = entry
            .path()
            .join("final")
            .join("frameflow_context_loop.mp4");
        if candidate.is_file() {
            let modified = fs::metadata(&candidate)
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_millis())
                .unwrap_or_default();
            candidates.push((modified, candidate));
        }
    }
    let Some((_, source)) = candidates.into_iter().max_by_key(|item| item.0) else {
        return Ok(None);
    };
    let target = PathBuf::from(output_path).with_extension("mp4");
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("연속 영상 복구 폴더를 만들지 못했습니다: {error}"))?;
    }
    fs::copy(&source, &target)
        .map_err(|error| format!("완료된 연속 영상을 프로젝트로 복구하지 못했습니다: {error}"))?;
    Ok(Some(target))
}

fn find_video(value: &Value) -> Option<Value> {
    match value {
        Value::Object(map) => {
            if let Some(filename) = map.get("filename").and_then(Value::as_str) {
                let format = map.get("format").and_then(Value::as_str).unwrap_or("");
                let extension = Path::new(filename)
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                if ["mp4", "webm", "mov", "mkv"]
                    .iter()
                    .any(|item| extension.eq_ignore_ascii_case(item))
                    || format.starts_with("video/")
                {
                    return Some(value.clone());
                }
            }
            map.values().find_map(find_video)
        }
        Value::Array(values) => values.iter().find_map(find_video),
        _ => None,
    }
}

fn find_audio(value: &Value) -> Option<Value> {
    match value {
        Value::Object(map) => {
            if let Some(filename) = map.get("filename").and_then(Value::as_str) {
                let extension = Path::new(filename)
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                if ["mp3", "wav", "flac", "ogg", "opus", "m4a"]
                    .iter()
                    .any(|item| extension.eq_ignore_ascii_case(item))
                {
                    return Some(value.clone());
                }
            }
            map.values().find_map(find_audio)
        }
        Value::Array(values) => values.iter().find_map(find_audio),
        _ => None,
    }
}

fn comfy_execution_error(entry: &Value) -> String {
    let payload = entry
        .pointer("/status/messages")
        .and_then(Value::as_array)
        .and_then(|messages| {
            messages.iter().find_map(|message| {
                let parts = message.as_array()?;
                (parts.first()?.as_str()? == "execution_error")
                    .then(|| parts.get(1))
                    .flatten()
            })
        });
    if let Some(payload) = payload {
        let node = payload
            .get("node_type")
            .and_then(Value::as_str)
            .unwrap_or("Comfy 노드");
        let kind = payload
            .get("exception_type")
            .and_then(Value::as_str)
            .unwrap_or("오류");
        let message = payload
            .get("exception_message")
            .and_then(Value::as_str)
            .unwrap_or("상세 메시지가 없습니다")
            .trim();
        return format!("{node} · {kind}: {message}");
    }
    "ComfyUI 작업이 실패했습니다. Comfy 로그를 확인해 주세요.".into()
}

fn output_target(requested: &str, filename: &str) -> PathBuf {
    let requested = PathBuf::from(requested);
    match Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
    {
        Some(extension) if !extension.is_empty() => requested.with_extension(extension),
        _ => requested,
    }
}

async fn server_available(base: &str) -> bool {
    matches!(server_health(base).await, ServerHealth::Ready)
}

async fn comfy_input_has_option(
    http: &Client,
    base: &str,
    class_name: &str,
    input_name: &str,
    expected: &str,
) -> bool {
    let Ok(response) = http
        .get(format!("{base}/object_info/{class_name}"))
        .send()
        .await
    else {
        return false;
    };
    let Ok(value) = response.json::<Value>().await else {
        return false;
    };
    value
        .pointer(&format!("/{class_name}/input/required/{input_name}/0"))
        .and_then(Value::as_array)
        .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(expected)))
}

async fn ensure_minimax_optimization_nodes(
    http: &Client,
    base: &str,
    require_latent_upscaler: bool,
) -> Result<(), String> {
    let mut required = vec![
        ("ModelAttentionBackend", "Comfy Kitchen Attention"),
        ("DenoTextEncoderUnload", "(Deno) Text Encoder Unload"),
    ];
    if require_latent_upscaler {
        required.extend([
            (
                "MinimaxH3LatentUpscaler3D",
                "MiniMax H3 Latent Upscaler (3D)",
            ),
            ("LTXVSeparateAVLatent", "Separate AV Latent"),
            ("LTXVConcatAVLatent", "Concat AV Latent"),
        ]);
    }
    for (class_name, label) in required {
        let response = http
            .get(format!("{base}/object_info/{class_name}"))
            .send()
            .await
            .map_err(|error| format!("{label} 노드 확인 실패: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "MiniMax-H3 최적화에 필요한 {label} 노드가 없습니다. Comfy Desktop의 custom_nodes 설치 상태를 확인한 뒤 다시 시작해 주세요."
            ));
        }
    }
    Ok(())
}

async fn ensure_generative_upscale_nodes(http: &Client, base: &str) -> Result<(), String> {
    let required = [
        (
            "RTXVideoSuperResolution",
            "NVIDIA RTX Video Super Resolution",
        ),
        (
            "FrameFlowRTXVideoSuperResolutionCPU",
            "FrameFlow RTX VSR RAM Output",
        ),
        ("VideoTileSliceFixed", "Video Tile Slice Fixed"),
        ("VideoTileMerge", "Video Tile Merge"),
        ("LTXVAudioVAEEncode", "H3 Audio VAE Encode"),
        ("LTXVConcatAVLatent", "H3 AV Latent Concat"),
        ("VHS_LoadVideo", "Video Helper Suite Load Video"),
    ];
    for (class_name, label) in required {
        let response = http
            .get(format!("{base}/object_info/{class_name}"))
            .send()
            .await
            .map_err(|error| format!("{label} 노드 확인 실패: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("생성형 Upscale에 필요한 {label} 노드가 없습니다. 설치된 custom_nodes를 적용하려면 현재 Comfy 작업이 끝난 뒤 Comfy Desktop을 한 번 다시 시작해 주세요."));
        }
    }
    Ok(())
}

async fn ensure_minimax_model_mode_ready(
    http: &Client,
    base: &str,
    kind: &str,
    mode: &str,
) -> Result<(), String> {
    let normalized = normalize_minimax_model_mode(Some(mode));
    if normalized == "default" {
        return Ok(());
    }
    let model_name = minimax_model_name(kind, mode);
    if !comfy_input_has_option(http, base, "UNETLoader", "unet_name", model_name).await {
        return Err(format!(
            "{} H3 모델을 찾지 못했습니다: {model_name}. ComfyUI/models/diffusion_models에 설치한 뒤 Comfy Desktop을 다시 시작해 주세요.",
            if normalized == "int4" { "INT4" } else { "W4A8" }
        ));
    }
    Ok(())
}

async fn minimax_dependencies_ready(base: &str) -> bool {
    let Ok(http) = Client::builder().timeout(Duration::from_secs(20)).build() else {
        return false;
    };
    comfy_input_has_option(
        &http,
        base,
        "UNETLoader",
        "unet_name",
        "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    )
    .await
        && comfy_input_has_option(
            &http,
            base,
            "CLIPLoader",
            "clip_name",
            "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        )
        .await
        && comfy_input_has_option(
            &http,
            base,
            "LoraLoaderModelOnly",
            "lora_name",
            MINIMAX_TURBO_V4_8STEP_LORA,
        )
        .await
}

async fn wait_for_minimax_dependencies(base: &str) -> Result<(), String> {
    loop {
        if minimax_dependencies_ready(base).await {
            return Ok(());
        }
        match server_health(base).await {
            ServerHealth::Stopped => {
                return Err(
                    "Minimax 모델 등록을 기다리는 동안 ComfyUI 서버가 종료되었습니다.".into(),
                )
            }
            ServerHealth::Ready | ServerHealth::Busy => {
                // Comfy Desktop registers shared models asynchronously.  A healthy
                // server with an incomplete object_info catalogue is initialization,
                // not a missing-model failure.
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ServerHealth {
    Ready,
    Busy,
    Stopped,
}

async fn tcp_port_alive(base: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let port = url.port_or_known_default().unwrap_or(8188);
    tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::TcpStream::connect((host, port)),
    )
    .await
    .is_ok_and(|result| result.is_ok())
}

async fn server_health(base: &str) -> ServerHealth {
    let response = Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10))
        .build()
        .ok()
        .map(|http| async move { http.get(format!("{base}/system_stats")).send().await })
        .map(|future| async move { future.await })
        .expect("HTTP client construction cannot fail with static timeouts")
        .await;
    if response.is_ok_and(|value| value.status().is_success()) {
        ServerHealth::Ready
    } else if tcp_port_alive(base).await {
        ServerHealth::Busy
    } else {
        ServerHealth::Stopped
    }
}

#[tauri::command]
pub fn comfy_list_environments() -> Result<Value, String> {
    let list = desktop_installations()?;
    let running = running_environment_name("http://127.0.0.1:8188");
    Ok(Value::Array(
        list.iter()
            .map(|item| environment_json(item, running.as_deref()))
            .collect(),
    ))
}

fn safe_backup_name(value: &str) -> String {
    let name: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if name.trim_matches('_').is_empty() {
        "Comfy".into()
    } else {
        name
    }
}

fn dereference_windows_shim(path: PathBuf) -> PathBuf {
    let shim = path.with_extension("shim");
    if !shim.is_file() {
        return path;
    }
    let Some(target) = fs::read_to_string(shim).ok().and_then(|text| {
        text.lines().find_map(|line| {
            line.trim()
                .strip_prefix("path = ")
                .map(|value| value.trim().trim_matches('"').to_string())
        })
    }) else {
        return path;
    };
    let target = PathBuf::from(target);
    if target.is_file() {
        target
    } else {
        path
    }
}

fn backup_ffmpeg_path(requested: &str) -> Result<PathBuf, String> {
    let requested_path = PathBuf::from(requested.trim());
    if requested_path.is_file() {
        return Ok(dereference_windows_shim(requested_path));
    }
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("where.exe")
            .arg(if requested.trim().is_empty() {
                "ffmpeg"
            } else {
                requested.trim()
            })
            .output()
            .map_err(|error| format!("FFmpeg 위치를 확인하지 못했습니다: {error}"))?;
        if output.status.success() {
            if let Some(path) = String::from_utf8_lossy(&output.stdout)
                .lines()
                .find(|line| !line.trim().is_empty())
            {
                let path = dereference_windows_shim(PathBuf::from(path.trim()));
                if path.is_file() {
                    return Ok(path);
                }
            }
        }
    }
    Err(format!(
        "백업에 포함할 FFmpeg 실행 파일을 찾지 못했습니다: {requested}"
    ))
}

fn environment_model_files(environment_root: &Path) -> Result<Vec<Value>, String> {
    let models_root = environment_root.join("ComfyUI").join("models");
    if !models_root.is_dir() {
        return Ok(Vec::new());
    }
    let mut stack = vec![models_root.clone()];
    let mut models = Vec::new();
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(&directory).map_err(|error| {
            format!(
                "모델 폴더를 읽지 못했습니다 ({}): {error}",
                directory.display()
            )
        })? {
            let entry = entry.map_err(|error| format!("모델 항목을 읽지 못했습니다: {error}"))?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if !path.is_file() {
                continue;
            }
            let relative = path
                .strip_prefix(&models_root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let bytes = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            models.push(json!({
                "name": path.file_name().and_then(|name| name.to_str()).unwrap_or("model"),
                "path": path,
                "relativePath": relative,
                "bytes": bytes
            }));
        }
    }
    models.sort_by(|left, right| {
        left.get("relativePath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase()
            .cmp(
                &right
                    .get("relativePath")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_lowercase(),
            )
    });
    Ok(models)
}

#[tauri::command]
pub async fn comfy_list_models(preferred_name: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let list = desktop_installations()?;
        let running = running_environment_name("http://127.0.0.1:8188");
        let selected = select_environment(&list, &preferred_name, running.as_deref())
            .ok_or_else(|| "모델을 조회할 Comfy Desktop 환경을 찾지 못했습니다.".to_string())?;
        let environment_root = PathBuf::from(&selected.install_path);
        let models = environment_model_files(&environment_root)?;
        Ok(json!({"environmentName": selected.name, "models": models}))
    })
    .await
    .map_err(|error| format!("Comfy 모델 조회 작업이 중단되었습니다: {error}"))?
}

#[tauri::command]
pub async fn comfy_copy_model(
    preferred_name: String,
    model_path: String,
    destination_dir: String,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let list = desktop_installations()?;
        let running = running_environment_name("http://127.0.0.1:8188");
        let selected = select_environment(&list, &preferred_name, running.as_deref())
            .ok_or_else(|| "모델을 복사할 Comfy Desktop 환경을 찾지 못했습니다.".to_string())?;
        let models_root = PathBuf::from(&selected.install_path)
            .join("ComfyUI")
            .join("models")
            .canonicalize()
            .map_err(|error| format!("모델 폴더를 확인하지 못했습니다: {error}"))?;
        let source = PathBuf::from(model_path)
            .canonicalize()
            .map_err(|error| format!("모델 파일을 찾지 못했습니다: {error}"))?;
        if !source.is_file() || !source.starts_with(&models_root) {
            return Err("선택한 파일이 현재 Comfy 환경의 models 폴더에 없습니다.".to_string());
        }
        let destination = PathBuf::from(destination_dir);
        fs::create_dir_all(&destination)
            .map_err(|error| format!("복사 대상 폴더를 만들지 못했습니다: {error}"))?;
        let filename = source
            .file_name()
            .ok_or_else(|| "모델 파일명이 올바르지 않습니다.".to_string())?;
        let target = destination.join(filename);
        if source == target {
            return Err("원본 모델과 같은 폴더에는 복사할 수 없습니다.".to_string());
        }
        let bytes = fs::copy(&source, &target)
            .map_err(|error| format!("모델 파일을 복사하지 못했습니다: {error}"))?;
        Ok(json!({"path": target, "bytes": bytes, "name": filename.to_string_lossy()}))
    })
    .await
    .map_err(|error| format!("Comfy 모델 복사 작업이 중단되었습니다: {error}"))?
}

const COMFY_RESTORE_BAT: &str = r#"@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore-comfy-environment.ps1"
set "RESTORE_EXIT=%ERRORLEVEL%"
echo.
if not "%RESTORE_EXIT%"=="0" echo Restore failed with exit code %RESTORE_EXIT%.
pause
exit /b %RESTORE_EXIT%
"#;

const COMFY_RESTORE_PS1: &str = r#"$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Get-Content -LiteralPath (Join-Path $packageRoot 'frameflow-comfy-backup.json') -Raw | ConvertFrom-Json
$desktopConfig = Join-Path $env:APPDATA 'Comfy Desktop'
$installationsPath = Join-Path $desktopConfig 'installations.json'
if (-not (Test-Path -LiteralPath $installationsPath)) {
  Write-Host 'Comfy Desktop is not installed or has not created an environment yet.' -ForegroundColor Red
  Write-Host 'Install Comfy Desktop, create one local environment, then run this BAT again.'
  exit 2
}
$installations = @(Get-Content -LiteralPath $installationsPath -Raw | ConvertFrom-Json)
$local = @($installations | Where-Object { $_.sourceId -ne 'cloud' -and $_.status -eq 'installed' })
if ($local.Count -eq 0) {
  Write-Host 'No installed local Comfy Desktop environment was found.' -ForegroundColor Red
  exit 3
}
Write-Host 'Available Comfy Desktop environments:' -ForegroundColor Cyan
$local | ForEach-Object { Write-Host ('  - ' + $_.name) }
$environmentName = Read-Host 'Enter the target environment name'
$target = $local | Where-Object { $_.name -ieq $environmentName } | Select-Object -First 1
if ($null -eq $target) {
  Write-Host ('Environment not found: ' + $environmentName) -ForegroundColor Red
  exit 4
}
$targetVersion = ''
if ($null -ne $target.comfyVersion -and $null -ne $target.comfyVersion.baseTag) { $targetVersion = [string]$target.comfyVersion.baseTag }
elseif ($null -ne $target.comfyVersionTag) { $targetVersion = [string]$target.comfyVersionTag }
elseif ($null -ne $target.version) { $targetVersion = [string]$target.version }
$backupVersion = [string]$manifest.comfyVersion
if ($backupVersion -and $targetVersion -and $backupVersion -ne $targetVersion) {
  Write-Host ('Comfy version mismatch. Backup: ' + $backupVersion + ' / Target: ' + $targetVersion) -ForegroundColor Yellow
  $answer = Read-Host 'Continue despite the version difference? [y/N]'
  if ($answer -notmatch '^(?i:y|yes)$') { Write-Host 'Restore cancelled.'; exit 5 }
}
$answer = Read-Host ('Restore into ' + $target.name + '? Close Comfy Desktop/ComfyUI first. [y/N]')
if ($answer -notmatch '^(?i:y|yes)$') { Write-Host 'Restore cancelled.'; exit 6 }
$targetRoot = [string]$target.installPath
if (-not (Test-Path -LiteralPath (Join-Path $targetRoot 'ComfyUI'))) {
  Write-Host ('Invalid environment path: ' + $targetRoot) -ForegroundColor Red
  exit 7
}
function Copy-Tree([string]$relative) {
  $source = Join-Path $packageRoot $relative
  if (-not (Test-Path -LiteralPath $source)) { return }
  $destination = Join-Path $targetRoot $relative
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  & robocopy.exe $source $destination /E /Z /J /R:2 /W:2
  if ($LASTEXITCODE -ge 8) { throw ('Robocopy failed for ' + $relative + ' with code ' + $LASTEXITCODE) }
}
Copy-Tree 'ComfyUI\custom_nodes'
Copy-Tree 'ComfyUI\user'
Write-Host 'Model binaries are not included in this backup. See models-list.txt.' -ForegroundColor Yellow
if ($null -ne $manifest.launchArgs) { $target.launchArgs = [string]$manifest.launchArgs }
[IO.File]::WriteAllText($installationsPath, (ConvertTo-Json -InputObject @($installations) -Depth 100), (New-Object Text.UTF8Encoding($false)))
$ffmpegSource = Join-Path $packageRoot 'tools\ffmpeg'
$ffmpegTarget = Join-Path $env:LOCALAPPDATA 'FrameFlow Studio\tools\ffmpeg'
New-Item -ItemType Directory -Force -Path $ffmpegTarget | Out-Null
Copy-Item -LiteralPath (Join-Path $ffmpegSource 'ffmpeg.exe') -Destination (Join-Path $ffmpegTarget 'ffmpeg.exe') -Force
if (Test-Path -LiteralPath (Join-Path $ffmpegSource 'ffprobe.exe')) { Copy-Item -LiteralPath (Join-Path $ffmpegSource 'ffprobe.exe') -Destination (Join-Path $ffmpegTarget 'ffprobe.exe') -Force }
$userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $ffmpegTarget) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $ffmpegTarget).TrimStart(';')), 'User')
}
$frameFlowData = Join-Path $env:APPDATA 'studio.frameflow.desktop'
New-Item -ItemType Directory -Force -Path $frameFlowData | Out-Null
$restoreSettings = @{ comfyEnvironmentName = [string]$target.name; ffmpegPath = (Join-Path $ffmpegTarget 'ffmpeg.exe') }
[IO.File]::WriteAllText((Join-Path $frameFlowData 'frameflow-comfy-restore.json'), ($restoreSettings | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
$python = Join-Path $targetRoot 'ComfyUI\.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { $python = Join-Path $targetRoot 'standalone-env\python.exe' }
if (Test-Path -LiteralPath $python) {
  $targetPythonVersion = (& $python --version 2>&1 | Out-String).Trim()
  if ($manifest.pythonVersion -and $targetPythonVersion -ne [string]$manifest.pythonVersion) {
    Write-Host ('Python version differs. Backup: ' + $manifest.pythonVersion + ' / Target: ' + $targetPythonVersion) -ForegroundColor Yellow
  }
  $portableLock = Join-Path $packageRoot 'python-packages-portable.txt'
  $targetPackages = @(& $python -m pip freeze 2>$null | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
  $backupPackages = @(Get-Content -LiteralPath $portableLock | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
  $packageDiff = @(Compare-Object -ReferenceObject $backupPackages -DifferenceObject $targetPackages)
  if ($packageDiff.Count -gt 0) {
    Write-Host ('Python package differences detected: ' + $packageDiff.Count) -ForegroundColor Yellow
    $syncPackages = Read-Host 'Install the backup portable package versions? GPU/CUDA Torch packages will remain from the target environment. [y/N]'
    if ($syncPackages -match '^(?i:y|yes)$') {
      & $python -m pip install -r $portableLock
      if ($LASTEXITCODE -ne 0) { Write-Warning 'Some portable package versions could not be installed. Review the output above.' }
    }
  } else {
    Write-Host 'Python portable package versions already match.' -ForegroundColor Green
  }
  $installDeps = Read-Host 'Run each copied custom-node requirements.txt as an additional compatibility step? [y/N]'
  if ($installDeps -match '^(?i:y|yes)$') {
    Get-ChildItem -LiteralPath (Join-Path $targetRoot 'ComfyUI\custom_nodes') -Filter requirements.txt -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      Write-Host ('Installing ' + $_.FullName)
      & $python -m pip install -r $_.FullName
      if ($LASTEXITCODE -ne 0) { Write-Warning ('Dependency install failed: ' + $_.FullName) }
    }
  }
}
Write-Host 'Restore completed.' -ForegroundColor Green
Write-Host ('Comfy environment: ' + $target.name)
Write-Host ('FFmpeg: ' + (Join-Path $ffmpegTarget 'ffmpeg.exe'))
Write-Host 'Restart FrameFlow Studio. It will import these restored settings automatically.'
"#;

#[tauri::command]
pub async fn comfy_backup_environment(
    preferred_name: String,
    ffmpeg_path: String,
    destination_dir: String,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let list = desktop_installations()?;
        let running = running_environment_name("http://127.0.0.1:8188");
        let selected = select_environment(&list, &preferred_name, running.as_deref())
            .ok_or_else(|| "백업할 Comfy Desktop 환경을 찾지 못했습니다.".to_string())?;
        let environment_root = PathBuf::from(&selected.install_path);
        let comfy_root = environment_root.join("ComfyUI");
        if !comfy_root.is_dir() {
            return Err(format!("ComfyUI 폴더를 찾지 못했습니다: {}", comfy_root.display()));
        }
        let destination = PathBuf::from(destination_dir);
        fs::create_dir_all(&destination).map_err(|error| format!("백업 폴더를 만들지 못했습니다: {error}"))?;
        let ffmpeg = backup_ffmpeg_path(&ffmpeg_path)?;
        let ffprobe = ffmpeg.parent().map(|parent| parent.join("ffprobe.exe")).filter(|path| path.is_file());
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let staging = env::temp_dir().join(format!("frameflow-comfy-backup-{}-{stamp}", std::process::id()));
        let tools = staging.join("tools").join("ffmpeg");
        fs::create_dir_all(&tools).map_err(|error| format!("백업 임시 폴더를 만들지 못했습니다: {error}"))?;
        fs::copy(&ffmpeg, tools.join("ffmpeg.exe")).map_err(|error| format!("FFmpeg를 백업에 복사하지 못했습니다: {error}"))?;
        if let Some(path) = &ffprobe {
            fs::copy(path, tools.join("ffprobe.exe")).map_err(|error| format!("FFprobe를 백업에 복사하지 못했습니다: {error}"))?;
        }
        let python = environment_python(&environment_root)
            .ok_or_else(|| "백업 환경의 Python 실행 파일을 찾지 못했습니다.".to_string())?;
        let python_version_output = Command::new(&python).arg("--version").output()
            .map_err(|error| format!("Python 버전을 확인하지 못했습니다: {error}"))?;
        let python_version = format!("{}{}", String::from_utf8_lossy(&python_version_output.stdout), String::from_utf8_lossy(&python_version_output.stderr)).trim().to_string();
        let freeze_output = Command::new(&python).args(["-m", "pip", "freeze"]).output()
            .map_err(|error| format!("Python 패키지 목록을 만들지 못했습니다: {error}"))?;
        if !freeze_output.status.success() {
            return Err(format!("pip freeze 실패: {}", String::from_utf8_lossy(&freeze_output.stderr).trim()));
        }
        let package_lock = String::from_utf8_lossy(&freeze_output.stdout).replace("\r\n", "\n");
        let portable_lock = package_lock.lines().filter(|line| {
            let lower = line.trim().to_ascii_lowercase();
            !["torch==", "torchvision==", "torchaudio==", "triton==", "xformers==", "nvidia-"].iter().any(|prefix| lower.starts_with(prefix))
                && !lower.starts_with("-e ")
                && !lower.contains(" @ file:")
        }).collect::<Vec<_>>().join("\r\n");
        fs::write(staging.join("python-packages-full.txt"), package_lock.replace('\n', "\r\n"))
            .map_err(|error| format!("전체 Python 패키지 목록을 쓰지 못했습니다: {error}"))?;
        fs::write(staging.join("python-packages-portable.txt"), format!("{portable_lock}\r\n"))
            .map_err(|error| format!("이식용 Python 패키지 목록을 쓰지 못했습니다: {error}"))?;
        let models = environment_model_files(&environment_root)?;
        let model_list = models.iter().map(|model| {
            let relative = model.get("relativePath").and_then(Value::as_str).unwrap_or("");
            let bytes = model.get("bytes").and_then(Value::as_u64).unwrap_or(0);
            format!("{bytes}\t{relative}")
        }).collect::<Vec<_>>().join("\r\n");
        fs::write(staging.join("models-list.txt"), format!("{model_list}\r\n"))
            .map_err(|error| format!("모델 목록을 쓰지 못했습니다: {error}"))?;
        let manifest = json!({
            "formatVersion": 1,
            "createdAtUnix": stamp,
            "environmentName": selected.name,
            "environmentId": selected.id,
            "comfyVersion": installation_comfy_version(selected),
            "pythonVersion": python_version,
            "launchArgs": selected.launch_args,
            "included": ["ComfyUI/custom_nodes", "ComfyUI/user", "tools/ffmpeg", "python-packages-full.txt", "python-packages-portable.txt", "models-list.txt"],
            "excluded": ["ComfyUI/models"],
            "modelCount": models.len(),
            "restoreMode": "merge-into-existing-comfy-desktop-environment"
        });
        fs::write(staging.join("frameflow-comfy-backup.json"), serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?)
            .map_err(|error| format!("백업 manifest를 쓰지 못했습니다: {error}"))?;
        fs::write(staging.join("restore-comfy-environment.bat"), COMFY_RESTORE_BAT.replace('\n', "\r\n"))
            .map_err(|error| format!("복원 BAT를 쓰지 못했습니다: {error}"))?;
        fs::write(staging.join("restore-comfy-environment.ps1"), COMFY_RESTORE_PS1.replace('\n', "\r\n"))
            .map_err(|error| format!("복원 스크립트를 쓰지 못했습니다: {error}"))?;
        let archive = destination.join(format!("FrameFlow-Comfy-{}-{stamp}.zip", safe_backup_name(&selected.name)));
        let mut command = Command::new("tar.exe");
        command.arg("-a").arg("-c").arg("-f").arg(&archive)
            .arg("-C").arg(&staging)
            .arg("frameflow-comfy-backup.json")
            .arg("python-packages-full.txt")
            .arg("python-packages-portable.txt")
            .arg("models-list.txt")
            .arg("restore-comfy-environment.bat")
            .arg("restore-comfy-environment.ps1")
            .arg("tools")
            .arg("-C").arg(&environment_root);
        for relative in ["ComfyUI/custom_nodes", "ComfyUI/user"] {
            if environment_root.join(relative).is_dir() { command.arg(relative); }
        }
        let output = command.output().map_err(|error| format!("ZIP 압축을 시작하지 못했습니다: {error}"))?;
        let _ = fs::remove_dir_all(&staging);
        if !output.status.success() {
            let _ = fs::remove_file(&archive);
            return Err(format!("Comfy 환경 ZIP 생성 실패: {}", String::from_utf8_lossy(&output.stderr).trim()));
        }
        let bytes = fs::metadata(&archive).map(|meta| meta.len()).unwrap_or(0);
        Ok(json!({"path": archive, "bytes": bytes, "environmentName": selected.name, "comfyVersion": installation_comfy_version(selected)}))
    }).await.map_err(|error| format!("Comfy 환경 백업 작업이 중단되었습니다: {error}"))?
}

#[tauri::command]
pub async fn comfy_ensure_environment(
    state: tauri::State<'_, ComfyRuntimeState>,
    base_url: String,
    preferred_name: String,
    force_restart: bool,
    show_console: bool,
    required_engine: Option<String>,
) -> Result<Value, String> {
    ensure_environment_impl(
        state.inner(),
        base_url,
        preferred_name,
        force_restart,
        show_console,
        required_engine,
    )
    .await
}

async fn ensure_environment_impl(
    state: &ComfyRuntimeState,
    base_url: String,
    preferred_name: String,
    force_restart: bool,
    show_console: bool,
    required_engine: Option<String>,
) -> Result<Value, String> {
    let base = normalize_base_url(&base_url)?;
    let list = desktop_installations()?;
    if list.is_empty() {
        return Err(
            "실행 가능한 로컬 Comfy Desktop 환경이 없습니다. 설정에서 환경 폴더를 지정해 주세요."
                .into(),
        );
    }
    let mut health = server_health(&base).await;
    let connected = health != ServerHealth::Stopped;
    let running = if connected {
        running_environment_name(&base)
    } else {
        None
    };
    let selected = select_environment(&list, &preferred_name, running.as_deref())
        .ok_or_else(|| "사용할 Comfy Desktop 환경을 선택하지 못했습니다.".to_string())?;
    let installed_node_changed = match required_engine.as_deref() {
        Some("minimax-h3-context-loop") => ensure_frameflow_h3_context_loop_fork(selected)?,
        Some("minimax-h3-generative-upscale") => ensure_frameflow_rtx_vsr_cpu_node(selected)?,
        _ => false,
    };
    // A newly installed/updated custom node is visible only after ComfyUI has
    // restarted. This happens before the continuous job is submitted.
    let force_restart = force_restart || installed_node_changed;
    let preferred_matches_running = preferred_name.trim().is_empty()
        || running
            .as_deref()
            .is_some_and(|name| name.eq_ignore_ascii_case(&selected.name));

    if health == ServerHealth::Busy && !force_restart && preferred_matches_running {
        // A busy GPU can temporarily delay /system_stats. The open TCP port proves that
        // Comfy is alive, so never launch a competing process on the same port.
        for _ in 0..60 {
            tokio::time::sleep(Duration::from_secs(2)).await;
            health = server_health(&base).await;
            if health == ServerHealth::Ready {
                break;
            }
            if health == ServerHealth::Stopped {
                return Err("ComfyUI 포트가 대기 중 닫혔습니다. 환경을 다시 확인해 주세요.".into());
            }
        }
        if health == ServerHealth::Busy {
            return Err("ComfyUI 프로세스와 포트는 살아 있지만 120초 동안 /system_stats 응답을 받지 못했습니다. 기존 작업이 끝난 뒤 다시 시도해 주세요.".into());
        }
    }

    if health == ServerHealth::Ready && !force_restart && preferred_matches_running {
        if matches!(
            required_engine.as_deref(),
            Some("minimax-h3") | Some("minimax-h3-context-loop")
        ) {
            wait_for_minimax_dependencies(&base).await?;
        }
        return Ok(json!({
            "connected": true,
            "started": false,
            "health": "ready",
            "selectionReason": if preferred_name.trim().is_empty() { "running" } else { "preferred" },
            "environment": environment_json(selected, running.as_deref()),
            "baseUrl": base,
        }));
    }

    if connected {
        if let Ok(http) = Client::builder().timeout(Duration::from_secs(3)).build() {
            let _ = http.post(format!("{base}/interrupt")).send().await;
        }
        if let Ok(mut child) = state.child.lock() {
            if let Some(mut process) = child.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
        if let Some(name) = running.as_deref() {
            kill_port_locked_environment(&base, name)?;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }

    // Keep the frontend preference in the command contract for compatibility,
    // but every Comfy process started by FrameFlow must be visible.  Restricting
    // this to `Stopped` hid the console when the previous server was unhealthy
    // or still starting, which made generation progress impossible to inspect.
    let _show_console_preference = show_console;
    let child = spawn_environment(
        selected,
        &base,
        true,
        matches!(
            required_engine.as_deref(),
            Some("minimax-h3") | Some("minimax-h3-context-loop")
        ),
    )?;
    let pid = child.id();
    *state
        .child
        .lock()
        .map_err(|_| "Comfy 환경 프로세스 상태 잠금에 실패했습니다.".to_string())? = Some(child);
    for _ in 0..60 {
        if server_available(&base).await {
            if matches!(
                required_engine.as_deref(),
                Some("minimax-h3") | Some("minimax-h3-context-loop")
            ) {
                wait_for_minimax_dependencies(&base).await?;
            }
            return Ok(json!({
                "connected": true,
                "started": true,
                "pid": pid,
                "selectionReason": if !preferred_name.trim().is_empty() { "preferred" } else if running.is_some() { "running" } else { "first" },
                "environment": environment_json(selected, Some(&selected.name)),
                "baseUrl": base,
            }));
        }
        if let Ok(mut current) = state.child.lock() {
            let exit_status = current
                .as_mut()
                .and_then(|process| process.try_wait().ok())
                .flatten();
            if let Some(status) = exit_status {
                *current = None;
                return Err(format!(
                    "{} 환경이 ComfyUI 서버 준비 전에 종료되었습니다 ({status}).",
                    selected.name
                ));
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    Err(format!(
        "{} 환경을 실행했지만 120초 안에 ComfyUI 서버가 준비되지 않았습니다.",
        selected.name
    ))
}

#[tauri::command]
pub async fn comfy_check(base_url: String) -> Result<Value, String> {
    let base = normalize_base_url(&base_url)?;
    match server_health(&base).await {
        ServerHealth::Ready => {
            let response = Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|error| error.to_string())?
                .get(format!("{base}/system_stats"))
                .send()
                .await
                .map_err(|error| format!("ComfyUI 상태 응답 실패: {error}"))?;
            let stats = response_json(response, "ComfyUI 상태 확인").await?;
            Ok(
                json!({"connected": true, "health": "ready", "baseUrl": base, "stats": stats, "workflow": "WAN 2.2 14B FLF2V + Lightx2v 4-step", "fps": FPS}),
            )
        }
        ServerHealth::Busy => Ok(
            json!({"connected": true, "health": "busy", "baseUrl": base, "message": "ComfyUI 포트는 살아 있으나 GPU 작업으로 상태 응답이 지연되고 있습니다."}),
        ),
        ServerHealth::Stopped => Err("ComfyUI 프로세스와 8188 포트가 응답하지 않습니다.".into()),
    }
}

fn workflow_media_name(path: Option<&str>, fallback: &str) -> String {
    path.filter(|value| !value.trim().is_empty())
        .and_then(|value| Path::new(value).file_name())
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

#[tauri::command]
pub fn comfy_export_workflow(request: WorkflowExportRequest) -> Result<Value, String> {
    let profile = normalize_minimax_profile(request.minimax_profile.as_deref());
    let model_mode = normalize_minimax_model_mode(request.minimax_model_mode.as_deref());
    let latent_upscale = normalize_latent_upscale_mode(request.latent_upscale_mode.as_deref());
    let music = request.background_music.unwrap_or(false);
    let seed = request.seed.or(Some(1));
    let first = workflow_media_name(request.first_image_path.as_deref(), "FIRST.png");
    let last = workflow_media_name(request.last_image_path.as_deref(), "LAST.png");
    let workflow = match request.kind.as_str() {
        "wan" => build_workflow(
            &first,
            &last,
            &request.prompt,
            request.width,
            request.height,
            request.length.unwrap_or_else(|| {
                ((request.duration.max(0.2) * FPS as f64).round() as u32 / 4) * 4 + 1
            }),
            "video/FrameFlow-WAN22-Workflow",
            seed,
        )?,
        "minimax-h3" => build_minimax_workflow(
            &first,
            &last,
            &request.prompt,
            request.width,
            request.height,
            request.duration,
            "video/FrameFlow-Minimax-H3-Workflow",
            seed,
            profile,
            model_mode,
            music,
            latent_upscale,
        )?.0,
        "minimax-h3-ref2va" => {
            let images = request.reference_images.iter().enumerate()
                .map(|(index, value)| workflow_media_name(Some(value), &format!("Picture-{}.png", index + 1)))
                .collect::<Vec<_>>();
            let videos = request.reference_videos.iter().enumerate()
                .map(|(index, value)| workflow_media_name(Some(value), &format!("Video-{}.mp4", index + 1)))
                .collect::<Vec<_>>();
            build_minimax_ref2va_video_workflow(
                &images,
                &videos,
                &request.prompt,
                request.width,
                request.height,
                request.duration,
                "video/FrameFlow-Minimax-H3-Ref2VA-Workflow",
                seed,
                request.ref_image_size.as_deref().unwrap_or("match"),
                profile,
                model_mode,
                music,
                latent_upscale,
            )?.0
        }
        "minimax-h3-extension" => {
            let source = workflow_media_name(request.source_video_path.as_deref(), "source-video.mp4");
            let optional_first = request.first_image_path.as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|value| workflow_media_name(Some(value), "extension-internal-first.png"));
            let optional_last = request.last_image_path.as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|value| workflow_media_name(Some(value), "extension-LAST.png"));
            let shot = ContextLoopShotInput {
                last_image_path: String::new(),
                prompt: request.prompt,
                duration: request.duration,
                seed,
            };
            build_minimax_existing_video_workflow(
                &source,
                optional_first.as_deref(),
                optional_last.as_deref(),
                &shot,
                request.width,
                request.height,
                "frameflow_extension_workflow",
                profile,
                model_mode,
                music,
            )?.0
        }
        _ => return Err(format!("지원하지 않는 워크플로 유형입니다: {}", request.kind)),
    };
    let target = PathBuf::from(&request.target_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("워크플로 저장 폴더를 만들지 못했습니다: {error}"))?;
    }
    let body = serde_json::to_string_pretty(&workflow)
        .map_err(|error| format!("워크플로 JSON 직렬화 실패: {error}"))?;
    fs::write(&target, body)
        .map_err(|error| format!("워크플로 JSON을 저장하지 못했습니다: {error}"))?;
    Ok(json!({"path": target.to_string_lossy(), "kind": request.kind, "profile": profile, "modelMode": model_mode, "latentUpscaleMode": latent_upscale}))
}

async fn quick_cleanup_request(http: &Client, base: &str) -> Result<Value, String> {
    let response = http
        .post(format!("{base}/free"))
        .json(&json!({"unload_models": false, "free_memory": true}))
        .send()
        .await
        .map_err(|error| format!("ComfyUI 빠른 정리 요청 실패: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(format!("ComfyUI 빠른 정리 실패 ({status}): {detail}"));
    }
    Ok(json!({
        "cleaned": true,
        "modelsUnloaded": false,
        "executionCacheReset": true,
        "mode": "native-free"
    }))
}

#[tauri::command]
pub async fn comfy_quick_cleanup(base_url: String) -> Result<Value, String> {
    let base = normalize_base_url(&base_url)?;
    let http = client()?;
    quick_cleanup_request(&http, &base).await
}

#[tauri::command]
pub async fn comfy_cancel_and_stop(
    state: tauri::State<'_, ComfyRuntimeState>,
    base_url: String,
) -> Result<Value, String> {
    CONTEXT_TEST_CANCEL_EPOCH.fetch_add(1, Ordering::SeqCst);
    let base = normalize_base_url(&base_url)?;
    if let Ok(http) = Client::builder().timeout(Duration::from_secs(4)).build() {
        let _ = http.post(format!("{base}/interrupt")).send().await;
        let _ = http
            .post(format!("{base}/queue"))
            .json(&json!({"clear": true}))
            .send()
            .await;
    }
    let running = running_environment_name(&base);
    if let Ok(mut current) = state.child.lock() {
        if let Some(mut process) = current.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
    }
    if let Some(name) = running.as_deref() {
        kill_port_locked_environment(&base, name)?;
    }
    #[cfg(target_os = "windows")]
    let fallback_pid = if tcp_port_alive(&base).await {
        kill_listening_process(&base)?
    } else {
        None
    };
    #[cfg(not(target_os = "windows"))]
    let fallback_pid: Option<u32> = None;

    for _ in 0..20 {
        if !tcp_port_alive(&base).await {
            return Ok(json!({
                "cancelled": true,
                "stopped": true,
                "environment": running,
                "fallbackPid": fallback_pid
            }));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(format!(
        "ComfyUI 종료 명령 후에도 {} 포트가 응답합니다. FrameFlow는 종료하지 않습니다.",
        port_from_url(&base)
    ))
}

#[tauri::command]
pub async fn comfy_generate_video(
    base_url: String,
    client_id: String,
    first_image_path: String,
    last_image_path: String,
    prompt: String,
    width: u32,
    height: u32,
    length: u32,
    output_path: String,
    seed: Option<u64>,
    engine: Option<String>,
    duration: Option<f64>,
    minimax_profile: Option<String>,
    minimax_model_mode: Option<String>,
    background_music: Option<bool>,
    latent_upscale_mode: Option<String>,
) -> Result<Value, String> {
    let base = normalize_base_url(&base_url)?;
    let http = client()?;
    let is_minimax = engine.as_deref() == Some("minimax-h3");
    if is_minimax {
        ensure_minimax_optimization_nodes(
            &http,
            &base,
            normalize_latent_upscale_mode(latent_upscale_mode.as_deref()) != "off",
        )
        .await?;
        ensure_minimax_model_mode_ready(
            &http,
            &base,
            "fl2va",
            normalize_minimax_model_mode(minimax_model_mode.as_deref()),
        )
        .await?;
    }
    let first = upload_image(&http, &base, &first_image_path, "first").await?;
    let last = upload_image(&http, &base, &last_image_path, "last").await?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let prefix = format!(
        "video/FrameFlow-{}-{stamp}",
        if is_minimax { "Minimax-H3" } else { "WAN22" }
    );
    let (workflow, actual_length, actual_fps) = if is_minimax {
        let (workflow, frames) = build_minimax_workflow(
            &first,
            &last,
            &prompt,
            width,
            height,
            duration.unwrap_or(5.0),
            &prefix,
            seed,
            normalize_minimax_profile(minimax_profile.as_deref()),
            normalize_minimax_model_mode(minimax_model_mode.as_deref()),
            background_music.unwrap_or(false),
            normalize_latent_upscale_mode(latent_upscale_mode.as_deref()),
        )?;
        (workflow, frames, MINIMAX_FPS)
    } else {
        (
            build_workflow(&first, &last, &prompt, width, height, length, &prefix, seed)?,
            length,
            FPS,
        )
    };
    let submit = || {
        http.post(format!("{base}/prompt"))
            .json(&json!({"prompt": workflow, "client_id": client_id}))
            .send()
    };
    let mut response = submit()
        .await
        .map_err(|error| format!("ComfyUI 작업 제출 실패: {error}"))?;
    if !response.status().is_success() && is_minimax {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        if detail.contains("value_not_in_list") {
            wait_for_minimax_dependencies(&base).await?;
            response = submit()
                .await
                .map_err(|error| format!("ComfyUI 작업 재제출 실패: {error}"))?;
        } else {
            return Err(format!(
                "ComfyUI 작업 제출 실패 ({status}): {}",
                detail.chars().take(1200).collect::<String>()
            ));
        }
    }
    let queued = response_json(
        response,
        "ComfyUI 작업 제출 (모델 목록 새로고침 후 1회 재시도 포함)",
    )
    .await?;
    let prompt_id = queued
        .get("prompt_id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("ComfyUI가 prompt_id를 반환하지 않았습니다: {queued}"))?;

    let descriptor = loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let response = http
            .get(format!("{base}/history/{prompt_id}"))
            .send()
            .await
            .map_err(|error| format!("ComfyUI 작업 상태 확인 실패: {error}"))?;
        let history = response_json(response, "ComfyUI 작업 상태 확인").await?;
        if let Some(entry) = history.get(prompt_id) {
            if entry.pointer("/status/status_str").and_then(Value::as_str) == Some("error") {
                return Err(format!(
                    "ComfyUI 생성 실패: {}",
                    comfy_execution_error(entry)
                ));
            }
            if let Some(video) = entry.get("outputs").and_then(find_video) {
                break video;
            }
            if entry.pointer("/status/completed").and_then(Value::as_bool) == Some(true) {
                return Err("ComfyUI 작업은 완료됐지만 저장된 영상 정보를 찾지 못했습니다. SaveVideo 노드를 확인해 주세요.".into());
            }
        }
    };
    let filename = descriptor
        .get("filename")
        .and_then(Value::as_str)
        .ok_or_else(|| "영상 파일명이 없습니다.".to_string())?;
    let subfolder = descriptor
        .get("subfolder")
        .and_then(Value::as_str)
        .unwrap_or("");
    let output_type = descriptor
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("output");
    let response = http
        .get(format!("{base}/view"))
        .query(&[
            ("filename", filename),
            ("subfolder", subfolder),
            ("type", output_type),
        ])
        .send()
        .await
        .map_err(|error| format!("ComfyUI 영상 다운로드 실패: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("ComfyUI 영상 다운로드 실패 ({status})"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("ComfyUI 영상 데이터를 읽지 못했습니다: {error}"))?;
    let target = output_target(&output_path, filename);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&target, bytes).map_err(|error| format!("영상을 저장하지 못했습니다: {error}"))?;
    let path = target
        .to_str()
        .ok_or_else(|| "저장된 영상 경로를 읽지 못했습니다.".to_string())?;
    // Cleanup is intentionally best-effort: a cleanup failure must not turn a
    // successfully generated and downloaded video into a failed job.
    let quick_cleanup = quick_cleanup_request(&http, &base)
        .await
        .unwrap_or_else(|error| json!({"cleaned": false, "error": error}));
    Ok(
        json!({"path": path, "promptId": prompt_id, "filename": filename, "fps": actual_fps, "frames": actual_length, "seed": seed, "engine": if is_minimax { "minimax-h3" } else { "wan-2.2" }, "negativePrompt": "", "firstImage": first, "lastImage": last, "quickCleanup": quick_cleanup}),
    )
}

#[tauri::command]
pub async fn comfy_generate_reference_audio(
    base_url: String,
    client_id: String,
    video_path: String,
    prompt: String,
    width: u32,
    height: u32,
    duration: f64,
    output_path: String,
    seed: Option<u64>,
    minimax_profile: Option<String>,
    minimax_model_mode: Option<String>,
    background_music: Option<bool>,
    latent_upscale_mode: Option<String>,
) -> Result<Value, String> {
    let base = normalize_base_url(&base_url)?;
    let http = client()?;
    ensure_minimax_optimization_nodes(
        &http,
        &base,
        normalize_latent_upscale_mode(latent_upscale_mode.as_deref()) != "off",
    )
    .await?;
    ensure_minimax_model_mode_ready(
        &http,
        &base,
        "ref2va",
        normalize_minimax_model_mode(minimax_model_mode.as_deref()),
    )
    .await?;
    let uploaded = upload_input_media(&http, &base, &video_path, "reference-video").await?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let prefix = format!("audio/FrameFlow-Video-to-Audio-{stamp}");
    let (workflow, frames) = build_minimax_ref2va_audio_workflow(
        &uploaded,
        &prompt,
        width,
        height,
        duration,
        &prefix,
        seed,
        normalize_minimax_profile(minimax_profile.as_deref()),
        normalize_minimax_model_mode(minimax_model_mode.as_deref()),
        background_music.unwrap_or(false),
        normalize_latent_upscale_mode(latent_upscale_mode.as_deref()),
    )?;
    let response = http
        .post(format!("{base}/prompt"))
        .json(&json!({"prompt": workflow, "client_id": client_id}))
        .send()
        .await
        .map_err(|error| format!("ComfyUI Ref2VA 오디오 작업 제출 실패: {error}"))?;
    let queued = response_json(response, "ComfyUI Ref2VA 오디오 작업 제출").await?;
    let prompt_id = queued
        .get("prompt_id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("ComfyUI가 prompt_id를 반환하지 않았습니다: {queued}"))?;

    let descriptor = loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let response = http
            .get(format!("{base}/history/{prompt_id}"))
            .send()
            .await
            .map_err(|error| format!("ComfyUI Ref2VA 오디오 상태 확인 실패: {error}"))?;
        let history = response_json(response, "ComfyUI Ref2VA 오디오 상태 확인").await?;
        if let Some(entry) = history.get(prompt_id) {
            if entry.pointer("/status/status_str").and_then(Value::as_str) == Some("error") {
                return Err(format!(
                    "ComfyUI Ref2VA 오디오 생성 실패: {}",
                    comfy_execution_error(entry)
                ));
            }
            if let Some(audio) = entry.get("outputs").and_then(find_audio) {
                break audio;
            }
            if entry.pointer("/status/completed").and_then(Value::as_bool) == Some(true) {
                return Err("ComfyUI 작업은 완료됐지만 MP3 출력 정보를 찾지 못했습니다. SaveAudioMP3 노드를 확인해 주세요.".into());
            }
        }
    };
    let filename = descriptor
        .get("filename")
        .and_then(Value::as_str)
        .ok_or_else(|| "생성 오디오 파일명이 없습니다.".to_string())?;
    let subfolder = descriptor
        .get("subfolder")
        .and_then(Value::as_str)
        .unwrap_or("");
    let output_type = descriptor
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("output");
    let response = http
        .get(format!("{base}/view"))
        .query(&[
            ("filename", filename),
            ("subfolder", subfolder),
            ("type", output_type),
        ])
        .send()
        .await
        .map_err(|error| format!("ComfyUI 생성 MP3 다운로드 실패: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("ComfyUI 생성 MP3 다운로드 실패 ({status})"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("ComfyUI 생성 MP3 데이터를 읽지 못했습니다: {error}"))?;
    let target = PathBuf::from(&output_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&target, bytes)
        .map_err(|error| format!("생성 MP3를 저장하지 못했습니다: {error}"))?;
    let quick_cleanup = quick_cleanup_request(&http, &base)
        .await
        .unwrap_or_else(|error| json!({"cleaned": false, "error": error}));
    Ok(json!({
        "path": target.to_string_lossy(),
        "promptId": prompt_id,
        "filename": filename,
        "fps": MINIMAX_FPS,
        "frames": frames,
        "duration": frames as f64 / MINIMAX_FPS as f64,
        "seed": seed,
        "engine": "minimax-h3-ref2va-audio",
        "referenceVideo": uploaded,
        "quickCleanup": quick_cleanup
    }))
}

fn build_generative_upscale_workflow(
    uploaded_video: &str,
    output_width: u32,
    output_height: u32,
    tile_width: u32,
    tile_height: u32,
    duration: f64,
    prefix: &str,
    seed: u64,
) -> Result<(Value, u32), String> {
    for (label, width, height) in [
        ("출력", output_width, output_height),
        ("타일", tile_width, tile_height),
    ] {
        if width < 64 || height < 64 || width % 32 != 0 || height % 32 != 0 {
            return Err(format!(
                "{label} 해상도는 64px 이상인 32배수여야 합니다: {width}×{height}"
            ));
        }
    }
    if output_width > 8192 || output_height > 8192 {
        return Err("생성형 Upscale 출력의 한 변은 최대 8192px입니다.".into());
    }
    if tile_width > output_width || tile_height > output_height {
        return Err("타일 크기는 출력 해상도보다 클 수 없습니다.".into());
    }
    let length = minimax_frame_length(duration);
    if length > MINIMAX_REF2VA_MAX_FRAMES {
        return Err(format!(
            "생성형 Upscale 입력이 너무 깁니다: {length}프레임 (최대 {MINIMAX_REF2VA_MAX_FRAMES})"
        ));
    }
    let prompt = "subject_definitions:\nThe encoded source tile latent is the sole visual source for the target.\n\nsummary:\n[video editing] Create a high-resolution faithful reconstruction of the encoded source tile.\n\nretention_analysis:\nThe encoded source tile: fully_preserved - preserve the exact composition, subjects, identities, geometry, camera, motion, timing, colors, lighting, and scene content.\n\ndetailed_description:\n[Shot 1] Preserve every visible element and every frame transition from the encoded source tile. Restore only plausible high-resolution texture, clean edges, fine material detail, and temporal coherence. Do not add, remove, replace, restyle, reframe, crop, or move any subject or object. Do not change facial identity, body shape, text, logos, perspective, camera movement, action timing, color palette, illumination, or exposure. The first and final frames must remain faithful to the source and blend seamlessly with adjacent overlapping tiles.\n\noverall_soundscape:\nPreserve the source video's original audio without generating replacement sound.\n\nnon_diegetic_music:\nN/A";
    let workflow = json!({
        "1":{"class_type":"VHS_LoadVideo","inputs":{"video":uploaded_video,"force_rate":MINIMAX_FPS,"custom_width":0,"custom_height":0,"frame_load_cap":0,"skip_first_frames":0,"select_every_nth":1,"format":"AnimateDiff"}},
        "3":{"class_type":"FrameFlowRTXVideoSuperResolutionCPU","inputs":{"images":["1",0],"width":output_width,"height":output_height,"quality":"ULTRA"}},
        "4":{"class_type":"VideoTileSliceFixed","inputs":{"images":["3",0],"tile_width":tile_width,"tile_height":tile_height,"multiple":32,"overlap":"1/4","pattern":"spiral"}},
        "5":{"class_type":"UNETLoader","inputs":{"unet_name":MINIMAX_REF2VA_DEFAULT_MODEL,"weight_dtype":"default"}},
        "6":{"class_type":"CLIPLoader","inputs":{"clip_name":"qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors","type":"minimax","device":"default"}},
        "7":{"class_type":"VAELoader","inputs":{"vae_name":"minimax_h3_video_vae_fp16.safetensors"}},
        "8":{"class_type":"VAELoader","inputs":{"vae_name":"minimax_h3_audio_vae_fp32.safetensors"}},
        "9":{"class_type":"ModelAttentionBackend","inputs":{"model":["5",0],"attention":"comfy kitchen attention"}},
        "10":{"class_type":"MiniMaxH3ReferenceToVideo","inputs":{"clip":["6",0],"vae":["7",0],"audio_vae":["8",0],"prompt":prompt,"width":tile_width,"height":tile_height,"length":length,"ref_image_size":"match"}},
        "11":{"class_type":"DenoTextEncoderUnload","inputs":{"value":["10",0],"clip":["6",0],"wait_for":["10",1]}},
        "12":{"class_type":"VAEEncode","inputs":{"pixels":["4",0],"vae":["7",0]}},
        "13":{"class_type":"LTXVAudioVAEEncode","inputs":{"audio":["1",2],"audio_vae":["8",0]}},
        "14":{"class_type":"LTXVConcatAVLatent","inputs":{"video_latent":["12",0],"audio_latent":["13",0]}},
        "15":{"class_type":"RandomNoise","inputs":{"noise_seed":seed}},
        "16":{"class_type":"KSamplerSelect","inputs":{"sampler_name":"res_multistep"}},
        "17":{"class_type":"BasicScheduler","inputs":{"model":["9",0],"scheduler":"simple","steps":6,"denoise":0.4}},
        "18":{"class_type":"BasicGuider","inputs":{"model":["9",0],"conditioning":["11",0]}},
        "19":{"class_type":"SamplerCustomAdvanced","inputs":{"noise":["15",0],"guider":["18",0],"sampler":["16",0],"sigmas":["17",0],"latent_image":["14",0]}},
        "20":{"class_type":"VAEDecode","inputs":{"samples":["19",1],"vae":["7",0]}},
        "21":{"class_type":"VideoTileMerge","inputs":{"tile_config":["4",1],"tiles":["20",0],"feather":0.25,"feather_curve":"linear","blend_mode":"alpha_over","merge_device":"cpu"}},
        "22":{"class_type":"CreateVideo","inputs":{"images":["21",0],"audio":["1",2],"fps":MINIMAX_FPS,"bit_depth":8}},
        "23":{"class_type":"SaveVideo","inputs":{"video":["22",0],"filename_prefix":prefix,"format":"auto","codec":"auto"}}
    });
    Ok((workflow, length))
}

#[tauri::command]
pub async fn comfy_generate_tiled_upscale(
    base_url: String,
    client_id: String,
    video_path: String,
    output_path: String,
    output_width: u32,
    output_height: u32,
    tile_width: u32,
    tile_height: u32,
    duration: f64,
    fps: f64,
    seed: Option<u64>,
) -> Result<Value, String> {
    let base = normalize_base_url(&base_url)?;
    let http = client()?;
    ensure_minimax_optimization_nodes(&http, &base, false).await?;
    ensure_generative_upscale_nodes(&http, &base).await?;
    let _source_fps = fps;
    let uploaded =
        upload_input_media(&http, &base, &video_path, "generative-upscale-source").await?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let prefix = format!("video/FrameFlow-H3-Generative-Upscale-{stamp}");
    let actual_seed = seed.unwrap_or(1);
    let (workflow, frames) = build_generative_upscale_workflow(
        &uploaded,
        output_width,
        output_height,
        tile_width,
        tile_height,
        duration,
        &prefix,
        actual_seed,
    )?;
    let response = http
        .post(format!("{base}/prompt"))
        .json(&json!({"prompt":workflow,"client_id":client_id}))
        .send()
        .await
        .map_err(|error| format!("ComfyUI 생성형 Upscale 작업 제출 실패: {error}"))?;
    let queued = response_json(response, "ComfyUI 생성형 Upscale 작업 제출").await?;
    let prompt_id = queued
        .get("prompt_id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("ComfyUI가 prompt_id를 반환하지 않았습니다: {queued}"))?;
    let descriptor = loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let response = http
            .get(format!("{base}/history/{prompt_id}"))
            .send()
            .await
            .map_err(|error| format!("ComfyUI 생성형 Upscale 상태 확인 실패: {error}"))?;
        let history = response_json(response, "ComfyUI 생성형 Upscale 상태 확인").await?;
        if let Some(entry) = history.get(prompt_id) {
            if entry.pointer("/status/status_str").and_then(Value::as_str) == Some("error") {
                return Err(format!(
                    "ComfyUI 생성형 Upscale 실패: {}",
                    comfy_execution_error(entry)
                ));
            }
            if let Some(video) = entry.get("outputs").and_then(find_video) {
                break video;
            }
            if entry.pointer("/status/completed").and_then(Value::as_bool) == Some(true) {
                return Err(
                    "ComfyUI 작업은 완료됐지만 생성형 Upscale 영상 출력 정보를 찾지 못했습니다."
                        .into(),
                );
            }
        }
    };
    let filename = descriptor
        .get("filename")
        .and_then(Value::as_str)
        .ok_or_else(|| "생성형 Upscale 영상 파일명이 없습니다.".to_string())?;
    let subfolder = descriptor
        .get("subfolder")
        .and_then(Value::as_str)
        .unwrap_or("");
    let output_type = descriptor
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("output");
    let response = http
        .get(format!("{base}/view"))
        .query(&[
            ("filename", filename),
            ("subfolder", subfolder),
            ("type", output_type),
        ])
        .send()
        .await
        .map_err(|error| format!("ComfyUI 생성형 Upscale 다운로드 실패: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("ComfyUI 생성형 Upscale 다운로드 실패 ({status})"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("업스케일 영상 데이터를 읽지 못했습니다: {error}"))?;
    let target = PathBuf::from(&output_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&target, bytes)
        .map_err(|error| format!("업스케일 영상을 저장하지 못했습니다: {error}"))?;
    let quick_cleanup = quick_cleanup_request(&http, &base)
        .await
        .unwrap_or_else(|error| json!({"cleaned":false,"error":error}));
    Ok(
        json!({"path":target.to_string_lossy(),"promptId":prompt_id,"filename":filename,
        "fps":MINIMAX_FPS,"frames":frames,"duration":frames as f64/MINIMAX_FPS as f64,
        "seed":actual_seed,"engine":"minimax-h3-generative-upscale","quickCleanup":quick_cleanup}),
    )
}

#[tauri::command]
pub async fn comfy_generate_ref2va_video(
    base_url: String,
    client_id: String,
    reference_images: Vec<String>,
    reference_videos: Vec<String>,
    prompt: String,
    width: u32,
    height: u32,
    duration: f64,
    output_path: String,
    seed: Option<u64>,
    ref_image_size: Option<String>,
    minimax_profile: Option<String>,
    minimax_model_mode: Option<String>,
    background_music: Option<bool>,
    latent_upscale_mode: Option<String>,
) -> Result<Value, String> {
    let base = normalize_base_url(&base_url)?;
    let http = client()?;
    ensure_minimax_optimization_nodes(
        &http,
        &base,
        normalize_latent_upscale_mode(latent_upscale_mode.as_deref()) != "off",
    )
    .await?;
    ensure_minimax_model_mode_ready(
        &http,
        &base,
        "ref2va",
        normalize_minimax_model_mode(minimax_model_mode.as_deref()),
    )
    .await?;
    if reference_images.len() > 9 || reference_videos.len() > 3 {
        return Err("Ref2VA는 이미지 최대 9개, 영상 최대 3개까지 지원합니다.".into());
    }
    let mut uploaded_images = Vec::with_capacity(reference_images.len());
    for (index, path) in reference_images.iter().enumerate() {
        uploaded_images
            .push(upload_image(&http, &base, path, &format!("ref-picture-{}", index + 1)).await?);
    }
    let mut uploaded_videos = Vec::with_capacity(reference_videos.len());
    for (index, path) in reference_videos.iter().enumerate() {
        uploaded_videos.push(
            upload_input_media(&http, &base, path, &format!("ref-video-{}", index + 1)).await?,
        );
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let prefix = format!("video/FrameFlow-Minimax-H3-Ref2VA-{stamp}");
    let (workflow, frames) = build_minimax_ref2va_video_workflow(
        &uploaded_images,
        &uploaded_videos,
        &prompt,
        width,
        height,
        duration,
        &prefix,
        seed,
        ref_image_size.as_deref().unwrap_or("match"),
        normalize_minimax_profile(minimax_profile.as_deref()),
        normalize_minimax_model_mode(minimax_model_mode.as_deref()),
        background_music.unwrap_or(false),
        normalize_latent_upscale_mode(latent_upscale_mode.as_deref()),
    )?;
    let response = http
        .post(format!("{base}/prompt"))
        .json(&json!({"prompt":workflow,"client_id":client_id}))
        .send()
        .await
        .map_err(|error| format!("ComfyUI Ref2VA 영상 작업 제출 실패: {error}"))?;
    let queued = response_json(response, "ComfyUI Ref2VA 영상 작업 제출").await?;
    let prompt_id = queued
        .get("prompt_id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("ComfyUI가 prompt_id를 반환하지 않았습니다: {queued}"))?;
    let descriptor = loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let response = http
            .get(format!("{base}/history/{prompt_id}"))
            .send()
            .await
            .map_err(|error| format!("ComfyUI Ref2VA 영상 상태 확인 실패: {error}"))?;
        let history = response_json(response, "ComfyUI Ref2VA 영상 상태 확인").await?;
        if let Some(entry) = history.get(prompt_id) {
            if entry.pointer("/status/status_str").and_then(Value::as_str) == Some("error") {
                return Err(format!(
                    "ComfyUI Ref2VA 영상 생성 실패: {}",
                    comfy_execution_error(entry)
                ));
            }
            if let Some(video) = entry.get("outputs").and_then(find_video) {
                break video;
            }
            if entry.pointer("/status/completed").and_then(Value::as_bool) == Some(true) {
                return Err(
                    "ComfyUI 작업은 완료됐지만 Ref2VA 영상 출력 정보를 찾지 못했습니다.".into(),
                );
            }
        }
    };
    let filename = descriptor
        .get("filename")
        .and_then(Value::as_str)
        .ok_or_else(|| "생성된 Ref2VA 영상 파일명이 없습니다.".to_string())?;
    let subfolder = descriptor
        .get("subfolder")
        .and_then(Value::as_str)
        .unwrap_or("");
    let output_type = descriptor
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("output");
    let response = http
        .get(format!("{base}/view"))
        .query(&[
            ("filename", filename),
            ("subfolder", subfolder),
            ("type", output_type),
        ])
        .send()
        .await
        .map_err(|error| format!("ComfyUI Ref2VA 영상 다운로드 실패: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("ComfyUI Ref2VA 영상 다운로드 실패 ({status})"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Ref2VA 영상 데이터를 읽지 못했습니다: {error}"))?;
    let target = PathBuf::from(&output_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&target, bytes)
        .map_err(|error| format!("Ref2VA 영상을 저장하지 못했습니다: {error}"))?;
    let quick_cleanup = quick_cleanup_request(&http, &base)
        .await
        .unwrap_or_else(|error| json!({"cleaned":false,"error":error}));
    Ok(json!({
        "path":target.to_string_lossy(),"promptId":prompt_id,"filename":filename,
        "fps":MINIMAX_FPS,"frames":frames,"duration":frames as f64/MINIMAX_FPS as f64,
        "seed":seed,"engine":"minimax-h3-ref2va","referenceImages":uploaded_images,
        "referenceVideos":uploaded_videos,"quickCleanup":quick_cleanup
    }))
}

#[tauri::command]
pub async fn comfy_extend_existing_video(
    base_url: String,
    client_id: String,
    source_video_path: String,
    first_image_path: Option<String>,
    last_image_path: Option<String>,
    prompt: String,
    width: u32,
    height: u32,
    duration: f64,
    output_path: String,
    seed: Option<u64>,
    minimax_profile: Option<String>,
    minimax_model_mode: Option<String>,
    background_music: Option<bool>,
) -> Result<Value, String> {
    if prompt.trim().is_empty() {
        return Err("비디오 확장 영문 프롬프트를 입력해 주세요.".into());
    }
    let profile = normalize_minimax_profile(minimax_profile.as_deref());
    if profile == "hybrid-8-4" {
        return Err("기존 영상 확장은 Context Loop를 사용하므로 4+8step 하이브리드를 지원하지 않습니다. Turbo 8step·10step 또는 품질우선 20step을 선택해 주세요.".into());
    }
    let model_mode = normalize_minimax_model_mode(minimax_model_mode.as_deref());
    let base = normalize_base_url(&base_url)?;
    let http = client()?;
    ensure_minimax_optimization_nodes(&http, &base, false).await?;
    ensure_minimax_model_mode_ready(&http, &base, "ref2va", model_mode).await?;
    for (node, label) in [
        (
            "MiniMaxH3ChainExternalVideo",
            "MiniMax H3 Existing Video Context",
        ),
        ("DenoTextEncoderUnload", "Deno Text Encoder Unload"),
    ] {
        let response = http
            .get(format!("{base}/object_info/{node}"))
            .send()
            .await
            .map_err(|error| format!("{label} 노드 확인 실패: {error}"))?;
        let info = response_json(response, &format!("{label} 노드 확인")).await?;
        if info.get(node).is_none() {
            return Err(format!("비디오 확장에 필요한 {label} 노드가 없습니다. Context Loop와 deno-custom-nodes 설치 후 Comfy Desktop을 다시 시작해 주세요."));
        }
    }
    let uploaded = upload_input_media(&http, &base, &source_video_path, "extension-source").await?;
    let uploaded_first = if let Some(path) = first_image_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(upload_image(&http, &base, path, "extension-internal-first").await?)
    } else {
        None
    };
    let uploaded_last = if let Some(path) = last_image_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(upload_image(&http, &base, path, "extension-last").await?)
    } else {
        None
    };
    if uploaded_last.is_some() && uploaded_first.is_none() {
        return Err("확장 LAST 이미지를 사용할 때 내부 원본 마지막 프레임이 필요합니다.".into());
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let run_name = format!("frameflow_extension_{stamp}");
    let shot = ContextLoopShotInput {
        last_image_path: String::new(),
        prompt,
        duration,
        seed,
    };
    let (workflow, generated_frames) = build_minimax_existing_video_workflow(
        &uploaded,
        uploaded_first.as_deref(),
        uploaded_last.as_deref(),
        &shot,
        width,
        height,
        &run_name,
        profile,
        model_mode,
        background_music.unwrap_or(false),
    )?;
    let response = http
        .post(format!("{base}/prompt"))
        .json(&json!({"prompt": workflow, "client_id": client_id}))
        .send()
        .await
        .map_err(|error| format!("ComfyUI 비디오 확장 작업 제출 실패: {error}"))?;
    let queued = response_json(response, "ComfyUI MiniMax-H3 비디오 확장 작업 제출").await?;
    let prompt_id = queued
        .get("prompt_id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("ComfyUI가 prompt_id를 반환하지 않았습니다: {queued}"))?;
    let (filename, subfolder, output_type) = loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let response = http
            .get(format!("{base}/history/{prompt_id}"))
            .send()
            .await
            .map_err(|error| format!("ComfyUI 비디오 확장 상태 확인 실패: {error}"))?;
        let history = response_json(response, "ComfyUI 비디오 확장 상태 확인").await?;
        if let Some(entry) = history.get(prompt_id) {
            if entry.pointer("/status/status_str").and_then(Value::as_str) == Some("error") {
                return Err(format!(
                    "ComfyUI 비디오 확장 실패: {}",
                    comfy_execution_error(entry)
                ));
            }
            if let Some(video) = entry.get("outputs").and_then(find_context_final_video_ref) {
                break video;
            }
            if entry.pointer("/status/completed").and_then(Value::as_bool) == Some(true) {
                return Err(
                    "비디오 확장은 완료됐지만 누적 합본 영상 경로를 반환하지 않았습니다.".into(),
                );
            }
        }
    };
    let target = download_comfy_output(
        &http,
        &base,
        &filename,
        &subfolder,
        &output_type,
        &output_path,
    )
    .await?;
    let quick_cleanup = quick_cleanup_request(&http, &base)
        .await
        .unwrap_or_else(|error| json!({"cleaned": false, "error": error}));
    Ok(json!({
        "path": target.to_string_lossy(),
        "promptId": prompt_id,
        "fps": MINIMAX_FPS,
        "generatedFrames": generated_frames,
        "contextFrames": 22,
        "engine": "minimax-h3-existing-video-extension",
        "runName": run_name,
        "quickCleanup": quick_cleanup
    }))
}

#[tauri::command]
pub async fn comfy_generate_continuous_video(
    app: tauri::AppHandle,
    base_url: String,
    client_id: String,
    first_image_path: String,
    shots: Vec<ContextLoopShotInput>,
    width: u32,
    height: u32,
    output_path: String,
    is_test: Option<bool>,
    minimax_profile: Option<String>,
    minimax_model_mode: Option<String>,
    background_music: Option<bool>,
) -> Result<Value, String> {
    let is_test = is_test.unwrap_or(false);
    let minimax_profile = normalize_minimax_profile(minimax_profile.as_deref());
    let cancel_epoch = CONTEXT_TEST_CANCEL_EPOCH.load(Ordering::SeqCst);
    let base = normalize_base_url(&base_url)?;
    let http = client()?;
    ensure_minimax_optimization_nodes(&http, &base, false).await?;
    ensure_minimax_model_mode_ready(
        &http,
        &base,
        "fl2va",
        normalize_minimax_model_mode(minimax_model_mode.as_deref()),
    )
    .await?;
    let context_info = http
        .get(format!("{base}/object_info/MiniMaxH3ChainPlan"))
        .send()
        .await
        .map_err(|error| format!("MiniMax-H3 Context Loop 노드 확인 실패: {error}"))?;
    if !context_info.status().is_success() {
        return Err("공식 MiniMax-H3 Context Loop 노드가 없습니다. Comfy Desktop custom_nodes 설치 후 다시 시작해 주세요.".into());
    }
    let cache_info = http
        .get(format!(
            "{base}/object_info/FrameFlowH3ConditioningPrefetch"
        ))
        .send()
        .await
        .map_err(|error| format!("FrameFlow H3 conditioning 선계산 노드 확인 실패: {error}"))?;
    if !cache_info.status().is_success() {
        return Err("FrameFlow H3 conditioning 선계산 노드가 아직 로드되지 않았습니다. FrameFlow에서 Comfy Desktop을 한 번 다시 시작해 주세요.".into());
    }
    let select_info = http
        .get(format!("{base}/object_info/FrameFlowH3ConditioningSelect"))
        .send()
        .await
        .map_err(|error| format!("FrameFlow H3 conditioning 선택 노드 확인 실패: {error}"))?;
    if !select_info.status().is_success() {
        return Err("FrameFlow H3 conditioning 선택 노드가 아직 로드되지 않았습니다. FrameFlow에서 Comfy Desktop을 한 번 다시 시작해 주세요.".into());
    }
    let unload_info = http
        .get(format!("{base}/object_info/DenoTextEncoderUnload"))
        .send()
        .await
        .map_err(|error| format!("Deno Text Encoder Unload 노드 확인 실패: {error}"))?;
    if !unload_info.status().is_success() {
        return Err("연속 영상에 필요한 (Deno) Text Encoder Unload 노드가 없습니다. deno-custom-nodes 설치 후 Comfy Desktop을 다시 시작해 주세요.".into());
    }
    if is_test {
        let response = http
            .get(format!("{base}/object_info/VRAM_Debug"))
            .send()
            .await
            .map_err(|error| format!("연속 영상(TEST) 메모리 정리 노드 확인 실패: {error}"))?;
        let info = response_json(response, "KJNodes VRAM_Debug 노드 확인").await?;
        if info.get("VRAM_Debug").is_none() {
            return Err("연속 영상(TEST)의 VAE 메모리 정리에 필요한 KJNodes VRAM_Debug 노드가 없습니다. KJNodes 설치 상태를 확인해 주세요.".into());
        }
    }
    let first = upload_image(&http, &base, &first_image_path, "context-first").await?;
    let mut last_images = Vec::with_capacity(shots.len());
    for (index, shot) in shots.iter().enumerate() {
        last_images.push(
            upload_image(
                &http,
                &base,
                &shot.last_image_path,
                &format!("context-last-{}", index + 1),
            )
            .await?,
        );
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let run_name = format!("frameflow_context_{stamp}");
    let (workflow, total_frames) = build_minimax_context_workflow(
        &first,
        &last_images,
        &shots,
        width,
        height,
        &run_name,
        is_test,
        minimax_profile,
        normalize_minimax_model_mode(minimax_model_mode.as_deref()),
        background_music.unwrap_or(false),
    )?;
    if is_test {
        let (prompt_id, (filename, subfolder, output_type), prompt_ids, _segment_refs) =
            run_context_test_clips(
                &http,
                &base,
                &client_id,
                &workflow,
                shots.len(),
                &CONTEXT_TEST_CANCEL_EPOCH,
                cancel_epoch,
                Duration::from_secs(2),
                |clip, stage, prompt_id| {
                    let _ = app.emit(
                        "frameflow-context-progress",
                        json!({
                            "clientId": client_id, "clip": clip, "count": shots.len(),
                            "stage": stage, "promptId": prompt_id, "runName": run_name
                        }),
                    );
                },
            )
            .await
            .map_err(|error| format!("{error} · 체크포인트 run: {run_name}"))?;
        let target = download_comfy_output(
            &http,
            &base,
            &filename,
            &subfolder,
            &output_type,
            &output_path,
        )
        .await?;
        let quick_cleanup = quick_cleanup_request(&http, &base)
            .await
            .unwrap_or_else(|error| json!({"cleaned": false, "error": error}));
        return Ok(json!({
            "path": target.to_string_lossy(), "promptId": prompt_id, "promptIds": prompt_ids,
            "fps": MINIMAX_FPS, "frames": total_frames,
            "engine": "minimax-h3-context-loop", "contextFrames": 22,
            "shotCount": shots.len(), "runName": run_name,
            "executionMode": "per-clip-checkpoint", "quickCleanup": quick_cleanup
        }));
    }
    let response = http
        .post(format!("{base}/prompt"))
        .json(&json!({"prompt": workflow, "client_id": client_id}))
        .send()
        .await
        .map_err(|error| format!("ComfyUI 연속 작업 제출 실패: {error}"))?;
    let queued = response_json(response, "ComfyUI MiniMax-H3 latent 연속 작업 제출").await?;
    let prompt_id = queued
        .get("prompt_id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("ComfyUI가 prompt_id를 반환하지 않았습니다: {queued}"))?;

    let (filename, subfolder, output_type) = loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let response = http
            .get(format!("{base}/history/{prompt_id}"))
            .send()
            .await
            .map_err(|error| format!("ComfyUI 연속 작업 상태 확인 실패: {error}"))?;
        let history =
            response_json(response, "ComfyUI MiniMax-H3 latent 연속 작업 상태 확인").await?;
        if let Some(entry) = history.get(&prompt_id) {
            if entry.pointer("/status/status_str").and_then(Value::as_str) == Some("error") {
                return Err(format!(
                    "ComfyUI 연속 생성 실패: {}",
                    comfy_execution_error(entry)
                ));
            }
            if let Some(video) = entry.get("outputs").and_then(find_context_final_video_ref) {
                break video;
            }
            if entry.pointer("/status/completed").and_then(Value::as_bool) == Some(true) {
                return Err(
                    "Context Loop는 완료됐지만 합본 영상 경로를 반환하지 않았습니다.".into(),
                );
            }
        }
    };
    let target = download_comfy_output(
        &http,
        &base,
        &filename,
        &subfolder,
        &output_type,
        &output_path,
    )
    .await?;
    let quick_cleanup = quick_cleanup_request(&http, &base)
        .await
        .unwrap_or_else(|error| json!({"cleaned": false, "error": error}));
    Ok(json!({
        "path": target.to_string_lossy(),
        "promptId": prompt_id,
        "fps": MINIMAX_FPS,
        "frames": total_frames,
        "engine": "minimax-h3-context-loop",
        "contextFrames": 22,
        "shotCount": shots.len(),
        "runName": run_name,
        "quickCleanup": quick_cleanup
    }))
}

#[tauri::command]
pub async fn comfy_generate_ref2va_continuous_video(
    app: tauri::AppHandle,
    base_url: String,
    client_id: String,
    reference_images: Vec<String>,
    reference_videos: Vec<String>,
    reference_audios: Vec<String>,
    shots: Vec<ContextLoopShotInput>,
    width: u32,
    height: u32,
    output_path: String,
    segment_output_paths: Vec<String>,
    is_test: Option<bool>,
    minimax_profile: Option<String>,
    minimax_model_mode: Option<String>,
    background_music: Option<bool>,
    ref_image_size: Option<String>,
) -> Result<Value, String> {
    let is_test = is_test.unwrap_or(false);
    let profile = normalize_minimax_profile(minimax_profile.as_deref());
    let cancel_epoch = CONTEXT_TEST_CANCEL_EPOCH.load(Ordering::SeqCst);
    let base = normalize_base_url(&base_url)?;
    let http = client()?;
    ensure_minimax_optimization_nodes(&http, &base, false).await?;
    ensure_minimax_model_mode_ready(
        &http,
        &base,
        "ref2va",
        normalize_minimax_model_mode(minimax_model_mode.as_deref()),
    )
    .await?;
    let info = http
        .get(format!(
            "{base}/object_info/FrameFlowH3Ref2VAConditioningPrefetch"
        ))
        .send()
        .await
        .map_err(|error| format!("FrameFlow Ref2VA 연속 노드 확인 실패: {error}"))?;
    if !info.status().is_success() {
        return Err("Ref2VA 연속 conditioning 노드가 로드되지 않았습니다. 새 FrameFlow에서 Comfy Desktop을 한 번 다시 시작해 주세요.".into());
    }

    let mut uploaded_images = Vec::with_capacity(reference_images.len());
    for (index, path) in reference_images.iter().enumerate() {
        uploaded_images.push(
            upload_image(
                &http,
                &base,
                path,
                &format!("ref-chain-picture-{}", index + 1),
            )
            .await?,
        );
    }
    let mut uploaded_videos = Vec::with_capacity(reference_videos.len());
    for (index, path) in reference_videos.iter().enumerate() {
        uploaded_videos.push(
            upload_input_media(
                &http,
                &base,
                path,
                &format!("ref-chain-video-{}", index + 1),
            )
            .await?,
        );
    }
    let mut uploaded_audios = Vec::with_capacity(reference_audios.len());
    for (index, path) in reference_audios.iter().enumerate() {
        uploaded_audios.push(
            upload_input_media(
                &http,
                &base,
                path,
                &format!("ref-chain-audio-{}", index + 1),
            )
            .await?,
        );
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let run_name = format!("frameflow_ref2va_context_{stamp}");
    let (workflow, total_frames) = build_minimax_ref2va_context_workflow(
        &uploaded_images,
        &uploaded_videos,
        &uploaded_audios,
        &shots,
        width,
        height,
        &run_name,
        is_test,
        profile,
        normalize_minimax_model_mode(minimax_model_mode.as_deref()),
        background_music.unwrap_or(false),
        ref_image_size.as_deref().unwrap_or("match"),
    )?;
    let (prompt_id, (filename, subfolder, output_type), prompt_ids, segment_refs) =
        run_context_test_clips(
            &http,
            &base,
            &client_id,
            &workflow,
            shots.len(),
            &CONTEXT_TEST_CANCEL_EPOCH,
            cancel_epoch,
            Duration::from_secs(2),
            |clip, stage, prompt_id| {
                let _ = app.emit(
                    "frameflow-context-progress",
                    json!({
                        "clientId": client_id, "clip": clip, "count": shots.len(),
                        "stage": stage, "promptId": prompt_id, "runName": run_name,
                        "kind": "ref2va"
                    }),
                );
            },
        )
        .await
        .map_err(|error| format!("{error} · 체크포인트 run: {run_name}"))?;
    let target = download_comfy_output(
        &http,
        &base,
        &filename,
        &subfolder,
        &output_type,
        &output_path,
    )
    .await?;
    let mut segments = Vec::new();
    for (index, descriptor) in segment_refs.iter().enumerate() {
        let requested = segment_output_paths.get(index).cloned().unwrap_or_else(|| {
            PathBuf::from(&output_path)
                .with_file_name(format!("clip_{:04}.mp4", index + 1))
                .to_string_lossy()
                .into_owned()
        });
        let path = download_comfy_output(
            &http,
            &base,
            &descriptor.0,
            &descriptor.1,
            &descriptor.2,
            &requested,
        )
        .await?;
        segments.push(path.to_string_lossy().into_owned());
    }
    let quick_cleanup = quick_cleanup_request(&http, &base)
        .await
        .unwrap_or_else(|error| json!({"cleaned": false, "error": error}));
    Ok(json!({
        "path": target.to_string_lossy(), "segments": segments,
        "promptId": prompt_id, "promptIds": prompt_ids,
        "fps": MINIMAX_FPS, "frames": total_frames,
        "engine": "minimax-h3-ref2va-context-loop", "contextFrames": 22,
        "shotCount": shots.len(), "runName": run_name,
        "executionMode": "per-clip-checkpoint", "quickCleanup": quick_cleanup
    }))
}

#[tauri::command]
pub async fn comfy_recover_continuous_video(
    base_url: String,
    job_id: String,
    output_path: String,
) -> Result<Value, String> {
    let base = normalize_base_url(&base_url)?;
    let http = client()?;
    let mut matches = Vec::new();
    if let Ok(response) = http
        .get(format!("{base}/history?max_items=200"))
        .send()
        .await
    {
        if let Ok(history) = response_json(response, "ComfyUI 연속 영상 복구 기록 확인").await
        {
            if let Some(entries) = history.as_object() {
                for (prompt_id, entry) in entries {
                    let client_id = entry
                        .pointer("/prompt/3/client_id")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let completed = entry
                        .pointer("/status/completed")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let success = entry.pointer("/status/status_str").and_then(Value::as_str)
                        == Some("success");
                    if !client_id.contains(&job_id) || !completed || !success {
                        continue;
                    }
                    if let Some(video) = entry.get("outputs").and_then(find_context_final_video_ref)
                    {
                        let created = entry
                            .pointer("/prompt/3/create_time")
                            .and_then(Value::as_u64)
                            .unwrap_or_default();
                        matches.push((created, prompt_id.clone(), video));
                    }
                }
            }
        }
    }
    let (target, prompt_id, offline) =
        if let Some((_, prompt_id, (filename, subfolder, output_type))) =
            matches.into_iter().max_by_key(|item| item.0)
        {
            (
                download_comfy_output(
                    &http,
                    &base,
                    &filename,
                    &subfolder,
                    &output_type,
                    &output_path,
                )
                .await?,
                Some(prompt_id),
                false,
            )
        } else if let Some(path) = recover_local_context_output(&job_id, &output_path)? {
            (path, None, true)
        } else {
            return Ok(Value::Null);
        };
    Ok(json!({
        "path": target.to_string_lossy(),
        "promptId": prompt_id,
        "fps": MINIMAX_FPS,
        "engine": "minimax-h3-context-loop",
        "contextFrames": 22,
        "recovered": true,
        "offlineRecovery": offline
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref2va_audio_workflow_uses_installed_models_and_decodes_audio_only() {
        let (workflow, frames) = build_minimax_ref2va_audio_workflow(
            "reference-video.mp4",
            "Low sustained chords with a brief impact on the visual transition.",
            288,
            160,
            5.0,
            "audio/frameflow-test",
            Some(42),
            "turbo-10",
            "default",
            false,
            "off",
        )
        .expect("Ref2VA audio workflow");

        assert_eq!(frames, 124);
        assert_eq!(workflow.pointer("/11/inputs/steps"), Some(&json!(10)));
        assert_eq!(
            workflow
                .pointer("/3/inputs/unet_name")
                .and_then(Value::as_str),
            Some("minimax_h3_ref2va_pruned_int8_convrot.safetensors")
        );
        assert_eq!(
            workflow
                .pointer("/7/inputs/lora_name")
                .and_then(Value::as_str),
            Some(MINIMAX_TURBO_V4_8STEP_LORA)
        );
        assert_eq!(
            workflow.pointer("/8/inputs/ref_videos.ref_video_0"),
            Some(&json!(["2", 0]))
        );
        assert!(workflow
            .pointer("/8/inputs/ref_video_audios.ref_video_audio_0")
            .is_none());
        assert_eq!(
            workflow.pointer("/14/class_type").and_then(Value::as_str),
            Some("VAEDecodeAudio")
        );
        assert_eq!(
            workflow.pointer("/15/class_type").and_then(Value::as_str),
            Some("SaveAudioMP3")
        );
        assert!(workflow
            .as_object()
            .is_some_and(|nodes| nodes.values().all(|node| {
                !matches!(
                    node.get("class_type").and_then(Value::as_str),
                    Some("VAEDecode") | Some("CreateVideo") | Some("SaveVideo")
                )
            })));
        assert_eq!(
            workflow
                .pointer("/16/inputs/attention")
                .and_then(Value::as_str),
            Some("comfy kitchen attention")
        );
        assert_eq!(
            workflow.pointer("/12/inputs/conditioning"),
            Some(&json!(["17", 0]))
        );
        let prompt = workflow
            .pointer("/8/inputs/prompt")
            .and_then(Value::as_str)
            .expect("wrapped H3 prompt");
        for section in [
            "subject_definitions:",
            "summary:",
            "retention_analysis:",
            "detailed_description:",
            "overall_soundscape:",
            "non_diegetic_music:",
        ] {
            assert!(prompt.contains(section), "missing section {section}");
        }
        assert!(!prompt.contains("overall_soundscape and music direction:"));

        let official_prompt = "subject_definitions:\n<Video 1> is silent.\n\nsummary:\n[reference generation] New soundtrack.\n\nretention_analysis:\n<Video 1>: fully_preserved.\n\ndetailed_description:\n[Shot 1] A visible transition receives a synchronized impact.\n\noverall_soundscape:\nA brief physical impact.\n\nnon_diegetic_music:\nSlow low strings.";
        let (official_workflow, _) = build_minimax_ref2va_audio_workflow(
            "official-reference.mp4",
            official_prompt,
            288,
            160,
            5.0,
            "audio/frameflow-official-test",
            Some(45),
            "turbo-10",
            "default",
            true,
            "off",
        )
        .expect("official Ref2VA prompt workflow");
        assert_eq!(
            official_workflow
                .pointer("/8/inputs/prompt")
                .and_then(Value::as_str),
            Some(official_prompt)
        );

        let (minute_workflow, minute_frames) = build_minimax_ref2va_audio_workflow(
            "one-minute-reference.mp4",
            "Continuous soundtrack synchronized to the complete reference video.",
            288,
            160,
            60.0,
            "audio/frameflow-minute-test",
            Some(43),
            "turbo-10",
            "default",
            false,
            "off",
        )
        .expect("one-minute Ref2VA audio workflow");
        assert_eq!(minute_frames, 1450);
        assert_eq!(
            minute_workflow
                .pointer("/8/inputs/length")
                .and_then(Value::as_u64),
            Some(1450)
        );

        let long_error = build_minimax_ref2va_audio_workflow(
            "five-minute-reference.mp4",
            "A continuous five-minute soundtrack.",
            288,
            160,
            300.0,
            "audio/frameflow-long-test",
            Some(44),
            "turbo-10",
            "default",
            false,
            "off",
        )
        .expect_err("an oversized Ref2VA segment must be rejected before Comfy submission");
        assert!(long_error.contains("149초 이하"));
    }

    #[tokio::test]
    #[ignore = "실행 중인 ComfyUI 기록에서 완료된 연속 영상을 복구하는 수동 E2E 검증"]
    async fn live_recovers_completed_context_video_by_job_id() {
        let output = std::env::temp_dir().join("frameflow-context-recovery-test.mp4");
        let recovered = comfy_recover_continuous_video(
            "http://127.0.0.1:8188".into(),
            "job-1788003935477-context-3".into(),
            output.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        let path = recovered.get("path").and_then(Value::as_str).unwrap();
        assert!(Path::new(path).is_file());
        assert!(fs::metadata(path).unwrap().len() > 1_000_000);
    }

    #[test]
    fn context_result_prefers_final_assembly_over_segment_clips() {
        let outputs = json!({
            "1704": {"images": [{"filename": "clip_0001.mp4", "subfolder": "h3_chains\\run\\segments", "type": "output"}]},
            "1706": {"images": [{"filename": "frameflow_context_loop.mp4", "subfolder": "h3_chains\\run\\final", "type": "output"}]}
        });
        let selected = find_context_final_video_ref(&outputs).unwrap();
        assert_eq!(selected.0, "frameflow_context_loop.mp4");
        assert!(selected.1.ends_with("final"));
    }

    #[test]
    fn workflow_applies_frames_images_and_never_negative_prompt() {
        let workflow = build_workflow(
            "first.png",
            "last.png",
            "positive only",
            640,
            640,
            81,
            "video/test",
            Some(610_773_037_305_500),
        )
        .unwrap();
        assert_eq!(
            workflow.pointer("/6/inputs/text").and_then(Value::as_str),
            Some("positive only")
        );
        assert_eq!(
            workflow.pointer("/7/inputs/text").and_then(Value::as_str),
            Some("")
        );
        assert_eq!(
            workflow
                .pointer("/67/inputs/length")
                .and_then(Value::as_u64),
            Some(81)
        );
        assert_eq!(
            workflow.pointer("/60/inputs/fps").and_then(Value::as_u64),
            Some(16)
        );
        assert_eq!(
            workflow.pointer("/68/inputs/image").and_then(Value::as_str),
            Some("first.png")
        );
        assert_eq!(
            workflow.pointer("/62/inputs/image").and_then(Value::as_str),
            Some("last.png")
        );
        assert_eq!(
            workflow.pointer("/99/class_type").and_then(Value::as_str),
            Some("UnetLoaderGGUF")
        );
        assert_eq!(
            workflow
                .pointer("/99/inputs/unet_name")
                .and_then(Value::as_str),
            Some("Wan2.2-I2V-A14B-HighNoise-Q5_1.gguf")
        );
        assert_eq!(
            workflow
                .pointer("/100/inputs/unet_name")
                .and_then(Value::as_str),
            Some("Wan2.2-I2V-A14B-LowNoise-Q5_1.gguf")
        );
        assert_eq!(workflow.pointer("/91/inputs/model/0"), Some(&json!("99")));
        assert_eq!(workflow.pointer("/92/inputs/model/0"), Some(&json!("100")));
        assert_eq!(
            workflow
                .pointer("/57/inputs/noise_seed")
                .and_then(Value::as_u64),
            Some(610_773_037_305_500)
        );
    }

    #[test]
    fn minimax_workflow_applies_flf_resolution_duration_and_seed() {
        let (workflow, frames) = build_minimax_workflow(
            "first.png",
            "last.png",
            "A clear motion prompt",
            3936,
            864,
            5.0,
            "video/test-minimax",
            Some(42),
            "turbo-10",
            "default",
            false,
            "off",
        )
        .unwrap();
        assert_eq!(frames, 124);
        assert_eq!(workflow["1"]["inputs"]["image"], "first.png");
        assert_eq!(workflow["2"]["inputs"]["image"], "last.png");
        assert_eq!(workflow["8"]["inputs"]["width"], 3936);
        assert_eq!(workflow["8"]["inputs"]["height"], 864);
        assert_eq!(workflow["8"]["inputs"]["length"], 124);
        assert_eq!(workflow["9"]["inputs"]["noise_seed"], 42);
        assert_eq!(workflow["18"]["class_type"], "ModelAttentionBackend");
        assert_eq!(
            workflow["18"]["inputs"]["attention"],
            "comfy kitchen attention"
        );
        assert_eq!(workflow["7"]["inputs"]["model"], json!(["18", 0]));
        assert_eq!(workflow["19"]["class_type"], "DenoTextEncoderUnload");
        assert_eq!(workflow["19"]["inputs"]["value"], json!(["8", 0]));
        assert_eq!(workflow["19"]["inputs"]["clip"], json!(["4", 0]));
        assert_eq!(workflow["19"]["inputs"]["wait_for"], json!(["8", 1]));
        assert_eq!(workflow["12"]["inputs"]["conditioning"], json!(["19", 0]));
        assert_eq!(
            workflow["17"]["inputs"]["filename_prefix"],
            "video/test-minimax"
        );
    }

    #[test]
    fn minimax_w4a8_mode_uses_the_core_diffusion_loader() {
        let (int4, _) = build_minimax_workflow(
            "first.png",
            "last.png",
            "Static camera. Continuous light motion.",
            960,
            416,
            5.0,
            "video/int4-fl2va",
            Some(41),
            "turbo-10",
            "int4",
            false,
            "off",
        )
        .unwrap();
        assert_eq!(int4["3"]["class_type"], "UNETLoader");
        assert_eq!(int4["3"]["inputs"]["unet_name"], MINIMAX_FL2VA_INT4_MODEL);

        let (fl2va, _) = build_minimax_workflow(
            "first.png",
            "last.png",
            "Static camera. Continuous light motion.",
            960,
            416,
            5.0,
            "video/w4a8-fl2va",
            Some(42),
            "turbo-10",
            "w4a8",
            false,
            "off",
        )
        .unwrap();
        assert_eq!(fl2va["3"]["class_type"], "UNETLoader");
        assert_eq!(fl2va["3"]["inputs"]["unet_name"], MINIMAX_FL2VA_W4A8_MODEL);
        assert_eq!(fl2va["18"]["inputs"]["model"], json!(["3", 0]));
        assert_eq!(fl2va["4"]["class_type"], "CLIPLoader");
        assert_eq!(fl2va["5"]["class_type"], "VAELoader");

        let prompt = "subject_definitions:\n<Video 1> is the reference.\n\nsummary:\n[video editing]\n\nretention_analysis:\n<Video 1>: preserved.\n\ndetailed_description:\n[Shot 1] Preserve motion.\n\noverall_soundscape:\nSynchronized effects.\n\nnon_diegetic_music:\nN/A";
        let (int4_ref2va, _) = build_minimax_ref2va_video_workflow(
            &[],
            &["reference.mp4".into()],
            prompt,
            960,
            416,
            5.0,
            "video/int4-ref2va",
            Some(42),
            "match",
            "turbo-10",
            "int4",
            false,
            "off",
        )
        .unwrap();
        assert_eq!(int4_ref2va["3"]["class_type"], "UNETLoader");
        assert_eq!(
            int4_ref2va["3"]["inputs"]["unet_name"],
            MINIMAX_REF2VA_INT4_MODEL
        );

        let (ref2va, _) = build_minimax_ref2va_video_workflow(
            &[],
            &["reference.mp4".into()],
            prompt,
            960,
            416,
            5.0,
            "video/w4a8-ref2va",
            Some(43),
            "match",
            "turbo-10",
            "w4a8",
            false,
            "off",
        )
        .unwrap();
        assert_eq!(ref2va["3"]["class_type"], "UNETLoader");
        assert_eq!(
            ref2va["3"]["inputs"]["unet_name"],
            MINIMAX_REF2VA_W4A8_MODEL
        );
        assert_eq!(ref2va["4"]["class_type"], "CLIPLoader");
        assert_eq!(ref2va["5"]["class_type"], "VAELoader");
    }

    #[test]
    fn minimax_latent_upscale_builds_two_pass_av_graph_without_chunking() {
        let (workflow, _) = build_minimax_workflow(
            "first.png",
            "last.png",
            "Static camera. Light moves continuously.",
            960,
            416,
            5.0,
            "video/latent-upscale-test",
            Some(42),
            "turbo-10",
            "default",
            false,
            "half-to-one",
        )
        .unwrap();
        assert_eq!(workflow["8"]["inputs"]["width"], 480);
        assert_eq!(workflow["8"]["inputs"]["height"], 224);
        assert_eq!(workflow["108"]["inputs"]["width"], 960);
        assert_eq!(workflow["108"]["inputs"]["height"], 416);
        assert_eq!(workflow["120"]["class_type"], "LTXVSeparateAVLatent");
        assert_eq!(workflow["121"]["class_type"], "MinimaxH3LatentUpscaler3D");
        assert_eq!(workflow["121"]["inputs"]["mode.width"], 960);
        assert_eq!(workflow["121"]["inputs"]["mode.height"], 416);
        assert_eq!(workflow["121"]["inputs"]["enable_temporal_chunking"], false);
        assert_eq!(workflow["122"]["class_type"], "LTXVConcatAVLatent");
        assert_eq!(workflow["127"]["inputs"]["latent_image"], json!(["122", 0]));
        assert_eq!(workflow["14"]["inputs"]["samples"], json!(["127", 0]));
        assert_eq!(workflow["15"]["inputs"]["samples"], json!(["127", 0]));
        assert_eq!(workflow["19"]["inputs"]["wait_for"], json!(["108", 0]));
    }

    #[test]
    fn minimax_two_thirds_latent_mode_aligns_to_32_pixels() {
        assert_eq!(
            latent_upscale_dimensions(3936, 864, "two-thirds-to-one"),
            (2624, 576, 3936, 864)
        );
        assert_eq!(
            normalize_latent_upscale_mode(Some("two-thirds-to-one")),
            "two-thirds-to-one"
        );
    }

    #[test]
    fn minimax_profiles_build_distinct_sampling_graphs_and_quality_has_no_acceleration_lora() {
        let build = |profile: &str| {
            build_minimax_workflow(
                "first.png",
                "last.png",
                "Static camera. A visible impact creates physical sparks.\n\noverall_soundscape:\nSharp impact and falling debris.\n\nnon_diegetic_music:\nSlow strings.",
                960,
                416,
                5.0,
                "video/profile-test",
                Some(42),
                profile,
                "default",
                false,
                "off",
            )
            .unwrap()
            .0
        };

        let turbo8 = build("turbo-8");
        assert_eq!(
            turbo8["7"]["inputs"]["lora_name"],
            MINIMAX_TURBO_V4_8STEP_LORA
        );
        assert!(turbo8.get("51").is_none());
        assert_eq!(turbo8["10"]["inputs"]["sampler_name"], "euler");
        assert_eq!(turbo8["11"]["inputs"]["scheduler"], "beta");
        assert_eq!(turbo8["11"]["inputs"]["steps"], 8);
        assert_eq!(turbo8["12"]["inputs"]["model"], json!(["50", 0]));

        let speed4 = build("speed-4");
        assert!(speed4["7"]["inputs"]["lora_name"]
            .as_str()
            .unwrap()
            .contains("fl2v_turbo_4step"));
        assert_eq!(speed4["50"]["inputs"]["shift_video"], 6.0);
        assert_eq!(speed4["50"]["inputs"]["shift_audio"], 3.0);
        assert_eq!(speed4["10"]["inputs"]["sampler_name"], "euler");
        assert_eq!(speed4["11"]["inputs"]["scheduler"], "simple");
        assert_eq!(speed4["11"]["inputs"]["steps"], 4);

        let turbo10 = build("turbo-10");
        assert_eq!(turbo10["11"]["inputs"]["steps"], 10);
        assert_eq!(
            turbo10["7"]["inputs"]["lora_name"],
            MINIMAX_TURBO_V4_8STEP_LORA
        );

        let hybrid = build("hybrid-8-4");
        assert_eq!(hybrid["51"]["class_type"], "MiniMaxH3PDDAccApply");
        assert_eq!(hybrid["51"]["inputs"]["nfe"], "8");
        assert_eq!(hybrid["13"]["inputs"]["latent_image"], json!(["54", 0]));
        assert!(hybrid["7"]["inputs"]["lora_name"]
            .as_str()
            .unwrap()
            .contains("turbo_4step"));

        let quality = build("quality-20");
        assert!(
            quality.get("7").is_none(),
            "quality profile must not load Turbo LoRA"
        );
        assert!(
            quality.get("50").is_none(),
            "quality profile must not add PDD nodes"
        );
        assert_eq!(quality["11"]["inputs"]["steps"], 20);
        assert_eq!(quality["11"]["inputs"]["model"], json!(["18", 0]));
        assert_eq!(quality["12"]["inputs"]["model"], json!(["18", 0]));

        let prompt = quality["8"]["inputs"]["prompt"].as_str().unwrap();
        assert!(prompt.contains("overall_soundscape:\nSharp impact and falling debris."));
        assert!(prompt.ends_with("non_diegetic_music:\nN/A"));
        assert!(!prompt.contains("Slow strings."));
    }

    #[test]
    fn minimax_ref2va_video_maps_native_picture_and_video_slots() {
        let prompt = "subject_definitions:\n<Subject 1> comes from <Picture 1>.\n\nsummary:\n[reference generation]\n\nretention_analysis:\n<Picture 1>: preserved. <Video 1>: attribute_transfer.\n\ndetailed_description:\n[Shot 1] Use <Subject 1>.\n\noverall_soundscape:\nSilence\n\nnon_diegetic_music:\nN/A";
        let (workflow, frames) = build_minimax_ref2va_video_workflow(
            &["person.png".into(), "object.png".into()],
            &["motion.mp4".into()],
            prompt,
            1344,
            768,
            5.0,
            "video/ref2va-test",
            Some(77),
            "match",
            "turbo-10",
            "default",
            false,
            "off",
        )
        .unwrap();
        assert_eq!(frames, 124);
        assert_eq!(
            workflow["3"]["inputs"]["unet_name"],
            "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
        );
        assert_eq!(workflow["100"]["inputs"]["image"], "person.png");
        assert_eq!(workflow["101"]["inputs"]["image"], "object.png");
        assert_eq!(workflow["200"]["inputs"]["file"], "motion.mp4");
        assert_eq!(
            workflow["8"]["inputs"]["ref_images.ref_image_0"],
            json!(["100", 0])
        );
        assert_eq!(
            workflow["8"]["inputs"]["ref_images.ref_image_1"],
            json!(["101", 0])
        );
        assert_eq!(
            workflow["8"]["inputs"]["ref_videos.ref_video_0"],
            json!(["201", 0])
        );
        assert_eq!(workflow["8"]["inputs"]["prompt"], prompt);
        assert_eq!(workflow["9"]["inputs"]["noise_seed"], 77);
        assert_eq!(workflow["12"]["inputs"]["conditioning"], json!(["19", 0]));
    }

    #[test]
    fn minimax_context_loop_uses_latent_context_and_all_cut_targets() {
        let shots = vec![
            ContextLoopShotInput {
                last_image_path: "one.png".into(),
                prompt: "first move".into(),
                duration: 5.0,
                seed: Some(10),
            },
            ContextLoopShotInput {
                last_image_path: "two.png".into(),
                prompt: "second move".into(),
                duration: 10.0,
                seed: Some(11),
            },
            ContextLoopShotInput {
                last_image_path: "three.png".into(),
                prompt: "third move".into(),
                duration: 5.0,
                seed: Some(12),
            },
        ];
        let images = vec![
            "uploaded-one.png".into(),
            "uploaded-two.png".into(),
            "uploaded-three.png".into(),
        ];
        let (workflow, frames) = build_minimax_context_workflow(
            "uploaded-first.png",
            &images,
            &shots,
            960,
            416,
            "test_context",
            false,
            "turbo-10",
            "default",
            false,
        )
        .unwrap();
        assert_eq!(
            workflow["1700"]["inputs"]["continuation_mode"],
            "latent_guide"
        );
        assert_eq!(workflow["1952"]["inputs"]["incoming_transition"], "guide");
        assert_eq!(workflow["1952"]["inputs"]["generated_continuity"], "on");
        assert_eq!(
            workflow["1941"]["inputs"]["attention"],
            "comfy kitchen attention"
        );
        assert_eq!(workflow["1700"]["inputs"]["context_length"], 22);
        assert_eq!(workflow["1944"]["inputs"]["enabled"], false);
        assert_eq!(workflow["1945"]["inputs"]["image"], "uploaded-first.png");
        assert!(workflow.get("110").is_none());
        assert!(workflow.get("1948").is_none());
        assert_eq!(
            workflow["22000"]["class_type"],
            "FrameFlowH3ConditioningPrefetch"
        );
        assert_eq!(
            workflow["22001"]["class_type"],
            "FrameFlowH3ConditioningSelect"
        );
        assert_eq!(
            workflow["1703"]["inputs"]["conditioning"],
            json!(["22001", 0])
        );
        assert_eq!(workflow["1703"]["inputs"]["latent"], json!(["22001", 1]));
        assert_eq!(workflow["1703"]["inputs"]["audio_vae"], json!(["4", 0]));
        assert_eq!(
            workflow["22000"]["inputs"]["first_frame"],
            json!(["1945", 0])
        );
        assert_eq!(
            workflow["22000"]["inputs"]["last_frame_1"],
            json!(["21001", 0])
        );
        assert_eq!(
            workflow["22000"]["inputs"]["last_frame_2"],
            json!(["21002", 0])
        );
        assert_eq!(
            workflow["22000"]["inputs"]["prompt_3"],
            "third move\n\nnon_diegetic_music:\nN/A"
        );
        assert_eq!(workflow["22002"]["class_type"], "DenoTextEncoderUnload");
        assert_eq!(workflow["22002"]["inputs"]["value"], json!(["22000", 0]));
        assert_eq!(workflow["22002"]["inputs"]["clip"], json!(["2", 0]));
        assert_eq!(workflow["22002"]["inputs"]["wait_for"], json!(["22000", 1]));
        assert_eq!(workflow["22001"]["inputs"]["bank"], json!(["22002", 0]));
        assert_eq!(
            workflow["2000"]["inputs"]["lora_name"],
            MINIMAX_TURBO_V4_8STEP_LORA
        );
        assert_eq!(workflow["5"]["inputs"]["model"], json!(["2000", 0]));
        assert_eq!(frames, 124 + 243 + 124);
        let plan: Value =
            serde_json::from_str(workflow["1700"]["inputs"]["plan_json"].as_str().unwrap())
                .unwrap();
        assert_eq!(plan["shots"].as_array().unwrap().len(), 3);
        assert_eq!(
            plan["shots"][1]["prompt"],
            "second move\n\nnon_diegetic_music:\nN/A"
        );
        assert_eq!(plan["shots"][1]["continuation_mode"], "latent_guide");
        assert_eq!(plan["shots"][1]["generated_continuity"], "on");
        let invalid_size = build_minimax_context_workflow(
            "uploaded-first.png",
            &images,
            &shots,
            1000,
            416,
            "invalid_context_size",
            true,
            "turbo-10",
            "default",
            false,
        )
        .expect_err("a non-32-multiple context size must be rejected before Comfy submission");
        assert!(invalid_size.contains("32의 배수"));
    }

    #[test]
    fn existing_video_extension_uses_only_the_final_22_frames_and_prepends_source() {
        let shot = ContextLoopShotInput {
            last_image_path: String::new(),
            prompt: "integrated_multimodal_description:\nContinue the incoming motion.\n\noverall_soundscape:\nSynchronized effects.\n\nnon_diegetic_music:\nN/A".into(),
            duration: 5.0,
            seed: Some(42),
        };
        let (workflow, frames) = build_minimax_existing_video_workflow(
            "uploaded-source.mp4",
            None,
            None,
            &shot,
            416,
            224,
            "extension-test",
            "turbo-10",
            "default",
            false,
        )
        .expect("existing video extension workflow");
        assert_eq!(workflow["24000"]["class_type"], "LoadVideo");
        assert_eq!(workflow["24000"]["inputs"]["file"], "uploaded-source.mp4");
        assert_eq!(
            workflow["24001"]["class_type"],
            "MiniMaxH3ChainExternalVideo"
        );
        assert_eq!(workflow["24001"]["inputs"]["prepend_original"], true);
        assert_eq!(
            workflow["1701"]["inputs"]["external_context"],
            json!(["24001", 0])
        );
        assert_eq!(workflow["1700"]["inputs"]["context_length"], 22);
        assert_eq!(workflow["1700"]["inputs"]["anchor_mode"], "head");
        assert_eq!(workflow["110"]["class_type"], "MiniMaxH3ReferenceToVideo");
        assert_eq!(
            workflow["1703"]["inputs"]["conditioning"],
            json!(["22002", 0])
        );
        assert_eq!(workflow["1703"]["inputs"]["latent"], json!(["110", 1]));
        assert_eq!(workflow["1703"]["inputs"]["audio_vae"], json!(["4", 0]));
        assert_eq!(workflow["22002"]["class_type"], "DenoTextEncoderUnload");
        assert_eq!(frames, 124);
    }

    #[test]
    fn existing_video_extension_can_add_an_optional_last_target() {
        let shot = ContextLoopShotInput {
            last_image_path: String::new(),
            prompt: "Continue into the requested final composition.".into(),
            duration: 5.0,
            seed: Some(7),
        };
        let (workflow, _) = build_minimax_existing_video_workflow(
            "source.mp4",
            Some("internal-first.png"),
            Some("optional-last.png"),
            &shot,
            416,
            224,
            "extension-last-test",
            "turbo-10",
            "default",
            false,
        )
        .expect("extension workflow with LAST target");
        assert_eq!(workflow["110"]["class_type"], "MiniMaxH3ImageToVideo");
        assert_eq!(
            workflow["110"]["inputs"]["first_frame"],
            json!(["24002", 0])
        );
        assert_eq!(workflow["110"]["inputs"]["last_frame"], json!(["24003", 0]));
        assert!(workflow["110"]["inputs"].get("audio_vae").is_none());
        assert_eq!(workflow["24002"]["inputs"]["image"], "internal-first.png");
        assert_eq!(workflow["24003"]["inputs"]["image"], "optional-last.png");
        assert_eq!(
            workflow["1701"]["inputs"]["external_context"],
            json!(["24001", 0])
        );
    }

    #[test]
    fn ref2va_context_loop_keeps_references_and_22_frame_latent_chain() {
        let prompt = "subject_definitions:\n<Picture 1> is the subject.\n\nsummary:\n[reference generation] Continue.\n\nretention_analysis:\n<Picture 1>: preserved.\n\ndetailed_description:\n[Shot 1] Continue the motion.\n\noverall_soundscape:\nSynchronized physical effects.\n\nnon_diegetic_music:\nN/A";
        let shots = vec![
            ContextLoopShotInput {
                last_image_path: String::new(),
                prompt: prompt.into(),
                duration: 5.0,
                seed: Some(1),
            },
            ContextLoopShotInput {
                last_image_path: String::new(),
                prompt: prompt.into(),
                duration: 5.0,
                seed: Some(2),
            },
        ];
        let (workflow, _) = build_minimax_ref2va_context_workflow(
            &["picture.png".into()],
            &["motion.mp4".into()],
            &["voice.wav".into()],
            &shots,
            416,
            224,
            "ref2va-test",
            true,
            "turbo-10",
            "default",
            false,
            "match",
        )
        .expect("Ref2VA context workflow");
        assert_eq!(
            workflow
                .pointer("/1/inputs/unet_name")
                .and_then(Value::as_str),
            Some("minimax_h3_ref2va_pruned_int8_convrot.safetensors")
        );
        assert_eq!(
            workflow
                .pointer("/22000/class_type")
                .and_then(Value::as_str),
            Some("FrameFlowH3Ref2VAConditioningPrefetch")
        );
        assert_eq!(
            workflow.pointer("/22000/inputs/ref_image_1"),
            Some(&json!(["23001", 0]))
        );
        assert_eq!(
            workflow.pointer("/22000/inputs/ref_video_1"),
            Some(&json!(["23201", 0]))
        );
        assert_eq!(
            workflow.pointer("/22000/inputs/ref_audio_1"),
            Some(&json!(["23301", 0]))
        );
        assert_eq!(
            workflow.pointer("/1700/inputs/context_length"),
            Some(&json!(22))
        );
        assert_eq!(
            workflow
                .pointer("/1700/inputs/continuation_mode")
                .and_then(Value::as_str),
            Some("latent_guide")
        );
        assert!(workflow.get("1945").is_none());
        assert!(workflow
            .as_object()
            .unwrap()
            .keys()
            .all(|node| !node.starts_with("21")));
    }

    #[test]
    fn context_text_encoder_unload_is_shared_by_test_and_full_workflows() {
        let shots = vec![ContextLoopShotInput {
            last_image_path: "last.png".into(),
            prompt: "continuous motion".into(),
            duration: 5.0,
            seed: Some(42),
        }];
        let images = vec!["uploaded-last.png".into()];
        for (width, height, run_name, is_test) in [
            (992, 224, "quarter_test", true),
            (3936, 864, "full_generation", false),
        ] {
            let (workflow, _) = build_minimax_context_workflow(
                "uploaded-first.png",
                &images,
                &shots,
                width,
                height,
                run_name,
                is_test,
                "turbo-10",
                "default",
                false,
            )
            .unwrap();
            assert_eq!(workflow["22002"]["class_type"], "DenoTextEncoderUnload");
            assert_eq!(workflow["22001"]["inputs"]["bank"], json!(["22002", 0]));
        }
    }

    #[test]
    fn context_decode_cleanup_is_test_only_and_preserves_sampled_latent() {
        let shots = vec![ContextLoopShotInput {
            last_image_path: "last.png".into(),
            prompt: "continuous motion".into(),
            duration: 5.0,
            seed: Some(42),
        }];
        let images = vec!["uploaded-last.png".into()];
        // Mode, not resolution or output filename, determines cleanup.
        for (width, height) in [(992, 224), (3936, 864)] {
            let (full, full_frames) = build_minimax_context_workflow(
                "first.png",
                &images,
                &shots,
                width,
                height,
                "same_run",
                false,
                "turbo-10",
                "default",
                false,
            )
            .unwrap();
            let (mut test, test_frames) = build_minimax_context_workflow(
                "first.png",
                &images,
                &shots,
                width,
                height,
                "same_run",
                true,
                "turbo-10",
                "default",
                false,
            )
            .unwrap();
            assert_eq!(test_frames, full_frames);
            assert!(full.get("22003").is_none());
            assert_eq!(test["22003"]["class_type"], "VRAM_Debug");
            assert_eq!(
                test["22003"]["inputs"],
                json!({
                    "any_input": ["124", 0], "empty_cache": true,
                    "gc_collect": true, "unload_all_models": true
                })
            );
            for decoder in ["130", "131"] {
                assert_eq!(test[decoder]["inputs"]["samples"], json!(["22003", 0]));
                assert_eq!(full[decoder]["inputs"]["samples"], json!(["124", 0]));
                set_input(&mut test, decoder, "samples", json!(["124", 0])).unwrap();
            }
            assert_eq!(test["122"]["inputs"]["sampler_name"], "euler");
            assert_eq!(full["122"]["inputs"]["sampler_name"], "res_multistep");
            assert_eq!(test["123"], full["123"]);
            assert_eq!(test["1700"], full["1700"]);
            // Reverting only the TEST cleanup and sampler overrides restores
            // the original graph, including checkpoint/next-cut latent links.
            test.as_object_mut().unwrap().remove("22003");
            set_input(&mut test, "122", "sampler_name", json!("res_multistep")).unwrap();
            assert_eq!(test, full);
        }
    }

    #[test]
    fn context_test_clip_graph_preserves_plan_bank_and_checkpoint_links() {
        let shots: Vec<_> = (1..=3)
            .map(|index| ContextLoopShotInput {
                last_image_path: format!("last-{index}.png"),
                prompt: format!("motion {index}"),
                duration: 5.0,
                seed: Some(index),
            })
            .collect();
        let images: Vec<_> = shots
            .iter()
            .map(|shot| shot.last_image_path.clone())
            .collect();
        let (base, _) = build_minimax_context_workflow(
            "first.png",
            &images,
            &shots,
            992,
            224,
            "sequential_test",
            true,
            "turbo-10",
            "default",
            false,
        )
        .unwrap();
        for clip in 1..=3 {
            let graph = context_test_clip_workflow(&base, clip, 3).unwrap();
            for node in ["1951", "1701"] {
                assert_eq!(graph[node]["inputs"]["scene_range"], clip.to_string());
                assert_eq!(graph[node]["inputs"]["start_clip"], clip);
                assert_eq!(graph[node]["inputs"]["verify_resume_history"], true);
            }
            for node in [
                "1700", "22000", "22001", "22002", "1703", "1704", "1944", "22003", "122", "123",
            ] {
                assert_eq!(graph[node], base[node], "clip {clip}, changed node {node}");
            }
            assert_eq!(graph.get("1705").is_some(), clip == 3);
            assert_eq!(graph.get("1706").is_some(), clip == 3);
            // Every link still has a source, including intermediate jobs with
            // the loop end and assembly removed.
            for node in graph.as_object().unwrap().values() {
                for input in node["inputs"].as_object().unwrap().values() {
                    if let Some(link) = input.as_array() {
                        if link.len() == 2 && link[0].is_string() && link[1].is_number() {
                            assert!(graph.get(link[0].as_str().unwrap()).is_some());
                        }
                    }
                }
            }
        }
        assert!(context_test_clip_workflow(&base, 0, 3).is_err());
        assert!(context_test_clip_workflow(&base, 4, 3).is_err());
        let only = context_test_clip_workflow(&base, 1, 1).unwrap();
        assert!(only.get("1706").is_some());
    }

    // Isolated HTTP fixture: no live Comfy server, GPU, or model installation
    // is used. Requests must arrive in the declared order.
    fn context_test_server(
        script: Vec<(&'static str, Value)>,
    ) -> (String, std::thread::JoinHandle<Vec<Value>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let thread = std::thread::spawn(move || {
            let mut submissions = Vec::new();
            for (expected, response) in script {
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(std::time::Instant::now() < deadline, "missing {expected}");
                            std::thread::sleep(Duration::from_millis(2));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 8192];
                let header_end = loop {
                    let read = stream.read(&mut buffer).unwrap();
                    assert!(read > 0);
                    bytes.extend_from_slice(&buffer[..read]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let header = String::from_utf8_lossy(&bytes[..header_end]);
                assert_eq!(
                    header.lines().next().unwrap(),
                    format!("{expected} HTTP/1.1")
                );
                let length = header
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                while bytes.len() < header_end + length {
                    let read = stream.read(&mut buffer).unwrap();
                    assert!(read > 0);
                    bytes.extend_from_slice(&buffer[..read]);
                }
                if expected.starts_with("POST") {
                    submissions.push(
                        serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap(),
                    );
                }
                let body = response.to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
            submissions
        });
        (base, thread)
    }

    #[tokio::test]
    async fn context_test_submits_one_clip_at_a_time_and_assembles_only_last() {
        let saved = |id: &str, clip: usize| json!({id: {"status":{"completed":true,"status_str":"success"},"outputs":{"1944":{"text":[format!("review bypassed for clip {clip}")]}}}});
        let (base, server) = context_test_server(vec![
            ("POST /prompt", json!({"prompt_id":"p1"})),
            ("GET /history/p1", json!({})),
            (
                "GET /history/p1",
                json!({"p1":{"status":{"completed":false},"outputs":{"1944":{"text":["review bypassed for clip 1"]}}}}),
            ),
            ("GET /history/p1", saved("p1", 1)),
            ("POST /prompt", json!({"prompt_id":"p2"})),
            ("GET /history/p2", saved("p2", 2)),
            ("POST /prompt", json!({"prompt_id":"p3"})),
            (
                "GET /history/p3",
                json!({"p3":{"status":{"completed":true,"status_str":"success"},"outputs":{"1706":{"images":[{"filename":"merged.mp4","subfolder":"h3_chains/run/final","type":"output"}]}}}}),
            ),
        ]);
        let http = Client::builder().no_proxy().build().unwrap();
        let template: Value = serde_json::from_str(MINIMAX_CONTEXT_WORKFLOW_JSON).unwrap();
        let cancel = AtomicU64::new(0);
        let mut events = Vec::new();
        let result = run_context_test_clips(
            &http,
            &base,
            "test",
            &template,
            3,
            &cancel,
            0,
            Duration::from_millis(1),
            |clip, stage, _| events.push((clip, stage.to_string())),
        )
        .await
        .unwrap();
        assert_eq!(result.0, "p3");
        assert_eq!(result.1 .0, "merged.mp4");
        assert_eq!(result.2, vec!["p1", "p2", "p3"]);
        assert_eq!(
            events
                .iter()
                .filter(|(_, stage)| stage == "completed")
                .count(),
            3
        );
        let submissions = server.join().unwrap();
        assert_eq!(submissions.len(), 3);
        for (index, payload) in submissions.iter().enumerate() {
            assert_eq!(
                payload["prompt"]["1701"]["inputs"]["scene_range"],
                (index + 1).to_string()
            );
            assert_eq!(payload["prompt"].get("1706").is_some(), index == 2);
        }
    }

    #[tokio::test]
    async fn context_test_failure_missing_checkpoint_and_cancel_never_submit_next_clip() {
        for mode in ["error", "missing_checkpoint", "cancel", "missing_assembly"] {
            let entry = match mode {
                "error" => {
                    json!({"status":{"completed":false,"status_str":"error","messages":[["execution_error",{"exception_message":"sampler failed"}]]}})
                }
                "missing_checkpoint" | "missing_assembly" => {
                    json!({"status":{"completed":true,"status_str":"success"},"outputs":{}})
                }
                _ => {
                    json!({"status":{"completed":true,"status_str":"success"},"outputs":{"1944":{"text":["review bypassed for clip 1"]}}})
                }
            };
            let (base, server) = context_test_server(vec![
                ("POST /prompt", json!({"prompt_id":"p1"})),
                ("GET /history/p1", json!({"p1":entry})),
            ]);
            let http = Client::builder().no_proxy().build().unwrap();
            let template: Value = serde_json::from_str(MINIMAX_CONTEXT_WORKFLOW_JSON).unwrap();
            let cancel = AtomicU64::new(0);
            let count = if mode == "missing_assembly" { 1 } else { 3 };
            let error = run_context_test_clips(
                &http,
                &base,
                "test",
                &template,
                count,
                &cancel,
                0,
                Duration::from_millis(1),
                |_, stage, _| {
                    if mode == "cancel" && stage == "completed" {
                        cancel.fetch_add(1, Ordering::SeqCst);
                    }
                },
            )
            .await
            .unwrap_err();
            assert!(
                error.contains(match mode {
                    "error" => "sampler failed",
                    "missing_checkpoint" => "체크포인트",
                    "cancel" => "취소",
                    _ => "합본",
                }),
                "{mode}: {error}"
            );
            assert_eq!(server.join().unwrap().len(), 1);
        }
    }

    #[test]
    fn rejects_non_four_n_plus_one_length() {
        assert!(build_workflow(
            "first.png",
            "last.png",
            "prompt",
            848,
            480,
            80,
            "video/test",
            None,
        )
        .is_err());
    }

    #[test]
    fn summarizes_comfy_execution_error_without_serializing_tensor_inputs() {
        let entry = json!({"status":{"messages":[["execution_error",{
            "node_type":"KSamplerAdvanced",
            "exception_type":"OSError",
            "exception_message":"[Errno 22] Invalid argument",
            "current_inputs":{"samples":"very large tensor data"}
        }]]}});
        assert_eq!(
            comfy_execution_error(&entry),
            "KSamplerAdvanced · OSError: [Errno 22] Invalid argument"
        );
    }

    fn environment(name: &str) -> DesktopInstallation {
        DesktopInstallation {
            id: format!("id-{name}"),
            name: name.into(),
            install_path: "C:/Comfy/Test".into(),
            source_id: "standalone".into(),
            status: "installed".into(),
            launch_args: String::new(),
            version: String::new(),
            comfy_version_tag: String::new(),
            comfy_version: Value::Null,
        }
    }

    #[test]
    fn environment_priority_is_preferred_then_running_then_first() {
        let list = vec![
            environment("alpha"),
            environment("beta"),
            environment("gamma"),
        ];
        assert_eq!(
            select_environment(&list, "gamma", Some("beta"))
                .unwrap()
                .name,
            "gamma"
        );
        assert_eq!(
            select_environment(&list, "", Some("beta")).unwrap().name,
            "beta"
        );
        assert_eq!(select_environment(&list, "", None).unwrap().name, "alpha");
        assert_eq!(
            select_environment(&list, "missing", None).unwrap().name,
            "alpha"
        );
    }

    #[test]
    fn portable_backup_restore_checks_versions_and_python_packages() {
        let mut item = environment("portable");
        item.comfy_version = json!({"baseTag":"v0.34.5","commit":"abc"});
        assert_eq!(installation_comfy_version(&item), "v0.34.5");
        assert!(COMFY_RESTORE_BAT.contains("restore-comfy-environment.ps1"));
        assert!(COMFY_RESTORE_PS1.contains("Comfy version mismatch"));
        assert!(COMFY_RESTORE_PS1.contains("python-packages-portable.txt"));
        assert!(COMFY_RESTORE_PS1.contains("frameflow-comfy-restore.json"));
    }

    #[test]
    fn launch_arguments_preserve_quoted_values() {
        assert_eq!(
            split_launch_args("--enable-manager --preview-method \"latent 2 rgb\""),
            vec!["--enable-manager", "--preview-method", "latent 2 rgb"]
        );
    }

    #[test]
    fn minimax_launch_replaces_conflicting_attention_with_comfy_kitchen() {
        assert_eq!(
            engine_launch_args("--enable-manager --use-sage-attention", true),
            vec!["--enable-manager", "--use-ck-attention"]
        );
        assert_eq!(
            engine_launch_args("--enable-manager", false),
            vec!["--enable-manager"]
        );
    }

    #[tokio::test]
    #[ignore = "ComfyUI와 GPU를 사용하는 수동 E2E 검증"]
    async fn live_comfy_generates_and_saves_flf_video() {
        let first = std::env::var("FRAMEFLOW_E2E_FIRST").expect("FRAMEFLOW_E2E_FIRST");
        let last = std::env::var("FRAMEFLOW_E2E_LAST").expect("FRAMEFLOW_E2E_LAST");
        let output = std::env::var("FRAMEFLOW_E2E_OUTPUT").expect("FRAMEFLOW_E2E_OUTPUT");
        let base =
            std::env::var("FRAMEFLOW_E2E_URL").unwrap_or_else(|_| "http://127.0.0.1:8188".into());
        let result = comfy_generate_video(
            base,
            "frameflow-e2e-single".into(),
            first,
            last,
            "Golden ginkgo leaves slowly expand from the center under sacred light while sparkling dust disperses, static camera, continuous motion.".into(),
            848,
            480,
            81,
            output,
            Some(610_773_037_305_500),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("live ComfyUI generation");
        let path = result
            .get("path")
            .and_then(Value::as_str)
            .expect("saved path");
        assert!(Path::new(path).is_file());
        assert!(fs::metadata(path).expect("video metadata").len() > 1024);
        assert_eq!(
            result.get("negativePrompt").and_then(Value::as_str),
            Some("")
        );
        assert_eq!(result.get("fps").and_then(Value::as_u64), Some(16));
        assert_eq!(result.get("frames").and_then(Value::as_u64), Some(81));
    }

    #[tokio::test]
    #[ignore = "ComfyUI와 GPU를 사용해 1초(17프레임) 작업 2개의 실제 큐 처리를 검증"]
    async fn live_comfy_queues_two_one_second_videos() {
        let first = std::env::var("FRAMEFLOW_E2E_FIRST").expect("FRAMEFLOW_E2E_FIRST");
        let last = std::env::var("FRAMEFLOW_E2E_LAST").expect("FRAMEFLOW_E2E_LAST");
        let output_a = std::env::var("FRAMEFLOW_E2E_OUTPUT_A").expect("FRAMEFLOW_E2E_OUTPUT_A");
        let output_b = std::env::var("FRAMEFLOW_E2E_OUTPUT_B").expect("FRAMEFLOW_E2E_OUTPUT_B");
        let base =
            std::env::var("FRAMEFLOW_E2E_URL").unwrap_or_else(|_| "http://127.0.0.1:8188".into());

        if !server_available(&base).await {
            let state = ComfyRuntimeState::default();
            ensure_environment_impl(&state, base.clone(), String::new(), false, true, None)
                .await
                .expect("Comfy Desktop 환경을 콘솔 표시 상태로 자동 실행");
        }

        let job_a = comfy_generate_video(
            base.clone(),
            "frameflow-e2e-a".into(),
            first.clone(),
            last.clone(),
            "Slow continuous transition between the first and last frame, static camera.".into(),
            480,
            480,
            17,
            output_a,
            Some(610_773_037_305_500),
            None,
            None,
            None,
            None,
            None,
            None,
        );
        let job_b = comfy_generate_video(
            base,
            "frameflow-e2e-b".into(),
            first,
            last,
            "Gentle continuous transition between the first and last frame, static camera.".into(),
            480,
            480,
            17,
            output_b,
            Some(610_773_037_305_501),
            None,
            None,
            None,
            None,
            None,
            None,
        );
        let (result_a, result_b) = tokio::join!(job_a, job_b);

        for result in [
            result_a.expect("first queued generation"),
            result_b.expect("second queued generation"),
        ] {
            let path = result
                .get("path")
                .and_then(Value::as_str)
                .expect("saved path");
            assert!(Path::new(path).is_file());
            assert!(fs::metadata(path).expect("video metadata").len() > 1024);
            assert_eq!(
                result.get("negativePrompt").and_then(Value::as_str),
                Some("")
            );
            assert_eq!(result.get("fps").and_then(Value::as_u64), Some(16));
            assert_eq!(result.get("frames").and_then(Value::as_u64), Some(17));
        }
    }

    #[tokio::test]
    #[ignore = "ComfyUI 완전 종료 상태에서 자동 환경 실행과 GPU 생성을 검증"]
    async fn auto_starts_desktop_environment_then_generates_video() {
        let first = std::env::var("FRAMEFLOW_E2E_FIRST").expect("FRAMEFLOW_E2E_FIRST");
        let last = std::env::var("FRAMEFLOW_E2E_LAST").expect("FRAMEFLOW_E2E_LAST");
        let output = std::env::var("FRAMEFLOW_E2E_OUTPUT").expect("FRAMEFLOW_E2E_OUTPUT");
        let base =
            std::env::var("FRAMEFLOW_E2E_URL").unwrap_or_else(|_| "http://127.0.0.1:8188".into());
        assert!(
            !server_available(&base).await,
            "검증 시작 전에 ComfyUI 서버가 완전히 종료되어 있어야 합니다"
        );

        let state = ComfyRuntimeState::default();
        let ensured =
            ensure_environment_impl(&state, base.clone(), String::new(), false, false, None)
                .await
                .expect("Comfy Desktop 환경 자동 실행");
        assert_eq!(
            ensured.get("connected").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(ensured.get("started").and_then(Value::as_bool), Some(true));
        assert_eq!(
            ensured.get("selectionReason").and_then(Value::as_str),
            Some("first")
        );
        assert!(ensured
            .pointer("/environment/name")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.is_empty()));

        let result = comfy_generate_video(
            base,
            "frameflow-e2e-auto".into(),
            first,
            last,
            "Golden ginkgo leaves slowly expand from the center under sacred light while sparkling dust disperses, static camera, continuous motion.".into(),
            848,
            480,
            81,
            output,
            Some(610_773_037_305_500),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .expect("자동 실행된 ComfyUI에서 FLF 영상 생성");
        let path = result
            .get("path")
            .and_then(Value::as_str)
            .expect("saved path");
        assert!(Path::new(path).is_file());
        assert!(fs::metadata(path).expect("video metadata").len() > 1024);
        assert_eq!(
            result.get("negativePrompt").and_then(Value::as_str),
            Some("")
        );
        assert_eq!(result.get("fps").and_then(Value::as_u64), Some(16));
        assert_eq!(result.get("frames").and_then(Value::as_u64), Some(81));
    }

    #[tokio::test]
    #[ignore = "Minimax-H3를 1/4·32배수 해상도로 시작만 확인하고 Comfy를 종료하는 수동 스모크 테스트"]
    async fn minimax_quarter_resolution_starts_then_stops_comfy() {
        let first = std::env::var("FRAMEFLOW_E2E_FIRST").expect("FRAMEFLOW_E2E_FIRST");
        let last = std::env::var("FRAMEFLOW_E2E_LAST").expect("FRAMEFLOW_E2E_LAST");
        let original_width = std::env::var("FRAMEFLOW_E2E_WIDTH")
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(3936);
        let original_height = std::env::var("FRAMEFLOW_E2E_HEIGHT")
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(864);
        let align_32 = |value: u32| (((value as f64 / 4.0) / 32.0).round() as u32).max(1) * 32;
        let width = align_32(original_width);
        let height = align_32(original_height);
        assert_eq!((width, height), (992, 224));

        let base = "http://127.0.0.1:8188".to_string();
        assert!(
            !server_available(&base).await,
            "안전한 스모크 테스트를 위해 시작 전에 ComfyUI가 완전히 종료되어 있어야 합니다"
        );
        let state = ComfyRuntimeState::default();
        let test_result: Result<Value, String> = async {
            ensure_environment_impl(&state, base.clone(), String::new(), false, true, Some("minimax-h3".into())).await?;
            let http = client()?;
            let first_name = upload_image(&http, &base, &first, "first").await?;
            let last_name = upload_image(&http, &base, &last, "last").await?;
            let (workflow, frames) = build_minimax_workflow(
                &first_name,
                &last_name,
                "Static camera. A coherent continuous transition from the first frame to the last frame.",
                width,
                height,
                5.0,
                "video/FrameFlow-Minimax-H3-smoke",
                Some(610_773_037_305_500),
                "turbo-10",
                "default",
                false,
                "off",
            )?;
            let response = http.post(format!("{base}/prompt")).json(&json!({
                "prompt": workflow,
                "client_id": "frameflow-minimax-quarter-smoke"
            })).send().await.map_err(|error| error.to_string())?;
            let queued = response_json(response, "Minimax 축소 스모크 제출").await?;
            let prompt_id = queued.get("prompt_id").and_then(Value::as_str).ok_or_else(|| format!("prompt_id 없음: {queued}"))?.to_owned();
            loop {
                let queue = http.get(format!("{base}/queue")).send().await.map_err(|error| error.to_string())?.json::<Value>().await.map_err(|error| error.to_string())?;
                let running = queue.get("queue_running").and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| item.to_string().contains(&prompt_id)));
                if running {
                    return Ok(json!({"started": true, "promptId": prompt_id, "width": width, "height": height, "frames": frames}));
                }
                let history = http.get(format!("{base}/history/{prompt_id}")).send().await.map_err(|error| error.to_string())?.json::<Value>().await.unwrap_or_else(|_| json!({}));
                if let Some(entry) = history.get(&prompt_id) {
                    if entry.pointer("/status/status_str").and_then(Value::as_str) == Some("error") {
                        return Err(format!("Minimax 실행 시작 실패: {}", comfy_execution_error(entry)));
                    }
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }.await;

        if let Ok(http) = Client::builder().timeout(Duration::from_secs(5)).build() {
            let _ = http.post(format!("{base}/interrupt")).send().await;
        }
        if let Ok(mut child) = state.child.lock() {
            if let Some(mut process) = child.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
        let result = test_result.expect("Minimax 축소 스모크가 실행 상태에 도달해야 합니다");
        assert_eq!(result.get("started").and_then(Value::as_bool), Some(true));
        assert!(
            !server_available(&base).await,
            "스모크 테스트 뒤 ComfyUI가 종료되어야 합니다"
        );
    }
}
