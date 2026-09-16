# FrameFlow Studio

OpenArt MCP를 연결해 FLF(First/Last Frame) 이미지와 씬 영상을 만들고, 선택한 영상을 하나의 프로젝트 영상으로 결합하는 Tauri 데스크톱 앱입니다.

## 실행

```powershell
npm install
npm run desktop
```

웹 UI만 확인하려면 `npm run dev`를 실행하고 `http://127.0.0.1:1420`을 엽니다. 데스크톱 실행에는 Rust stable과 Microsoft WebView2가 필요합니다.

## 처음 설정

1. 왼쪽 `설정`에서 프로젝트 기본 폴더를 지정합니다.
2. `OpenArt로 로그인`을 누르고 시스템 브라우저에서 OAuth 접근을 승인합니다. API 키를 직접 입력하지 않습니다.
3. FFmpeg가 PATH에 있다면 기본값 `ffmpeg`를 유지하고 `설치 상태 확인`을 누릅니다. 아니라면 `ffmpeg.exe`의 전체 경로를 입력합니다.
4. `프로젝트` → `새 프로젝트`, 프로젝트 안에서 `씬 추가`를 누릅니다.

## 주요 기능

- SQLite와 프로젝트 폴더의 `project.frameflow.json`에 프로젝트/씬/작업/선택 결과 저장
- 프로젝트 기본 모델·최종 해상도와 씬별 모델·길이 변경
- 프로젝트 설정에서 미디어월의 가로·세로 픽셀을 직접 입력하고 모든 씬에 공통 적용
- 테스트 영상은 프로젝트 화면비를 유지하며 848×480과 유사한 픽셀 수로 자동 계산
- OpenArt MCP 도구 및 영상 모델 자동 탐색
- OpenArt FLF 이미지 생성과 로컬 이미지 가져오기
- FLF 파일명 `flf/0001-0-원본이름`(First), `flf/0001-1-원본이름`(Last)
- 씬별 테스트/최종 영상 생성, 최신 결과 우선 표시, 선택 결과 교체
- 테스트 생성은 모델의 최저 해상도 사용
- 두 번째 씬부터 이전 선택 영상의 마지막 프레임 추출 연결
- FIRST Frame이 없을 때 이전 씬 영상에서 자동 추출하고, 추출 원본이 없으면 경고창 표시
- LLM JSON의 독해용 한국어 요약을 별도 창에서 확인하고, 내장 Supertonic Sarah 음성으로 1.2배속 청취
- 전체 생성 시 이미 선택된 영상은 재생성하지 않고 재사용
- 생성 큐, 오류 표시 및 재시도
- FFmpeg 최종 영상 결합과 `exports` 저장
- 프로젝트 manifest 가져오기 및 목록에서 안전하게 제거(미디어 파일 유지)

## 배포

Windows 포터블 ZIP:

```powershell
npm run portable:win
powershell -ExecutionPolicy Bypass -File scripts/package-portable.ps1
```

결과는 `release/FrameFlow-Studio-Portable-Windows.zip`입니다. 포터블 앱도 OpenArt 로그인은 PC별로 승인해야 하며, FFmpeg는 별도 설치하거나 설정에서 실행 파일 경로를 지정해야 합니다.

Windows와 macOS 설치 파일은 `.github/workflows/build.yml`로 각 운영체제에서 빌드할 수 있습니다. macOS 앱은 Apple 서명/공증 정보를 등록하지 않으면 Gatekeeper 경고가 표시될 수 있습니다.

## 저장 구조

```text
프로젝트폴더/
  project.frameflow.json
  flf/
  videos/test/
  videos/final/
  scenes/scene-01/videos/{test,final}/
  exports/
```

OpenArt MCP의 도구 이름과 입력 스키마는 연결 후 런타임에 읽습니다. 제공 모델별 옵션이 다르면 FrameFlow가 공통 필드를 자동 매핑하고, 지원되지 않는 옵션은 보내지 않습니다.

Supertonic 음성 모델(`public/supertonic/onnx/*.onnx`)은 용량 때문에 소스 저장소에 포함하지 않습니다. 포터블 패키지를 만들 때 해당 모델 파일을 별도로 배치하면 오프라인으로 동작합니다. `듣기`를 누르는 즉시 Web Audio 출력을 활성화하고 합성 후 자동 재생하며, 생성 음량을 검증한 수동 재생 플레이어도 표시합니다. 첫 실행은 모델 준비와 음성 합성에 시간이 걸릴 수 있습니다.
