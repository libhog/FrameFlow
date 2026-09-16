// FrameFlow's private file renderer. ReShade SDK v6.8.0 (BSD-3-Clause/MIT).
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <wrl/client.h>
#include <cstdio>
#include <vector>
#include <filesystem>
#include <stdexcept>
#include <io.h>
#include <fcntl.h>
#include <winver.h>
#include "reshade_api.hpp"
using Microsoft::WRL::ComPtr;
static void check(HRESULT hr){if(FAILED(hr))throw std::runtime_error("D3D11 operation failed");}
static void read(void* p,size_t n){if(fread(p,1,n,stdin)!=n)throw std::runtime_error("Incomplete frame");}
int wmain(int argc,wchar_t** argv){
  _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
  if(argc!=3)return 2;
  try{
    uint32_t size[2];read(size,sizeof(size));const auto w=size[0],h=size[1];
    if(w<1||h<1||w>8192||h>8192)throw std::runtime_error("Invalid dimensions");
    float values[4];read(values,sizeof(values));
    DWORD ignored=0,versionSize=GetFileVersionInfoSizeW(argv[1],&ignored);
    std::vector<unsigned char> version(versionSize);VS_FIXEDFILEINFO* info=nullptr;UINT infoSize=0;
    if(!versionSize||!GetFileVersionInfoW(argv[1],0,versionSize,version.data())||!VerQueryValueW(version.data(),L"\\",(void**)&info,&infoSize)||
      HIWORD(info->dwFileVersionMS)!=6||LOWORD(info->dwFileVersionMS)!=8||HIWORD(info->dwFileVersionLS)!=0)
      throw std::runtime_error("ReShade 6.8.0 Add-on DLL required (SDK ABI is version-specific)");
    WNDCLASSW cls={};cls.lpfnWndProc=DefWindowProcW;cls.hInstance=GetModuleHandleW(nullptr);cls.lpszClassName=L"FrameFlowReShade";
    RegisterClassW(&cls);
    HWND window=CreateWindowW(cls.lpszClassName,L"FrameFlow processing",WS_POPUP,0,0,w,h,nullptr,nullptr,cls.hInstance,nullptr);
    DXGI_SWAP_CHAIN_DESC desc={};desc.BufferDesc.Width=w;desc.BufferDesc.Height=h;desc.BufferDesc.Format=DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.SampleDesc.Count=1;desc.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;desc.BufferCount=1;desc.OutputWindow=window;desc.Windowed=TRUE;desc.SwapEffect=DXGI_SWAP_EFFECT_DISCARD;
    ComPtr<ID3D11Device> device;ComPtr<ID3D11DeviceContext> context;ComPtr<IDXGISwapChain> swap;
    check(D3D11CreateDeviceAndSwapChain(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,0,nullptr,0,D3D11_SDK_VERSION,&desc,&swap,&device,nullptr,&context));
    SetEnvironmentVariableW(L"RESHADE_BASE_PATH_OVERRIDE",std::filesystem::path(argv[2]).parent_path().c_str());
    SetEnvironmentVariableW(L"RESHADE_DISABLE_INPUT_HOOK",L"1");
    HMODULE dll=LoadLibraryExW(argv[1],nullptr,LOAD_WITH_ALTERED_SEARCH_PATH);
    if(!dll){fprintf(stderr,"LoadLibrary error %lu\n",GetLastError());throw std::runtime_error("Cannot load ReShade64.dll");}
    using Create=bool(*)(reshade::api::device_api,void*,void*,void*,const char*,reshade::api::effect_runtime**);
    using Update=void(*)(reshade::api::effect_runtime*);
    auto create=(Create)GetProcAddress(dll,"ReShadeCreateEffectRuntime");
    auto update=(Update)GetProcAddress(dll,"ReShadeUpdateAndPresentEffectRuntime");
    auto destroy=(Update)GetProcAddress(dll,"ReShadeDestroyEffectRuntime");
    if(!create||!update||!destroy)throw std::runtime_error("ReShade 6.8 add-on runtime API missing");
    int n=WideCharToMultiByte(CP_UTF8,0,argv[2],-1,nullptr,0,nullptr,nullptr);std::vector<char> config(n);
    WideCharToMultiByte(CP_UTF8,0,argv[2],-1,config.data(),n,nullptr,nullptr);
    reshade::api::effect_runtime* runtime=nullptr;
    if(!create(reshade::api::device_api::d3d11,device.Get(),context.Get(),swap.Get(),config.data(),&runtime))throw std::runtime_error("ReShade runtime creation failed");
    ComPtr<ID3D11Texture2D> back,staging;check(swap->GetBuffer(0,IID_PPV_ARGS(&back)));
    ComPtr<ID3D11RenderTargetView> rtv;check(device->CreateRenderTargetView(back.Get(),nullptr,&rtv));
    D3D11_TEXTURE2D_DESC td;back->GetDesc(&td);td.Usage=D3D11_USAGE_STAGING;td.BindFlags=0;td.CPUAccessFlags=D3D11_CPU_ACCESS_READ;td.MiscFlags=0;
    check(device->CreateTexture2D(&td,nullptr,&staging));
    reshade::api::effect_technique technique={0};
    for(int i=0;i<500;i++){update(runtime);technique=runtime->find_technique("FrameFlowColor.fx","FrameFlowColor");if(technique.handle)break;Sleep(10);}
    if(!technique.handle)throw std::runtime_error("FrameFlowColor.fx compilation failed");
    runtime->set_technique_state(technique,true);
    for(int i=0;i<100;i++){update(runtime);Sleep(10);}
    const char* names[]={"Exposure","Gamma","Contrast","Saturation"};
    for(int i=0;i<4;i++){auto var=runtime->find_uniform_variable("FrameFlowColor.fx",names[i]);if(!var.handle)throw std::runtime_error("Shader uniform missing");runtime->set_uniform_value_float(var,&values[i],1);}
    auto cmd=runtime->get_command_queue()->get_immediate_command_list();
    reshade::api::resource_view view={(uint64_t)rtv.Get()};
    uint32_t ready=1;fwrite(&ready,4,1,stdout);fflush(stdout);
    std::vector<unsigned char> frame(size_t(w)*h*4);
    while(true){
      const size_t got=fread(frame.data(),1,frame.size(),stdin);if(got==0)break;if(got!=frame.size())throw std::runtime_error("Truncated input");
      context->UpdateSubresource(back.Get(),0,nullptr,frame.data(),w*4,0);
      // Direct technique rendering excludes ReShade's UI/splash from output.
      runtime->render_technique(technique,cmd,view);
      context->CopyResource(staging.Get(),back.Get());
      D3D11_MAPPED_SUBRESOURCE mapped={};check(context->Map(staging.Get(),0,D3D11_MAP_READ,0,&mapped));
      for(uint32_t y=0;y<h;y++)memcpy(frame.data()+size_t(y)*w*4,(char*)mapped.pData+size_t(y)*mapped.RowPitch,w*4);
      context->Unmap(staging.Get(),0);
      if(fwrite(frame.data(),1,frame.size(),stdout)!=frame.size())break;fflush(stdout);
    }
    destroy(runtime);DestroyWindow(window);return 0;
  }catch(const std::exception& e){fprintf(stderr,"%s\n",e.what());return 1;}
}
