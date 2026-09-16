"""FrameFlow file adapter for a user-provided NeuralScreen D5V3 runtime.

No NVIDIA binaries or NeuralScreen source are bundled. Never captures a desktop.
Protocol reference: DLSS5-NeuralScreen/native/dlss5-feed-host64.cpp (2026-09-10).
"""
import ast
import json
import math
import os
from pathlib import Path
import queue
import struct
import subprocess
import sys
import threading
import time
from fractions import Fraction

OWNED_CHILDREN = []


def watch_parent(pid):
    if os.name != "nt" or not pid:
        return
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x00100000, False, int(pid))
    if not handle:
        raise RuntimeError("FrameFlow 부모 프로세스를 확인하지 못했습니다.")
    def monitor():
        try:
            if kernel.WaitForSingleObject(handle, 0xFFFFFFFF) == 0:
                for child in tuple(OWNED_CHILDREN):
                    try:
                        if child.poll() is None:
                            child.kill()
                    except OSError:
                        pass
                os._exit(2)
        finally:
            kernel.CloseHandle(handle)
    threading.Thread(target=monitor, daemon=True).start()


def emit(**event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def exact(stream, size):
    data = bytearray()
    while len(data) < size:
        chunk = stream.read(size - len(data))
        if not chunk:
            raise RuntimeError("NeuralScreen 작업 프로세스가 응답을 중단했습니다.")
        data.extend(chunk)
    return bytes(data)


def work_size(width, height):
    scale = min(1, 2560 / width, 1440 / height)
    if scale == 1:
        return width, height
    return max(64, int(width * scale) // 2 * 2), max(64, int(height * scale) // 2 * 2)


def load_profiles(root):
    # Read literal presets only; importing main.py would initialize desktop APIs.
    tree = ast.parse((root / "main.py").read_text(encoding="utf-8-sig"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "PROFILES" for t in node.targets):
            profiles = {}
            for key, value in zip(node.value.keys, node.value.values):
                if not isinstance(value, ast.Call) or not isinstance(value.func, ast.Name) or value.func.id != "dict" or value.args:
                    raise ValueError("호환되지 않는 NeuralScreen 프리셋 형식입니다.")
                profiles[ast.literal_eval(key)] = {k.arg: ast.literal_eval(k.value) for k in value.keywords}
            return profiles
    raise ValueError("NeuralScreen PROFILES를 찾지 못했습니다.")


class Worker:
    def __init__(self, root, width, height, profile, cancel):
        self.cancel = cancel
        self.width, self.height = width, height
        self.work_w, self.work_h = work_size(width, height)
        self.replies = queue.Queue(maxsize=2)
        self.logs = []
        env = dict(os.environ, NS_NR_SMALL="0", NS_ARCH_SPOOF="0")
        # No architecture spoofing: use supported hardware, fail explicitly otherwise.
        self.proc = subprocess.Popen([str(root / "native" / "nvngx.dll"), "--live"],
            cwd=root / "native", stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        OWNED_CHILDREN.append(self.proc)
        threading.Thread(target=self._logs, daemon=True).start()
        threading.Thread(target=self._read, daemon=True).start()
        params = [profile[k] for k in ("profile", "preset", "style", "auto_mask", "ui_correction",
                                      "intensity", "local_tone", "local_structure", "skin_structure")]
        header = struct.pack("<10I4f2I", 0x33563544, self.work_w, self.work_h, 8, 0,
                             *params, width, height)
        try:
            self.proc.stdin.write(header)
            self.proc.stdin.flush()
        except Exception:
            self.close()
            raise

    def _logs(self):
        for line in self.proc.stderr:
            self.logs.append(line.decode("utf-8", "replace").strip())
            self.logs[:] = self.logs[-20:]

    def _read(self):
        try:
            while True:
                magic, index, ok, size, result, pts = struct.unpack("<5Iq", exact(self.proc.stdout, 28))
                if magic != 0x3154554F or ok != 1 or result != 1:
                    raise RuntimeError(f"NeuralScreen 처리 실패: NGX 0x{result:08X}. GPU·드라이버·런타임 호환성을 확인하세요.")
                if size != self.width * self.height * 4:
                    raise RuntimeError("호환되지 않는 NeuralScreen 출력 크기입니다.")
                self.replies.put((index, exact(self.proc.stdout, size)))
        except Exception as error:
            self.replies.put(error)

    def process(self, index, rgba, motion, reset, pts):
        # Writes also have a deadline: a stalled native reader must not hang Cancel.
        packet = struct.pack("<4Iq", 0x314D5246, index, int(reset), 2, pts)
        done = queue.Queue(maxsize=1)
        def send():
            try:
                self.proc.stdin.write(packet)
                self.proc.stdin.write(rgba.tobytes())
                self.proc.stdin.write(motion.tobytes())
                self.proc.stdin.flush()
                done.put(None)
            except Exception as e:
                done.put(e)
        threading.Thread(target=send, daemon=True).start()
        end = time.monotonic() + 120
        error = self._wait(done, end)
        if error:
            raise error
        answer = self._wait(self.replies, end)
        if isinstance(answer, Exception):
            raise RuntimeError(f"{answer}\n" + "\n".join(self.logs[-5:]))
        if answer[0] != index:
            raise RuntimeError("NeuralScreen 프레임 순서가 맞지 않습니다.")
        return answer[1]

    def _wait(self, channel, end):
        while time.monotonic() < end:
            if self.cancel.exists():
                raise RuntimeError("작업을 취소했습니다.")
            try:
                return channel.get(timeout=.1)
            except queue.Empty:
                pass
        raise RuntimeError("NeuralScreen 응답 시간이 초과되었습니다 (120초).")

    def close(self):
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait(timeout=10)


def resolve_profile(profiles, request):
    custom = request.get("customSettings") or {}
    name = custom.get("baseProfile", "Strong / Cinematic") if request.get("profile") == "Custom" else request.get("profile", "Faithful")
    params = dict(profiles[name])
    if request.get("profile") == "Custom":
        for key in ("intensity", "local_tone", "local_structure", "skin_structure"):
            value = custom.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not (-1 if key == "skin_structure" else 0) <= value <= 3:
                raise ValueError(f"잘못된 Custom 설정: {key}")
            params[key] = float(value)
    return params


class ReShadeWorker(Worker):
    """Private hidden D3D11 renderer using the actual ReShade effect runtime."""
    def __init__(self, directory, dll, width, height, settings, cancel):
        self.cancel=cancel
        self.logs=[]
        self.width,self.height=width,height
        values=[]
        for key,default,low,high in [('exposure',0,-3,3),('gamma',1,.25,3),('contrast',1,0,3),('saturation',1,0,3)]:
            value=(settings or {}).get(key,default)
            if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not low<=value<=high:
                raise ValueError('잘못된 ReShade 설정: '+key)
            values.append(value)
        if width<160 and height<120:
            raise ValueError('ReShade 입력은 가로 160px 또는 세로 120px 이상이어야 합니다. 원본을 확대하지 않습니다.')
        config=directory/'ReShade.ini'
        config.write_text('[GENERAL]\nEffectSearchPaths='+str(directory)+'\nIntermediateCachePath='+str(directory)+'\nNoEffectCache=1\nSkipLoadingDisabledEffects=0\n',encoding='utf-8')
        self.proc=subprocess.Popen([str(directory/'frameflow-reshade.exe'),str(dll),str(config)],cwd=directory,
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        OWNED_CHILDREN.append(self.proc)
        threading.Thread(target=self._logs,daemon=True).start()
        try:
            ready=self.exchange(struct.pack('<2I4f',width,height,*values),4)
            if ready!=struct.pack('<I',1):raise RuntimeError('ReShade 초기화 응답 오류')
        except Exception:
            self.close()
            raise

    def exchange(self,packet,size):
        replies=queue.Queue(maxsize=1)
        def transfer():
            try:
                self.proc.stdin.write(packet);self.proc.stdin.flush()
                replies.put(exact(self.proc.stdout,size))
            except Exception as error:replies.put(error)
        threading.Thread(target=transfer,daemon=True).start()
        result=self._wait(replies,time.monotonic()+120)
        if isinstance(result,Exception):raise RuntimeError('ReShade 처리 실패: '+str(result)+'\n'+'\n'.join(self.logs[-5:]))
        return result

    def process(self,rgba):
        return self.exchange(rgba.tobytes(),self.width*self.height*4)


def run(request):
    root = Path(request["runtimeDir"]).resolve()
    sys.path.insert(0, str(root))
    import av
    import numpy as np
    nr_enabled=request.get('nrEnabled',True)
    reshade_enabled=request.get('reshadeEnabled',False)
    if not isinstance(nr_enabled,bool) or not isinstance(reshade_enabled,bool):
        raise ValueError('처리 방식은 true/false여야 합니다.')
    profiles={}
    if nr_enabled:
        from guides import TemporalGuideGenerator
        profiles = load_profiles(root)
    if request.get("check"):
        emit(type="ready", profiles=list(profiles))
        return
    source = Path(request["sourcePath"]).resolve(strict=True)
    directory = Path(request["outputDir"]).resolve(strict=True)
    preview = request.get("preview", False)
    image_input = source.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")
    output = directory / ("preview.png" if preview or image_input else "enhanced.mp4")
    before = directory / "original.png"
    temp = directory / "video.partial.mp4"
    if output.exists() or temp.exists() or before.exists():
        raise ValueError("출력 파일이 이미 있습니다. 원본과 기존 결과는 덮어쓰지 않습니다.")
    cancel = directory / "cancel"
    worker = None
    color_worker = None
    encoder = None
    def save_png(rgba, target):
        with av.open(str(target), mode="w", format="image2") as png:
            stream = png.add_stream("png", rate=1)
            stream.width, stream.height, stream.pix_fmt = rgba.shape[1], rgba.shape[0], "rgba"
            for packet in stream.encode(av.VideoFrame.from_ndarray(rgba, format="rgba")):
                png.mux(packet)
            for packet in stream.encode():
                png.mux(packet)
    try:
        with av.open(str(source)) as container:
            video = container.streams.video[0]
            width, height = video.width, video.height
            if width < 64 or height < 64 or width > 8192 or height > 8192 or width * height > 34000000:
                raise ValueError("지원 크기: 가로·세로 64~8192px, 최대 34MP입니다.")
            if video.codec_context.color_trc in (16, 18):
                raise ValueError("HDR 입력은 지원하지 않습니다. SDR 영상으로 변환해 주세요.")
            profile = resolve_profile(profiles, request) if nr_enabled else {}
            nr_enabled = request.get("nrEnabled", True)
            if not isinstance(nr_enabled, bool):
                raise ValueError("NR 설정은 true/false여야 합니다.")
            emit(type="progress", percent=0, message=('ReShade → ' if reshade_enabled else '')+('NR' if nr_enabled else '색상 보정')+' · Full · 초기화 중')
            if reshade_enabled:
                color_worker=ReShadeWorker(directory,request['reshadePath'],width,height,request.get('reshadeSettings'),cancel)
            if nr_enabled:
                worker = Worker(root, width, height, profile, cancel)
                guides = TemporalGuideGenerator(worker.work_w, worker.work_h)
            rate = video.average_rate or Fraction(24, 1)
            duration = float(video.duration * video.time_base) if video.duration else float(container.duration or 0) / 1000000
            origin = None
            count = 0
            if not preview and not image_input:
                encoder = av.open(str(temp), "w")
                stream = encoder.add_stream("libx264", rate=rate)
                stream.width, stream.height = width, height
                stream.pix_fmt = "yuv420p" if width % 2 == 0 and height % 2 == 0 else "yuv444p"
                stream.options = {"crf": "18", "preset": "medium"}
                stream.time_base = Fraction(1, 1000000)
                stream.codec_context.time_base = Fraction(1, 1000000)
            for index, frame in enumerate(container.decode(video)):
                if cancel.exists():
                    raise RuntimeError("작업을 취소했습니다.")
                if frame.width != width or frame.height != height:
                    raise ValueError("도중에 해상도가 바뀌는 영상은 지원하지 않습니다.")
                rgba = frame.to_ndarray(format="rgba")
                original=rgba.copy()
                if color_worker:
                    rgba=np.frombuffer(color_worker.process(rgba),dtype=np.uint8).reshape(height,width,4).copy()
                seconds = float(frame.pts * frame.time_base) if frame.pts is not None else index / float(rate)
                if origin is None:
                    origin = seconds
                pts = max(0, round((seconds - origin) * 1000000))
                if worker:
                    guide = guides.process(rgba)
                    result = worker.process(index, rgba, guide.motion, guide.reset, pts)
                    processed = np.frombuffer(result, dtype=np.uint8).reshape(height, width, 4).copy()
                else:
                    processed = rgba.copy()
                # Preserve an image's original alpha, regardless of runtime output.
                processed[:, :, 3] = original[:, :, 3]
                if index == 0 and preview:
                    save_png(original, before)
                if preview or image_input:
                    save_png(processed, output)
                    count = 1
                    break
                enhanced = av.VideoFrame.from_ndarray(processed, format="rgba")
                enhanced.pts, enhanced.time_base = pts, Fraction(1, 1000000)
                for packet in stream.encode(enhanced):
                    encoder.mux(packet)
                count = index + 1
                if index % 10 == 0:
                    emit(type="progress", percent=min(94, round((seconds-origin)/duration*94)) if duration else 0,
                         message=f"{count} 프레임 처리 중", frames=count)
            if not count:
                raise ValueError("입력에서 프레임을 읽지 못했습니다.")
            if encoder:
                for packet in stream.encode():
                    encoder.mux(packet)
                encoder.close()
                encoder = None
        if not preview and not image_input:
            emit(type="progress", percent=95, message="원본 오디오 결합 중")
            with (directory / "ffmpeg.log").open("wb") as log:
                mux = subprocess.Popen([request["ffmpeg"], "-nostdin", "-v", "error", "-n", "-i", str(temp),
                    "-i", str(source), "-map", "0:v:0", "-map", "1:a?", "-c:v", "copy", "-c:a", "aac",
                    "-b:a", "192k", "-movflags", "+faststart", str(output)], stdout=log, stderr=log,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                OWNED_CHILDREN.append(mux)
                while mux.poll() is None:
                    if cancel.exists():
                        mux.kill(); mux.wait()
                        raise RuntimeError("작업을 취소했습니다.")
                    time.sleep(.1)
                if mux.returncode:
                    raise RuntimeError("오디오 결합 실패: " + (directory / "ffmpeg.log").read_text(errors="replace")[-2000:])
            temp.unlink()
        emit(type="complete", path=str(output), beforePath=str(before), width=width, height=height, frames=count,
             kind="image" if preview or image_input else "video", preview=preview,
             nrEnabled=nr_enabled, reshadeEnabled=reshade_enabled, reshadeSettings=request.get('reshadeSettings'), resolution="Full", appliedSettings=profile)
    finally:
        if encoder:
            encoder.close()
        if worker:
            worker.close()
        if color_worker:
            color_worker.close()


if __name__ == "__main__":
    try:
        request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        watch_parent(request.get("parentPid"))
        run(request)
    except Exception as error:
        emit(type="error", message=str(error))
        sys.exit(1)
