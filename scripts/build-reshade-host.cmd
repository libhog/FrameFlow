@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b 1
cl /nologo /std:c++17 /EHsc /O2 /MT /Iwork\reshade-sdk\include scripts\reshade-host.cpp /Fework\reshade-runtime\frameflow-reshade.exe /Fowork\reshade-runtime\reshade-host.obj /link d3d11.lib dxgi.lib user32.lib version.lib
if errorlevel 1 exit /b 1
if not exist assets\native\reshade mkdir assets\native\reshade
copy /y work\reshade-runtime\frameflow-reshade.exe assets\native\reshade\frameflow-reshade.exe >nul
