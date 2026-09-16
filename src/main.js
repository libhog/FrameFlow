import './styles.css';
import './design-system.css';
import './vta-prompt.css';
import './ux-refresh.css';
import './ux-stability.css';
import { createNavigationHistory } from './navigation-history.js';
import { createMediaProcess } from './media-process.js';
import { openVideoAudioPromptStudio,assembleSegmentAudioPrompt,REF2VA_MAX_SECONDS } from './vta-prompt.js';
import { buildVideoAudioProjectPaths } from './vta-storage.js';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';

const videoModel = (id,name,resolutions=['480p','720p','1080p']) => ({id,name,flf:true,resolutions,catalog:true});
const curatedVideoModels = [
  videoModel('grok-imagine-1-5','Grok Imagine 1.5'),
  videoModel('gemini-omni-flash','Gemini Omni Flash',['720p','1080p']),
  videoModel('kling-3-omni','Kling 3 Omni',['540p','720p','1080p']),
  videoModel('byte-plus-seedance-2','Seedance 2.0',['480p','720p','1080p','4K']),
  videoModel('byte-plus-seedance-2-fast','Seedance 2.0 Fast'),
  videoModel('byte-plus-seedance-2-mini','Seedance 2.0 Mini'),
  videoModel('byte-plus-seedance-2-5','Seedance 2.5',['480p','720p','1080p']),
  videoModel('wan2-7','Wan 2.7'),
  videoModel('pixverseV6','PixVerse V6'),
  videoModel('smart-shot','Smart Shot · 자동 선택'),
];
let models = structuredClone(curatedVideoModels);

const demoScenes = [
  { id: 1, name: '새벽의 온실', status: '최종 준비', duration: 5, model: null, promptKo: '새벽빛이 스며드는 유리 온실. 카메라가 천천히 앞으로 이동한다.', promptEn: 'A glass greenhouse at dawn, soft mint light filtering through condensation, slow cinematic dolly forward, delicate plants swaying.', first: 'linear-gradient(135deg,#c8f1dc,#7ac7b1 52%,#315f58)', last: 'linear-gradient(135deg,#f7dfaf,#ee9677 55%,#6b7a60)', selected: { type: 'FINAL', res: '1920×1080', date: '오늘 11:42', color: 'linear-gradient(135deg,#2f635d,#9bd8bc 45%,#ffbf98)' }, results: 4 },
  { id: 2, name: '빛의 복도', status: '테스트 완료', duration: 5, model: null, promptKo: '인물이 빛으로 이루어진 복도를 통과한다. 잔잔하고 몽환적인 움직임.', promptEn: 'A solitary figure walks through a corridor made of refracted light, calm dreamlike motion, subtle lens bloom, locked composition.', first: 'linear-gradient(135deg,#315f58,#99d8bd 55%,#f1ba92)', last: 'linear-gradient(135deg,#dad0ff,#8c87c8 55%,#34334f)', selected: { type: 'TEST', res: '848×480', date: '오늘 10:18', color: 'linear-gradient(135deg,#6760a7,#c3b8ef 48%,#f1a985)' }, results: 6 },
  { id: 3, name: '수면의 기억', status: '테스트 필요', duration: 8, model: 'kling-3-omni', promptKo: '수면 위로 기억의 이미지가 잔물결처럼 번진다.', promptEn: 'Memories ripple across a dark reflective water surface, fragments of warm light drifting outward, elegant overhead camera movement.', first: 'linear-gradient(135deg,#b7d7dc,#4d7b84 55%,#203b46)', last: 'linear-gradient(135deg,#ffcaa7,#b76163 55%,#382f45)', selected: null, results: 2 },
  { id: 4, name: '도시의 숨', status: '프롬프트 작성', duration: 5, model: null, promptKo: '도시의 불빛이 호흡하듯 천천히 밝아지고 어두워진다.', promptEn: 'City lights breathing in a gentle rhythm at blue hour, cinematic aerial drift, soft atmospheric haze.', first: 'linear-gradient(135deg,#8fb4c8,#496579 55%,#182f40)', last: null, selected: null, results: 0 },
];

const initialProjects = [{ id: 'afterglow', name: 'Afterglow', description: '빛이 공간을 통과하며 남기는 잔상에 관한 짧은 시퀀스', baseFolder: 'C:\\Users\\libho\\Videos\\FrameFlow Projects', projectPath: 'C:\\Users\\libho\\Videos\\FrameFlow Projects\\Afterglow', model: 'byte-plus-seedance-2', ratio: '16:9', duration: 5, resolution: '1920x1080', resolutionWidth: 1920, resolutionHeight: 1080, updatedAt: '오늘', scenes: demoScenes }];
const testMode = new URLSearchParams(location.search).has('test');
const stored = testMode ? null : localStorage.getItem('frameflow-projects-v1');
let projects = stored ? JSON.parse(stored) : initialProjects;
const videoAudioStored=testMode?null:localStorage.getItem('frameflow-video-to-audio-v1');
let videoAudioWorkspace=videoAudioStored?JSON.parse(videoAudioStored):{source:null,prompt:'',jobs:[],results:[]};
let videoAudioResultSelection=new Set();
for(const job of videoAudioWorkspace.jobs||[])if(['running','queued'].includes(job.status)){job.status='interrupted';job.error='프로그램 종료로 중단된 Video-to-Audio 작업입니다.';}
const videoVideoStored=testMode?null:localStorage.getItem('frameflow-video-to-video-v1');
let videoVideoWorkspace=videoVideoStored?JSON.parse(videoVideoStored):{source:null,prompt:'',width:null,height:null,jobs:[],results:[]};
for(const job of videoVideoWorkspace.jobs||[])if(['running','queued'].includes(job.status)){job.status='interrupted';job.error='프로그램 종료로 중단된 Video-to-Video 작업입니다.';}
const generativeUpscaleStored=testMode?null:localStorage.getItem('frameflow-generative-upscale-v1');
let generativeUpscaleWorkspace=generativeUpscaleStored?JSON.parse(generativeUpscaleStored):{source:null,multiplier:2,tileMp:.5,jobs:[],results:[]};
for(const job of generativeUpscaleWorkspace.jobs||[])if(['running','queued'].includes(job.status)){job.status='interrupted';job.error='프로그램 종료로 중단된 생성형 Upscale 작업입니다.';}
let activeProjectId = localStorage.getItem('frameflow-active-project') || projects[0]?.id;
let activeScene = projects.find(p => p.id === activeProjectId)?.scenes?.[1]?.id || projects.find(p => p.id === activeProjectId)?.scenes?.[0]?.id || null;
let activeCut = 1;
let page = 'project', modal = null, view = 'cards', nativeReady = false, sceneEditorOpen = false, promptSaveTimer = null, toastTimer = null, dragDropUnlisten = null, focusSceneName = false, generationPlan = null;
let queuePumpActive=false, queuePaused=false, generationDockExpanded=false, pendingBatchId=null, projectRollTimer=null, closeHandlerBound=false, appClosing=false, comfyRuntimeOnline=false, preserveComfyJobsOnExit=false;
let appSettings = { defaultFolder: 'C:\\Users\\libho\\Videos\\FrameFlow Projects', ffmpegPath: 'ffmpeg', generationBackend: 'comfy', comfyUrl: 'http://127.0.0.1:8188', comfyEnvironmentName: '', showComfyConsole: false };
let comfyEnvironments = [];
let comfyModels = [], comfyModelsEnvironment = null;

const currentProject = () => projects.find(p => p.id === activeProjectId) || projects[0];
const scenes = () => currentProject()?.scenes || [];
const cuts = (project=currentProject()) => (project?.scenes||[]).flatMap(scene=>(scene.cuts||[]).map(cut=>({scene,cut})));
const currentScene = () => scenes().find(scene=>scene.id===activeScene) || scenes()[0] || null;
const currentCut = () => currentScene()?.cuts?.find(cut=>cut.id===activeCut) || currentScene()?.cuts?.[0] || null;
const findCut = (project,sceneId,cutId) => project?.scenes?.find(scene=>scene.id===sceneId)?.cuts?.find(cut=>cut.id===cutId) || null;
const cutLocation = (target,project=currentProject()) => {for(const scene of project?.scenes||[]){const cut=(scene.cuts||[]).find(item=>item===target||item.uid===target?.uid);if(cut)return{scene,cut};}return{scene:null,cut:null};};
const jobs = () => { const project=currentProject(); if(!project)return[]; return project.jobs ||= []; };
const allJobs = () => [...projects.flatMap(p=>(p.jobs||[]).map(job=>({...job,projectName:p.name}))),...(videoAudioWorkspace.jobs||[]).map(job=>({...job,projectName:job.projectName||'Video-to-Audio',jobKind:'video-audio'})),...(videoVideoWorkspace.jobs||[]).map(job=>({...job,projectName:job.projectName||'Video-to-Video',jobKind:'video-video'}))];
const saveVideoAudio=()=>{if(!testMode)localStorage.setItem('frameflow-video-to-audio-v1',JSON.stringify(videoAudioWorkspace));};
const saveVideoVideo=()=>{if(!testMode)localStorage.setItem('frameflow-video-to-video-v1',JSON.stringify(videoVideoWorkspace));};
const saveGenerativeUpscale=()=>{if(!testMode)localStorage.setItem('frameflow-generative-upscale-v1',JSON.stringify(generativeUpscaleWorkspace));};
const latestCutJob=(project,cut)=>[...(project?.jobs||[])].reverse().find(job=>job.cutUid===cut?.uid);
const briefJobError=value=>{const text=String(value||'').replace(/\\n/g,' ').replace(/\s+/g,' ').trim();return text.length>320?`${text.slice(0,317)}…`:text;};
const modelForId = id => models.find(model=>model.id===id) || models[0];
const effectiveModel = () => ({id:'wan-2.2-14b-flf2v',name:'WAN 2.2 14B FLF2V',flf:true});
const legacyResolutionSize=(value,ratio='16:9')=>{
  const match=String(value||'').match(/(\d+)\s*[x×]\s*(\d+)/i);if(match)return{width:Number(match[1]),height:Number(match[2])};
  const base=String(value||'1080p').toUpperCase()==='4K'?{width:3840,height:2160}:String(value||'').toLowerCase()==='720p'?{width:1280,height:720}:String(value||'').toLowerCase()==='540p'?{width:960,height:540}:String(value||'').toLowerCase()==='480p'?{width:848,height:480}:{width:1920,height:1080};
  if(ratio==='9:16')return{width:base.height,height:base.width};if(ratio==='1:1')return{width:base.height,height:base.height};return base;
};
const projectResolution=project=>{const legacy=legacyResolutionSize(project?.resolution,project?.ratio);return{width:Number(project?.resolutionWidth)||legacy.width,height:Number(project?.resolutionHeight)||legacy.height};};
const alignMinimaxResolution=size=>{const align=value=>Math.max(64,Math.round((Number(value)||64)/32)*32);return{width:align(size?.width),height:align(size?.height)};};
const minimaxResolution=project=>{const actual=projectResolution(project);return alignMinimaxResolution({width:Number(project?.minimaxWidth)||actual.width,height:Number(project?.minimaxHeight)||actual.height});};
const minimaxQuarterResolution=project=>{const source=minimaxResolution(project),align=value=>Math.max(64,Math.round((Number(value)||64)/4/32)*32);return{width:align(source.width),height:align(source.height)};};
const resolutionLabel=size=>`${size.width}×${size.height}`;
const resolutionValue=size=>`${size.width}x${size.height}`;
const testResolution=project=>{const source=projectResolution(project),targetPixels=848*480,scale=Math.sqrt(targetPixels/(source.width*source.height)),align=value=>Math.max(16,Math.round(value*scale/16)*16);return{width:align(source.width),height:align(source.height)};};
const COMFY_FPS=16;
const MINIMAX_FPS=24;
const COMFY_BASE_SEED=610773037305500;
const comfyFrameLength=seconds=>Math.max(5,Math.round((Number(seconds)||5)*COMFY_FPS/4)*4+1);
const minimaxFrameLength=seconds=>{const raw=Math.max(5,Math.round((Number(seconds)||5)*MINIMAX_FPS));return raw+(5+17-raw%17)%17;};
const gcd=(a,b)=>b?gcd(b,a%b):a;
const projectAspect=project=>{const {width,height}=projectResolution(project),divisor=gcd(width,height);return`${width/divisor}:${height/divisor}`;};
const finalResolution = () => resolutionValue(projectResolution(currentProject()));
const isTauri = () => !testMode && Boolean(window.__TAURI__?.core);
const mediaSource = result => result?.path&&isTauri()?window.__TAURI__.core.convertFileSrc(result.path):result?.url||null;
const escapeAttr = value => String(value??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const joinPath = (root,...parts) => `${String(root).replace(/[\\/]$/,'')}${String(root).includes('\\')?'\\':'/'}${parts.join(String(root).includes('\\')?'\\':'/')}`;
const projectCode = project => String(project?.projectCode||'0001').toUpperCase().padStart(4,'0').slice(-4);
const mediaPrefix = (project,sceneId,cutId) => `${projectCode(project)}-S${String(sceneId).padStart(2,'0')}-C${String(cutId).padStart(2,'0')}`;
const cutStorageNumber = (sceneId,cutId) => Number(sceneId)*100+Number(cutId);
const estimateSeconds = seconds => Number(seconds)>=10?1200:Number(seconds)<=5?220:Math.round(220+(Number(seconds)-5)*196);
const megapixels=size=>Math.max(.001,(Number(size?.width)||1)*(Number(size?.height)||1)/1_000_000);
const megapixelLabel=size=>`${megapixels(size).toFixed(2)}MP`;
const GENERATIVE_TILE_MP_OPTIONS=[.25,.5,.75,1,1.25,1.5];
const alignedSizeForMegapixels=(source,targetMp)=>{
  const sw=Math.max(1,Number(source?.width)||16),sh=Math.max(1,Number(source?.height)||9),ratio=sw/sh,target=Math.max(.1,Number(targetMp)||.5)*1_000_000;
  let best=null;
  const idealH=Math.sqrt(target/ratio),center=Math.max(64,Math.round(idealH/32)*32);
  for(let h=Math.max(64,center-128);h<=center+128;h+=32){const w=Math.max(64,Math.round(h*ratio/32)*32),score=Math.abs(w*h-target)/target+Math.abs(w/h-ratio)/ratio*.35;if(!best||score<best.score)best={width:w,height:h,score};}
  return{width:best.width,height:best.height};
};
const generativeUpscalePlan=(source,multiplier=2,tileMp=.5)=>{
  const align=value=>Math.max(64,Math.round(value/32)*32),scale=Math.max(1,Math.min(4,Number(multiplier)||2));
  const output={width:align((Number(source?.width)||1920)*scale),height:align((Number(source?.height)||1080)*scale)},tile=alignedSizeForMegapixels(source,tileMp);
  tile.width=Math.min(tile.width,output.width);tile.height=Math.min(tile.height,output.height);
  const count=(size,tileSize)=>size<=tileSize?1:Math.ceil((size-tileSize)/(tileSize*.75))+1;
  const columns=count(output.width,tile.width),rows=count(output.height,tile.height);
  return{output,tile,columns,rows,tileCount:columns*rows,overlap:'1/4'};
};
const MINIMAX_BENCHMARK_SIZE={width:992,height:224};
const MINIMAX_BENCHMARK_SECONDS=130;
// 측정값: 3936×864의 1/4·32배수인 992×224, 5초 생성에 130초.
// 프로젝트 해상도가 바뀌어도 고정된 측정 MP 대비 실제 작업 MP와 길이에 선형 비례시킨다.
const minimaxEstimateSeconds=(project,seconds,size=minimaxResolution(project))=>{
  const pixelRatio=megapixels(size)/megapixels(MINIMAX_BENCHMARK_SIZE),durationRatio=(Number(seconds)||5)/5;
  return Math.max(1,Math.round(MINIMAX_BENCHMARK_SECONDS*pixelRatio*durationRatio));
};
const MINIMAX_PROFILES=[
  {id:'turbo-8',label:'기본 (8step)',help:'Larry v4 Step-600 EMA를 Euler/Beta 8-step으로 실행',factor:.8},
  {id:'speed-4',label:'속도 (4step)',help:'빠른 생성 · 전용 4-step LoRA로 실행',factor:.45},
  {id:'quality-20',label:'품질 (20step)',help:'가속 LoRA 없이 기본 모델을 20-step으로 실행',factor:2},
];
const DEFAULT_MINIMAX_PROFILE='turbo-8';
const minimaxProfile=id=>MINIMAX_PROFILES.find(item=>item.id===id)||MINIMAX_PROFILES[0];
const minimaxProfileOptions=(selected=DEFAULT_MINIMAX_PROFILE)=>MINIMAX_PROFILES.map(item=>`<label class="minimax-profile-option"><input type="radio" name="minimax-profile" value="${item.id}" ${item.id===selected?'checked':''}><span><b>${item.label}</b><small>${item.help}</small></span></label>`).join('');
const MINIMAX_MODEL_MODES=[
  {id:'default',label:'기본 INT8',help:'INT8 ConvRot H3 모델 · 기본값'},
  {id:'int4',label:'INT4',help:'INT4 ConvRot H3 모델'},
  {id:'w4a8',label:'W4A8',help:'ComfyUI 코어 W4A8 모델'},
];
const canonicalMinimaxModelMode=id=>id==='int4'?'int4':['w4a8','int4-w4a8','low-vram'].includes(id)?'w4a8':'default';
const minimaxModelMode=id=>MINIMAX_MODEL_MODES.find(item=>item.id===canonicalMinimaxModelMode(id))||MINIMAX_MODEL_MODES[0];
const minimaxModelModeOptions=(selected='default')=>{const active=canonicalMinimaxModelMode(selected);return MINIMAX_MODEL_MODES.map(item=>`<label class="minimax-profile-option"><input type="radio" name="minimax-model-mode" value="${item.id}" ${item.id===active?'checked':''}><span><b>${item.label}</b><small>${item.help}</small></span></label>`).join('');};
const MINIMAX_MODEL_FILES={
  default:{fl2va:'minimax_h3_fl2va_pruned_int8_convrot.safetensors',ref2va:'minimax_h3_ref2va_pruned_int8_convrot.safetensors'},
  int4:{fl2va:'minimaxH3INT4Convrot_fl2vaPrunedInt4.safetensors',ref2va:'minimaxH3INT4Convrot_ref2vPrunedInt4.safetensors'},
  w4a8:{fl2va:'minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors',ref2va:'minimax_h3_ref2va_pruned-w4a8_convrot_pruned.safetensors'},
};
const MINIMAX_TURBO_V4_LORA='minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors';
const minimaxVariant=value=>{const source=String(value?.engine||value?.generationMode||value?.modelName||'').toLowerCase();return source.includes('ref2va')||source.includes('reference')||source.includes('extension')?'ref2va':'fl2va';};
const inferredMinimaxModelMode=value=>{if(value?.minimaxModelMode)return canonicalMinimaxModelMode(value.minimaxModelMode);const name=String(value?.modelName||'').toLowerCase();return name.includes('w4a8')?'w4a8':name.includes('int4')?'int4':'default';};
const canonicalMinimaxProfile=id=>id==='speed-4'?'speed-4':id==='quality-20'?'quality-20':'turbo-8';
const effectiveMinimaxModelMode=(_profile,mode)=>canonicalMinimaxModelMode(mode);
const inferredMinimaxProfile=value=>{if(value?.minimaxProfile)return canonicalMinimaxProfile(value.minimaxProfile);const text=`${value?.profileLabel||''} ${value?.modelName||''}`.toLowerCase();return text.includes('20step')?'quality-20':text.includes('4step')&&!text.includes('4+8')?'speed-4':'turbo-8';};
function makeMinimaxGenerationSpec({engine='minimax-h3-fl2va',modelMode='default',profile=DEFAULT_MINIMAX_PROFILE,latentUpscaleMode='off',backgroundMusic=false}={}){
  const variant=minimaxVariant({engine}),profileId=minimaxProfile(profile).id,mode=effectiveMinimaxModelMode(profileId,modelMode),profileLabel=minimaxProfile(profileId).label,latent=MINIMAX_LATENT_UPSCALE_MODES.find(item=>item.id===latentUpscaleMode)||MINIMAX_LATENT_UPSCALE_MODES[0],ref=variant==='ref2va',engineLabel=String(engine).includes('extension')?'Ref2VA · 기존 영상 확장':String(engine).includes('audio')?'Ref2VA · Video-to-Audio':String(engine).includes('video-to-video')?'Ref2VA · Video-to-Video':String(engine).includes('context-loop')?`${ref?'Ref2VA':'FL2VA'} 연속 영상 · 22F 잠재 연결`:ref?'Ref2VA':'FL2VA';
  let sampling='res_multistep · Simple · 10 steps',acceleration=MINIMAX_TURBO_V4_LORA;
  if(profileId==='turbo-8')sampling='Euler · Beta · 8 steps · Sigma V12/A5';
  else if(profileId==='speed-4'){sampling=`Euler · Simple · 4 steps · Sigma ${ref?'V12/A3':'V6/A3'}`;acceleration=ref?'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors':'minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors';}
  else if(profileId==='quality-20'){sampling='res_multistep · Simple · 20 steps';acceleration='사용 안 함';}
  return{version:1,engine:engineLabel,variant,modelMode:mode,modelLabel:minimaxModelMode(mode).label,modelFile:MINIMAX_MODEL_FILES[mode][variant],profile:profileId,profileLabel,sampling,acceleration,latentUpscaleMode:latent.id,latentUpscaleLabel:latent.id==='off'?'잠재 업스케일 없음':`${latent.label} 잠재 업스케일`,backgroundMusic:!!backgroundMusic};
}
function generationSpecFor(value){
  if(value?.generationSpec?.modelFile)return value.generationSpec;
  const isMinimax=/minimax/i.test(`${value?.engine||''} ${value?.modelName||''}`)||value?.minimaxModelMode||value?.minimaxProfile||value?.profileLabel;
  if(!isMinimax)return null;
  const rawEngine=String(value?.engine||value?.modelName||'').toLowerCase(),engine=rawEngine.includes('audio')?'minimax-h3-ref2va-audio':rawEngine.includes('video-to-video')?'minimax-h3-ref2va-video-to-video':rawEngine.includes('context')?(minimaxVariant(value)==='ref2va'?'minimax-h3-ref2va-context-loop':'minimax-h3-fl2va-context-loop'):minimaxVariant(value)==='ref2va'?'minimax-h3-ref2va':'minimax-h3-fl2va';
  return makeMinimaxGenerationSpec({engine,modelMode:inferredMinimaxModelMode(value),profile:inferredMinimaxProfile(value),latentUpscaleMode:value?.latentUpscaleMode||'off',backgroundMusic:!!value?.backgroundMusic});
}
function generationSpecBadges(value){const spec=generationSpecFor(value);if(!spec)return value?.modelName?`<div class="generation-spec-strip"><span>${escapeAttr(value.modelName)}</span></div>`:'';return`<div class="generation-spec-strip"><span>${escapeAttr(spec.engine)}</span><strong>${escapeAttr(spec.modelLabel)}</strong><span>${escapeAttr(spec.profileLabel)}</span><span>${escapeAttr(spec.latentUpscaleLabel)}</span><span>BGM ${spec.backgroundMusic?'포함':'없음'}</span></div>`;}
function generationSpecDetails(value){const spec=generationSpecFor(value);if(!spec)return'';const seeds=Array.isArray(value?.seeds)?value.seeds.map((seed,index)=>`C${String(index+1).padStart(2,'0')} ${seed}`).join(' · '):Array.isArray(value?.segmentSeeds)?value.segmentSeeds.map((seed,index)=>`구간 ${index+1} ${seed}`).join(' · '):Number.isSafeInteger(Number(value?.seed))?String(value.seed):'기록 없음';return`<details class="generation-spec-details"><summary>생성 설정 상세</summary><dl><div><dt>생성 방식</dt><dd>${escapeAttr(spec.engine)}</dd></div><div><dt>모델</dt><dd>${escapeAttr(spec.modelLabel)}</dd></div><div class="wide"><dt>정확한 모델 파일</dt><dd title="${escapeAttr(spec.modelFile)}">${escapeAttr(spec.modelFile)}</dd></div><div><dt>샘플링</dt><dd>${escapeAttr(spec.sampling)}</dd></div><div><dt>잠재 업스케일</dt><dd>${escapeAttr(spec.latentUpscaleLabel)}</dd></div><div class="wide"><dt>가속 LoRA/PDD</dt><dd title="${escapeAttr(spec.acceleration)}">${escapeAttr(spec.acceleration)}</dd></div><div><dt>배경음악</dt><dd>${spec.backgroundMusic?'포함':'사용 안 함'}</dd></div><div class="wide"><dt>Seed</dt><dd>${escapeAttr(seeds)}</dd></div></dl></details>`;}
const MINIMAX_LATENT_UPSCALE_MODES=[
  {id:'off',label:'사용하지 않음',help:'기존 단일 해상도 생성 · 기본값'},
  {id:'quarter-to-one',label:'1/4 → 1',help:'가로·세로 1/4에서 생성 후 설정 해상도로 잠재 업스케일'},
  {id:'half-to-one',label:'1/2 → 1',help:'가로·세로 1/2에서 생성 후 설정 해상도로 잠재 업스케일'},
  {id:'two-thirds-to-one',label:'2/3 → 1',help:'가로·세로 2/3에서 생성 후 설정 해상도로 잠재 업스케일'},
  {id:'one-to-two',label:'1 → 2',help:'설정 해상도에서 생성 후 가로·세로 2배로 잠재 업스케일'},
  {id:'one-to-four',label:'1 → 4',help:'설정 해상도에서 생성 후 가로·세로 4배로 잠재 업스케일 · 매우 큰 VRAM 필요'},
];
const latentUpscaleModeOptions=(selected='off')=>MINIMAX_LATENT_UPSCALE_MODES.map(item=>`<label class="minimax-profile-option"><input type="radio" name="latent-upscale-mode" value="${item.id}" ${item.id===selected?'checked':''}><span><b>${item.label}</b><small>${item.help}</small></span></label>`).join('');
const latentUpscalePlan=(size,mode='off')=>{const align=value=>Math.max(64,Math.round(value/32)*32),base={width:align(size.width),height:align(size.height)};if(mode==='quarter-to-one')return{first:{width:align(base.width/4),height:align(base.height/4)},target:base};if(mode==='half-to-one')return{first:{width:align(base.width/2),height:align(base.height/2)},target:base};if(mode==='two-thirds-to-one')return{first:{width:align(base.width*2/3),height:align(base.height*2/3)},target:base};if(mode==='one-to-two')return{first:base,target:{width:align(base.width*2),height:align(base.height*2)}};if(mode==='one-to-four')return{first:base,target:{width:align(base.width*4),height:align(base.height*4)}};return{first:base,target:base};};
const latentUpscaleWorkMegapixels=(plan,mode='off')=>megapixels(plan.target)+(mode==='off'?0:megapixels(plan.first));
const median=values=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!sorted.length)return null;const middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};
function generationResolutionKey(value){
  const matches=[...String(value?.resolution||value?.res||'').matchAll(/(\d+)\s*[x×]\s*(\d+)/gi)],match=matches.at(-1);if(match)return`${Number(match[1])}x${Number(match[2])}`;
  if(Number(value?.resolutionWidth)>0&&Number(value?.resolutionHeight)>0)return`${Math.round(value.resolutionWidth)}x${Math.round(value.resolutionHeight)}`;return'unknown';
}
function generationEngineKey(value){
  const spec=value?.generationSpec,raw=String(value?.engine||spec?.engine||value?.modelName||value?.jobKind||'').toLowerCase();
  if(raw.includes('video-to-audio')||raw.includes('ref2va audio')||value?.jobKind==='video-audio')return'ref2va-audio';
  if(raw.includes('video-to-video')||value?.jobKind==='video-video')return'ref2va-video';
  if(raw.includes('extension')||value?.videoExtension)return'ref2va-extension';
  if(raw.includes('context')||raw.includes('latent chain'))return`${raw.includes('ref2va')?'ref2va':'fl2va'}-context`;
  if(raw.includes('ref2va'))return'ref2va';if(raw.includes('minimax'))return'fl2va';if(raw.includes('wan'))return'wan';return raw||'unknown';
}
function generationEstimateIdentity(value,includeWork=true){
  const spec=value?.generationSpec,parts=[generationEngineKey(value),canonicalMinimaxModelMode(value?.minimaxModelMode||spec?.modelMode),canonicalMinimaxProfile(value?.minimaxProfile||spec?.profile),value?.latentUpscaleMode||spec?.latentUpscaleMode||'off'];
  if(includeWork)parts.push(generationResolutionKey(value),String(Number(value?.frames)>0?Math.round(value.frames):Math.round((Number(value?.duration)||0)*10)/10));
  return parts.join('|');
}
function generationWork(value){
  const key=generationResolutionKey(value),match=key.match(/^(\d+)x(\d+)$/),pixels=match?Number(match[1])*Number(match[2]):1_000_000,duration=Math.max(.2,Number(value?.duration)||Number(value?.frames)/Math.max(1,Number(value?.fps)||MINIMAX_FPS)||5);return Math.max(1,pixels*duration);
}
function completedGenerationRecords(){
  const records=[];for(const project of projects)for(const scene of project.scenes||[]){for(const cut of scene.cuts||[])records.push(...(cut.videoResults||[]));records.push(...continuousVideoList(scene));}records.push(...(videoAudioWorkspace.results||[]),...(videoVideoWorkspace.results||[]));
  return records.filter(item=>Number(item?.generationSeconds)>0);
}
function historicalGenerationEstimate(value,fallback){
  const records=completedGenerationRecords().filter(item=>item.jobId!==value?.id),exactKey=generationEstimateIdentity(value,true),exact=records.filter(item=>generationEstimateIdentity(item,true)===exactKey),exactMedian=median(exact.map(item=>Number(item.generationSeconds)));
  if(exactMedian)return{seconds:Math.max(1,Math.round(exactMedian)),source:`동일 설정 실측 ${exact.length}건`,samples:exact.length,exact:true};
  const configKey=generationEstimateIdentity(value,false),work=generationWork(value),scaled=records.filter(item=>generationEstimateIdentity(item,false)===configKey).map(item=>Number(item.generationSeconds)*work/generationWork(item)),nearMedian=median(scaled);
  if(nearMedian)return{seconds:Math.max(1,Math.round(nearMedian)),source:`동일 모델·샘플링 실측 보정 ${scaled.length}건`,samples:scaled.length,exact:false};
  return{seconds:Math.max(1,Math.round(Number(fallback)||estimateSeconds(value?.duration))),source:'기본 계산값',samples:0,exact:false};
}
function applyHistoricalEstimate(job,fallback=job?.estimatedSeconds){const estimate=historicalGenerationEstimate(job,fallback);job.estimatedSeconds=estimate.seconds;job.estimateSource=estimate.source;job.estimateSamples=estimate.samples;job.estimateExact=estimate.exact;return estimate;}
function runningJobTiming(job){
  if(!job)return{elapsed:0,estimate:0,remaining:0,source:''};const elapsed=Math.max(0,(Date.now()-new Date(job.startedAt||job.createdAt).getTime())/1000),history=historicalGenerationEstimate(job,job.estimatedSeconds),live=Number(job.liveRemainingSeconds),fresh=Date.now()-Number(job.liveRateUpdatedAt||0)<15000,remaining=fresh&&Number.isFinite(live)?Math.max(0,live):Math.max(0,history.seconds-elapsed);return{elapsed,estimate:Math.max(elapsed+remaining,history.seconds),remaining,source:fresh&&job.iterationText?`실시간 ${job.iterationText}`:history.source};
}
function minimaxPromptMusic(prompt,backgroundMusic=false){
  const source=String(prompt||'').trim();if(backgroundMusic)return source;
  const marker=/non_diegetic_music\s*:/i,match=marker.exec(source);
  return match?`${source.slice(0,match.index).trimEnd()}\n\nnon_diegetic_music:\nN/A`:`${source}\n\nnon_diegetic_music:\nN/A`;
}
function videoToVideoPrompt(prompt,backgroundMusic=false){
  const source=String(prompt||'').trim();
  if(hasRef2vaPrompt(source))return minimaxPromptMusic(source,backgroundMusic);
  return `subject_definitions:\n<Video 1> is the temporal reference video for the target, including its subjects, motion, timing, camera movement, framing, and composition.\n\nsummary:\n[video editing + video reference] Generate a new video based on <Video 1> while following the user's requested transformation.\n\nretention_analysis:\n<Video 1>: attribute_transfer - preserve the source motion, pose, timing, camera movement, framing, and composition unless the user explicitly requests a change.\n\ndetailed_description:\n[Shot 1] ${source}\n\nMaintain temporal coherence and use <Video 1> as the visual and motion reference for the full shot.\n\noverall_soundscape:\nGenerate synchronized environmental ambience and physical sound effects that match visible actions and scene changes.${backgroundMusic?'':' Do not add background music.'}\n\nnon_diegetic_music:\n${backgroundMusic?'Create fitting background music that follows the user direction and the scene timing.':'N/A'}`;
}
function minimaxOptionsDialog({title='MiniMax-H3 생성 설정',allowHybrid=true,audio=false}={}){
  return new Promise(resolve=>{const overlay=document.createElement('div');overlay.className='action-dialog-backdrop';overlay.innerHTML=`<section class="action-dialog minimax-options-dialog" role="dialog" aria-modal="true"><header><span>MINIMAX-H3</span><h2>${escapeAttr(title)}</h2><p>H3 모델, 샘플링 방식과 2-pass 잠재 업스케일을 선택하세요.</p></header><h3 class="minimax-option-heading">H3 모델</h3><div class="minimax-profile-options">${minimaxModelModeOptions('default')}</div><h3 class="minimax-option-heading">샘플링 방식</h3><div class="minimax-profile-options">${minimaxProfileOptions(DEFAULT_MINIMAX_PROFILE,allowHybrid)}</div>${allowHybrid?`<h3 class="minimax-option-heading">2-pass 잠재 업스케일</h3><div class="minimax-profile-options">${latentUpscaleModeOptions()}</div>`:''}<label class="generation-source-option minimax-music-option"><input type="checkbox" class="minimax-background-music"><span><b>배경음악 포함</b><small>기본 사용 안 함 · 꺼두면 non_diegetic_music은 N/A로 고정하고 ${audio?'환경음·음향효과':'영상의 환경음·음향효과'}는 유지합니다.</small></span></label>${!allowHybrid?'<p class="minimax-profile-note">latent 연속 영상은 전용 Context Loop sampler를 사용합니다.</p>':''}<footer><button type="button" class="button secondary minimax-options-cancel">취소</button><button type="button" class="button primary minimax-options-confirm">확인</button></footer></section>`;document.body.append(overlay);const finish=value=>{overlay.remove();resolve(value);};overlay.querySelector('.minimax-options-cancel').addEventListener('click',()=>finish(null));overlay.querySelector('.minimax-options-confirm').addEventListener('click',()=>{const profile=overlay.querySelector('[name="minimax-profile"]:checked')?.value||DEFAULT_MINIMAX_PROFILE;finish({modelMode:effectiveMinimaxModelMode(profile,overlay.querySelector('[name="minimax-model-mode"]:checked')?.value||'default'),profile,latentUpscaleMode:overlay.querySelector('[name="latent-upscale-mode"]:checked')?.value||'off',backgroundMusic:overlay.querySelector('.minimax-background-music').checked});});overlay.addEventListener('click',event=>{if(event.target===overlay)finish(null);});});
}
function workflowEngineDialog(){
  return new Promise(resolve=>{const overlay=document.createElement('div');overlay.className='action-dialog-backdrop';overlay.innerHTML=`<section class="action-dialog workflow-engine-dialog" role="dialog" aria-modal="true"><header><span>COMFYUI API WORKFLOW</span><h2>Workflow 다운로드</h2><p>현재 컷에 적용할 생성 엔진을 선택하세요.</p></header><div class="workflow-engine-options"><button type="button" class="button secondary" data-workflow-engine="wan"><b>WAN 2.2</b><small>현재 FIRST·LAST·프롬프트와 프로젝트 해상도</small></button><button type="button" class="button secondary" data-workflow-engine="minimax-h3"><b>MiniMax-H3</b><small>모델·step·2-pass 설정을 선택한 뒤 저장</small></button></div><footer><button type="button" class="button secondary workflow-engine-cancel">취소</button></footer></section>`;document.body.append(overlay);const finish=value=>{overlay.remove();resolve(value);};overlay.querySelectorAll('[data-workflow-engine]').forEach(button=>button.addEventListener('click',()=>finish(button.dataset.workflowEngine)));overlay.querySelector('.workflow-engine-cancel').addEventListener('click',()=>finish(null));overlay.addEventListener('click',event=>{if(event.target===overlay)finish(null);});});
}
async function downloadCutWorkflow(scene,cut){
  try{
    if(!isTauri())throw new Error('Workflow 다운로드는 데스크톱 앱에서 사용할 수 있습니다.');
    const extension=isVideoExtensionCut(cut),ref2va=isRef2vaCut(cut),project=currentProject();
    let kind=extension?'minimax-h3-extension':ref2va?'minimax-h3-ref2va':await workflowEngineDialog();if(!kind)return;
    let options={modelMode:'default',profile:DEFAULT_MINIMAX_PROFILE,latentUpscaleMode:'off',backgroundMusic:false};
    if(kind!=='wan'){const selected=await minimaxOptionsDialog({title:`${scene.title} · ${cut.name} Workflow 설정`,allowHybrid:!extension});if(!selected)return;options=selected;}
    const duration=Math.max(.2,Number(cut.duration)||5),size=kind==='wan'?projectResolution(project):minimaxResolution(project),state=ensureRef2vaState(cut),extensionState=cut.extension||{};
    let prompt=ref2va?REF2VA_SECTIONS.map(section=>`${section}:\n`).join('\n'):String(cut.promptEn||'').trim();
    if(!prompt)throw new Error('Workflow에 넣을 영문 프롬프트를 먼저 입력해 주세요.');
    if(kind!=='wan'&&!ref2va)prompt=extension?videoExtensionPrompt(prompt,!!options.backgroundMusic):minimaxPromptMusic(prompt,!!options.backgroundMusic);
    const profile=minimaxProfile(options.profile),mode=minimaxModelMode(options.modelMode),slug=kind==='wan'?'WAN22':extension?'Minimax-H3-Extension':ref2va?'Minimax-H3-Ref2VA':'Minimax-H3-FL2VA',filename=`${slug}-${mode.id}-${profile.id}.json`;
    const targetPath=await window.__TAURI__.dialog.save({title:'ComfyUI API Workflow 저장',defaultPath:filename,filters:[{name:'ComfyUI Workflow JSON',extensions:['json']}]});if(!targetPath)return;
    const result=await window.__TAURI__.core.invoke('comfy_export_workflow',{request:{kind,targetPath,firstImagePath:extension?(extensionState.internalFirstPath||(cut.lastPath?'extension-internal-first.png':'')):(cut.firstPath||''),lastImagePath:cut.lastPath||'',sourceVideoPath:extensionState.sourceVideoPath||'',referenceImages:ref2va?state.pictures.map(item=>item.path):[],referenceVideos:ref2va?state.videos.map(item=>item.path):[],prompt,width:size.width,height:size.height,length:comfyFrameLength(duration),duration,seed:Number.isSafeInteger(cut.nextGenerationSeed)?cut.nextGenerationSeed:COMFY_BASE_SEED,minimaxProfile:options.profile,minimaxModelMode:options.modelMode,latentUpscaleMode:extension?'off':options.latentUpscaleMode,backgroundMusic:!!options.backgroundMusic,refImageSize:state.refImageSize||'match'}});
    toast(`Workflow 저장 완료: ${result.path}`,9000);
  }catch(error){toast(`Workflow 다운로드 실패: ${error.message||error}`,10000);}
}
const REF2VA_SECTIONS=['subject_definitions','summary','retention_analysis','detailed_description','overall_soundscape','non_diegetic_music'];
const H3_OFFICIAL_BASE_LLM_RULES=`MINIMAX H3 OFFICIAL BASE PROMPT RULES — MANDATORY:
- Identify and obey the active mode: T2VA builds the complete timeline from text; I2VA starts from Picture 1; FL2VA describes one continuous path from Picture 1 to Picture 2; L2VA infers a plausible opening and converges to Picture 1 at the end.
- Preserve the exact mode-specific picture-alignment instruction as the first line of the final prompt. FrameFlow assembles that line, so return only the requested section values.
- The core section order is integrated_multimodal_description, overall_soundscape, non_diegetic_music.
- integrated_multimodal_description is chronological. Start with [Shot 1] and no timestamp. Every later cut must use a strictly increasing [Shot N] At MM:SS.mmm timestamp inside the requested duration. Prefer continuous camera motion over a cut when only distance or a slight angle changes.
- For FL2VA, write a continuous observable path: first-frame state, intermediate physical changes, progressively narrowing differences, and exact landing on the final frame. Favor one shot unless the user explicitly requests cuts.
- Describe camera motion naturally with motion type and, when meaningful, amplitude and speed. Use precise H3 vocabulary such as Push In/Pull Out, Pan, Truck, Tilt, Pedestal, Arc Shot, Tracking Shot, Static Shot, Shake, POV, and Roll. Do not append disconnected camera keyword lists.
- Each shot must establish composition, subjects, environment, actions/state changes, camera behavior, lighting, and synchronized diegetic sound. Preserve subject identity, clothing, colors, key objects, positions, contact points, and spatial relationships across the timeline.
- Assign stable (S1), (S2) IDs only to actual vocal sources. Put only exact user-provided dialogue or lyrics inside <d>[Language] ...</d>; preserve wording, punctuation, and language without translation or invention. For off-screen voiceover use the phrase says in an off-screen voiceover and explicitly state that the matching on-screen lips remain closed.
- If dialogue crosses a cut, place <scenetrans> at both connecting portions and state that audio continues across the cut. Use <cutoff> only when speech is truncated by the end of the video.
- Preserve visible signs, subtitles, banners, labels, and other on-screen text verbatim in English double quotation marks without translation.
- overall_soundscape is one continuous paragraph of 1–4 concrete English sentences covering ambience, physical action sounds, and non-verbal human sounds. Do not repeat dialogue, singing, or diegetic music there. Use N/A only when the user explicitly requests complete silence.
- non_diegetic_music is audience-only score. When enabled, use 1–3 concrete English sentences describing instrumentation, tempo, rhythm, and dynamic/volume development; do not substitute abstract mood words or explain emotional purpose. Put music audible to characters inside the chronological description. Use N/A when audience-only music is absent.
- Never invent unsupported dialogue, lyrics, visible text, references, cuts, objects, or timing. Timing must fit the requested duration exactly.`;
const H3_OFFICIAL_REF_LLM_RULES=`MINIMAX H3 OFFICIAL FULL-REFERENCE RULES — MANDATORY:
${H3_OFFICIAL_BASE_LLM_RULES}
- Return the six Ref2VA sections in this exact order: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. English is the generation prompt; Korean mirrors it for FrameFlow review.
- Keep every <Subject N>, <Picture N>, <Video N>, and <Audio N> label immutable and semantically consistent across all six sections. A <Subject N> denotes reusable visible content; a source asset label does not replace subject labels.
- Give a standalone <Picture N> definition only when the image itself is a first frame, keyframe, last frame, edited keyframe, composition anchor, or storyboard anchor. Otherwise cite it inside the corresponding <Subject N> definition.
- Use <Video N> for whole-video editing, continuation, camera/cut/rhythm, or temporal-structure roles. Use <Audio N> only for an explicitly enabled audio copy/reference role; a video containing audio does not automatically create an Audio label.
- BOTH summary.ko and summary.en MUST begin with the applicable official task type inside literal square brackets. The only valid opening forms are [keyframe completion], [reference generation], [video editing], [video continuation], [audio reuse], [audio reference], or multiple applicable types joined inside the same brackets with ' + ', for example [video editing + reference generation]. Square brackets are mandatory. A bare opening such as "video editing." is invalid. Do not invent task-type names.
- retention_analysis must contain one line per used reference label. Visible relationships use only fully_preserved, partially_preserved, attribute_transfer, or weak_reference. Audio relationships use only fully_copy, partially_copy, reference, or weak_reference. State where each reference appears and exactly which attributes are retained, transferred, changed, copied, or merely referenced.
- When continuity.preserveIdentity is true, retention_analysis.ko and retention_analysis.en must explicitly state whose identity or stable target form is preserved. Write "the target subject identity and form remain consistent throughout the video" in English and "목표 피사체의 정체성과 형태가 영상 전체에서 일관되게 유지됩니다." in Korean. If the user requests replacing or transforming a source subject, preserve the requested transformed target after it appears, not the source identity being replaced.
- detailed_description must be maximally explicit rather than a plot summary. Establish the overall style in one or two English sentences before [Shot 1], then describe every shot in playback order with composition, appearance/position, environment, lighting, actions/state changes, camera, current sound, and the exact point where each reference takes effect.
- For generation tasks, normally target 350–500 English words in detailed_description while still fitting the actual duration; dialogue-heavy work prioritizes the complete spoken timeline, and editing/continuation length scales with source complexity.
- When only voice timbre, rhythm, emotion, or delivery is referenced, never copy the source's spoken words. Reuse stable speaker IDs consistently and never put speaker IDs in retention_analysis.
- Before returning JSON, audit label definitions, task types, relationship markers, shot numbering, timestamps, dialogue tags, visible text, sound classification, and requested duration. Return JSON only.`;
function ensureRef2vaState(cut){
  cut.generationMode=cut.generationMode==='video-extension'?'video-extension':cut.generationMode==='ref2va'?'ref2va':'flf';
  cut.ref2va=cut.ref2va&&typeof cut.ref2va==='object'?cut.ref2va:{};
  cut.ref2va.pictures=Array.isArray(cut.ref2va.pictures)?cut.ref2va.pictures:[];
  cut.ref2va.videos=Array.isArray(cut.ref2va.videos)?cut.ref2va.videos:[];
  cut.ref2va.audios=Array.isArray(cut.ref2va.audios)?cut.ref2va.audios:[];
  cut.ref2va.userDirection=String(cut.ref2va.userDirection||'');
  cut.ref2va.refImageSize=cut.ref2va.refImageSize==='max'?'max':'match';
  return cut.ref2va;
}
const isRef2vaContinuousScene=scene=>scene?.sceneType==='ref2va-continuous';
function ensureRef2vaContinuousScene(scene){
  scene.sceneType=isRef2vaContinuousScene(scene)?'ref2va-continuous':'standard';
  scene.ref2vaContinuous=scene.ref2vaContinuous&&typeof scene.ref2vaContinuous==='object'?scene.ref2vaContinuous:{};
  const state=scene.ref2vaContinuous;
  state.pictures=Array.isArray(state.pictures)?state.pictures:[];
  state.videos=Array.isArray(state.videos)?state.videos:[];
  state.audios=Array.isArray(state.audios)?state.audios:[];
  state.userDirection=String(state.userDirection||'');
  state.refImageSize=state.refImageSize==='max'?'max':'match';
  return state;
}
function syncContinuousReferences(scene){
  if(!isRef2vaContinuousScene(scene))return;
  const shared=ensureRef2vaContinuousScene(scene);
  for(const cut of scene.cuts||[]){const state=ensureRef2vaState(cut);cut.generationMode='ref2va';state.pictures=structuredClone(shared.pictures);state.videos=structuredClone(shared.videos);state.audios=structuredClone(shared.audios);state.refImageSize=shared.refImageSize;}
}
const isRef2vaCut=cut=>ensureRef2vaState(cut)&&cut.generationMode==='ref2va';
const hasRef2vaPrompt=prompt=>REF2VA_SECTIONS.every(section=>String(prompt||'').includes(`${section}:`));
function ref2vaReferenceLabels(cut){const state=ensureRef2vaState(cut);return[...state.pictures.map((item,index)=>({...item,label:`<Picture ${index+1}>`,kind:'picture'})),...state.videos.map((item,index)=>({...item,label:`<Video ${index+1}>`,kind:'video'})),...state.audios.map((item,index)=>({...item,label:`<Audio ${index+1}>`,kind:'audio'}))];}
function ref2vaRequestPayload(cut){
  const state=ensureRef2vaState(cut),kindRequirements={picture:['identity','design','appearance','materials','color','composition','style'],video:['subjects','motion','pose','timing','camera movement','framing','composition'],audio:['voice/timbre','rhythm','emotion','delivery','ambience and sound character']};
  return {
    schema:'frameflow.ref2va.request.v1',
    duration_seconds:Math.max(.2,Number(cut.duration)||Number(currentProject()?.duration)||5),
    reference_order:ref2vaReferenceLabels(cut).map(item=>({label:item.label,type:item.kind,file:item.name||item.path?.split(/[\\/]/).pop()||'reference',user_assigned_role:String(item.role||''),must_analyze_and_state_policy_for:kindRequirements[item.kind]})),
    user_direction:String(state.userDirection||''),
    frameflow_detail_context:ref2vaDetailContext(cut),
    required_output:{format:'JSON only',version:1,sections:REF2VA_SECTIONS,section_shape:{ko:'string',en:'string'}}
  };
}
function ref2vaPromptFromJson(result,language='en'){
  return REF2VA_SECTIONS.map(section=>{const value=result?.[section],text=typeof value==='string'?value:value?.[language]||'';return`${section}:\n${String(text).trim()}`;}).join('\n\n');
}
function ref2vaLlmInstruction(cut){
  const request=ref2vaRequestPayload(cut),labels=request.reference_order.map(item=>item.label).join(', ');
  return `STRICT OUTPUT CONTRACT — MINIMAX H3 REF2VA VIDEO PROMPT ONLY:\nReturn only one valid JSON object for Ref2VA VIDEO generation. This is not a soundtrack-design task. Never return the Video-to-Audio schema or fields such as vocal_enabled, background_music_enabled, mood_tags, instruments, music, sound_effects, no_effects_reason, segments, prompt_ko, or prompt_en. Do not create, render, edit, or return media, markdown, explanations, or code fences.\n\nYou are designing a MiniMax H3 Ref2VA video prompt. Analyze every attached reference in the exact immutable order in FRAMEFLOW REF2VA REQUEST JSON.\n\n${H3_OFFICIAL_REF_LLM_RULES}\n\nFRAMEFLOW REF2VA REQUEST JSON — MANDATORY INPUT, NOT OUTPUT:\n${JSON.stringify(request,null,2)}\n\nREFERENCE-AWARE APPLICATION RULES:\n- Process every reference_order entry. Do not omit a registered label from the response.\n- user_assigned_role is authoritative when non-empty; otherwise infer a precise role from the attached media.\n- For every Picture, analyze and explicitly state what happens to identity, design, appearance, materials, color, composition, and style.\n- For every Video, analyze and explicitly state what happens to subjects, motion, pose, timing, camera movement, framing, and composition. A Video is temporal evidence, never a keyframe.\n- For every Audio, analyze only reusable voice/timbre, rhythm, emotion, delivery, ambience, and sound character; never copy spoken words unless explicitly requested.\n- Apply every non-empty value in frameflow_detail_context. Merge it into the official six sections instead of returning frameflow_detail_context as an extra field.\n- Resolve conflicts in this order: user_direction, user_assigned_role, frameflow_detail_context, inferred reference content.\n\nReturn JSON only. The response must be one JSON object with version=1 and these exact six keys in addition to version and request_id: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. Each section value must be {"ko":"...","en":"..."}.\n\nRules:\n- summary.ko and summary.en must each start with a literal square-bracket task tag, such as [video editing] or [video editing + reference generation]. Never start either value with bare text such as "video editing.".\n- Use only the immutable native labels ${labels||'(none)'}.\n- Define reusable visible <Subject N> entities in subject_definitions and cite their actual Picture/Video sources without replacing subjects with file labels.\n- For image subjects, preserve identity/design in retention_analysis.\n- For video references, explicitly state whether motion, pose, timing, camera movement, framing, and composition are preserved or transformed.\n- detailed_description must contain the complete playback-order [Shot N] timeline and identify every subject/reference at the point it applies.\n- overall_soundscape and non_diegetic_music must be explicit. Use N/A for overall_soundscape only when complete silence is explicitly requested; use N/A for non_diegetic_music when audience-only music is absent.\n- English must be directly usable as the MiniMax H3 Ref2VA prompt. Korean is for FrameFlow review.\n- Do not omit any section and do not add unsupported media labels.\n\nFINAL SCHEMA (replace every placeholder):\n{"version":1,"request_id":"unique request id","subject_definitions":{"ko":"...","en":"..."},"summary":{"ko":"[official task type] ...","en":"[official task type] ..."},"retention_analysis":{"ko":"...","en":"..."},"detailed_description":{"ko":"... [Shot 1] ...","en":"... [Shot 1] ..."},"overall_soundscape":{"ko":"...","en":"..."},"non_diegetic_music":{"ko":"... or N/A","en":"... or N/A"}}`;
}
const REF2VA_OFFICIAL_TASK_TYPE='(?:keyframe completion|reference generation|video editing|video continuation|audio reuse|audio reference)';
function normalizeRef2vaSummaryTaskType(text){
  const source=String(text||'').trim(),bracketed=new RegExp(`^\\[${REF2VA_OFFICIAL_TASK_TYPE}(?:\\s*\\+\\s*${REF2VA_OFFICIAL_TASK_TYPE})*\\]`,'i');
  if(bracketed.test(source))return source;
  const bare=new RegExp(`^(${REF2VA_OFFICIAL_TASK_TYPE}(?:\\s*\\+\\s*${REF2VA_OFFICIAL_TASK_TYPE})*)\\s*(?:[.:：-]\\s*)?`,'i'),match=source.match(bare);
  if(!match)return source;
  const taskTag=match[1].split('+').map(item=>item.trim().toLowerCase()).join(' + '),body=source.slice(match[0].length).trim();
  return `[${taskTag}]${body?` ${body}`:''}`;
}
function validateRef2vaJson(raw,cut){
  let value;try{value=typeof raw==='string'?JSON.parse(raw.trim()):raw;}catch(error){throw new Error(`JSON 형식 오류: ${error.message}`);}
  if(Number(value?.version)!==1)throw new Error('version은 1이어야 합니다.');
  for(const section of REF2VA_SECTIONS){if(!value?.[section]||typeof value[section].ko!=='string'||typeof value[section].en!=='string'||!value[section].en.trim())throw new Error(`${section}의 ko/en 응답이 필요합니다.`);}
  value.summary.ko=normalizeRef2vaSummaryTaskType(value.summary.ko);
  value.summary.en=normalizeRef2vaSummaryTaskType(value.summary.en);
  const allowed=new Set(ref2vaReferenceLabels(cut).map(item=>item.label));
  const labels=[...JSON.stringify(value).matchAll(/<(Picture|Video|Audio)\s+\d+>/g)].map(match=>match[0]);
  const invalid=[...new Set(labels.filter(label=>!allowed.has(label)))];if(invalid.length)throw new Error(`등록되지 않은 레퍼런스 라벨입니다: ${invalid.join(', ')}`);
  const used=new Set(labels),missingReferences=[...allowed].filter(label=>!used.has(label));if(missingReferences.length)throw new Error(`등록된 레퍼런스가 JSON에 반영되지 않았습니다: ${missingReferences.join(', ')}`);
  const summary=String(value.summary.en||''),retention=String(value.retention_analysis.en||''),details=String(value.detailed_description.en||'');
  if(!new RegExp(`^\\s*\\[${REF2VA_OFFICIAL_TASK_TYPE}(?:\\s*\\+\\s*${REF2VA_OFFICIAL_TASK_TYPE})*\\]`,'i').test(summary))throw new Error('summary가 공식 MiniMax H3 작업 유형 대괄호로 시작하지 않습니다.');
  if(labels.length&&!/\b(?:fully_preserved|partially_preserved|attribute_transfer|weak_reference|fully_copy|partially_copy|reference)\b/.test(retention))throw new Error('retention_analysis에 공식 보존·복사 관계 값이 없습니다.');
  if(!/\[Shot 1\]/i.test(details))throw new Error('detailed_description에 타임스탬프 없는 [Shot 1]이 필요합니다.');
  const laterShots=[...details.matchAll(/\[Shot\s+(\d+)\]/gi)].filter(match=>Number(match[1])>1);for(const shot of laterShots)if(!new RegExp(`\\[Shot\\s+${shot[1]}\\]\\s+At\\s+\\d{2}:\\d{2}\\.\\d{3}`,'i').test(details))throw new Error(`[Shot ${shot[1]}]에 At MM:SS.mmm 형식의 컷 시간이 필요합니다.`);
  validateRef2vaDetailCoverage(value,cut);
  return value;
}
function ref2vaDetailContext(cut){
  const meta=sceneMeta(cut),camera=meta.camera||{},mood=allMoodPresets().find(item=>item.id===meta.moodPreset),aesthetic=allAestheticPresets().find(item=>item.id===meta.aestheticPreset),transition=bilingualTransition(meta.transition),elements=(meta.elements||[]).map(bilingualElement),isStatic=(camera.movements||[]).includes('static'),tracking=camera.trackingTarget==='custom'?camera.trackingCustom:elements.find(item=>item.id===camera.trackingTarget)?.nameKo||camera.trackingTarget;
  const moodTraitList=meta.moodTraits||moodTraits(mood),aestheticTraitList=meta.aestheticTraits||aestheticTraits(aesthetic);
  const explicitNoCrossfade=/\bcross[\s-]?fade\b|크로스\s*페이드/i.test([ensureRef2vaState(cut).userDirection,meta.direction,meta.negativeDirection,meta.additionalDirection].filter(Boolean).join('\n'));
  return {
    priority_user_directions:{reference_mode_direction:ensureRef2vaState(cut).userDirection||'',detailed_staging_direction:meta.direction||'',negative_direction_to_convert_into_positive_constraints:meta.negativeDirection||'',observed_additional_direction:meta.additionalDirection||''},prompt_timing:promptTimingPayload(cut),
    camera:{shot_size:camera.shotSize||'auto',angle:camera.angle||'auto',lens:camera.lens||'auto',composition:camera.composition||'auto',movements:camera.movements||['static'],speed:isStatic?null:camera.speed||'slow',tracking_target:(camera.movements||[]).includes('tracking')?tracking||null:null,tracking_method:(camera.movements||[]).includes('tracking')?camera.trackingMethod||null:null},
    style_presets:{mood:mood?{id:mood.id,name_ko:mood.nameKo,name_en:mood.name||mood.nameEn,mandatory_traits_ko:moodTraitList,emotion:mood.emotion,worldview:mood.worldview,scale:mood.scale,material:mood.material,motion:mood.motion,space:mood.space}:moodTraitList.length?{id:'custom-direct',name_ko:'직접 입력',name_en:'Direct input',mandatory_traits_ko:moodTraitList}:null,aesthetic:aesthetic?{id:aesthetic.id,name_ko:aesthetic.nameKo,name_en:aesthetic.nameEn,mandatory_traits_ko:aestheticTraitList,description:aesthetic.description}:aestheticTraitList.length?{id:'custom-direct',name_ko:'직접 입력',name_en:'Direct input',mandatory_traits_ko:aestheticTraitList}:null,inference_policy:{when_mood_is_null:'infer concrete mood tags from the tagged reference sheet and apply them throughout the prompt',when_aesthetic_is_null:'infer a concrete visual aesthetic, material language, and rendering treatment from the tagged reference sheet'}},
    timeline:transition?{summary_ko:transition.summaryKo,summary_en:transition.summaryEn,type_ko:transition.typeKo,type_en:transition.typeEn,pacing_ko:transition.pacingKo,pacing_en:transition.pacingEn,phases:transition.phases.map(item=>({time_seconds:item.timeSeconds,action_ko:item.actionKo,action_en:item.actionEn})),relationships:transition.relationships.map(item=>({driver:item.driver,affected:item.affected,relation_ko:item.relationKo,relation_en:item.relationEn}))}:{phases:[],relationships:[]},
    continuity:{...(transition?.continuity||{preserveIdentity:true,noSuddenAppearance:true,lastFrameLock:false}),noCrossfade:explicitNoCrossfade},
    analyzed_elements:elements.map(item=>({id:item.id,type:item.type,name_ko:item.nameKo,name_en:item.nameEn,mood_ko:item.moodKo,mood_en:item.moodEn,start_state_ko:item.startStateKo,start_state_en:item.startStateEn,end_state_ko:item.endStateKo,end_state_en:item.endStateEn,movement_ko:item.movementKo,movement_en:item.movementEn,timing_ko:item.timingKo,timing_en:item.timingEn}))
  };
}
const REF2VA_CAMERA_VOCABULARY={
  shot_size:{wide:{canonical:'Wide Shot',pattern:/\b(?:wide|long) shot\b/i},medium:{canonical:'Medium Shot',pattern:/\b(?:medium|mid) shot\b/i},close_up:{canonical:'Close-Up',pattern:/\bclose[ -]?up\b/i},extreme_close_up:{canonical:'Extreme Close-Up',pattern:/\bextreme close[ -]?up\b/i}},
  angle:{eye_level:{canonical:'Eye-Level',pattern:/\beye[ -]?level\b/i},high:{canonical:'High Angle',pattern:/\bhigh[ -]?angle\b/i},low:{canonical:'Low Angle',pattern:/\blow[ -]?angle\b/i},overhead:{canonical:'Overhead',pattern:/\b(?:overhead|bird'?s[ -]?eye)\b/i},pov:{canonical:'POV',pattern:/\b(?:pov|point[ -]of[ -]view)\b/i}},
  lens:{normal:{canonical:'Normal Lens',pattern:/\b(?:normal|standard) lens\b/i},wide:{canonical:'Wide-Angle Lens',pattern:/\bwide[ -]?angle(?: lens)?\b/i},telephoto:{canonical:'Telephoto Lens',pattern:/\btelephoto(?: lens)?\b/i},anamorphic:{canonical:'Anamorphic Lens',pattern:/\banamorphic(?: lens)?\b/i},macro:{canonical:'Macro Lens',pattern:/\bmacro(?: lens| shot)?\b/i}},
  composition:{center:{canonical:'Centered Composition',pattern:/\b(?:centered|central|centre(?:d)?) (?:composition|framing)\b/i},thirds:{canonical:'Rule of Thirds',pattern:/\b(?:rule of thirds|thirds composition)\b/i},symmetry:{canonical:'Symmetrical Composition',pattern:/\b(?:symmetr(?:y|ic|ical)|symmetrical composition)\b/i},leading_lines:{canonical:'Leading Lines',pattern:/\bleading lines?\b/i},negative_space:{canonical:'Negative Space',pattern:/\bnegative space\b/i}},
  movement:{static:{canonical:'Static Shot (static camera)',pattern:/\b(?:static (?:camera|shot)|locked[ -]off(?: camera| shot)?|camera (?:remains|stays|is|keeps)[^.]{0,48}\bstatic)\b/i},dolly_in:{canonical:'Dolly In',pattern:/\b(?:dolly in|push in|camera (?:moves|travels) forward)\b/i},dolly_out:{canonical:'Dolly Out',pattern:/\b(?:dolly out|pull out|camera (?:moves|travels) backward)\b/i},pan_left:{canonical:'Pan Left',pattern:/\b(?:pan(?:s|ning)? left|leftward pan)\b/i},pan_right:{canonical:'Pan Right',pattern:/\b(?:pan(?:s|ning)? right|rightward pan)\b/i},tilt_up:{canonical:'Tilt Up',pattern:/\b(?:tilt(?:s|ing)? up|upward tilt)\b/i},tilt_down:{canonical:'Tilt Down',pattern:/\b(?:tilt(?:s|ing)? down|downward tilt)\b/i},tracking:{canonical:'Tracking Shot',pattern:/\b(?:tracking shot|camera track(?:s|ing)?)\b/i},steadicam:{canonical:'Steadicam',pattern:/\bsteadicam\b/i},crane:{canonical:'Crane Shot',pattern:/\b(?:crane|jib) shot\b/i},dolly_zoom:{canonical:'Dolly Zoom',pattern:/\b(?:dolly zoom|vertigo effect)\b/i},handheld:{canonical:'Handheld',pattern:/\bhand[ -]?held\b/i}}
};
function ref2vaRequiredCameraTerms(details){
  const required=[];
  for(const field of ['shot_size','angle','lens','composition']){const selected=details.camera[field],entry=REF2VA_CAMERA_VOCABULARY[field]?.[selected];if(selected&&selected!=='auto'&&entry)required.push(entry.canonical);}
  for(const movement of details.camera.movements||[]){const entry=REF2VA_CAMERA_VOCABULARY.movement[movement];if(entry)required.push(entry.canonical);}
  return required;
}
function legacyRef2vaDetailedLlmInstruction(cut){
  const base=ref2vaLlmInstruction(cut),details=ref2vaDetailContext(cut),cameraTerms=ref2vaRequiredCameraTerms(details);
  return `${base}\n\nFRAMEFLOW DETAIL APPLICATION RULES — MANDATORY:\n- Treat every non-empty value in FRAMEFLOW REF2VA REQUEST JSON as USER-LOCKED. The reference sheet establishes identity; these settings control the target video.\n- Explicitly place the complete camera configuration in detailed_description and keep it consistent in every shot. A non-auto value must appear concretely.${cameraTerms.length?` Include these exact canonical English terms verbatim: ${cameraTerms.join(', ')}.`:''} Static Shot (static camera) forbids any pan, tilt, dolly, zoom, orbit, crane, handheld, or tracking motion.\n- Apply every mandatory_traits_ko item semantically in the English generation text as well as the Korean review text. Do not replace a selected trait with a generic cinematic adjective.\n- Convert negative_direction_to_convert_into_positive_constraints into concrete positive preservation instructions. Never quote the negative wording and never weaken the intent.\n- detailed_description must cover the entire 0-100% timeline. Preserve the supplied phase ranges; if only default phases are supplied, write explicit [Shot/Phase] instructions for 0-20%, 20-80%, and 80-100%.\n- Map every analyzed element and every <Subject N> to its start state, motion, timing, causal relationship, and final state. If analyzed_elements is empty, infer those fields separately for every tagged reference.\n- Put identity/design preservation, attribute transfer, and enabled continuity requirements in retention_analysis.${details.continuity.noCrossfade?' Because noCrossfade is explicitly enabled, state the no-crossfade requirement there.':''} In Ref2VA mode, lastFrameLock means settling into the described target state; it does not introduce an FLF LAST image.\n- Preserve all user directions, reference roles, camera constraints, preset traits, timing phases, element relationships, atmosphere/effects, overall soundscape, and music decision in the six returned sections.\n- Before returning JSON, silently audit the six sections against every non-empty setting above. Rewrite until nothing is missing. Return the same six-section JSON schema requested above and nothing else.`;
}
function validateRef2vaDetailCoverage(value,cut){
  const details=ref2vaDetailContext(cut),english=REF2VA_SECTIONS.map(key=>value[key]?.en||'').join(' ').toLowerCase().replace(/[_-]+/g,' '),korean=REF2VA_SECTIONS.map(key=>value[key]?.ko||'').join(' '),missing=[];
  for(const field of ['shot_size','angle','lens','composition']){const selected=details.camera[field],entry=REF2VA_CAMERA_VOCABULARY[field]?.[selected];if(selected&&selected!=='auto'&&entry&&!entry.pattern.test(english))missing.push(`카메라 ${field}: ${entry.canonical}`);}
  for(const movement of details.camera.movements||[]){const entry=REF2VA_CAMERA_VOCABULARY.movement[movement];if(entry&&!entry.pattern.test(english))missing.push(`카메라 움직임: ${entry.canonical}`);}
  for(const preset of Object.values(details.style_presets)){for(const trait of preset?.mandatory_traits_ko||[])if(trait&&!korean.includes(trait))missing.push(`프리셋 특성: ${trait}`);}
  for(const phase of details.timeline.phases||[])if(phase.time_seconds!=null&&!english.includes(Number(phase.time_seconds).toFixed(3))&&!korean.includes(String(phase.time_seconds)))missing.push(`시작 시간: ${phase.time_seconds}초`);
  for(const element of details.analyzed_elements||[]){const represented=(element.name_en&&english.includes(element.name_en.toLowerCase()))||(element.name_ko&&korean.includes(element.name_ko));if((element.name_en||element.name_ko)&&!represented)missing.push(`요소: ${element.name_ko||element.name_en}`);}
  const identityContinuity=/\bidentity\b|\b(?:maintain|maintains|maintained|preserve|preserves|preserved|retain|retains|retained)\b.{0,80}\b(?:appearance|design|form|subject|character|cloud)\b|\b(?:remain|remains|stays|continues)\b.{0,80}\b(?:the same|consistent|a cloud|cloud form)\b|without (?:ever )?revert(?:ing)?/i.test(english)||/정체성|동일한?.{0,40}(?:형태|외형|디자인)|(?:형태|외형|디자인).{0,40}유지|(?:사람|인간)의?\s*형태로\s*(?:돌아가지|되돌아가지)|일관된?\s*(?:형태|외형|디자인)/.test(korean);
  if(details.continuity?.preserveIdentity&&!identityContinuity)missing.push('연속성: 대상의 정체성·형태 유지');
  if(details.continuity?.noCrossfade&&!english.includes('crossfade')&&!korean.toLowerCase().includes('크로스페이드'))missing.push('연속성: crossfade 금지');
  if(missing.length)throw new Error(`Ref2VA 세부 조건이 JSON에 누락되었습니다: ${missing.join(', ')}`);
}
const cutHasOutput=cut=>Boolean(cut?.selected||(cut?.videoResults||[]).length);
function cutGenerationReadiness(project,scene,cut,{forcePrevious=false,plannedPreviousUids=null}={}){
  if(cut.selected)return{state:'skip',reason:`선택 영상이 있어 다시 생성하지 않습니다 (${cut.selected.type} · ${cut.selected.res})`};
  const active=(project.jobs||[]).find(job=>job.cutUid===cut.uid&&['queued','running'].includes(job.status));
  if(active)return{state:'blocked',reason:`이미 ${active.status==='running'?'생성 중':'큐 대기 중'}인 작업이 있습니다`};
  if(isRef2vaCut(cut)){
    const refs=ref2vaReferenceLabels(cut);
    if(!refs.length)return{state:'blocked',reason:'Ref2VA 레퍼런스 이미지 또는 영상이 없습니다'};
    if(!hasRef2vaPrompt(cut.promptEn))return{state:'blocked',reason:'Ref2VA 공식 6섹션 영문 프롬프트가 없습니다'};
    return{state:'ready',reason:`Ref2VA 레퍼런스 ${refs.length}개와 공식 프롬프트가 준비되었습니다`};
  }
  if(!String(cut.promptEn||'').trim())return{state:'blocked',reason:'영문 프롬프트가 없습니다'};
  const hasFirst=isTauri()?Boolean(cut.firstPath):Boolean(cut.first);
  const hasLast=isTauri()?Boolean(cut.lastPath):Boolean(cut.last);
  if(!hasLast)return{state:'blocked',reason:'LAST Frame 이미지가 없습니다'};
  if(forcePrevious){
    const flat=cuts(project),index=flat.findIndex(item=>item.cut.uid===cut.uid),previous=index>0?flat[index-1]:null;
    if(!previous)return{state:'blocked',reason:'이전 컷이 없어 선택 영상의 마지막 프레임을 가져올 수 없습니다'};
    if(plannedPreviousUids?.has(previous.cut.uid))return{state:'ready',reason:`이전 컷 ${mediaPrefix(project,previous.scene.id,previous.cut.id)}의 이번 배치 생성 결과에서 마지막 프레임을 이어받습니다`};
    if(!previous.cut.selected?.path&&isTauri())return{state:'blocked',reason:`이전 컷 ${mediaPrefix(project,previous.scene.id,previous.cut.id)}에 선택된 대표 영상이 없습니다`};
    if(!previous.cut.selected&&!isTauri())return{state:'blocked',reason:'이전 컷에 선택된 대표 영상이 없습니다'};
    return{state:'ready',reason:`저장된 FIRST를 무시하고 이전 컷 ${mediaPrefix(project,previous.scene.id,previous.cut.id)} 선택 영상의 마지막 프레임을 사용합니다`};
  }
  if(!hasFirst){
    const flat=cuts(project),index=flat.findIndex(item=>item.cut.uid===cut.uid),previous=index>0?flat[index-1]:null;
    if(!previous)return{state:'blocked',reason:'FIRST Frame이 없고 이전 컷도 없습니다'};
    if(!previous.cut.selected?.path&&isTauri())return{state:'blocked',reason:`FIRST Frame이 없고 이전 컷 ${mediaPrefix(project,previous.scene.id,previous.cut.id)}의 선택 영상도 없습니다`};
    if(!previous.cut.selected&&!isTauri())return{state:'blocked',reason:'FIRST Frame이 없고 이전 컷의 선택 영상도 없습니다'};
    return{state:'ready',reason:'이전 컷의 선택 영상 마지막 프레임을 FIRST로 자동 추출합니다'};
  }
  return{state:'ready',reason:'FLF 이미지와 영문 프롬프트가 준비되었습니다'};
}
function projectGenerationProgress(project){
  const flat=cuts(project),doneCuts=flat.filter(({cut})=>cutHasOutput(cut)).length,doneScenes=(project.scenes||[]).filter(scene=>(scene.cuts||[]).length&&(scene.cuts||[]).every(cutHasOutput)).length;
  const activeJobs=(project.jobs||[]).filter(job=>['queued','running'].includes(job.status));
  const remaining=activeJobs.length?activeJobs.reduce((sum,job)=>sum+(job.status==='running'?runningJobTiming(job).remaining:historicalGenerationEstimate(job,job.estimatedSeconds).seconds),0):flat.filter(({cut})=>!cutHasOutput(cut)).reduce((sum,{cut})=>sum+estimateSeconds(cut.duration),0);
  return{doneCuts,totalCuts:flat.length,doneScenes,totalScenes:(project.scenes||[]).length,remaining:Math.max(0,remaining),running:activeJobs.filter(job=>job.status==='running').length,queued:activeJobs.filter(job=>job.status==='queued').length,percent:flat.length?Math.round(doneCuts/flat.length*100):0};
}
function assignProjectCodes(){
  const used=new Set(projects.map(project=>String(project.projectCode||'').toUpperCase()).filter(code=>/^[0-9A-F]{4}$/.test(code)));
  for(const project of projects){if(/^[0-9A-F]{4}$/.test(String(project.projectCode||'').toUpperCase()))continue;for(let value=1;value<=0xFFFF;value++){const code=value.toString(16).toUpperCase().padStart(4,'0');if(!used.has(code)){project.projectCode=code;used.add(code);break;}}}
}
function migrateProjectModel(){
  assignProjectCodes();
  for(const project of projects){
    const actual=projectResolution(project);project.minimaxWidth=Number(project.minimaxWidth)||actual.width;project.minimaxHeight=Number(project.minimaxHeight)||actual.height;
    project.scenes=(project.scenes||[]).map((legacy,index)=>{
      if(Array.isArray(legacy.cuts)){legacy.id=index+1;legacy.title=legacy.title||legacy.name||`씬 ${String(index+1).padStart(2,'0')}`;legacy.content=legacy.content||'';legacy.cuts.forEach((cut,cutIndex)=>{cut.id=cutIndex+1;cut.uid=cut.uid||`cut-${Date.now()}-${index}-${cutIndex}`;cut.name=cut.name||`컷 ${String(cutIndex+1).padStart(2,'0')}`;});return legacy;}
      const cut={...legacy,id:1,uid:`cut-${Date.now()}-${index}-0`,name:'컷 01'};delete cut.cuts;
      return{id:index+1,title:legacy.name||`씬 ${String(index+1).padStart(2,'0')}`,content:'',cuts:[cut]};
    });
    for(const scene of project.scenes){
      ensureRef2vaContinuousScene(scene);
      scene.continuousVideos=Array.isArray(scene.continuousVideos)?scene.continuousVideos:[];
      if(scene.continuousVideo&&!scene.continuousVideos.some(item=>item.id===scene.continuousVideo.id||item.path===scene.continuousVideo.path))scene.continuousVideos.unshift(scene.continuousVideo);
      const offlineRecovered=scene.continuousVideos.filter(item=>item.recovered&&String(item.path||'').includes('-recovered-job-'));
      if(offlineRecovered.length>1){const newest=offlineRecovered.sort((a,b)=>Number(String(b.jobId||'').match(/\d{13}/)?.[0]||0)-Number(String(a.jobId||'').match(/\d{13}/)?.[0]||0))[0];scene.continuousVideos=scene.continuousVideos.filter(item=>!offlineRecovered.includes(item)||item===newest);scene.continuousVideo=newest;scene.selectedContinuousVideoId=newest.id;}
      if(!scene.selectedContinuousVideoId&&scene.continuousVideos[0])scene.selectedContinuousVideoId=scene.continuousVideos[0].id;
      for(const cut of scene.cuts||[]){cut.filePrefix=cut.filePrefix||mediaPrefix(project,scene.id,cut.id);ensureRef2vaState(cut);const meta=cut.metaPrompt;if(meta&&!meta.userCollapsed&&((meta.elements||[]).length||meta.transition||meta.finalPromptEn||meta.revisedPromptKo))meta.open=true;}
      syncContinuousReferences(scene);
    }
    for(const job of project.jobs||[]){job.cutId=job.cutId||1;if(job.status==='running'||(job.status==='queued'&&!project.autoResumeQueueOnce)){job.status='interrupted';job.error=job.error||'프로그램 종료로 중단된 작업입니다.';}if(String(job.error||'').length>1200){const match=String(job.error).match(/exception_message["']?\s*:\s*["']([^"']+)/i);job.error=`ComfyUI 생성 실패: ${match?.[1]||'이전 상세 오류가 너무 길어 축약했습니다. Comfy 로그를 확인해 주세요.'}`;}}
  }
}
migrateProjectModel();
if(testMode){
  const demoCut=projects[0]?.scenes?.[0]?.cuts?.[0];
  if(demoCut&&!(demoCut.videoResults||[]).length){
    demoCut.videoResults=[
      {id:'demo-result-final',type:'FINAL',res:'1920×1080',createdAt:'2026. 8. 24. 오후 2:30',duration:5,fps:16,frames:81,modelName:'WAN 2.2 14B FLF2V',backend:'Comfy Desktop',promptKo:demoCut.promptKo,promptEn:demoCut.promptEn,gifUrl:'/preset-visuals/mood-presets-v1.png',sheetPath:'test-sheet.png',sheetUrl:'/preset-visuals/mood-presets-v1.png',sheetSamples:11,color:'linear-gradient(135deg,#315f58,#9bd8bc)'},
      {id:'demo-result-test',type:'TEST',res:'848×480',createdAt:'2026. 8. 24. 오후 2:18',duration:5,fps:16,frames:81,modelName:'WAN 2.2 14B FLF2V',backend:'Comfy Desktop',promptKo:demoCut.promptKo,promptEn:demoCut.promptEn,gifUrl:'/preset-visuals/aesthetic-presets-v1.png',sheetPath:'test-sheet-2.png',sheetUrl:'/preset-visuals/aesthetic-presets-v1.png',sheetSamples:11,color:'linear-gradient(135deg,#6760a7,#c3b8ef)'}
    ];
    demoCut.selected={...demoCut.videoResults[0],date:demoCut.videoResults[0].createdAt};demoCut.results=2;
  }
}
const persistentProject = project => {
  const copy=structuredClone(project);
  for(const {cut} of cuts(copy)){if(cut.firstPath)cut.first=null;if(cut.lastPath)cut.last=null;}
  return copy;
};
async function localImageDetails(path){
  const project=currentProject();
  const thumbnail=await window.__TAURI__.core.invoke('ensure_image_thumbnail',{sourcePath:path,projectPath:project?.projectPath||appSettings.defaultFolder});
  const source=window.__TAURI__.core.convertFileSrc(thumbnail.path);
  return{background:`url('${String(source).replace(/'/g,'%27')}')`,width:thumbnail.sourceWidth,height:thumbnail.sourceHeight,thumbnailPath:thumbnail.path};
}
function setCutImageDetails(cut,key,details){cut[key]=details.background;cut[`${key}Width`]=Number(details.width)||null;cut[`${key}Height`]=Number(details.height)||null;}
async function hydrateProjectImages(){
  if(!isTauri())return;
  const tasks=projects.flatMap(project=>cuts(project).flatMap(({cut})=>['first','last'].map(key=>({project,cut,key,path:cut[`${key}Path`]})))).filter(item=>item.path);
  // Prioritize the open project; limit concurrent disk/thumbnail work.
  tasks.sort((a,b)=>Number(b.project.id===activeProjectId)-Number(a.project.id===activeProjectId));
  const worker=async()=>{while(tasks.length){const item=tasks.shift();
    try{const thumbnail=await window.__TAURI__.core.invoke('ensure_image_thumbnail',{sourcePath:item.path,projectPath:item.project.projectPath});const source=window.__TAURI__.core.convertFileSrc(thumbnail.path);setCutImageDetails(item.cut,item.key,{background:`url('${String(source).replace(/'/g,'%27')}')`,width:thumbnail.sourceWidth,height:thumbnail.sourceHeight});}
    catch(error){item.cut[item.key]=null;console.error(`FLF preview failed: ${item.path}`,error);}
    if(item.project.id===activeProjectId){const location=cutLocation(item.cut,item.project);document.querySelectorAll(`.cut-card[data-scene="${location.scene?.id}"][data-cut="${item.cut.id}"] .frame.${item.key}`).forEach(frame=>{frame.style.background=item.cut[item.key]||'';frame.classList.toggle('missing',!item.cut[item.key]);const label=frame.querySelector('span');if(label)label.textContent=item.cut[item.key]?item.key.toUpperCase():`+ ${item.key.toUpperCase()}`;});}
    await new Promise(resolve=>setTimeout(resolve,0));
  }};await Promise.all([worker(),worker()]);
  document.querySelectorAll('[data-project-roll]').forEach(card=>{const project=projects.find(item=>item.id===card.dataset.projectRoll);if(!project)return;const cover=projectSceneCovers(project)[0];if(cover){let frame=card.querySelector('.project-cover-frame');if(!frame){frame=document.createElement('div');card.append(frame);}frame.className='project-cover-frame active';frame.style.background=cover.background;frame.textContent='';}});
}
let inputDispatch=false,projectSaveTimer=null;
const pendingProjectSaves=new Set();
document.addEventListener('input',()=>{inputDispatch=true;queueMicrotask(()=>{inputDispatch=false;});},true);
function flushProjectSaves(){
  clearTimeout(projectSaveTimer);projectSaveTimer=null;
  if(testMode||!pendingProjectSaves.size)return Promise.resolve();
  const pending=[...pendingProjectSaves];pendingProjectSaves.clear();
  localStorage.setItem('frameflow-projects-v1',JSON.stringify(projects.map(persistentProject)));
  localStorage.setItem('frameflow-active-project',activeProjectId||'');
  return Promise.all(pending.filter(project=>projects.includes(project)&&nativeReady).map(project=>window.__TAURI__.core.invoke('save_project',{project:persistentProject(project)}).catch(console.error)));
}
window.addEventListener('pagehide',flushProjectSaves);
document.addEventListener('visibilitychange',()=>{if(document.hidden)void flushProjectSaves();});
function save() {
  if (testMode) return;
  const active=currentProject();if(active){active.updatedAtMs=Date.now();if(!active.updatedAt||active.updatedAt==='오늘')active.updatedAt='방금 전';}
  if(active)pendingProjectSaves.add(active);
  clearTimeout(projectSaveTimer);
  if(inputDispatch)projectSaveTimer=setTimeout(flushProjectSaves,250);else void flushProjectSaves();
}
function renderPreservingEditorScroll(){
  const current=document.querySelector('.scene-editor-backdrop .inspector'),scrollTop=current?.scrollTop||0;
  render();
  requestAnimationFrame(()=>{const next=document.querySelector('.scene-editor-backdrop .inspector');if(next)next.scrollTop=scrollTop;});
}
const cameraMovements=[['static','Static camera (고정 카메라)'],['dolly_in','Dolly in (카메라 전진)'],['dolly_out','Dolly out (카메라 후진)'],['pan_left','Pan left (왼쪽 회전)'],['pan_right','Pan right (오른쪽 회전)'],['tilt_up','Tilt up (위로 회전)'],['tilt_down','Tilt down (아래로 회전)'],['tracking','Tracking (대상 추적)'],['steadicam','Steadicam (부드러운 이동)'],['crane','Crane shot (수직 이동)'],['dolly_zoom','Dolly zoom (원근 변화)'],['handheld','Handheld (손-held 흔들림)']];
const moodPresets=[
  ['sublime-monumental','Sublime Monumental','숭고, 경외','초현실·자연','기념비적','암석, 안개, 입자','극저속, 유동','광활, 심연'],
  ['sacred-stillness','Sacred Stillness','신성, 명상','제의적','건축적','석재, 유리, 안개','거의 정지, 호흡','대칭, 성소'],
  ['dream-memory','Dream Memory','몽환, 서정','기억·초현실','인간~건축','안개, 빛, 파티클','모핑, 부유, 소멸','층위, 부유'],
  ['poetic-nature','Poetic Nature','시적, 명상','동양적 자연','거대 자연','물, 나무, 안개','바람, 흐름','개방, 여백'],
  ['craft-sublime','Craft Sublime','숭고, 우아','전통+미래','기념비적','자개, 금, 섬유','극저속, 미세 반사','광활, 제의적'],
  ['cosmic-infinite','Cosmic Infinite','경외, 신비','우주적','우주','입자, 성운, 빛','천천히 확산','무한, 심연'],
  ['primordial-genesis','Primordial Genesis','원초, 신비','태초','미시→거대','암석, 액체, 세포','생성, 성장','깊은 층위'],
  ['cellular-universe','Cellular Universe','기이함, 경외','생체적','극미시','세포, 막, 균사','분열, 성장','유기적 무한'],
  ['organic-future','Organic Future','신비, 미래','유기적 미래주의','건축적','생체막, 섬유, 유리','성장, 호흡','살아있는 건축'],
  ['data-dream','Data Dream','몽환, 신비','데이터·디지털','추상','점, 선, 데이터','군집, 생성','무중력'],
  ['data-collapse','Data Collapse','불안, 긴장','디스토피아','건축~무한','데이터, 노이즈','글리치, 파편화','불안정'],
  ['cyber-dystopia','Cyber Dystopia','긴장, 압도','사이버펑크','도시적','금속, 유리, 네온','빠른 맥동','고밀도'],
  ['synesthetic-pulse','Synesthetic Pulse','역동, 몰입','추상','가변','빛, 기하학','오디오 반응, 맥동','몰입형'],
  ['liquid-meditation','Liquid Meditation','명상, 몽환','추상적 자연','매크로','액체, 유리','느린 유동','무중력'],
  ['tactile-dream','Tactile Dream','쾌감, 친밀','촉각적','매크로','섬유, 젤, 소프트바디','눌림, 팽창','친밀'],
  ['iridescent-luxury','Iridescent Luxury','우아, 화려','공예 미래주의','오브젝트~건축','자개, 결정, 금속','미세 변화','정제된 전시 공간'],
  ['minimal-void','Minimal Void','고독, 명상','미니멀','기념비적','단일 물질','극저속','거대한 공허'],
  ['melancholic-ruins','Melancholic Ruins','상실, 기억','폐허','건축적','먼지, 균열, 안개','소멸, 침식','빈 공간'],
  ['psychedelic-flow','Psychedelic Flow','황홀, 혼란','환각적','가변','액체, 패턴','반복, 모핑','왜곡된 무한'],
  ['hyper-pop','Hyper Pop','유쾌, 강렬','하이퍼팝','인간~오브젝트','글로시, 젤, 플라스틱','탄성, 빠른 반응','그래픽 공간']
].map(([id,name,emotion,worldview,scale,material,motion,space],index)=>({id,name,number:String(index+1).padStart(2,'0'),emotion,worldview,scale,material,motion,space}));
const moodPresetKoreanNames=['숭고한 기념비','신성한 정적','꿈의 기억','시적인 자연','공예적 숭고','우주적 무한','태초의 생성','세포 우주','유기적 미래','데이터의 꿈','데이터 붕괴','사이버 디스토피아','공감각적 맥동','액체 명상','촉각적 꿈','영롱한 럭셔리','미니멀 공허','멜랑콜릭 폐허','환각적 흐름','하이퍼 팝'];
moodPresets.forEach((preset,index)=>preset.nameKo=moodPresetKoreanNames[index]);
const aestheticPresets=[
  ['nacre-sublime','자개 숭고','Nacre Sublime','거대한 자개 구조 + 숭고'],
  ['nacre-memory','자개 기억','Nacre Memory','자개 + 기억 + 소멸'],
  ['nacre-dream','자개 몽환','Nacre Dream','자개 + 몽환 + 안개'],
  ['nacre-sacred','자개 성소','Nacre Sacred','자개 + 제의적 공간'],
  ['korean-monumental','한국적 기념비','Korean Monumental','한국 전통 조형 + 기념비적 스케일'],
  ['korean-poetic','한국적 시정','Korean Poetic','산수·여백·느린 자연'],
  ['korean-futurism','한국 미래주의','Korean Futurism','전통 소재 + 미래 기술'],
  ['memory-archive','기억 아카이브','Memory Archive','기록·축적·층위'],
  ['memory-dissolution','기억의 소멸','Memory Dissolution','존재 → 입자 → 부재'],
  ['light-stratum','빛의 지층','Light Stratum','빛의 축적·지층·시간']
].map(([id,nameKo,nameEn,description],index)=>({id,nameKo,nameEn,description,number:String(index+1).padStart(2,'0')}));
const readCustomPresets=key=>{try{const value=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(value)?value:[];}catch{return[];}};
let customMoodPresets=readCustomPresets('frameflow-custom-mood-presets-v1');
let customAestheticPresets=readCustomPresets('frameflow-custom-aesthetic-presets-v1');
const allMoodPresets=()=>[...customMoodPresets,...moodPresets];
const allAestheticPresets=()=>[...customAestheticPresets,...aestheticPresets];
const moodTraits=preset=>preset?[preset.emotion,preset.worldview,preset.scale,preset.material,preset.motion,preset.space].flatMap(value=>String(value||'').split(/[,·+]/).map(item=>item.trim()).filter(Boolean)).filter((value,index,list)=>list.indexOf(value)===index):[];
const aestheticTraits=preset=>preset?String(preset.description||'').split(/[+·,→]/).map(item=>item.trim()).filter(Boolean):[];
const optionalElementText=value=>{const text=String(value||'').trim();return /^(?:n\/?a|none|not applicable|해당\s*없음)$/i.test(text)?'':text;};
const bilingualElement=(element,index)=>({
  id:String(element.id||`element-${String(index+1).padStart(2,'0')}`),type:String(element.type||'scene element'),
  nameEn:String(element.nameEn||element.name_en||element.name||element.label||''),nameKo:String(element.nameKo||element.name_ko||''),
  moodEn:optionalElementText(element.moodEn||element.mood_en||element.mood),moodKo:optionalElementText(element.moodKo||element.mood_ko),
  startStateEn:String(element.startStateEn||element.start_state_en||element.startState||element.start_state||''),startStateKo:String(element.startStateKo||element.start_state_ko||''),
  endStateEn:String(element.endStateEn||element.end_state_en||element.endState||element.end_state||''),endStateKo:String(element.endStateKo||element.end_state_ko||''),
  movementEn:optionalElementText(element.movementEn||element.movement_en||element.movement||element.motion),movementKo:optionalElementText(element.movementKo||element.movement_ko),
  timingEn:optionalElementText(element.timingEn||element.timing_en||element.timing),timingKo:optionalElementText(element.timingKo||element.timing_ko)
});
const bilingualTransition=transition=>transition?{
  summaryEn:String(transition.summaryEn||transition.summary_en||''),summaryKo:String(transition.summaryKo||transition.summary_ko||''),
  typeEn:String(transition.typeEn||transition.transition_type_en||transition.transition_type||''),typeKo:String(transition.typeKo||transition.transition_type_ko||''),
  pacingEn:String(transition.pacingEn||transition.pacing_en||transition.pacing||''),pacingKo:String(transition.pacingKo||transition.pacing_ko||''),
  phases:(transition.phases||[]).map((phase,index)=>({id:String(phase.id||`phase-${index+1}`),timeSeconds:phase.timeSeconds??phase.time_seconds??null,range:String(phase.range||''),actionEn:String(phase.actionEn||phase.action_en||''),actionKo:String(phase.actionKo||phase.action_ko||'')})),
  relationships:(transition.relationships||[]).map((relation,index)=>({id:String(relation.id||`relation-${index+1}`),driver:String(relation.driver||relation.driver_id||''),affected:String(relation.affected||relation.affected_id||''),relationEn:String(relation.relationEn||relation.relation_en||''),relationKo:String(relation.relationKo||relation.relation_ko||'')})),
  continuity:{preserveIdentity:Boolean(transition.continuity?.preserve_identity??transition.continuity?.preserveIdentity??true),noSuddenAppearance:Boolean(transition.continuity?.no_sudden_appearance??transition.continuity?.noSuddenAppearance??true),noCrossfade:Boolean(transition.continuity?.no_crossfade??transition.continuity?.noCrossfade??true),lastFrameLock:Boolean(transition.continuity?.last_frame_lock??transition.continuity?.lastFrameLock??true)}
}:null;
function sceneMeta(scene){
  const meta=scene.meta ||= {open:false,combinedPath:null,direction:'',negativeDirection:'',additionalDirection:'',camera:{shotSize:'auto',angle:'auto',lens:'auto',composition:'auto',movements:['static'],speed:'slow',trackingTarget:'custom',trackingCustom:'',trackingMethod:'부드럽게 일정한 거리를 유지하며 추적'},transition:null,elements:[],llmJson:'',finalPromptEn:'',revisedPromptKo:'',readableSummaryKo:''};
  meta.additionalDirection??='';meta.negativePrompt??='';meta.promptMode=meta.promptMode==='staged'?'staged':'basic';meta.promptSteps=Array.isArray(meta.promptSteps)?meta.promptSteps:[];
  while(meta.promptSteps.length<2)meta.promptSteps.push({id:`prompt-step-${Date.now()}-${meta.promptSteps.length}`,timeSeconds:meta.promptSteps.length===0?0:null,instruction:''});
  meta.promptSteps=meta.promptSteps.map((step,index)=>({id:String(step?.id||`prompt-step-${Date.now()}-${index}`),timeSeconds:step?.timeSeconds===''||step?.timeSeconds==null?null:Math.max(0,Number(step.timeSeconds)||0),instruction:String(step?.instruction||'')}));return meta;
}
function promptTimingPayload(scene){const meta=sceneMeta(scene),duration=Math.max(.2,Number(scene.duration)||Number(currentProject()?.duration)||5);return{mode:meta.promptMode,video_duration_seconds:duration,basic_prompt:meta.direction||'',steps:meta.promptMode==='staged'?meta.promptSteps.map((step,index)=>({step:index+1,requested_start_seconds:step.timeSeconds,instruction:step.instruction})).filter(step=>step.instruction.trim()):[]};}
function promptInputMarkup(scene){const meta=sceneMeta(scene),staged=meta.promptMode==='staged',steps=meta.promptSteps.map((step,index)=>`<article class="meta-prompt-step" data-prompt-step="${index}"><header><b>단계 ${String(index+1).padStart(2,'0')}</b>${meta.promptSteps.length>2?`<button type="button" class="remove-prompt-step" data-prompt-step-remove="${index}" aria-label="단계 삭제">×</button>`:''}</header><div><label><span>시작 시간 <small>비우면 LLM이 결정</small></span><input type="number" min="0" max="${Math.max(.2,Number(scene.duration)||5)}" step="0.1" inputmode="decimal" data-prompt-step-time="${index}" value="${step.timeSeconds==null?'':step.timeSeconds}" placeholder="자동"></label><label><span>이 단계에서 할 일</span><textarea data-prompt-step-instruction="${index}" placeholder="예: 빛줄기가 결속력을 잃고 입자로 흩어진다.">${escapeAttr(step.instruction)}</textarea></label></div></article>`).join('');return`<section class="meta-user-prompt"><div class="meta-prompt-tabs" role="tablist" aria-label="프롬프트 작성 방식"><button type="button" role="tab" data-prompt-mode="basic" aria-selected="${!staged}" class="${staged?'':'active'}">기본 프롬프트</button><button type="button" role="tab" data-prompt-mode="staged" aria-selected="${staged}" class="${staged?'active':''}">단계별 프롬프트</button></div><div class="meta-prompt-panel ${staged?'hidden':''}" data-prompt-panel="basic"><label class="meta-direction"><span>연출 의도</span><textarea id="meta-direction" placeholder="두 프레임 사이에서 무엇이 어떻게 변해야 하는지 입력하세요.">${escapeAttr(meta.direction||'')}</textarea></label></div><div class="meta-prompt-panel ${staged?'':'hidden'}" data-prompt-panel="staged"><div class="meta-prompt-step-help"><b>총 ${Number(scene.duration)||5}초</b><span>시간을 비우면 LLM이 장면과 단계 내용을 보고 시작 시각을 정합니다. 입력한 시간은 그대로 유지됩니다.</span></div><div class="meta-prompt-steps">${steps}</div><button type="button" class="button secondary add-prompt-step">${icon('plus')} 단계 추가</button></div></section>`;}
function previousCutEntry(target){const flat=cuts(currentProject()),index=flat.findIndex(item=>item.cut.uid===target?.uid);return index>0?flat[index-1]:null;}
function importPreviousCutPrompts(target){
  const previous=previousCutEntry(target);if(!previous){toast('첫 번째 Cut에는 이전 Cut이 없습니다.');return;}
  const sourceMeta=sceneMeta(previous.cut),hasSource=Boolean(String(previous.cut.promptKo||'').trim()||String(previous.cut.promptEn||'').trim()||sourceMeta.direction||sourceMeta.negativeDirection||sourceMeta.additionalDirection||sourceMeta.llmJson||sourceMeta.finalPromptEn||sourceMeta.revisedPromptKo||(sourceMeta.elements||[]).length||sourceMeta.transition||sourceMeta.moodPreset||sourceMeta.aestheticPreset);if(!hasSource){toast('이전 Cut에 저장된 프롬프트 또는 메타프롬프트가 없습니다.',6000);return;}
  const targetMeta=sceneMeta(target),hasTarget=Boolean(String(target.promptKo||'').trim()||String(target.promptEn||'').trim()||targetMeta.direction||targetMeta.negativeDirection||targetMeta.additionalDirection||targetMeta.llmJson||targetMeta.finalPromptEn||targetMeta.revisedPromptKo||(targetMeta.elements||[]).length||targetMeta.transition);if(hasTarget&&!window.confirm('현재 Cut의 프롬프트와 메타프롬프트를 모두 이전 Cut의 내용으로 바꾸시겠습니까?'))return;
  target.promptKo=previous.cut.promptKo||'';target.promptEn=previous.cut.promptEn||'';target.kling26Prompt=previous.cut.kling26Prompt||'';target.meta=structuredClone(sourceMeta);target.meta.combinedPath=null;target.meta.open=false;target.meta.userCollapsed=true;save();renderPreservingEditorScroll();toast('이전 Cut의 프롬프트와 메타프롬프트 전체를 가져왔습니다.');
}
if(testMode&&demoScenes[0]){
  sceneMeta(demoScenes[0]).readableSummaryKo='고정된 카메라가 새벽의 온실 전체를 바라봅니다. 부드러운 빛이 온실 중앙에서 점차 넓어집니다. 유리 표면의 물방울이 빛을 받아 반짝입니다. 섬세한 식물이 느린 바람을 따라 부드럽게 흔들립니다. 넓어진 빛이 온실 전체를 따뜻하게 채웁니다.';
}
function metaPromptMarkup(scene){
  const meta=sceneMeta(scene),camera=meta.camera,ready=isRef2vaCut(scene)?ref2vaReferenceLabels(scene).length>0:isTauri()?Boolean(scene.firstPath&&scene.lastPath):Boolean(scene.first&&scene.last),movements=camera.movements?.length?camera.movements:['static'];
  if(!meta.open){
    const previous=previousCutEntry(scene),previousMeta=previous?sceneMeta(previous.cut):null,hasPreviousPrompt=Boolean(String(previous?.cut.promptKo||'').trim()||String(previous?.cut.promptEn||'').trim()||previousMeta?.direction||previousMeta?.negativeDirection||previousMeta?.additionalDirection||previousMeta?.llmJson||previousMeta?.finalPromptEn||previousMeta?.revisedPromptKo||(previousMeta?.elements||[]).length||previousMeta?.transition||previousMeta?.moodPreset||previousMeta?.aestheticPreset);
    if(!ready)return `<section class="meta-prompt-entry"><div class="meta-entry-actions"><button type="button" class="button secondary" disabled>${icon('spark')} FLF 메타 프롬프트 설정</button>${previous?`<button type="button" class="button secondary import-previous-prompt" ${hasPreviousPrompt?'':'disabled'} title="${hasPreviousPrompt?'이전 Cut의 프롬프트와 메타프롬프트 전체를 현재 Cut에 복사합니다.':'이전 Cut에 저장된 프롬프트가 없습니다.'}">${icon('link')} 이전 Cut 프롬프트 가져오기</button>`:''}</div><small>FIRST와 LAST 이미지를 모두 업로드하면 사용할 수 있습니다.</small></section>`;
    // Use the browser's native disclosure control for the first opening. This
    // remains operable even if an app click handler is interrupted elsewhere.
    meta.open=true;const workspace=metaPromptMarkup(scene);meta.open=false;
    return `<details class="meta-prompt-entry meta-prompt-disclosure"><summary class="button primary meta-native-summary">${icon('spark')} FLF 메타 프롬프트 설정</summary><div class="meta-entry-support">${previous?`<button type="button" class="button secondary import-previous-prompt" ${hasPreviousPrompt?'':'disabled'} title="${hasPreviousPrompt?'이전 Cut의 프롬프트와 메타프롬프트 전체를 현재 Cut에 복사합니다.':'이전 Cut에 저장된 프롬프트가 없습니다.'}">${icon('link')} 이전 Cut 프롬프트 가져오기</button>`:''}<small>카메라·분위기·전환 조건을 설정한 뒤 LLM 분석을 진행합니다.</small></div>${workspace}</details>`;
  }
  const select=(id,label,value,options)=>`<label class="meta-control"><span>${label}</span><select id="${id}">${options.map(([v,n])=>`<option value="${v}" ${value===v?'selected':''}>${n}</option>`).join('')}</select></label>`;
  meta.elements=(meta.elements||[]).map(bilingualElement);
  const trackOptions=[['custom','Direct input (직접 입력)'],...meta.elements.map(element=>[element.id,element.nameKo||element.nameEn])];
  const resolved=meta.resolvedCamera;
  let cameraResult=resolved?`<section class="meta-camera-result"><header><b>분석된 카메라</b><span>LLM RESULT</span></header><dl><div data-tooltip="피사체가 화면에서 차지하는 크기와 촬영 범위입니다."><dt>Shot size (샷 크기)</dt><dd>${escapeAttr(resolved.shotSize||'-')}</dd></div><div data-tooltip="카메라가 피사체를 바라보는 높이와 방향입니다."><dt>Angle (앵글)</dt><dd>${escapeAttr(resolved.angle||'-')}</dd></div><div data-tooltip="화각과 원근감, 배경 압축 정도를 결정하는 렌즈 표현입니다."><dt>Lens (렌즈)</dt><dd>${escapeAttr(resolved.lens||'-')}</dd></div><div data-tooltip="프레임 안에서 요소를 배치하는 시각적 구성 방식입니다."><dt>Composition (구도)</dt><dd>${escapeAttr(resolved.composition||'-')}</dd></div><div class="wide" data-tooltip="영상 동안 카메라 자체가 이동하거나 고정되는 방식입니다."><dt>Movement (움직임)</dt><dd>${escapeAttr((resolved.movements||[]).join(', ')||'-')}</dd></div></dl></section>`:'';
  meta.transition=bilingualTransition(meta.transition);
  if(meta.transition){
    const transition=meta.transition,bi=(title,en,ko,field)=>`<section class="meta-transition-bi"><b>${title}</b><div><label class="meta-lang-en"><span>English · 원본</span><textarea readonly>${escapeAttr(en)}</textarea></label><label class="meta-lang-ko"><span>한국어 · 수정 가능</span><textarea data-transition-field="${field}">${escapeAttr(ko)}</textarea></label></div></section>`;
    const phases=transition.phases.map((phase,index)=>`<article class="meta-transition-step" data-transition-phase="${index}"><header><b>${escapeAttr(phase.range||`단계 ${index+1}`)}</b><span>PHASE ${String(index+1).padStart(2,'0')}</span></header><div><label class="meta-lang-en"><span>English · 원본</span><textarea readonly>${escapeAttr(phase.actionEn)}</textarea></label><label class="meta-lang-ko"><span>한국어 · 수정 가능</span><textarea data-transition-phase-ko="${index}">${escapeAttr(phase.actionKo)}</textarea></label></div></article>`).join('');
    const relationships=transition.relationships.map((relation,index)=>`<article class="meta-transition-relation" data-transition-relation="${index}"><b>${escapeAttr(relation.driver)} → ${escapeAttr(relation.affected)}</b><div><label class="meta-lang-en"><span>English · 원본</span><textarea readonly>${escapeAttr(relation.relationEn)}</textarea></label><label class="meta-lang-ko"><span>한국어 · 수정 가능</span><textarea data-transition-relation-ko="${index}">${escapeAttr(relation.relationKo)}</textarea></label></div></article>`).join('');
    const continuity=Object.entries({preserveIdentity:'Identity 유지',noSuddenAppearance:'갑작스러운 등장 금지',noCrossfade:'Crossfade 금지',lastFrameLock:'LAST 프레임 고정'}).filter(([key])=>transition.continuity[key]).map(([,label])=>`<span>${label}</span>`).join('');
    cameraResult+=`<section class="meta-transition"><header><div><b>03. 장면 전환</b><small>SCENE TRANSITION · FIRST → LAST</small></div><span>LLM RESULT</span></header>${bi('전환 요약',transition.summaryEn,transition.summaryKo,'summaryKo')}${bi('전환 방식',transition.typeEn,transition.typeKo,'typeKo')}${bi('속도와 리듬',transition.pacingEn,transition.pacingKo,'pacingKo')}<h5>시간 단계</h5>${phases}<h5>요소 간 인과관계</h5>${relationships||'<p class="meta-transition-empty">지정된 인과관계가 없습니다.</p>'}<div class="meta-continuity">${continuity}</div></section>`;
  }else cameraResult+=`<section class="meta-transition meta-transition-pending"><header><div><b>03. 장면 전환</b><small>SCENE TRANSITION · FIRST → LAST</small></div><span>분석 필요</span></header><div class="meta-transition-placeholder"><b>아직 장면 전환 계획이 없습니다</b><p>새 메타 프롬프트로 분석하면 시간 단계와 요소 간 인과관계가 이 위치에 표시됩니다.</p><button type="button" class="button primary meta-transition-copy">새 메타 프롬프트 복사</button></div></section>`;
  const bilingualField=(title,enField,koField,enValue,koValue,kind='textarea')=>`<section class="meta-bi-field"><b>${title}</b><div><label class="meta-lang-en"><span>English · 원본</span>${kind==='input'?`<input value="${escapeAttr(enValue)}" readonly>`:`<textarea readonly>${escapeAttr(enValue)}</textarea>`}</label><label class="meta-lang-ko"><span>한국어 · 수정 가능</span>${kind==='input'?`<input data-element-field="${koField}" value="${escapeAttr(koValue)}">`:`<textarea data-element-field="${koField}">${escapeAttr(koValue)}</textarea>`}</label></div></section>`;
  let elementCards=meta.elements.length?meta.elements.map((element,index)=>`<article class="meta-element" data-element-index="${index}"><header><b>${String(index+1).padStart(2,'0')} · ${escapeAttr(element.nameKo||element.nameEn||'이름 없는 요소')}</b><span>${escapeAttr(element.type)}</span></header>${bilingualField('요소명','nameEn','nameKo',element.nameEn,element.nameKo,'input')}${bilingualField('FIRST 상태','startStateEn','startStateKo',element.startStateEn,element.startStateKo)}${bilingualField('LAST 상태','endStateEn','endStateKo',element.endStateEn,element.endStateKo)}${bilingualField('분위기','moodEn','moodKo',element.moodEn,element.moodKo)}${bilingualField('두 프레임 사이의 움직임','movementEn','movementKo',element.movementEn,element.movementKo)}</article>`).join(''):`<div class="meta-elements-empty"><b>아직 분석된 요소가 없습니다</b><span>합성 이미지와 메타 프롬프트를 LLM에 전달한 뒤 JSON 결과를 붙여 넣어 주세요.</span></div>`;
  elementCards=`<div class="meta-elements-heading"><h4>04. 분석된 요소</h4><p>전환 계획에 따라 각 요소의 FIRST·LAST 상태와 움직임을 관리합니다.</p></div>${elementCards}`;
  return `<section class="meta-workspace"><header class="meta-title"><div><span>PROMPT WORKSPACE</span><h3>FLF 메타 프롬프트</h3><p>프레임 분석 전에는 요소가 생성되지 않습니다. 사용자 연출과 카메라 조건을 먼저 정리하세요.</p></div><button type="button" class="meta-collapse">접기</button></header><div class="meta-grid"><div class="meta-main"><label class="meta-direction"><span>연출 의도</span><textarea id="meta-direction" placeholder="두 프레임 사이에서 무엇이 어떻게 변해야 하는지 입력하세요.">${escapeAttr(meta.direction||'')}</textarea></label><section class="meta-camera"><h4>카메라 설정</h4><div class="meta-select-grid">${select('meta-shot-size','샷 크기',camera.shotSize,[['auto','이미지에서 자동 분석'],['wide','Wide Shot'],['medium','Medium Shot'],['close_up','Close-up'],['extreme_close_up','Extreme Close-up']])}${select('meta-angle','카메라 앵글',camera.angle,[['auto','이미지에서 자동 분석'],['eye_level','Eye Level'],['high','High Angle'],['low','Low Angle'],['overhead','Overhead'],['pov','POV']])}${select('meta-lens','렌즈',camera.lens,[['auto','이미지에서 자동 분석'],['normal','Normal'],['wide','Wide Angle'],['telephoto','Telephoto'],['anamorphic','Anamorphic'],['macro','Macro']])}${select('meta-composition','구도',camera.composition,[['auto','이미지에서 자동 분석'],['center','Center'],['thirds','Rule of Thirds'],['symmetry','Symmetrical'],['leading_lines','Leading Lines'],['negative_space','Negative Space']])}</div><span class="meta-label">카메라 움직임</span><div class="meta-movements">${cameraMovements.map(([value,label])=>`<label><input type="checkbox" data-camera-movement="${value}" ${movements.includes(value)?'checked':''}><span>${label}</span></label>`).join('')}</div><div class="meta-track ${movements.includes('tracking')?'':'hidden'}"><div class="meta-select-grid">${select('meta-track-target','추적할 오브젝트',camera.trackingTarget||'custom',trackOptions)}<label class="meta-control"><span>속도</span><select id="meta-camera-speed">${[['very_slow','Very Slow'],['slow','Slow'],['normal','Normal'],['fast','Fast']].map(([v,n])=>`<option value="${v}" ${camera.speed===v?'selected':''}>${n}</option>`).join('')}</select></label></div><label class="meta-control meta-track-custom ${camera.trackingTarget&&camera.trackingTarget!=='custom'?'hidden':''}"><span>추적 대상 설명</span><input id="meta-track-custom" value="${escapeAttr(camera.trackingCustom||'')}" placeholder="예: 붉은 우산을 든 인물"></label><label class="meta-control"><span>추적 방식</span><input id="meta-track-method" value="${escapeAttr(camera.trackingMethod||'')}"></label></div></section></div><aside class="meta-elements"><h4>분석된 요소</h4><p>LLM JSON 적용 후에만 표시됩니다.</p>${cameraResult}${elementCards}</aside></div><section class="meta-llm"><div class="meta-actions"><button type="button" class="button secondary meta-copy-image">합성 이미지 복사</button><button type="button" class="button primary meta-copy-prompt">메타 프롬프트 복사</button></div><label><span>LLM JSON 결과</span><textarea id="meta-json" placeholder="LLM에서 받은 JSON 결과를 여기에 붙여 넣으세요.">${escapeAttr(meta.llmJson||'')}</textarea></label><div class="meta-actions"><button type="button" class="button secondary meta-paste-json">클립보드에서 붙여넣기</button><button type="button" class="button primary meta-apply-json">JSON 적용</button></div>${meta.finalPromptEn?`<div class="meta-final"><header><b>생성된 최종 프롬프트</b><button type="button" class="button primary meta-apply-scene">씬 프롬프트에 적용</button></header><div class="meta-final-grid"><label><span>한국어 프롬프트 · 관리용</span><textarea id="meta-final-ko">${escapeAttr(meta.revisedPromptKo||'')}</textarea></label><label><span>English prompt · 생성용</span><textarea id="meta-final-en">${escapeAttr(meta.finalPromptEn)}</textarea></label></div></div>`:''}</section></section>`;
}

const icon = name => {
  const icons = {
    play: '<path d="m9 7 8 5-8 5V7Z"/>', spark: '<path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3Z"/><path d="m18 14 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7L18 14Z"/>',
    film: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 5v14M17 5v14M3 9h4m10 0h4M3 15h4m10 0h4"/>', grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="5" cy="6" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="5" cy="18" r="1"/>', settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>', pin: '<path d="m14 4 6 6-3 1-3 4 .5 3.5-1 1-4-4-4 4-1-1 4-4L3 10.5l1-1 3.5.5 4-3 1-3Z"/>', link: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1"/>', folder: '<path d="M3 6h7l2 2h9v10H3V6Z"/>', archive: '<path d="M4 7h16v13H4V7Z"/><path d="M3 4h18v4H3V4ZM9 12h6"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>', trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>', left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
};

function sidebar() { const pending=allJobs().filter(j=>['queued','running'].includes(j.status)).length,running=allJobs().some(j=>j.status==='running');return `<aside class="sidebar"><div class="brand"><div class="brand-mark">F</div><div><b>FrameFlow</b><small>STUDIO</small></div></div><nav aria-label="주 메뉴"><button class="nav-item ${page === 'projects' ? 'active' : ''}" data-nav="projects" title="프로젝트">${icon('grid')}<span>프로젝트</span></button><button class="nav-item ${page === 'video-video' ? 'active' : ''}" data-nav="video-video" title="Video-to-Video">${icon('film')}<span>Video-to-Video</span></button><button class="nav-item ${page === 'video-audio' ? 'active' : ''}" data-nav="video-audio" title="Video-to-Audio">${icon('play')}<span>Video-to-Audio</span></button><button class="nav-item ${page === 'frame-interpolation' ? 'active' : ''}" data-nav="frame-interpolation" title="프레임 보간">${icon('film')}<span>프레임 보간</span></button><button class="nav-item ${page === 'upscale' ? 'active' : ''}" data-nav="upscale" title="업스케일">${icon('spark')}<span>업스케일</span></button><button class="nav-item ${page === 'queue' ? 'active' : ''}" data-nav="queue" title="생성 큐">${icon('film')}<span>생성 큐</span>${pending?`<em>${pending}</em>`:''}</button><button class="nav-item ${page === 'settings' ? 'active' : ''}" data-nav="settings" title="설정">${icon('settings')}<span>설정</span></button></nav><div class="sidebar-bottom"><div class="connection ${comfyRuntimeOnline||running?'':'offline'}"><span></span><div><b>Comfy Desktop</b><small>${running?'생성 작업 실행 중':comfyRuntimeOnline?'실행 중 · 연결됨':'실행되지 않음'}</small></div></div></div></aside>`; }
function topbar(title = '') { return `<header class="topbar"><div class="breadcrumbs"><button class="crumb-projects">프로젝트</button>${title ? `<b>/</b><strong>${title}</strong>` : ''}</div></header>`; }

function cutCard(scene,cut){
  const project=currentProject(),selected=cut.selected,candidate=!selected?(cut.videoResults||[])[0]:null,preview=selected||candidate,prefix=mediaPrefix(project,scene.id,cut.id),latest=latestCutJob(project,cut),failure=latest?.status==='failed'?briefJobError(latest.error):'',resolution=projectResolution(project),ratio=resolution.width/resolution.height,selectedMeta=selected?`<span class="selected-video-info"><b>${escapeAttr(selected.type||'VIDEO')} · ${escapeAttr(selected.res||resolutionLabel(resolution))}</b><small>${escapeAttr(selected.date||selected.createdAt||'')}</small></span>`:candidate?`<span class="selected-video-info candidate"><b>후보 영상 · 대표 미선택</b><small>${candidate.cumulativeExtension?`누적 확장본 · 연결 ${candidate.contextFrames||22}프레임`:escapeAttr(candidate.createdAt||'')}</small></span>`:'',cutIndex=(scene.cuts||[]).findIndex(item=>item.uid===cut.uid);
  return `<article class="scene-card cut-card ${activeScene===scene.id&&activeCut===cut.id?'active':''}" data-scene="${scene.id}" data-cut="${cut.id}"><header class="scene-head"><div class="scene-number">C${String(cut.id).padStart(2,'0')}</div><div class="scene-title"><h3>${cut.name||`컷 ${String(cut.id).padStart(2,'0')}`}</h3></div><div class="order-controls cut-order-controls" aria-label="컷 순서 변경"><button type="button" class="order-button cut-order" data-scene="${scene.id}" data-cut="${cut.id}" data-direction="previous" title="이전으로 이동" aria-label="이전으로 이동" ${cutIndex<=0?'disabled':''}>${icon('left')}</button><button type="button" class="order-button cut-order" data-scene="${scene.id}" data-cut="${cut.id}" data-direction="next" title="다음으로 이동" aria-label="다음으로 이동" ${cutIndex===(scene.cuts||[]).length-1?'disabled':''}>${icon('right')}</button></div></header><code class="media-prefix">${prefix}</code><div class="scene-visuals" style="--cut-ratio:${ratio};--flf-ratio:${ratio*2}"><div class="flf-stack"><div class="frame first ${!cut.first?'missing':''}" style="background:${cut.first||'#eef0eb'}"><span>${cut.first?'FIRST':'+ FIRST'}</span></div><div class="flow-link">${icon('link')}<small>${cut.usePrevious?'이전 컷 연결':'직접 선택'}</small></div><div class="frame last ${!cut.last?'missing':''}" style="background:${cut.last||'#f1f1ed'}"><span>${cut.last?'LAST':'+ LAST'}</span></div></div><div class="selected-video ${selected?'':'empty'}" style="${selected?`background:${selected.color}`:''}">${selected?`<button class="play" title="대표 영상 재생">${icon('play')}</button>`:`<div class="empty-state">${icon('film')}<b>대표 영상 없음</b><small>${failure?'아래 실패 이유를 확인하세요':'생성 결과에서 대표 영상을 선택하세요'}</small></div>`}</div></div><div class="scene-info"><span>${cut.duration||project.duration}초</span>${selectedMeta}</div>${failure?`<div class="cut-generation-error"><b>최근 생성 실패</b><span>${escapeAttr(failure)}</span></div>`:''}<div class="scene-actions"><button class="button secondary copy-cut-prompt" data-scene="${scene.id}" data-cut="${cut.id}">${icon('spark')} 프롬프트 복사</button><button class="button secondary open-cut-images" data-scene="${scene.id}" data-cut="${cut.id}">${icon('folder')} 이미지 폴더 열기</button><button class="results">결과 ${(cut.videoResults||[]).length}개</button></div></article>`;
}
function cutCardWithCandidate(scene,cut){
  return cutCard(scene,cut);
}
function ref2vaCutCard(scene,cut){
  const state=ensureRef2vaState(cut),project=currentProject(),selected=cut.selected,candidate=!selected?(cut.videoResults||[])[0]:null,preview=selected,prefix=mediaPrefix(project,scene.id,cut.id),latest=latestCutJob(project,cut),failure=latest?.status==='failed'?briefJobError(latest.error):'',resolution=projectResolution(project),ratio=resolution.width/resolution.height,cutIndex=(scene.cuts||[]).findIndex(item=>item.uid===cut.uid),refs=[...state.pictures.map((item,index)=>({...item,kind:'picture',label:`Picture ${index+1}`})),...state.videos.map((item,index)=>({...item,kind:'video',label:`Video ${index+1}`}))],visibleRefs=refs.slice(0,4),more=Math.max(0,refs.length-visibleRefs.length);
  const referenceTiles=visibleRefs.length?visibleRefs.map(item=>`<div class="ref2va-card-reference ${item.kind}" ${item.kind==='picture'&&item.preview?`style="background-image:${item.preview}"`:''}>${item.kind==='video'?`<video muted playsinline preload="metadata" data-ref2va-card-video="${escapeAttr(item.path||'')}"></video>${icon('film')}`:''}<span>&lt;${item.label}&gt;</span></div>`).join(''):'<div class="ref2va-card-reference empty">'+icon('plus')+'<span>레퍼런스 없음</span></div>';
  const selectedMeta=selected?`<span class="selected-video-info"><b>${escapeAttr(selected.type||'VIDEO')} · ${escapeAttr(selected.res||resolutionLabel(resolution))}</b><small>${escapeAttr(selected.date||selected.createdAt||'')}</small></span>`:candidate?'<span class="selected-video-info candidate"><b>대표 미선택</b><small>생성 후보 영상</small></span>':'';
  return `<article class="scene-card cut-card ref2va-cut-card ${activeScene===scene.id&&activeCut===cut.id?'active':''}" data-scene="${scene.id}" data-cut="${cut.id}"><header class="scene-head"><div class="scene-number">C${String(cut.id).padStart(2,'0')}</div><div class="scene-title"><span class="ref2va-card-badge">REF2VA · IMAGE ${state.pictures.length} · VIDEO ${state.videos.length}</span><h3>${escapeAttr(cut.name||`컷 ${String(cut.id).padStart(2,'0')}`)}</h3></div><div class="order-controls cut-order-controls" aria-label="컷 순서 변경"><button type="button" class="order-button cut-order" data-scene="${scene.id}" data-cut="${cut.id}" data-direction="previous" title="이전으로 이동" ${cutIndex<=0?'disabled':''}>${icon('left')}</button><button type="button" class="order-button cut-order" data-scene="${scene.id}" data-cut="${cut.id}" data-direction="next" title="다음으로 이동" ${cutIndex===(scene.cuts||[]).length-1?'disabled':''}>${icon('right')}</button></div></header><code class="media-prefix">${prefix}</code><div class="scene-visuals ref2va-card-visuals" style="--cut-ratio:${ratio};--flf-ratio:${ratio*2}"><div class="ref2va-card-references">${referenceTiles}${more?`<b class="ref2va-card-more">+${more}</b>`:''}</div><div class="selected-video ${preview?'':'empty'}" style="${preview?`background:${preview.color||'linear-gradient(135deg,#245f57,#84d3b6 50%,#ffb78d)'}`:''}">${preview?`<button class="play" title="대표 영상 재생">${icon('play')}</button>`:`<div class="empty-state">${icon('film')}<b>${candidate?'대표 미선택':'대표 영상 없음'}</b><small>${failure?'아래 실패 이유를 확인하세요':candidate?'결과에서 대표 영상을 선택하세요':'Ref2VA 생성 결과가 없습니다'}</small></div>`}</div></div><div class="scene-info"><span>${cut.duration||project.duration}초 · Ref2VA</span>${selectedMeta}</div>${failure?`<div class="cut-generation-error"><b>최근 생성 실패</b><span>${escapeAttr(failure)}</span></div>`:''}<div class="scene-actions"><button class="button secondary copy-cut-prompt" data-scene="${scene.id}" data-cut="${cut.id}">${icon('spark')} 프롬프트 복사</button><button class="button secondary open-cut-images" data-scene="${scene.id}" data-cut="${cut.id}">${icon('folder')} 레퍼런스 폴더 열기</button><button class="results">결과 ${(cut.videoResults||[]).length}개</button></div></article>`;
}
function extensionCutCard(scene,cut){
  const state=cut.extension||{},candidate=!cut.selected?(cut.videoResults||[])[0]:null,preview=cut.selected,latest=latestCutJob(currentProject(),cut),failure=latest?.status==='failed'?briefJobError(latest.error):'',prefix=mediaPrefix(currentProject(),scene.id,cut.id),poster=state.poster||'',sourceLabel=`C${String(state.sourceCutId||Math.max(1,cut.id-1)).padStart(2,'0')} · ${state.sourceName||'원본 영상'}`;
  return `<article class="scene-card cut-card video-extension-cut ${activeScene===scene.id&&activeCut===cut.id?'active':''}" data-scene="${scene.id}" data-cut="${cut.id}"><header class="scene-head"><div class="scene-number">C${String(cut.id).padStart(2,'0')}</div><div class="scene-title"><span class="extension-card-badge">VIDEO EXTENSION · 22F LATENT</span><h3>${escapeAttr(cut.name||'비디오 확장')}</h3></div></header><code class="media-prefix">${prefix}</code><div class="extension-card-flow"><div class="extension-source-poster" style="${poster?`background-image:${poster}`:''}"><span>원본 FINAL 22F</span><b>${escapeAttr(sourceLabel)}</b></div><div class="flow-link">${icon('link')}<small>Context 01·05·10·22</small></div><div class="selected-video ${preview?'':'empty'}" style="${preview?`background:${preview.color||'linear-gradient(135deg,#245f57,#84d3b6 50%,#ffb78d)'}`:''}">${preview?`<button class="play" title="대표 영상 재생">${icon('play')}</button><span class="candidate-preview-badge">대표 영상</span>`:`<div class="empty-state">${icon('film')}<b>${candidate?'대표 미선택':'확장 영상 대기'}</b><small>${candidate?'결과에서 대표 영상을 선택하세요':state.contextAssets?.samples?.length===4?'LLM 프롬프트를 적용해 생성하세요':'22F 분석 이미지 준비 중'}</small></div>`}</div></div><div class="scene-info"><span>새 구간 ${cut.duration||5}초</span><span>${cut.lastPath?'LAST 사용':'LAST 없음'}</span></div>${failure?`<div class="cut-generation-error"><b>최근 생성 실패</b><span>${escapeAttr(failure)}</span></div>`:''}<div class="scene-actions"><button class="button secondary copy-cut-prompt" data-scene="${scene.id}" data-cut="${cut.id}">${icon('spark')} 프롬프트 복사</button><button class="results">결과 ${(cut.videoResults||[]).length}개</button></div></article>`;
}
function continuousVideoList(scene){
  const videos=Array.isArray(scene.continuousVideos)?[...scene.continuousVideos]:[];
  if(scene.continuousVideo&&!videos.some(item=>item.id===scene.continuousVideo.id||item.path===scene.continuousVideo.path))videos.unshift(scene.continuousVideo);
  return videos.sort((a,b)=>new Date(b.completedAt||b.createdAt||0)-new Date(a.completedAt||a.createdAt||0));
}
function selectedSceneContinuousVideo(scene){const videos=continuousVideoList(scene);return videos.find(item=>item.id===scene.selectedContinuousVideoId)||videos[0]||null;}
function registerSceneContinuousVideo(scene,video){
  const normalized={id:video.id||`continuous-${Date.now()}`,...video};
  const videos=continuousVideoList(scene).filter(item=>item.id!==normalized.id&&item.path!==normalized.path);
  scene.continuousVideos=[normalized,...videos];scene.selectedContinuousVideoId=normalized.id;scene.continuousVideo=normalized;return normalized;
}
function sceneContinuousPanel(scene){
  const videos=continuousVideoList(scene),selected=selectedSceneContinuousVideo(scene),count=videos.length;
  const player=selected?`<div class="scene-continuous-player"><video controls playsinline preload="metadata" data-scene-continuous="${scene.id}"></video><aside class="scene-continuous-meta"><div class="scene-continuous-primary-info"><span class="continuous-kind ${String(selected.type||'FINAL').toLowerCase()}">${escapeAttr(selected.type||'FINAL')}</span><b>${escapeAttr(selected.resolution||selected.res||'해상도 정보 없음')}</b><small>${escapeAttr(selected.createdAt||'최근 생성')} · ${Number(selected.generationSeconds)>0?`생성 ${formatClock(selected.generationSeconds)}`:`${Number(selected.cutCount)||scene.cuts?.length||0}개 컷`}</small></div><button type="button" class="button secondary open-continuous-folder" data-scene="${scene.id}" data-result="${escapeAttr(selected.id)}">${icon('folder')} 폴더 열기</button>${generationSpecBadges(selected)}${generationSpecDetails(selected)}</aside></div>`:`<div class="scene-continuous-empty">${icon('film')}<div><b>아직 연속 영상이 없습니다</b><small>연속 영상 생성 또는 테스트가 완료되면 이곳에서 바로 재생할 수 있습니다.</small></div></div>`;
  const history=count>1?`<div class="scene-continuous-history" aria-label="연속 영상 생성 기록">${videos.map((video,index)=>`<button type="button" class="continuous-history-item ${video.id===selected?.id?'selected':''}" data-scene="${scene.id}" data-result="${escapeAttr(video.id)}"><span>${escapeAttr(video.type||'FINAL')}</span><b>${escapeAttr(video.resolution||video.res||'-')}</b><small>${escapeAttr(video.createdAt||`결과 ${index+1}`)}</small></button>`).join('')}</div>`:'';
  return `<section class="scene-continuous-library"><header><div><span>SCENE CONTINUOUS VIDEO</span><h3>연속 영상</h3></div><strong>${count}개</strong></header>${player}${history}</section>`;
}
function ref2vaContinuousCutCard(scene,cut,index){
  const selected=cut.selected,prefix=mediaPrefix(currentProject(),scene.id,cut.id),ready=hasRef2vaPrompt(cut.promptEn),context=index===0?'공통 레퍼런스로 시작':'직전 컷의 마지막 22프레임 latent 연결';
  return `<article class="scene-card cut-card ref2va-chain-cut ${activeScene===scene.id&&activeCut===cut.id?'active':''}" data-scene="${scene.id}" data-cut="${cut.id}"><header class="scene-head"><div class="scene-number">C${String(cut.id).padStart(2,'0')}</div><div class="scene-title"><h3>${escapeAttr(cut.name||`컷 ${cut.id}`)}</h3><small>${context}</small></div><span class="chain-ready ${ready?'ready':''}">${ready?'프롬프트 준비':'LLM 필요'}</span></header><code class="media-prefix">${prefix}</code><div class="ref2va-chain-preview ${selected?'':'empty'}" style="${selected?`background:${selected.color}`:''}">${selected?`<button class="play" title="대표 영상 재생">${icon('play')}</button><span>${escapeAttr(selected.type||'VIDEO')} · ${escapeAttr(selected.res||'')}</span>`:`${icon('film')}<b>생성 영상 대기</b><small>${context}</small>`}</div><div class="cut-direction-preview"><b>컷 지시</b><p>${escapeAttr(ensureRef2vaState(cut).userDirection||'컷 편집에서 전체 연출 지시를 입력하세요.')}</p></div><div class="scene-actions"><button class="button secondary copy-cut-prompt" data-scene="${scene.id}" data-cut="${cut.id}">${icon('spark')} 프롬프트 복사</button><button class="results">결과 ${(cut.videoResults||[]).length}개</button></div></article>`;
}
function sceneCard(scene){
  const sceneCuts=scene.cuts||[],sceneIndex=scenes().findIndex(item=>item===scene),dedicated=isRef2vaContinuousScene(scene),content=sceneCuts.length?sceneCuts.map((cut,index)=>dedicated?ref2vaContinuousCutCard(scene,cut,index):isVideoExtensionCut(cut)?extensionCutCard(scene,cut):isRef2vaCut(cut)?ref2vaCutCard(scene,cut):cutCardWithCandidate(scene,cut)).join(''):`<div class="scene-empty-cuts">${icon('film')}<div><b>이 씬에 컷이 없습니다</b><small>첫 컷을 추가해 연출 지시를 작성하세요.</small></div><button class="button secondary add-cut" data-scene="${scene.id}">${icon('plus')} 첫 컷 추가</button></div>`,combined=!dedicated&&scene.combinedVideo?`<div class="scene-combined"><div class="scene-combined-heading"><div><b>S${String(scene.id).padStart(2,'0')} 영상 합본</b><small>${escapeAttr(scene.combinedVideo.createdAt||'최근 생성')}</small></div><div class="scene-combined-actions"><span>${sceneCuts.length}개 컷 연결</span><button type="button" class="button secondary open-scene-combined-folder" data-scene="${scene.id}">${icon('folder')} 합본 폴더 열기</button></div></div><video controls playsinline preload="metadata" data-scene-combined="${scene.id}"></video></div>`:'';
  const actions=dedicated?`<button class="button secondary scene-ref2va-llm" data-scene="${scene.id}">${icon('spark')} LLM 전체 프롬프트</button><button class="button secondary scene-ref2va-continuous-test" data-scene="${scene.id}">${icon('spark')} 연속 생성(테스트)</button><button class="button primary scene-ref2va-continuous" data-scene="${scene.id}">${icon('film')} 연속 생성</button><button class="button secondary add-cut" data-scene="${scene.id}">${icon('plus')} 컷 추가</button>`:`<button class="button primary scene-combine" data-scene="${scene.id}">${icon('film')} 영상 합본 생성</button><button class="button secondary add-cut" data-scene="${scene.id}">${icon('plus')} 컷 추가</button>`;
  return `<section class="scene-group ${dedicated?'ref2va-continuous-scene':''}" data-scene-group="${scene.id}"><header class="scene-group-head"><span class="scene-group-number">S${String(scene.id).padStart(2,'0')}</span><div class="scene-group-copy">${dedicated?'<span class="scene-type-badge">REF2VA · 22F LATENT CHAIN</span>':''}<h2>${scene.title}</h2><p>${scene.content||'씬 내용을 입력해 주세요.'}</p></div><div class="scene-bulk-actions">${actions}</div><div class="scene-head-tools"><div class="order-controls scene-order-controls" aria-label="씬 순서 변경"><button type="button" class="order-button scene-order" data-scene="${scene.id}" data-direction="previous" ${sceneIndex<=0?'disabled':''}>${icon('left')}</button><button type="button" class="order-button scene-order" data-scene="${scene.id}" data-direction="next" ${sceneIndex===scenes().length-1?'disabled':''}>${icon('right')}</button></div><button type="button" class="scene-settings-open" data-scene="${scene.id}" title="씬 정보 수정">${icon('settings')}</button></div></header>${sceneContinuousPanel(scene)}${combined}<div class="scene-cuts">${content}</div></section>`;
}

function resultMetadata(result,cut){
  return {
    duration:Number(result.duration||cut.duration||currentProject().duration||5),
    fps:Number(result.fps||COMFY_FPS),
    frames:Number(result.frames||comfyFrameLength(result.duration||cut.duration)),
    model:result.modelName||'WAN 2.2 14B FLF2V',
    backend:result.backend||'Comfy Desktop'
  };
}
function resultRow(scene,cut,result){
  const active=cut.selected?.id===result.id,meta=resultMetadata(result,cut),created=result.createdAt||'날짜 정보 없음',filename=result.path?.split(/[\\/]/).pop()||'웹 생성 결과';
  return `<article class="video-result-row ${active?'active':''}" data-result-row="${result.id}">
    <div class="video-result-media" data-preview-result="${result.id}"><video controls playsinline preload="metadata"></video><span class="result-badge ${String(result.type).toLowerCase()}">${result.type} · ${result.res}</span><span class="hover-video-hint">마우스를 올리면 전체 영상 반복 재생</span></div>
    <div class="video-result-content"><header><div><b>${active?'대표 영상':'생성 영상'}</b><span>${created}</span></div><details class="result-menu"><summary aria-label="결과 메뉴">···</summary><button type="button" class="delete-result" data-result="${result.id}">${icon('trash')} 삭제</button></details></header>
      <button type="button" class="result-file-location" data-result="${result.id}" title="${escapeAttr(result.path||filename)}">${icon('folder')}<span><b>${escapeAttr(filename)}</b><small>클릭하여 파일 위치 열기</small></span></button>
      <div class="result-prompts"><section><label>한국어 프롬프트</label><textarea readonly rows="6" spellcheck="false">${escapeAttr(result.promptKo||cut.promptKo||'저장된 한국어 프롬프트가 없습니다.')}</textarea></section><section><label>English prompt</label><textarea readonly rows="6" spellcheck="false">${escapeAttr(result.promptEn||cut.promptEn||'No saved English prompt.')}</textarea></section></div>
      ${generationSpecBadges(result)}<div class="result-core-meta"><span>${meta.duration}초</span><span>${meta.fps}fps · ${meta.frames}프레임</span><span>${result.generationSeconds?`생성 ${formatClock(result.generationSeconds)}`:'생성시간 기록 없음'}</span>${Number.isSafeInteger(Number(result.seed))?`<button type="button" class="copy-result-seed" data-seed="${result.seed}" title="Seed 복사">Seed ${result.seed} · 복사</button>`:'<span>Seed 기록 없음</span>'}</div>
      ${generationSpecDetails(result)}<details class="result-more"><summary>파일 정보 더보기</summary><dl><div><dt>파일</dt><dd>${escapeAttr(filename)}</dd></div><div><dt>생성 백엔드</dt><dd>${escapeAttr(meta.backend)}</dd></div><div><dt>해상도</dt><dd>${escapeAttr(result.res)}</dd></div><div><dt>시트</dt><dd>${result.sheetPath?`8프레임 간격 · ${result.sheetSamples||'자동'}장`:'생성되지 않음'}</dd></div></dl></details>
      <div class="result-primary-actions"><button type="button" class="button secondary ${active?'deselect-result':'select-result'}" data-result="${result.id}">${active?'대표 영상 해제':'대표 영상으로 선택'}</button><button type="button" class="button secondary extend-result-video" data-result="${result.id}" ${result.path?'':'disabled'}>${icon('link')} 비디오 확장</button><button type="button" class="button secondary save-result-as" data-result="${result.id}">${icon('folder')} 다른 이름으로 저장</button><button type="button" class="button secondary open-result-folder" data-result="${result.id}">${icon('folder')} 파일 위치 열기</button></div>
      <div class="result-analysis-actions"><button type="button" class="button primary open-result-analysis" data-result="${result.id}" ${result.sheetPath?'':'disabled'}>영상 분석 및 프롬프트 재생성</button></div>
    </div>
  </article>`;
}

const isVideoExtensionCut=cut=>cut?.generationMode==='video-extension'&&cut?.extension?.sourceVideoPath;
function generationModeMarkup(cut){
  if(isVideoExtensionCut(cut))return `<div class="field generation-mode-field extension-mode-locked"><label>생성 모드</label><div class="generation-mode-switch"><button type="button" class="active" disabled>${icon('link')} 비디오 확장 (MiniMax H3) · 고정</button></div><small class="field-help">지정된 원본 영상의 마지막 22프레임 latent에서 시작합니다. FIRST는 입력할 수 없고 LAST만 선택적으로 사용할 수 있습니다.</small></div>`;
  const ref=isRef2vaCut(cut);
  return `<div class="field generation-mode-field"><label>생성 모드</label><div class="generation-mode-switch" role="group" aria-label="컷 생성 모드"><button type="button" class="${ref?'':'active'}" data-generation-mode="flf">시작·끝 프레임 (FLF)</button><button type="button" class="${ref?'active':''}" data-generation-mode="ref2va">레퍼런스 기반 (Ref2VA)</button></div><small class="field-help">${ref?'이미지·인물·사물·영상 레퍼런스를 사용합니다. FIRST/LAST는 사용하지 않습니다.':'FIRST와 LAST를 고정해 기존 FLF 워크플로로 생성합니다.'}</small></div>`;
}
function ref2vaPanelMarkup(cut,scene=null){
  const shared=isRef2vaContinuousScene(scene),state=shared?ensureRef2vaContinuousScene(scene):ensureRef2vaState(cut);
  const pictures=state.pictures.map((item,index)=>`<article class="reference-item"><div class="reference-thumb" style="${item.preview?`background-image:${item.preview}`:''}"><b>Picture ${index+1}</b></div><div><strong>${escapeAttr(item.name||`Picture ${index+1}`)}</strong><input class="reference-role" data-ref-kind="picture" data-ref-index="${index}" value="${escapeAttr(item.role||'')}" placeholder="인물/사물의 역할 또는 설명"><small>&lt;Picture ${index+1}&gt;</small></div><button type="button" class="remove-reference" data-ref-kind="picture" data-ref-index="${index}" aria-label="레퍼런스 제거">${icon('trash')}</button></article>`).join('');
  const videos=state.videos.map((item,index)=>`<article class="reference-item"><div class="reference-thumb video">${icon('film')}<b>Video ${index+1}</b></div><div><strong>${escapeAttr(item.name||`Video ${index+1}`)}</strong><input class="reference-role" data-ref-kind="video" data-ref-index="${index}" value="${escapeAttr(item.role||'')}" placeholder="동작/포즈/카메라 등 참조 역할"><small>&lt;Video ${index+1}&gt; · ${Number(item.duration||0).toFixed(1)}초</small></div><button type="button" class="remove-reference" data-ref-kind="video" data-ref-index="${index}" aria-label="레퍼런스 제거">${icon('trash')}</button></article>`).join('');
  const audios=state.audios.map((item,index)=>`<article class="reference-item"><div class="reference-thumb audio">♪<b>Audio ${index+1}</b></div><div><strong>${escapeAttr(item.name||`Audio ${index+1}`)}</strong><input class="reference-role" data-ref-kind="audio" data-ref-index="${index}" value="${escapeAttr(item.role||'')}" placeholder="음색·보이스·환경음 참조 역할"><small>&lt;Audio ${index+1}&gt;</small></div><button type="button" class="remove-reference" data-ref-kind="audio" data-ref-index="${index}" aria-label="레퍼런스 제거">${icon('trash')}</button></article>`).join('');
  return `<div class="field ref2va-field ${shared?'shared-reference-field':''}"><div class="label-row"><label>${shared?'씬 공통 Ref2VA 레퍼런스':'Ref2VA 레퍼런스'}</label><small>이미지 ${state.pictures.length}/9 · 영상 ${state.videos.length}/3${shared?` · 오디오 ${state.audios.length}/3`:''}</small></div>${shared?'<div class="shared-reference-note">모든 컷에 같은 레퍼런스를 정확한 라벨 순서로 적용합니다.</div>':''}<div class="reference-actions"><button type="button" class="button secondary add-reference-images">${icon('plus')} 이미지 추가</button><button type="button" class="button secondary add-reference-video">${icon('plus')} 영상 추가</button>${shared?'<button type="button" class="button secondary add-reference-audio">+ 오디오 추가</button>':''}<label>이미지 처리<select class="ref-image-size"><option value="match" ${state.refImageSize==='match'?'selected':''}>출력 해상도에 맞춤 (권장)</option><option value="max" ${state.refImageSize==='max'?'selected':''}>최대 품질 (느림)</option></select></label></div><div class="reference-list">${pictures}${videos}${shared?audios:''}${!pictures&&!videos&&(!shared||!audios)?'<div class="reference-empty">레퍼런스 이미지·영상·오디오를 추가하세요.</div>':''}</div><div class="field"><label>${shared?'이 컷의 전체 연출 지시':'사용자 연출 지시'}</label><textarea class="ref2va-direction" placeholder="보존할 요소, 바꿀 요소, 동작·카메라·음향을 구체적으로 입력하세요.">${escapeAttr(shared?ensureRef2vaState(cut).userDirection:state.userDirection)}</textarea></div><button type="button" class="button primary open-ref2va-prompt">${icon('spark')} LLM Ref2VA 프롬프트 생성</button><small class="field-help">레퍼런스 보존·변경 지시와 컷 연출을 공식 6섹션에 함께 반영합니다.</small></div>`;
}

function kling26Instruction(scene,cut){
  const meta=sceneMeta(cut),ref=ensureRef2vaState(cut),steps=(meta.promptSteps||[]).filter(step=>String(step.instruction||'').trim()).map((step,index)=>`- 단계 ${index+1}${step.timeSeconds==null?'':` (${Number(step.timeSeconds).toFixed(1)}초부터)`}: ${String(step.instruction).trim()}`),directions=[cut.promptKo,meta.direction,meta.additionalDirection,ref.userDirection].map(value=>String(value||'').trim()).filter(Boolean),negativeDirections=[cut.kling26NegativePrompt,meta.negativeDirection,meta.negativePrompt].map(value=>String(value||'').trim()).filter(Boolean),extension=isVideoExtensionCut(cut)||Boolean(cut.usePrevious);
  return `You are performing a LOSSLESS FORMAT CONVERSION of an existing production prompt for Kling AI VIDEO 2.6. This is not a summarization task.

SOURCE ENGLISH PROMPT:
${String(cut.promptEn||'').trim()||'(empty)'}

USER DIRECTION AND SAVED PRODUCTION NOTES:
${directions.length?directions.map(value=>`- ${value}`).join('\n'):'- No additional user direction.'}
${steps.length?`\nUSER-DEFINED ACTION STAGES:\n${steps.join('\n')}`:''}

NEGATIVE PROMPT / UNWANTED RESULTS:
${negativeDirections.length?negativeDirections.map(value=>`- ${value}`).join('\n'):'- No negative prompt was supplied.'}

SHOT CONDITIONS:
- Duration: ${Number(cut.duration)||5} seconds.
- Generation input: ${cut.firstPath||cut.first?'FIRST image present':'FIRST image absent'}; ${cut.lastPath||cut.last?'LAST image present':'LAST image absent'}.
- Previous generated ending used as FIRST: ${cut.usePrevious?'yes':'no'}.

KLING 2.6 CONVERSION RULES:
1. Preserve every material fact from the source and user directions. Remove only section labels and truly redundant wording; never shorten by deleting production information.
2. The output must retain all subjects and environment elements, their exact appearance, material, screen position, geometry, composition, and preservation requirements.
3. Preserve the full ${Number(cut.duration)||5}-second duration, every event in chronological order, timing cues, action speed and intensity, spatial direction, causal relationships, and final settled state. Convert sectioned or shot-based input into fluent continuous prose without merging or dropping distinct events.
4. Preserve camera framing, lens, angle, movement or locked-camera restrictions, lighting changes, colors, materials, visual style, and scale. Never weaken repeated or absolute constraints such as perfectly static, exact, identical, or with every strike.
5. Treat uploaded FIRST/LAST images and the source video as visual truth. Describe how the existing state continues or changes; do not restart it with misleading words such as “Initially” when the action is already underway.
6. ${extension?'The first sentence of kling_2_6_prompt MUST state: “Continue seamlessly from the exact final frame of the source video.” Preserve continuity of motion, speed, lighting, composition, geometry, and sound across the boundary.':'Do not claim that a source video exists unless the source prompt explicitly supplies one.'}
7. Preserve synchronized diegetic ambience and every physical sound effect, including exactly which visible event triggers each sound. Preserve dialogue only when explicitly requested. Never add narration, singing, vocals, or background music unless explicitly requested.
8. Treat every NEGATIVE PROMPT / UNWANTED RESULTS item as a HIGH-PRIORITY transformation requirement that overrides ambiguous wording elsewhere. Convert every unwanted result into an explicit, affirmative production direction in kling_2_6_prompt whenever possible: for example, “camera movement” becomes “the camera remains completely locked,” “flicker” becomes “lighting remains temporally stable,” and “background music” becomes “the soundtrack consists exclusively of synchronized diegetic ambience and effects.” Verify that the final normal prompt cannot reasonably be interpreted as permitting any listed unwanted result. Do not merely copy the negative list and do not produce a separate negative-prompt result.
9. Do not invent or substitute characters, objects, actions, scene changes, camera movement, lighting, sound, music, logos, or text.
10. Write a detailed, direct, production-ready English prompt. Completeness is more important than brevity; target roughly 80-250 words when needed to preserve the source.

OUTPUT:
Return valid JSON only, with exactly this schema:
{"kling_2_6_prompt":"losslessly converted detailed English prompt with negative directions rewritten as positive production constraints"}`;
}
function kling26PromptMarkup(cut){return `<div class="field kling26-field"><div class="kling26-toolbar"><div><label>Kling 2.6 prompt</label><small>원문 정보 무손실 변환 · 부정 지시는 정상 문장의 긍정 제약으로 변환</small></div><div><button type="button" class="button secondary copy-kling26-instruction">${icon('spark')} LLM 지시문 복사</button><button type="button" class="button secondary paste-kling26-result">LLM 결과 붙여넣기</button></div></div><label>Kling 2.6 부정 프롬프트</label><textarea class="english kling26-negative-textarea" data-prompt="kling26-negative" placeholder="원하지 않는 움직임, 카메라, 피사체, 스타일, 음향 등을 입력하세요. LLM이 정상 프롬프트의 명확한 긍정 조건으로 변환합니다.">${escapeAttr(cut.kling26NegativePrompt||'')}</textarea><small class="field-help">LLM에 강한 금지 조건으로 전달되며 별도 결과가 아니라 아래 정상 프롬프트 문장에 반영됩니다.</small><textarea class="english kling26-textarea" data-prompt="kling26" placeholder="LLM 결과를 붙여넣거나 Kling 2.6 프롬프트를 직접 작성하세요.">${escapeAttr(cut.kling26Prompt||'')}</textarea><div class="count">${String(cut.kling26Prompt||'').trim()?String(cut.kling26Prompt).trim().split(/\s+/).length:0} words</div></div>`;}
async function copyKling26Instruction(scene,cut){
  if(!String(cut.promptEn||'').trim()){toast('먼저 기존 English prompt를 작성하거나 LLM 분석 결과를 적용해 주세요.',7000);return;}
  try{await navigator.clipboard.writeText(kling26Instruction(scene,cut));toast('Kling 2.6 변환용 LLM 지시문을 복사했습니다.');}catch(error){toast(`Kling 2.6 지시문 복사 실패: ${error.message||error}`,7000);}
}
async function pasteKling26Result(cut){
  try{const raw=await navigator.clipboard.readText();if(!String(raw||'').trim())throw new Error('클립보드가 비어 있습니다.');const parsed=parseLlmJson(raw),prompt=String(parsed.kling_2_6_prompt||parsed.kling26_prompt||'').trim();if(!prompt)throw new Error('kling_2_6_prompt 필드가 없습니다.');const words=prompt.split(/\s+/).filter(Boolean).length;if(words<40)throw new Error(`Kling 2.6 프롬프트가 지나치게 짧아 원문 정보가 누락될 수 있습니다. 현재 ${words}단어입니다.`);cut.kling26Prompt=prompt;save();renderPreservingEditorScroll();toast(`부정 지시까지 정상 문장으로 변환한 Kling 2.6 프롬프트 ${words}단어를 적용했습니다.`);}catch(error){toast(`LLM 결과 적용 실패: ${error.message||error}`,8000);}
}

function inspector(scene,cut){
  if(!scene||!cut)return `<aside class="inspector empty-inspector"><div>${icon('film')}<h3>첫 씬을 만들어보세요</h3><p>씬에는 하나 이상의 컷이 포함됩니다.</p><button class="button primary add-scene">${icon('plus')} 첫 씬 추가</button></div></aside>`;
  const model=effectiveModel(cut),history=cut.videoResults||[],testSize=resolutionLabel(testResolution(currentProject())),finalSize=resolutionLabel(projectResolution(currentProject())),latest=latestCutJob(currentProject(),cut),failure=latest?.status==='failed'?briefJobError(latest.error):'',nextSeed=Number.isSafeInteger(cut.nextGenerationSeed)?cut.nextGenerationSeed:COMFY_BASE_SEED;
  const resultPanel=`<div class="result-panel"><div class="selected-result-heading"><div><label>선택된 영상</label><small>${cut.selected?`${cut.selected.type} · ${cut.selected.res}`:'선택 없음'}</small></div><span>최종 빌드와 다음 컷 연결에 사용됩니다.</span></div>${cut.selected?`<div class="selected-result" data-selected-result="${cut.selected.id}" style="background:${cut.selected.color||'linear-gradient(135deg,#375f58,#91cdb8)'}"><span>${cut.selected.type} · ${cut.selected.res}</span></div>`:`<div class="selected-result empty">${failure?'최근 작업이 실패했습니다. 아래 이유를 확인하세요.':'아래 생성 영상에서 대표 영상을 선택하세요'}</div>`}${failure?`<div class="cut-generation-error inspector-error"><b>최근 생성 실패</b><span>${escapeAttr(failure)}</span></div>`:''}<div class="history-heading"><div><b>생성한 영상</b><small>최신순 · 영상에서 직접 재생할 수 있습니다.</small></div><span>${history.length}개</span></div>${history.length?`<div class="result-history youtube-results">${history.map(result=>resultRow(scene,cut,result)).join('')}</div>`:'<div class="result-history-empty">아직 생성한 영상이 없습니다.</div>'}</div>`;
  return `<aside class="inspector"><div class="inspector-head"><div><span>SCENE ${String(scene.id).padStart(2,'0')} · CUT ${String(cut.id).padStart(2,'0')}</span><h2>${cut.name||`컷 ${String(cut.id).padStart(2,'0')}`}</h2><small>${scene.title}</small></div><div class="scene-manage"><button data-cut-action="up" title="이전으로 이동" aria-label="이전으로 이동">${icon('left')}</button><button data-cut-action="down" title="다음으로 이동" aria-label="다음으로 이동">${icon('right')}</button><button data-cut-action="duplicate" title="컷 복제">⧉</button><button class="cut-delete" data-cut-action="delete" title="컷 삭제" aria-label="컷 삭제">${icon('trash')}</button></div></div><div class="field"><label>컷 제목</label><input id="cut-name" value="${escapeAttr(cut.name||'')}" placeholder="컷 제목"></div>${resultPanel}<div class="field"><label>길이</label><select id="scene-duration">${[1,5,8,10].map(value=>`<option value="${value}" ${Number(cut.duration)===value?'selected':''}>${value}초</option>`).join('')}</select><small class="field-help">최종 ${finalSize} · 테스트 ${testSize}</small></div><div class="field cut-seed-field"><div class="label-row"><label>생성 Seed</label><small>WAN · MiniMax-H3 · Ref2VA 공통</small></div><div class="cut-seed-control"><input id="cut-generation-seed" type="text" pattern="[0-9]+" value="${nextSeed}" inputmode="numeric" autocomplete="off"><button type="button" class="button secondary copy-cut-seed" data-seed="${nextSeed}">Seed 복사</button></div><small class="field-help">모든 생성에서 이 Seed를 그대로 사용합니다. 값을 직접 바꾸기 전에는 자동으로 증가하지 않습니다.</small></div><div class="field"><div class="label-row"><label>한국어 프롬프트</label><small>관리용</small></div><textarea data-prompt="ko">${cut.promptKo||''}</textarea></div><div class="field"><div class="label-row"><label>English prompt</label></div><textarea class="english" data-prompt="en">${cut.promptEn||''}</textarea><div class="count">${(cut.promptEn||'').length} / 1200</div></div>${kling26PromptMarkup(cut)}<div class="inspector-note"><span>✦</span><p><b>Comfy Desktop · 테스트 생성은 ${testSize}로 실행됩니다.</b><br>파일 접두사 ${mediaPrefix(currentProject(),scene.id,cut.id)}</p></div><div class="inspector-actions"><button class="button primary test-btn" data-scene="${scene.id}" data-cut="${cut.id}">${icon('spark')} 테스트 영상 생성</button></div></aside>`;
}

function projectSceneCovers(project){return (project.scenes||[]).map(scene=>{const cut=(scene.cuts||[])[0],background=cut?.first||cut?.last||cut?.selected?.color||`linear-gradient(135deg,#315f58,#9bd8bc 52%,#f3bf9b)`;return{title:scene.title||`씬 ${String(scene.id).padStart(2,'0')}`,background};});}
function mountProjectRollers(){clearInterval(projectRollTimer);projectRollTimer=null;}
function projectUpdatedTime(project){const explicit=Number(project.updatedAtMs);if(Number.isFinite(explicit)&&explicit>0)return explicit;const fromId=Number(String(project.id||'').match(/\d{12,}/)?.[0]||0);if(fromId>0)return fromId;const parsed=Date.parse(project.updatedAt||'');return Number.isFinite(parsed)?parsed:0;}
function orderedProjects(){return [...projects].sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned)||(Number.isFinite(Number(a.sortOrder))?Number(a.sortOrder):Number.MAX_SAFE_INTEGER)-(Number.isFinite(Number(b.sortOrder))?Number(b.sortOrder):Number.MAX_SAFE_INTEGER)||projectUpdatedTime(b)-projectUpdatedTime(a)||String(a.id).localeCompare(String(b.id)));}
async function persistProjectOrder(){localStorage.setItem('frameflow-projects-v1',JSON.stringify(projects.map(persistentProject)));if(nativeReady)await Promise.all(projects.map(project=>window.__TAURI__.core.invoke('save_project',{project:persistentProject(project)})));}
function renderProjects() {
  const visible=orderedProjects();document.querySelector('#app').innerHTML = `<div class="app-shell">${sidebar()}<main>${topbar()}<section class="projects-page"><div class="projects-heading"><div><div class="eyebrow">YOUR WORKSPACE</div><h1>프로젝트</h1><p>고정 프로젝트를 먼저, 지정한 순서와 최신 작업 순으로 표시합니다.</p></div><div class="heading-actions"><button class="button secondary import-project">프로젝트 가져오기</button><button class="button primary new-project">${icon('plus')} 새 프로젝트</button></div></div><div class="project-grid">${visible.map((p,index)=>{const covers=projectSceneCovers(p),cutCount=cuts(p).length,sameGroup=visible.filter(item=>!!item.pinned===!!p.pinned),groupIndex=sameGroup.findIndex(item=>item.id===p.id);return`<article class="project-card ${p.pinned?'pinned':''}" data-project-card="${p.id}"><div class="project-order-buttons" aria-label="프로젝트 순서 이동"><button type="button" class="project-order" data-project-order="${p.id}" data-direction="previous" title="앞으로 이동" aria-label="앞으로 이동" ${groupIndex<=0?'disabled':''}>${icon('left')}</button><button type="button" class="project-order" data-project-order="${p.id}" data-direction="next" title="뒤로 이동" aria-label="뒤로 이동" ${groupIndex===sameGroup.length-1?'disabled':''}>${icon('right')}</button></div><button class="project-open" data-project="${p.id}"><div class="project-cover" data-project-roll="${p.id}" data-roll-index="0"><span>${p.scenes.length} SCENES</span>${covers.length?covers.map((cover,index)=>`<div class="project-cover-frame ${index===0?'active':''}" style="background:${cover.background}"></div>`).join(''):`<div class="project-cover-frame active fallback"><b>${escapeAttr(p.name.charAt(0))}</b><small>아직 씬이 없습니다</small></div>`}</div><div class="project-card-body"><h3>${p.pinned?`<i class="project-pin-indicator" title="고정된 프로젝트">${icon('pin')}</i>`:''}${escapeAttr(p.name)}</h3><p>${escapeAttr(p.description || '설명이 없습니다.')}</p><div><span>씬 ${p.scenes.length} · 컷 ${cutCount}</span><small>${escapeAttr(p.updatedAt||'')}</small></div><code>${escapeAttr(p.projectPath||'')}</code></div></button><button class="project-delete" data-delete-project="${p.id}" title="프로젝트 삭제" aria-label="프로젝트 삭제">${icon('trash')}</button></article>`;}).join('')}<button class="project-card create-card new-project">${icon('plus')}<b>새 프로젝트 만들기</b><small>기본 폴더와 해상도를 설정하세요</small></button></div></section></main></div>${modalMarkup()}<div id="toast"></div>`;
  injectRecoveryQueue();bindCommon();mountProjectRollers();enhanceProjectMenus();bindProjectOrderButtons(); document.querySelectorAll('.new-project').forEach(b=>b.addEventListener('click',()=>{modal='project';renderProjects();})); document.querySelectorAll('[data-project]').forEach(b=>b.addEventListener('click',()=>openProject(b.dataset.project))); document.querySelectorAll('[data-pin-project]').forEach(b=>b.addEventListener('click',()=>toggleProjectPin(b.dataset.pinProject))); document.querySelectorAll('[data-backup-project]').forEach(b=>b.addEventListener('click',()=>backupProject(b.dataset.backupProject))); document.querySelectorAll('[data-delete-project]').forEach(b=>b.addEventListener('click',()=>deleteProject(b.dataset.deleteProject))); document.querySelector('.import-project')?.addEventListener('click',importProject); bindModal();
}

function enhanceProjectMenus(){
  document.querySelectorAll('[data-project-card]').forEach(card=>{const old=card.querySelector(':scope > .project-delete'),project=projects.find(item=>item.id===card.dataset.projectCard);if(!old||!project)return;old.insertAdjacentHTML('beforebegin',`<details class="project-menu"><summary title="프로젝트 메뉴" aria-label="프로젝트 메뉴">···</summary><div><button type="button" data-pin-project="${card.dataset.projectCard}">${icon('pin')} ${project.pinned?'고정 해제':'프로젝트 고정'}</button><button type="button" class="project-backup" data-backup-project="${card.dataset.projectCard}">${icon('archive')} 백업</button><button type="button" class="project-delete" data-delete-project="${card.dataset.projectCard}">${icon('trash')} 삭제</button></div></details>`);old.remove();});
}

function reindexProjectGroup(group){group.forEach((project,index)=>{project.sortOrder=index;});}
function bindProjectOrderButtons(){document.querySelectorAll('[data-project-order]').forEach(button=>button.addEventListener('click',async event=>{event.preventDefault();event.stopPropagation();const id=button.dataset.projectOrder,project=projects.find(item=>item.id===id);if(!project)return;const group=orderedProjects().filter(item=>!!item.pinned===!!project.pinned),index=group.findIndex(item=>item.id===id),targetIndex=button.dataset.direction==='previous'?index-1:index+1;if(index<0||targetIndex<0||targetIndex>=group.length)return;[group[index],group[targetIndex]]=[group[targetIndex],group[index]];reindexProjectGroup(group);await persistProjectOrder();renderProjects();toast(`${project.name} 프로젝트를 ${button.dataset.direction==='previous'?'앞':'뒤'}으로 이동했습니다.`);}));}
async function toggleProjectPin(id){const project=projects.find(item=>item.id===id);if(!project)return;const before=orderedProjects();project.pinned=!project.pinned;const pinned=before.filter(item=>item!==project&&item.pinned),unpinned=before.filter(item=>item!==project&&!item.pinned);if(project.pinned)pinned.unshift(project);else unpinned.unshift(project);reindexProjectGroup(pinned);reindexProjectGroup(unpinned);await persistProjectOrder();renderProjects();toast(project.pinned?'프로젝트를 목록 위에 고정했습니다.':'프로젝트 고정을 해제했습니다.');
}

function renderSettingsLegacy(){
  const tools=openartInfo.tools||[];
  document.querySelector('#app').innerHTML=`<div class="app-shell">${sidebar()}<main>${topbar('설정')}<section class="settings-page"><div class="projects-heading"><div><div class="eyebrow">APP SETTINGS</div><h1>설정</h1><p>영상 생성 엔진과 저장 위치, 영상 빌드 환경을 관리합니다.</p></div></div>
  <div class="settings-layout"><div class="settings-main"><section class="settings-card"><div class="settings-card-head"><div class="service-logo">OA</div><div><h2>OpenArt MCP</h2><p>이미지·영상 생성 모델과 OpenArt 라이브러리를 연결합니다.</p></div><span class="connection-badge ${openartInfo.connected?'online':''}">${openartInfo.connected?'연결됨':'연결 안 됨'}</span></div><div class="setting-row"><div><b>MCP 엔드포인트</b><small>OAuth 2.1 · Streamable HTTP</small></div><code>${openartInfo.endpoint}</code></div><div class="setting-row"><div><b>사용 가능한 도구</b><small>${openartInfo.connected?'모델·생성·라이브러리 도구를 동기화했습니다.':'연결 후 자동으로 조회됩니다.'}</small></div><strong>${openartInfo.toolCount}개</strong></div>${tools.length?`<div class="tool-chips">${tools.slice(0,8).map(t=>`<span>${t.name||'tool'}</span>`).join('')}</div>`:''}<div class="settings-actions">${openartInfo.connected?`<button class="button secondary refresh-openart">모델·도구 새로고침</button><button class="button danger disconnect-openart">연결 해제</button>`:`<button class="button primary connect-openart">OpenArt로 로그인</button>`}</div><div class="settings-message">${openartInfo.message}</div></section>
  <section class="settings-card"><div class="settings-card-head"><div class="service-logo">CF</div><div><h2>Comfy Desktop</h2><p>WAN 2.2 14B FLF2V + Lightx2v 4-step 워크플로를 실행합니다.</p></div><span class="connection-badge comfy-badge">확인 필요</span></div><div class="field"><label>영상 생성 엔진</label><select id="generation-backend"><option value="comfy" ${appSettings.generationBackend==='comfy'?'selected':''}>Comfy Desktop · WAN 2.2 FLF2V</option><option value="openart" ${appSettings.generationBackend==='openart'?'selected':''}>OpenArt MCP</option></select></div><div class="field"><label>ComfyUI 서버 주소</label><input id="comfy-url" value="${escapeAttr(appSettings.comfyUrl||'http://127.0.0.1:8188')}" placeholder="http://127.0.0.1:8188"></div><label class="choice-row"><input type="checkbox" id="show-comfy-console" ${appSettings.showComfyConsole?'checked':''}><span><b>Comfy 콘솔 창 표시</b><small>다음 자동 실행 또는 환경 재시작부터 Python 진행 로그를 별도 창에 출력합니다.</small></span></label><div class="setting-row"><div><b>길이 계산</b><small>사용자 설정 초 × 16fps, WAN 4n+1 규칙</small></div><strong>1초 = 17프레임</strong></div><div class="setting-row"><div><b>프롬프트 입력</b><small>영문 긍정 프롬프트만 전달</small></div><strong>Negative 없음</strong></div><div class="settings-actions"><button class="button secondary check-comfy">연결 확인</button></div><div class="settings-message comfy-message">Comfy Desktop에서 서버를 실행한 뒤 확인하세요.</div></section>
  <section class="settings-card"><div class="settings-card-head"><div class="service-logo folder">${icon('folder')}</div><div><h2>프로젝트 저장</h2><p>새 프로젝트에서 기본으로 사용할 미디어 폴더입니다.</p></div></div><div class="field"><label>프로젝트 기본 폴더</label><div class="folder-input"><input id="default-folder" value="${appSettings.defaultFolder||''}" placeholder="기본 프로젝트 폴더"><button class="choose-default-folder">${icon('folder')} 찾아보기</button></div></div><button class="button primary save-settings">설정 저장</button></section>
  <section class="settings-card"><div class="settings-card-head"><div class="service-logo ff">FF</div><div><h2>FFmpeg</h2><p>마지막 프레임 추출과 전체 영상 결합에 사용합니다.</p></div><span class="connection-badge">확인 필요</span></div><div class="field"><label>실행 경로</label><input id="ffmpeg-path" value="${appSettings.ffmpegPath||'ffmpeg'}"></div><div class="settings-actions"><button class="button secondary check-ffmpeg">설치 상태 확인</button></div><div class="settings-message ffmpeg-message">아직 확인하지 않았습니다.</div></section></div>
  <aside class="settings-help"><h3>연결 순서</h3><ol><li><span>1</span><p><b>OpenArt 로그인</b><small>브라우저에서 계정 권한을 승인합니다.</small></p></li><li><span>2</span><p><b>모델 동기화</b><small>지원 모델과 FLF 옵션을 가져옵니다.</small></p></li><li><span>3</span><p><b>프로젝트 생성</b><small>기본 폴더에 미디어 구조를 만듭니다.</small></p></li></ol><div class="security-note"><b>API 키가 필요 없습니다.</b><p>OAuth 토큰은 앱 내부에 보관하며 화면에 표시하지 않습니다.</p></div></aside></div></section></main></div><div id="toast"></div>`;
  const comfyUrlField=document.querySelector('#comfy-url')?.closest('.field');
  if(comfyUrlField){
    const options=comfyEnvironments.map(environment=>`<option value="${escapeAttr(environment.name)}" ${appSettings.comfyEnvironmentName===environment.name?'selected':''}>${environment.name}${environment.running?' · 실행 중':''}</option>`).join('');
    comfyUrlField.insertAdjacentHTML('beforebegin',`<div class="field"><label>Comfy 가상환경</label><select id="comfy-environment"><option value="" ${!appSettings.comfyEnvironmentName?'selected':''}>자동 선택 · 실행 중 환경 → 첫 번째 환경</option>${options}</select><small class="field-help">Comfy Desktop 설치 위치와 관계없이 사용자 설치 목록에서 찾습니다.</small></div>`);
    const actions=document.querySelector('.check-comfy')?.closest('.settings-actions');
    actions?.insertAdjacentHTML('beforeend','<button class="button secondary restart-comfy">선택 환경 재시작</button><button class="button secondary refresh-comfy-environments">환경 새로고침</button>');
  }
  bindCommon();bindSettings();
}

const formatStorageSize=bytes=>{const value=Number(bytes)||0;if(value>=1073741824)return`${(value/1073741824).toFixed(2)} GB`;if(value>=1048576)return`${(value/1048576).toFixed(1)} MB`;if(value>=1024)return`${(value/1024).toFixed(0)} KB`;return`${value} B`;};
function comfyModelListMarkup(){
  const rows=comfyModels.length?comfyModels.map((model,index)=>`<div class="comfy-model-row"><div><b>${escapeAttr(model.name||'model')}</b><small title="${escapeAttr(model.path||'')}">${escapeAttr(model.relativePath||model.path||'')}</small></div><span>${formatStorageSize(model.bytes)}</span><button type="button" class="button secondary copy-comfy-model" data-model-index="${index}">${icon('folder')} 파일 복사</button></div>`).join(''):'<div class="comfy-model-empty">선택한 Comfy 환경에서 모델 파일을 불러오는 중입니다.</div>';
  return `<section class="comfy-model-inventory"><header><div><b>모델 목록</b><small>모델은 환경 백업 ZIP에서 제외됩니다. 필요한 파일만 별도로 복사하세요.</small></div><div><button type="button" class="button secondary copy-comfy-model-list" ${comfyModels.length?'':'disabled'}>목록 복사</button><button type="button" class="button secondary refresh-comfy-models">새로고침</button></div></header><div class="comfy-model-list">${rows}</div></section>`;
}
function renderSettings(){
  document.querySelector('#app').innerHTML=`<div class="app-shell">${sidebar()}<main>${topbar('설정')}<section class="settings-page"><div class="projects-heading"><div><div class="eyebrow">APP SETTINGS</div><h1>설정</h1><p>Comfy Desktop 실행 환경과 프로젝트 저장 위치를 관리합니다.</p></div></div><div class="settings-layout"><div class="settings-main">
  <section class="settings-card"><div class="settings-card-head"><div class="service-logo">CF</div><div><h2>Comfy Desktop</h2><p>MiniMax-H3와 WAN 영상 생성에 사용할 환경을 관리합니다.</p></div><span class="connection-badge comfy-badge ${comfyRuntimeOnline?'online':''}">${comfyRuntimeOnline?'실행 중':'확인 필요'}</span></div><div class="field"><label>ComfyUI 서버 주소</label><input id="comfy-url" value="${escapeAttr(appSettings.comfyUrl||'http://127.0.0.1:8188')}" placeholder="http://127.0.0.1:8188"></div><label class="choice-row"><input type="checkbox" id="show-comfy-console" ${appSettings.showComfyConsole?'checked':''}><span><b>Comfy 콘솔 창 표시</b><small>다음 자동 실행 또는 환경 재시작부터 Python 진행 로그를 별도 창에 표시합니다.</small></span></label><div class="setting-row"><div><b>지원 생성 모델</b><small>각 생성 화면에서 모델과 품질을 선택합니다.</small></div><strong>MiniMax-H3 · WAN 2.2</strong></div><div class="setting-row"><div><b>길이 계산</b><small>MiniMax-H3 24fps · WAN 16fps</small></div><strong>모델별 자동 계산</strong></div><div class="settings-actions"><button class="button secondary check-comfy">연결 확인</button></div><div class="settings-message comfy-message">Comfy Desktop 실행 상태를 확인해 주세요.</div></section>
  <section class="settings-card"><div class="settings-card-head"><div class="service-logo folder">${icon('folder')}</div><div><h2>프로젝트 저장</h2><p>새 프로젝트에서 기본으로 사용할 미디어 폴더입니다.</p></div></div><div class="field"><label>프로젝트 기본 폴더</label><div class="folder-input"><input id="default-folder" value="${appSettings.defaultFolder||''}" placeholder="기본 프로젝트 폴더"><button class="choose-default-folder">${icon('folder')} 찾아보기</button></div></div><button class="button primary save-settings">설정 저장</button></section>
  <section class="settings-card"><div class="settings-card-head"><div class="service-logo ff">FF</div><div><h2>FFmpeg</h2><p>마지막 프레임 추출과 영상 Sheet 생성에 사용합니다.</p></div><span class="connection-badge">확인 필요</span></div><div class="field"><label>실행 경로</label><input id="ffmpeg-path" value="${appSettings.ffmpegPath||'ffmpeg'}"></div><div class="settings-actions"><button class="button secondary check-ffmpeg">설치 상태 확인</button></div><div class="settings-message ffmpeg-message">아직 확인하지 않았습니다.</div></section></div>
  <aside class="settings-help"><h3>실행 순서</h3><ol><li><span>1</span><p><b>Comfy 환경 확인</b><small>실행 중인 환경을 우선 사용합니다.</small></p></li><li><span>2</span><p><b>FLF 준비</b><small>FIRST와 LAST 이미지를 업로드합니다.</small></p></li><li><span>3</span><p><b>생성 큐 실행</b><small>여러 컷을 순서대로 처리합니다.</small></p></li></ol><div class="security-note"><b>로컬 생성 전용</b><p>영상 생성은 Comfy Desktop에서 처리됩니다.</p></div></aside></div></section></main></div><div id="toast"></div>`;
  const comfyUrlField=document.querySelector('#comfy-url')?.closest('.field');if(comfyUrlField){const options=comfyEnvironments.map(environment=>`<option value="${escapeAttr(environment.name)}" ${appSettings.comfyEnvironmentName===environment.name?'selected':''}>${environment.name}${environment.running?' · 실행 중':''}</option>`).join('');comfyUrlField.insertAdjacentHTML('beforebegin',`<div class="field"><label>Comfy 가상환경</label><select id="comfy-environment"><option value="" ${!appSettings.comfyEnvironmentName?'selected':''}>자동 선택 · 실행 중 환경 → 첫 번째 환경</option>${options}</select><small class="field-help">설치 위치와 관계없이 사용자 환경 목록에서 찾습니다.</small></div>`);document.querySelector('.check-comfy')?.closest('.settings-actions')?.insertAdjacentHTML('beforeend','<button class="button secondary restart-comfy">선택 환경 재시작</button><button class="button secondary refresh-comfy-environments">환경 새로고침</button><button class="button secondary backup-comfy-environment">Comfy 환경 백업</button>');comfyUrlField.closest('.settings-card')?.insertAdjacentHTML('beforeend',comfyModelListMarkup());}
  bindCommon();bindSettings();
}

const videoAudioResolution=(source,mode)=>{
  const original={width:Number(source?.width)||1280,height:Number(source?.height)||720},align=value=>Math.max(32,Math.round(value/32)*32);
  if(mode==='original')return{width:align(original.width),height:align(original.height),label:'원본'};
  if(mode==='quarter')return{width:align(original.width/4),height:align(original.height/4),label:'1/4'};
  const target=mode==='0.25mp'?250000:mode==='0.1mp'?100000:50000,scale=Math.sqrt(target/(original.width*original.height));
  return{width:align(original.width*scale),height:align(original.height*scale),label:mode==='0.25mp'?'0.25MP':mode==='0.1mp'?'0.1MP':'0.05MP'};
};
const videoAudioMediaUrl=path=>path&&isTauri()?window.__TAURI__.core.convertFileSrc(path):'';
function videoAudioResolutionDialog(source,preferredBackgroundMusic=false){
  return new Promise(resolve=>{
    const choices=[['0.05mp','0.05MP','가장 빠른 작동·오디오 방향 확인용'],['0.1mp','0.1MP','낮은 해상도 장면 동기화 테스트'],['0.25mp','0.25MP','장면 정보와 처리 속도의 균형'],['quarter','1/4','원본 가로·세로를 각각 1/4로 축소'],['original','원본','원본 비율을 유지한 32배수 해상도']];
    const segmentCount=videoAudioWorkspace.audioPromptDraft?.result?.segments?.length||1;
    const overlay=document.createElement('div');
    overlay.className='action-dialog-backdrop';
    overlay.innerHTML=`<section class="action-dialog vta-resolution-dialog" role="dialog" aria-modal="true"><header><span>MINIMAX-H3 REF2VA</span><h2>오디오 생성 설정</h2><p>전체 ${formatClock(source.duration)} · ${segmentCount}개 구간(각 149초 이하) · 최종 MP4는 원본 전체 영상을 유지합니다.</p></header><h3 class="minimax-option-heading">H3 모델</h3><div class="minimax-profile-options">${minimaxModelModeOptions()}</div><h3 class="minimax-option-heading">샘플링 방식</h3><div class="minimax-profile-options">${minimaxProfileOptions(DEFAULT_MINIMAX_PROFILE,true)}</div><h3 class="minimax-option-heading">2-pass 잠재 업스케일</h3><div class="minimax-profile-options">${latentUpscaleModeOptions()}</div><p class="minimax-profile-note">영상 latent만 확대하고 오디오 latent는 보존합니다. Split/Tiled 방식은 사용하지 않습니다.</p><label class="generation-source-option minimax-music-option"><input type="checkbox" class="minimax-background-music" ${preferredBackgroundMusic?'checked':''}><span><b>배경음악 포함</b><small>기본 사용 안 함 · LLM 설계 화면의 선택을 이어받습니다. 꺼두면 환경음·음향효과만 생성하고 non_diegetic_music은 N/A로 고정합니다.</small></span></label><h3 class="minimax-option-heading">처리 해상도</h3><div class="minimax-profile-options vta-resolution-options">${choices.map(([value,title,help])=>{const size=videoAudioResolution(source,value);return`<label class="minimax-profile-option"><input type="radio" name="vta-resolution" value="${value}" ${value==='0.05mp'?'checked':''}><span><b>${title} · ${size.width}×${size.height}</b><small>${help}</small></span></label>`;}).join('')}</div><label class="vta-fade-setting"><span><b>구간 페이드</b><small>각 구간 마지막 fade-out · 두 번째부터 처음 fade-in · 오디오 겹침 없음</small></span><input type="number" class="vta-fade-seconds" min="0" max="10" step="0.1" value="2"><em>초</em></label><footer><button type="button" class="button secondary vta-resolution-cancel">취소</button><button type="button" class="button primary vta-resolution-confirm">${icon('spark')} Video-to-Audio 생성</button></footer></section>`;
    document.body.append(overlay);
    const finish=value=>{overlay.remove();resolve(value);};
    overlay.querySelector('.vta-resolution-confirm').addEventListener('click',()=>{
      const fadeSeconds=Number(overlay.querySelector('.vta-fade-seconds').value);
      if(!Number.isFinite(fadeSeconds)||fadeSeconds<0||fadeSeconds>10){toast('페이드 길이는 0~10초로 입력해 주세요.');return;}
      finish({mode:overlay.querySelector('[name="vta-resolution"]:checked')?.value||'0.05mp',fadeSeconds,modelMode:overlay.querySelector('[name="minimax-model-mode"]:checked')?.value||'default',profile:overlay.querySelector('[name="minimax-profile"]:checked')?.value||DEFAULT_MINIMAX_PROFILE,latentUpscaleMode:overlay.querySelector('[name="latent-upscale-mode"]:checked')?.value||'off',backgroundMusic:overlay.querySelector('.minimax-background-music').checked});
    });
    overlay.querySelector('.vta-resolution-cancel').addEventListener('click',()=>finish(null));
  });
}
function videoAudioResultCard(result){
  const audioUrl=videoAudioMediaUrl(result.audioPath),videoUrl=videoAudioMediaUrl(result.videoPath),created=escapeAttr(result.createdAt||''),name=escapeAttr(result.sourceName||'참조 영상');
  return `<article class="vta-result-card"><header><div><span>REF2VA AUDIO</span><h3>${name}</h3><p>${created} · ${escapeAttr(result.resolution||'')} · ${(result.segments||[]).length||1}개 구간${result.fadeSeconds!=null?` · ${result.fadeSeconds}초 페이드`:''}</p></div><span class="vta-result-status">완료</span></header><div class="vta-result-media-grid"><button type="button" class="vta-media-card audio" data-vta-play="audio"><span>MP3</span><b>생성 오디오</b><audio preload="metadata" src="${escapeAttr(audioUrl)}"></audio><small>${escapeAttr(result.audioFilename||'')}</small></button><button type="button" class="vta-media-card video" data-vta-play="video"><span>MP4 · CRF 15</span><b>원본 전체 영상 + 생성 오디오</b><video preload="metadata" playsinline src="${escapeAttr(videoUrl)}"></video><small>${escapeAttr(result.videoFilename||'')}</small></button></div>${generationSpecBadges(result)}${generationSpecDetails(result)}${(result.segments||[]).length?`<details class="vta-result-prompt"><summary>구간별 생성 파일</summary>${result.segments.map(segment=>`<div class="vta-segment-files"><span>구간 ${segment.index} · ${formatClock(segment.startSeconds)}–${formatClock(segment.endSeconds)}</span><button type="button" class="vta-open-file" data-path="${escapeAttr(segment.generatedPath||segment.audioPath||'')}">${icon('folder')} ${escapeAttr(String(segment.generatedPath||segment.audioPath||'segment.mp3').split(/[\\/]/).pop())}</button><button type="button" class="vta-open-file" data-path="${escapeAttr(segment.referencePath||'')}">${icon('folder')} ${escapeAttr(String(segment.referencePath||'reference.mp4').split(/[\\/]/).pop())}</button></div>`).join('')}</details>`:''}<details class="vta-result-prompt"><summary>사용한 프롬프트</summary><p>${escapeAttr(result.prompt||'')}</p></details><footer><button type="button" class="button secondary vta-open-file" data-path="${escapeAttr(result.audioPath||'')}">${icon('folder')} MP3 파일 위치</button><button type="button" class="button secondary vta-open-file" data-path="${escapeAttr(result.videoPath||'')}">${icon('folder')} MP4 파일 위치</button></footer></article>`;
}
function videoAudioResultPaths(result){return [...new Set([result.audioPath,result.videoPath,...(result.segments||[]).flatMap(item=>[item.generatedPath,item.audioPath,item.referencePath])].filter(Boolean))];}
async function deleteVideoAudioResults(ids){
  const targets=(videoAudioWorkspace.results||[]).filter(result=>ids.has(result.id));
  if(!targets.length){toast('삭제할 결과를 선택해 주세요.');return;}
  if(!await confirmDestructive({title:`Video-to-Audio 결과 ${targets.length}개를 삭제하시겠습니까?`,target:'생성 오디오와 합성 영상',message:'결과 목록과 실제 MP3·MP4·구간 파일이 함께 삭제됩니다.',confirmLabel:'결과 삭제'}))return;
  const removed=[];
  try{
    for(const result of targets){
      const root=result.projectPath||currentProject()?.projectPath;
      if(isTauri())await window.__TAURI__.core.invoke('delete_result_assets',{projectPath:root,paths:videoAudioResultPaths(result)});
      removed.push(result.id);
    }
    const done=new Set(removed);videoAudioWorkspace.results=(videoAudioWorkspace.results||[]).filter(result=>!done.has(result.id));for(const id of done)videoAudioResultSelection.delete(id);saveVideoAudio();renderVideoAudio();toast(`${removed.length}개 결과를 삭제했습니다.`);
  }catch(error){toast(`결과 삭제 실패: ${error.message||error}`,9000);}
}
function bindVideoAudioResultManagement(){
  const results=videoAudioWorkspace.results||[],header=document.querySelector('.vta-results>header');
  if(results.length)header?.insertAdjacentHTML('beforeend',`<div class="vta-result-toolbar"><label><input type="checkbox" class="vta-result-all" ${videoAudioResultSelection.size===results.length?'checked':''}> 전체 선택</label><button class="button secondary vta-delete-selected">선택 삭제</button><button class="button danger vta-delete-all">전체 삭제</button></div>`);
  document.querySelectorAll('.vta-result-card').forEach((card,index)=>{const result=results[index];if(!result)return;card.querySelector('header')?.insertAdjacentHTML('afterbegin',`<label class="vta-result-select"><input type="checkbox" data-vta-result-check="${escapeAttr(result.id)}" ${videoAudioResultSelection.has(result.id)?'checked':''}><span>선택</span></label>`);card.insertAdjacentHTML('beforeend',`<button type="button" class="button danger vta-delete-result" data-result="${escapeAttr(result.id)}">${icon('trash')} 삭제</button>`);});
  document.querySelector('.vta-result-all')?.addEventListener('change',event=>{videoAudioResultSelection=event.target.checked?new Set(results.map(result=>result.id)):new Set();renderVideoAudio();});
  document.querySelectorAll('[data-vta-result-check]').forEach(input=>input.addEventListener('change',()=>{input.checked?videoAudioResultSelection.add(input.dataset.vtaResultCheck):videoAudioResultSelection.delete(input.dataset.vtaResultCheck);renderVideoAudio();}));
  document.querySelector('.vta-delete-selected')?.addEventListener('click',()=>deleteVideoAudioResults(new Set(videoAudioResultSelection)));
  document.querySelector('.vta-delete-all')?.addEventListener('click',()=>deleteVideoAudioResults(new Set(results.map(result=>result.id))));
  document.querySelectorAll('.vta-delete-result').forEach(button=>button.addEventListener('click',()=>deleteVideoAudioResults(new Set([button.dataset.result]))));
}
function renderVideoAudio(){
  const source=videoAudioWorkspace.source,active=(videoAudioWorkspace.jobs||[]).filter(job=>['queued','running'].includes(job.status)),recent=[...(videoAudioWorkspace.jobs||[])].reverse().slice(0,6),project=currentProject();
  document.querySelector('#app').innerHTML=`<div class="app-shell">${sidebar()}<main>${topbar('Video-to-Audio')}<section class="vta-page"><header class="vta-hero"><div><div class="eyebrow">MINIMAX-H3 REF2VA</div><h1>Video-to-Audio</h1><p>영상의 장면·전환·리듬을 참조해 새 사운드트랙을 만들고 원본 MP4에 합성합니다.</p><div class="vta-save-location">${icon('folder')}<span><b>${escapeAttr(project?.name||'프로젝트 없음')}</b><small>${escapeAttr(project?.projectPath?joinPath(project.projectPath,'audio','video-to-audio'):'프로젝트 저장 폴더를 먼저 지정해 주세요.')}</small></span></div></div></header><div class="vta-workspace"><section class="vta-input-card"><div class="vta-section-heading"><span>01</span><div><h2>참조 MP4</h2><p>영상 길이와 원본 FPS를 자동으로 읽고 Ref2VA용 24fps로 처리합니다.</p></div></div>${source?`<button type="button" class="vta-source selected choose-vta-video"><div class="vta-source-icon">${icon('film')}</div><span><b>${escapeAttr(source.filename)}</b><small>${source.width}×${source.height} · ${formatClock(source.duration)} · ${Number(source.fps||0).toFixed(2)}fps · ${Number(source.megapixels||0).toFixed(2)}MP</small></span><em>변경</em></button>`:`<button type="button" class="vta-source choose-vta-video">${icon('plus')}<span><b>MP4 파일 선택</b><small>영상 길이·FPS·해상도를 자동으로 확인합니다.</small></span></button>`}<div class="vta-section-heading prompt"><span>02</span><div><h2>오디오 프롬프트</h2><p>음악·환경음·효과음의 분위기와 장면 동기화 방식을 작성하세요.</p></div></div><textarea id="vta-prompt" placeholder="예: 저역의 느린 코드 진행을 유지하고, 주요 장면 전환에만 짧은 고역 임팩트를 추가한다.">${escapeAttr(videoAudioWorkspace.prompt||'')}</textarea><div class="vta-prompt-help"><span>장면별 지시 예시</span><code>[Shot 2] At 00:03.500, a brief high-frequency impact accent occurs.</code></div><button type="button" class="button primary vta-generate" ${source&&project?.projectPath?'':'disabled'}>${icon('spark')} Audio 생성</button></section><aside class="vta-queue-card"><header><div><span>GENERATION QUEUE</span><h2>Video-to-Audio 생성 큐</h2></div><strong>${active.length}</strong></header>${recent.length?`<div class="vta-job-list">${recent.map(job=>`<article class="${job.status}"><span></span><div><b>${escapeAttr(job.sourceName||'MP4')}</b><small>${escapeAttr(job.projectName||'프로젝트 미지정')} · ${job.currentSegment?`구간 ${job.currentSegment}/${job.segments?.length||1} · `:''}${escapeAttr(job.resolution||'')} · ${formatClock(job.duration||0)} · ${{queued:'대기',running:'생성 중',completed:'완료',failed:'실패',interrupted:'중단'}[job.status]||job.status}</small>${job.error?`<em>${escapeAttr(briefJobError(job.error))}</em>`:''}</div>${['failed','interrupted','cancelled'].includes(job.status)?`<button type="button" class="vta-retry" data-job="${job.id}">재시도</button>`:''}</article>`).join('')}</div>`:'<div class="vta-empty-queue">대기 중인 작업이 없습니다.</div>'}</aside></div><section class="vta-results"><header><div><span>OUTPUT LIBRARY</span><h2>생성 결과</h2></div><strong>${(videoAudioWorkspace.results||[]).length}개</strong></header><div class="vta-results-grid">${(videoAudioWorkspace.results||[]).length?(videoAudioWorkspace.results||[]).map(videoAudioResultCard).join(''):'<div class="vta-empty-results">MP3와 합성 MP4가 여기에 카드로 표시됩니다.</div>'}</div></section></section></main></div><div id="toast"></div>`;
  bindVideoAudioResultManagement();
  document.querySelector('#vta-prompt').insertAdjacentHTML('beforebegin',`<button type="button" class="button secondary vta-open-prompt-studio" ${source?'':'disabled'}>${icon('spark')} LLM 프롬프트 생성</button>`);
  if(videoAudioWorkspace.promptKo)document.querySelector('#vta-prompt').insertAdjacentHTML('afterend',`<details class="vta-prompt-ko-summary"><summary>최종 한국어 프롬프트 보기</summary><p>${escapeAttr(videoAudioWorkspace.promptKo)}</p></details>`);
  document.querySelector('.vta-open-prompt-studio').addEventListener('click',()=>openVideoAudioPromptStudio({workspace:videoAudioWorkspace,save:saveVideoAudio,notify:toast,onApply:renderVideoAudio,invoke:(command,args)=>{
    if(!isTauri())return Promise.reject(new Error('프레임 시트 추출은 데스크톱 앱에서 사용할 수 있습니다.'));
    return window.__TAURI__.core.invoke(command,{...args,...(command==='generate_vta_frame_sheets'?{executable:appSettings.ffmpegPath||'ffmpeg'}:{})});
  }}));
  bindCommon();document.querySelectorAll('.choose-vta-video').forEach(button=>button.addEventListener('click',chooseVideoAudioSource));document.querySelector('#vta-prompt')?.addEventListener('input',event=>{videoAudioWorkspace.prompt=event.target.value;videoAudioWorkspace.promptKo='';document.querySelector('.vta-prompt-ko-summary')?.remove();saveVideoAudio();});document.querySelector('.vta-generate')?.addEventListener('click',queueVideoAudioGeneration);document.querySelectorAll('.vta-retry').forEach(button=>button.addEventListener('click',()=>retryJob(button.dataset.job)));document.querySelectorAll('.vta-open-file').forEach(button=>button.addEventListener('click',()=>openVideoAudioFile(button.dataset.path)));document.querySelectorAll('[data-vta-play]').forEach(button=>button.addEventListener('click',event=>{if(event.target.closest('audio,video'))return;const media=button.querySelector(button.dataset.vtaPlay);if(!media)return;if(media.paused){document.querySelectorAll('.vta-media-card audio,.vta-media-card video').forEach(item=>{if(item!==media)item.pause();});media.play().catch(()=>{});button.classList.add('playing');}else{media.pause();button.classList.remove('playing');}}));
}
async function chooseVideoAudioSource(){
  if(!isTauri()){toast('MP4 선택은 데스크톱 앱에서 사용할 수 있습니다.');return;}
  const path=await window.__TAURI__.dialog.open({multiple:false,title:'Video-to-Audio 참조 MP4 선택',filters:[{name:'MP4 Video',extensions:['mp4']}]});if(!path)return;
  try{toast('영상 정보를 확인하는 중…',120000);const nextSource=await window.__TAURI__.core.invoke('probe_video',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:path});if(videoAudioWorkspace.source?.path!==nextSource.path&&videoAudioWorkspace.promptKo){videoAudioWorkspace.prompt='';videoAudioWorkspace.promptKo='';}videoAudioWorkspace.source=nextSource;saveVideoAudio();render();toast('참조 MP4를 불러왔습니다.');}catch(error){toast(`MP4 불러오기 실패: ${error.message||error}`,8000);}
}
async function queueVideoAudioGeneration(){
  const source=videoAudioWorkspace.source,prompt=String(document.querySelector('#vta-prompt')?.value||videoAudioWorkspace.prompt||'').trim(),project=currentProject();
  if(!source){toast('참조 MP4를 선택해 주세요.');return;}if(!project?.projectPath){toast('현재 프로젝트의 저장 폴더를 먼저 지정해 주세요.');return;}if(!prompt){toast('오디오 프롬프트를 입력해 주세요.');return;}
  const duration=Number(source.duration)||0,frames=minimaxFrameLength(duration),design=videoAudioWorkspace.audioPromptDraft?.result;
  if(duration<.2){toast('0.2초 이상의 MP4를 선택해 주세요.');return;}
  if(duration>REF2VA_MAX_SECONDS&&(!design||design.version!==5||!Array.isArray(design.segments))){toast(`149초를 초과한 영상은 LLM 사운드트랙 설계에서 상세 영상 설명이 포함된 구간 JSON을 먼저 적용해 주세요.`,9000);return;}
  const preferredBackgroundMusic=videoAudioWorkspace.audioPromptDraft?.backgroundMusic===true;
  const setting=await videoAudioResolutionDialog(source,preferredBackgroundMusic);if(!setting)return;const {mode,fadeSeconds,profile,modelMode,latentUpscaleMode,backgroundMusic}=setting,size=videoAudioResolution(source,mode),upscalePlan=latentUpscalePlan(size,latentUpscaleMode),stamp=new Date().toISOString().replace(/[:.]/g,'-'),paths=buildVideoAudioProjectPaths({project,sourceName:source.filename,mode,stamp}),seed=Date.now()%Number.MAX_SAFE_INTEGER;
  if(design&&!!design.background_music_enabled!==!!backgroundMusic){toast('LLM 설계의 배경음악 설정과 생성 설정이 다릅니다. LLM 프롬프트 생성에서 옵션을 맞춘 뒤 JSON을 다시 적용해 주세요.',9000);return;}
  const sourceSegments=design?.version===5&&Array.isArray(design.segments)?design.segments:[{index:1,start_seconds:0,end_seconds:duration,prompt_ko:videoAudioWorkspace.promptKo||prompt,prompt_en:prompt}];
  if(sourceSegments.some((segment,index)=>segment.end_seconds-segment.start_seconds>REF2VA_MAX_SECONDS+.001||(index>0&&fadeSeconds*2>=segment.end_seconds-segment.start_seconds))){toast('모든 구간은 149초 이하이고, 두 번째 이후 구간은 페이드 길이의 2배보다 길어야 합니다.',9000);return;}
  const vocals=videoAudioWorkspace.audioPromptDraft?.vocals===true,segments=sourceSegments.map((segment,index)=>({index:index+1,startSeconds:segment.start_seconds,endSeconds:segment.end_seconds,duration:segment.end_seconds-segment.start_seconds,promptKo:assembleSegmentAudioPrompt(design,vocals,segment,'ko',backgroundMusic)||segment.prompt_ko,promptEn:minimaxPromptMusic(assembleSegmentAudioPrompt(design,vocals,segment,'en',backgroundMusic)||segment.prompt_en,backgroundMusic),referencePath:joinPath(paths.outputDir,'segments',`segment-${String(index+1).padStart(3,'0')}-reference.mp4`),audioPath:joinPath(paths.outputDir,'segments',`segment-${String(index+1).padStart(3,'0')}.mp3`),status:'queued'}));
  const job={id:`vta-${Date.now()}`,jobKind:'video-audio',batchId:`vta-${Date.now()}`,type:'AUDIO',status:'queued',sceneName:'Video-to-Audio',cutName:source.filename,sourceName:source.filename,sourcePath:source.path,prompt,minimaxProfile:profile||DEFAULT_MINIMAX_PROFILE,minimaxModelMode:modelMode||'default',latentUpscaleMode:latentUpscaleMode||'off',backgroundMusic:!!backgroundMusic,modelName:`MiniMax-H3 Ref2VA Audio · ${minimaxModelMode(modelMode).label} · ${minimaxProfile(profile).label}`,generationSpec:makeMinimaxGenerationSpec({engine:'minimax-h3-ref2va-audio',modelMode,profile,latentUpscaleMode,backgroundMusic}),resolutionMode:mode,resolution:`${size.label} · ${upscalePlan.target.width}×${upscalePlan.target.height}`,resolutionWidth:size.width,resolutionHeight:size.height,duration,sourceFps:Number(source.fps)||MINIMAX_FPS,fps:MINIMAX_FPS,frames,estimatedSeconds:Math.max(30,Math.round(130*latentUpscaleWorkMegapixels(upscalePlan,latentUpscaleMode)/megapixels(MINIMAX_BENCHMARK_SIZE)*duration/5*minimaxProfile(profile).factor)),seed,fadeSeconds,segments,...paths,createdAt:new Date().toISOString(),error:null,cancelRequested:false};
  videoAudioWorkspace.prompt=prompt;applyHistoricalEstimate(job);(videoAudioWorkspace.jobs||=[]).push(job);saveVideoAudio();render();toast(`${segments.length}개 Ref2VA 구간 · ${fadeSeconds}초 페이드로 생성 큐에 추가했습니다.`);runVideoAudioQueue();
}
function normalizeVideoAudioJobSegments(job){
  const design=videoAudioWorkspace.audioPromptDraft?.result,vocals=videoAudioWorkspace.audioPromptDraft?.vocals===true;
  const usableDesign=design?.version===5&&Math.abs(Number(design.duration_seconds)-Number(job.duration))<=.05&&Array.isArray(design.segments)&&design.segments.length&&design.segments.every(segment=>segment.end_seconds-segment.start_seconds<=REF2VA_MAX_SECONDS+.001);
  const sourceSegments=usableDesign?design.segments:(job.segments||[]).flatMap(segment=>{
    const start=Number(segment.startSeconds)||0,end=Number(segment.endSeconds)||start+(Number(segment.duration)||0),duration=end-start,count=Math.max(1,Math.ceil(duration/REF2VA_MAX_SECONDS)),step=duration/count;
    return Array.from({length:count},(_,index)=>({
      start_seconds:start+step*index,
      end_seconds:index===count-1?end:start+step*(index+1),
      prompt_ko:segment.promptKo||job.promptKo||job.prompt,
      prompt_en:segment.promptEn||job.prompt,
    }));
  });
  if(!sourceSegments.length)throw new Error('Ref2VA 오디오 구간 계획이 없습니다. LLM 설계를 다시 적용해 주세요.');
  job.segments=sourceSegments.map((segment,index)=>({
    index:index+1,
    startSeconds:Number(segment.start_seconds),
    endSeconds:Number(segment.end_seconds),
    duration:Number(segment.end_seconds)-Number(segment.start_seconds),
    promptKo:usableDesign?(assembleSegmentAudioPrompt(design,vocals,segment,'ko',!!job.backgroundMusic)||segment.prompt_ko):segment.prompt_ko,
    promptEn:minimaxPromptMusic(usableDesign?(assembleSegmentAudioPrompt(design,vocals,segment,'en',!!job.backgroundMusic)||segment.prompt_en):segment.prompt_en,!!job.backgroundMusic),
    referencePath:joinPath(job.outputDir,'segments',`segment-${String(index+1).padStart(3,'0')}-reference.mp4`),
    audioPath:joinPath(job.outputDir,'segments',`segment-${String(index+1).padStart(3,'0')}.mp3`),
    status:'queued',
  }));
  if(job.segments.some(segment=>!Number.isFinite(segment.duration)||segment.duration<.2||segment.duration>REF2VA_MAX_SECONDS+.001))throw new Error('Ref2VA 구간은 각각 0.2초 이상, 149초 이하여야 합니다.');
}
let videoAudioQueuePumpActive=false;
async function runVideoAudioQueue(){
  if(videoAudioQueuePumpActive||queuePaused)return;videoAudioQueuePumpActive=true;
  try{while(!queuePaused){const job=(videoAudioWorkspace.jobs||[]).find(item=>item.status==='queued');if(!job)break;await executeVideoAudioJob(job);}}
  finally{videoAudioQueuePumpActive=false;renderGenerationDock();if(!queuePaused&&(videoAudioWorkspace.jobs||[]).some(job=>job.status==='queued'))queueMicrotask(runVideoAudioQueue);}
}
async function executeVideoAudioJob(job){
  applyHistoricalEstimate(job);job.status='running';job.startedAt=new Date().toISOString();job.stage='MiniMax-H3 Ref2VA 준비 중';job.samplerStage=job.stage;job.stageTimeline=[];job.progressSample=null;job.iterationRate=0;job.iterationText='';job.liveRemainingSeconds=null;job.liveProgress=1;saveVideoAudio();renderGenerationDock();if(page==='video-audio')render();
  try{
    if(!isTauri())throw new Error('Video-to-Audio는 데스크톱 앱에서 실행할 수 있습니다.');if(!job.projectPath||Number(job.storageVersion)!==2)throw new Error('이 작업에는 프로젝트 저장 경로가 지정되지 않았습니다. 재시도를 눌러 현재 프로젝트에 다시 연결해 주세요.');
    job.stage='원본 영상 길이·FPS 확인 중';job.samplerStage=job.stage;job.liveProgress=1;renderGenerationDock();const sourceInfo=await window.__TAURI__.core.invoke('probe_video',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:job.sourcePath});job.duration=Number(sourceInfo.duration)||0;job.sourceFps=Number(sourceInfo.fps)||MINIMAX_FPS;job.fps=MINIMAX_FPS;job.frames=minimaxFrameLength(job.duration);applyHistoricalEstimate(job,Math.max(30,Math.round(130*megapixels({width:job.resolutionWidth,height:job.resolutionHeight})/megapixels(MINIMAX_BENCHMARK_SIZE)*job.duration/5*minimaxProfile(job.minimaxProfile).factor)));
    normalizeVideoAudioJobSegments(job);
    await window.__TAURI__.core.invoke('comfy_ensure_environment',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188',preferredName:appSettings.comfyEnvironmentName||'',forceRestart:false,showConsole:!!appSettings.showComfyConsole,requiredEngine:'minimax-h3'});comfyRuntimeOnline=true;const started=Date.now(),rawSegments=[];
    for(let index=0;index<job.segments.length;index++){
      const segment=job.segments[index];if(job.cancelRequested||job.status==='cancelled')throw new Error('cancelled');segment.status='running';job.currentSegment=index+1;job.stage=`Ref2VA 구간 ${index+1}/${job.segments.length} · ${formatClock(segment.startSeconds)}–${formatClock(segment.endSeconds)}`;job.liveProgress=Math.max(2,Math.round(index/job.segments.length*95));saveVideoAudio();renderGenerationDock();if(page==='video-audio')render();
      const referencePath=await window.__TAURI__.core.invoke('prepare_video_audio_reference',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:job.sourcePath,outputPath:segment.referencePath,width:job.resolutionWidth,height:job.resolutionHeight,startSeconds:segment.startSeconds,duration:segment.duration,fps:MINIMAX_FPS});
      const clientId=`frameflow-vta-${Date.now()}-${job.id}-${index+1}`,socket=monitorComfyProgress(job,clientId);let raw;try{raw=await window.__TAURI__.core.invoke('comfy_generate_reference_audio',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188',clientId,videoPath:referencePath,prompt:segment.promptEn,width:job.resolutionWidth,height:job.resolutionHeight,duration:segment.duration,outputPath:segment.audioPath,seed:job.seed+index,minimaxProfile:job.minimaxProfile||DEFAULT_MINIMAX_PROFILE,minimaxModelMode:job.minimaxModelMode||'default',latentUpscaleMode:job.latentUpscaleMode||'off',backgroundMusic:!!job.backgroundMusic});}finally{socket?.close();}
      segment.status='completed';segment.promptId=raw.promptId;segment.generatedPath=raw.path;rawSegments.push(raw.path);saveVideoAudio();
    }
    job.stage=`${job.segments.length}개 MP3 · ${job.fadeSeconds}초 fade-out/fade-in 연결 중`;job.liveProgress=96;renderGenerationDock();
    const audioPath=await window.__TAURI__.core.invoke('assemble_audio_segments',{executable:appSettings.ffmpegPath||'ffmpeg',audioPaths:rawSegments,durations:job.segments.map(segment=>segment.duration),fadeSeconds:job.fadeSeconds,outputPath:job.audioPath});
    job.stage='원본 전체 MP4에 CRF 15 오디오 합성 중';job.liveProgress=98;renderGenerationDock();const videoPath=await window.__TAURI__.core.invoke('mux_video_with_audio',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:job.sourcePath,audioPath,outputPath:job.videoPath});
    const result={id:`vta-result-${Date.now()}`,jobId:job.id,projectId:job.projectId,projectName:job.projectName,projectPath:job.projectPath,outputDir:job.outputDir,sourceName:job.sourceName,sourcePath:job.sourcePath,audioPath,videoPath,audioFilename:String(audioPath).split(/[\\/]/).pop(),videoFilename:String(videoPath).split(/[\\/]/).pop(),prompt:job.prompt,resolution:job.resolution,duration:job.duration,sourceFps:job.sourceFps,fps:job.fps,frames:job.frames,segments:job.segments,fadeSeconds:job.fadeSeconds,createdAt:new Date().toLocaleString('ko-KR'),generationSeconds:Math.max(1,Math.round((Date.now()-new Date(job.startedAt).getTime())/1000)),seed:job.seed,segmentSeeds:(job.segments||[]).map((_,index)=>job.seed+index),promptId:job.segments.at(-1)?.promptId,modelName:job.modelName,minimaxProfile:job.minimaxProfile||DEFAULT_MINIMAX_PROFILE,minimaxModelMode:job.minimaxModelMode||'default',latentUpscaleMode:job.latentUpscaleMode||'off',backgroundMusic:!!job.backgroundMusic,generationSpec:job.generationSpec};(videoAudioWorkspace.results||=[]).unshift(result);completeJobStage(job);job.status='completed';job.completedAt=new Date().toISOString();job.resultId=result.id;job.liveProgress=100;job.resultPath=videoPath;toast(`${job.projectName} 프로젝트에 ${job.segments.length}개 구간 오디오와 원본 전체 MP4 합성을 완료했습니다.`);
  }catch(error){if(job.cancelRequested||job.status==='cancelled'){job.status='cancelled';job.error='사용자가 작업을 취소했습니다.';}else{job.status='failed';job.error=String(error.message||error);const segment=job.segments?.find(item=>item.status==='running');if(segment){segment.status='failed';segment.error=job.error;}}job.completedAt=new Date().toISOString();toast(`Video-to-Audio 생성 실패: ${briefJobError(job.error)}`,10000);}saveVideoAudio();if(page==='video-audio')render();else renderGenerationDock();
}
async function openVideoAudioFile(path){if(!path){toast('파일 경로가 없습니다.');return;}if(!isTauri()){toast('파일 위치 열기는 데스크톱 앱에서 사용할 수 있습니다.');return;}try{await window.__TAURI__.core.invoke('open_media_folder',{path});}catch(error){toast(`파일 위치 열기 실패: ${error.message||error}`,7000);}}

function videoVideoResultCard(result){
  const url=videoAudioMediaUrl(result.path),filename=escapeAttr(result.filename||String(result.path||'').split(/[\\/]/).pop()||'generated.mp4');
  return `<article class="vta-result-card vtv-result-card"><header><div><span>MINIMAX-H3 VIDEO</span><h3>${escapeAttr(result.sourceName||'참조 영상')}</h3><p>${escapeAttr(result.createdAt||'')} · ${escapeAttr(result.resolution||'')} · ${formatClock(result.duration||0)}</p></div><span class="vta-result-status">완료</span></header><video class="vtv-result-video" controls playsinline preload="metadata" src="${escapeAttr(url)}"></video>${generationSpecBadges(result)}<div class="vtv-result-meta"><span>생성 ${formatClock(result.generationSeconds||0)}</span><button type="button" class="copy-result-seed" data-seed="${result.seed}">Seed ${result.seed} · 복사</button></div>${generationSpecDetails(result)}<button type="button" class="vta-open-file vtv-filename" data-path="${escapeAttr(result.path||'')}">${icon('folder')}<span><b>${filename}</b><small>클릭하여 파일 위치 열기</small></span></button><details class="vta-result-prompt"><summary>사용한 프롬프트</summary><p>${escapeAttr(result.prompt||'')}</p></details></article>`;
}
function renderVideoVideo(){
  const source=videoVideoWorkspace.source,project=currentProject(),active=(videoVideoWorkspace.jobs||[]).filter(job=>['queued','running'].includes(job.status)),recent=[...(videoVideoWorkspace.jobs||[])].reverse().slice(0,6),width=Number(videoVideoWorkspace.width)||Number(source?.width)||1280,height=Number(videoVideoWorkspace.height)||Number(source?.height)||720;
  document.querySelector('#app').innerHTML=`<div class="app-shell">${sidebar()}<main>${topbar('Video-to-Video')}<section class="vta-page vtv-page"><header class="vta-hero vtv-hero"><div><div class="eyebrow">MINIMAX-H3 REF2VA · FINAL</div><h1>Video-to-Video</h1><p>참조 영상의 동작·타이밍·카메라를 바탕으로 새 MiniMax-H3 영상을 생성합니다.</p><div class="vta-save-location">${icon('folder')}<span><b>${escapeAttr(project?.name||'프로젝트 없음')}</b><small>${escapeAttr(project?.projectPath?joinPath(project.projectPath,'videos','video-to-video'):'프로젝트 저장 폴더를 먼저 지정해 주세요.')}</small></span></div></div><div class="vtv-engine-badge"><span>생성 엔진</span><b>MiniMax-H3</b><small>최종 생성 · 방식 선택 · 24fps</small></div></header><div class="vta-workspace"><section class="vta-input-card"><div class="vta-section-heading"><span>01</span><div><h2>참조 MP4</h2><p>MiniMax-H3 Ref2VA 입력 범위인 2~15초 영상을 선택하세요.</p></div></div>${source?`<button type="button" class="vta-source selected choose-vtv-video"><div class="vta-source-icon">${icon('film')}</div><span><b>${escapeAttr(source.filename)}</b><small>${source.width}×${source.height} · ${formatClock(source.duration)} · ${Number(source.fps||0).toFixed(2)}fps</small></span><em>변경</em></button>`:`<button type="button" class="vta-source choose-vtv-video">${icon('plus')}<span><b>MP4 파일 선택</b><small>영상 길이·FPS·해상도를 자동으로 확인합니다.</small></span></button>`}<div class="vta-section-heading prompt"><span>02</span><div><h2>출력 해상도</h2><p>가로·세로는 생성 직전에 가장 가까운 32배수로 자동 정리됩니다.</p></div></div><div class="vtv-resolution"><label><span>가로</span><input id="vtv-width" type="number" min="64" max="16384" step="32" value="${width}"></label><i>×</i><label><span>세로</span><input id="vtv-height" type="number" min="64" max="16384" step="32" value="${height}"></label><strong>${megapixelLabel({width,height})}</strong></div><div class="vta-section-heading prompt"><span>03</span><div><h2>영상 프롬프트</h2><p>원하는 변화와 연출을 작성하세요. 공식 Ref2VA 6섹션 프롬프트도 그대로 사용할 수 있습니다.</p></div></div><textarea id="vtv-prompt" class="vtv-prompt" placeholder="예: 원본의 카메라 움직임과 인물 동작은 유지하고, 배경을 비 내리는 미래 도시의 밤으로 바꾼다.">${escapeAttr(videoVideoWorkspace.prompt||'')}</textarea><div class="vta-prompt-help"><span>자동 처리</span><code>Video 1의 동작·포즈·타이밍·카메라·구도를 유지하도록 공식 6섹션 형식으로 변환합니다.</code></div><button type="button" class="button primary vtv-generate" ${source&&project?.projectPath?'':'disabled'}>${icon('film')} MiniMax-H3 영상 생성</button></section><aside class="vta-queue-card"><header><div><span>FINAL GENERATION</span><h2>Video-to-Video 생성 큐</h2></div><strong>${active.length}</strong></header>${recent.length?`<div class="vta-job-list">${recent.map(job=>`<article class="${job.status}"><span></span><div><b>${escapeAttr(job.sourceName||'MP4')}</b><small>${escapeAttr(job.projectName||'프로젝트 미지정')} · ${escapeAttr(job.resolution||'')} · Seed ${job.seed??'-'} · ${formatClock(job.duration||0)} · ${{queued:'대기',running:'생성 중',completed:'완료',failed:'실패',interrupted:'중단'}[job.status]||job.status}</small>${job.error?`<em>${escapeAttr(briefJobError(job.error))}</em>`:''}</div>${['failed','interrupted','cancelled'].includes(job.status)?`<button type="button" class="vta-retry" data-job="${job.id}">재시도</button>`:''}</article>`).join('')}</div>`:'<div class="vta-empty-queue">대기 중인 작업이 없습니다.</div>'}</aside></div><section class="vta-results"><header><div><span>OUTPUT LIBRARY</span><h2>생성 결과</h2></div><strong>${(videoVideoWorkspace.results||[]).length}개</strong></header><div class="vta-results-grid">${(videoVideoWorkspace.results||[]).length?(videoVideoWorkspace.results||[]).map(videoVideoResultCard).join(''):'<div class="vta-empty-results">생성된 MiniMax-H3 영상이 여기에 표시됩니다.</div>'}</div></section></section></main></div><div id="toast"></div>`;
  bindCommon();document.querySelectorAll('.choose-vtv-video').forEach(button=>button.addEventListener('click',chooseVideoVideoSource));document.querySelector('#vtv-prompt')?.addEventListener('input',event=>{videoVideoWorkspace.prompt=event.target.value;saveVideoVideo();});for(const [selector,key] of [['#vtv-width','width'],['#vtv-height','height']])document.querySelector(selector)?.addEventListener('input',event=>{videoVideoWorkspace[key]=Number(event.target.value)||null;const badge=document.querySelector('.vtv-resolution>strong');if(badge)badge.textContent=megapixelLabel({width:Number(document.querySelector('#vtv-width')?.value),height:Number(document.querySelector('#vtv-height')?.value)});saveVideoVideo();});document.querySelector('.vtv-generate')?.addEventListener('click',queueVideoVideoGeneration);document.querySelectorAll('.vta-retry').forEach(button=>button.addEventListener('click',()=>retryJob(button.dataset.job)));document.querySelectorAll('.vta-open-file').forEach(button=>button.addEventListener('click',()=>openVideoAudioFile(button.dataset.path)));document.querySelectorAll('.copy-result-seed').forEach(button=>button.addEventListener('click',()=>copySeed(button.dataset.seed)));
}
async function chooseVideoVideoSource(){
  if(!isTauri()){toast('MP4 선택은 데스크톱 앱에서 사용할 수 있습니다.');return;}
  const path=await window.__TAURI__.dialog.open({multiple:false,title:'Video-to-Video 참조 MP4 선택',filters:[{name:'MP4 Video',extensions:['mp4']}]});if(!path)return;
  try{toast('영상 정보를 확인하는 중…',120000);const source=await window.__TAURI__.core.invoke('probe_video',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:path}),duration=Number(source.duration)||0;if(duration<2||duration>15)throw new Error(`MiniMax-H3 Ref2VA 참조 영상은 2~15초여야 합니다. 선택 영상: ${duration.toFixed(2)}초`);videoVideoWorkspace.source=source;const size=alignMinimaxResolution({width:source.width,height:source.height});videoVideoWorkspace.width=size.width;videoVideoWorkspace.height=size.height;saveVideoVideo();render();toast(`참조 MP4를 불러왔습니다. 출력 해상도 ${resolutionLabel(size)}로 맞췄습니다.`);}catch(error){toast(`MP4 불러오기 실패: ${error.message||error}`,8000);}
}
async function queueVideoVideoGeneration(){
  const source=videoVideoWorkspace.source,project=currentProject(),prompt=String(document.querySelector('#vtv-prompt')?.value||videoVideoWorkspace.prompt||'').trim();if(!source){toast('참조 MP4를 선택해 주세요.');return;}if(!project?.projectPath){toast('현재 프로젝트의 저장 폴더를 먼저 지정해 주세요.');return;}if(!prompt){toast('영상 프롬프트를 입력해 주세요.');return;}
  const duration=Number(source.duration)||0;if(duration<2||duration>15){toast('MiniMax-H3 Ref2VA 참조 영상은 2~15초여야 합니다.');return;}const requested={width:Number(document.querySelector('#vtv-width')?.value),height:Number(document.querySelector('#vtv-height')?.value)};if(!Number.isFinite(requested.width)||!Number.isFinite(requested.height)||requested.width<64||requested.height<64){toast('가로·세로 해상도를 64픽셀 이상으로 입력해 주세요.');return;}const options=await minimaxOptionsDialog({title:'Video-to-Video 최종 생성 설정',allowHybrid:true});if(!options)return;const size=alignMinimaxResolution(requested),upscalePlan=latentUpscalePlan(size,options.latentUpscaleMode),profileInfo=minimaxProfile(options.profile),modelModeInfo=minimaxModelMode(options.modelMode);videoVideoWorkspace.width=size.width;videoVideoWorkspace.height=size.height;videoVideoWorkspace.prompt=prompt;const stamp=new Date().toISOString().replace(/[:.]/g,'-'),base=String(source.filename||'reference').replace(/\.[^.]+$/,'').replace(/[<>:"/\\|?*]+/g,'-').slice(0,80)||'reference',outputPath=joinPath(project.projectPath,'videos','video-to-video',`${base}-minimax-h3-${upscalePlan.target.width}x${upscalePlan.target.height}-${stamp}.mp4`),seed=Date.now()%Number.MAX_SAFE_INTEGER,job={id:`vtv-${Date.now()}`,batchId:`vtv-${Date.now()}`,jobKind:'video-video',type:'FINAL',status:'queued',sceneName:'Video-to-Video',cutName:source.filename,projectId:project.id,projectName:project.name,projectPath:project.projectPath,sourceName:source.filename,sourcePath:source.path,prompt,promptEn:videoToVideoPrompt(prompt,!!options.backgroundMusic),modelName:`MiniMax-H3 Ref2VA · ${modelModeInfo.label} · ${profileInfo.label}`,minimaxProfile:options.profile,minimaxModelMode:options.modelMode||'default',latentUpscaleMode:options.latentUpscaleMode,backgroundMusic:!!options.backgroundMusic,generationSpec:makeMinimaxGenerationSpec({engine:'minimax-h3-ref2va-video-to-video',modelMode:options.modelMode,profile:options.profile,latentUpscaleMode:options.latentUpscaleMode,backgroundMusic:options.backgroundMusic}),resolution:resolutionLabel(upscalePlan.target),resolutionWidth:size.width,resolutionHeight:size.height,duration,fps:MINIMAX_FPS,frames:minimaxFrameLength(duration),estimatedSeconds:MINIMAX_BENCHMARK_SECONDS*latentUpscaleWorkMegapixels(upscalePlan,options.latentUpscaleMode)/megapixels(MINIMAX_BENCHMARK_SIZE)*duration/5*profileInfo.factor,seed,outputPath,createdAt:new Date().toISOString(),error:null,cancelRequested:false};applyHistoricalEstimate(job);(videoVideoWorkspace.jobs||=[]).push(job);saveVideoVideo();render();if(size.width!==requested.width||size.height!==requested.height)toast(`${resolutionLabel(requested)}를 32배수 ${resolutionLabel(size)}로 조정하고 ${modelModeInfo.label} · ${profileInfo.label} 작업을 추가했습니다.`,6000);else toast(`${modelModeInfo.label} · ${profileInfo.label} · ${resolutionLabel(upscalePlan.target)} 최종 작업을 큐에 추가했습니다.`);runVideoVideoQueue();
}
let videoVideoQueuePumpActive=false;
async function runVideoVideoQueue(){
  if(videoVideoQueuePumpActive||queuePaused)return;videoVideoQueuePumpActive=true;try{while(!queuePaused){const job=(videoVideoWorkspace.jobs||[]).find(item=>item.status==='queued');if(!job)break;await executeVideoVideoJob(job);}}finally{videoVideoQueuePumpActive=false;renderGenerationDock();if(!queuePaused&&(videoVideoWorkspace.jobs||[]).some(job=>job.status==='queued'))queueMicrotask(runVideoVideoQueue);}
}
async function executeVideoVideoJob(job){
  applyHistoricalEstimate(job);job.status='running';job.startedAt=new Date().toISOString();job.stage='MiniMax-H3 Ref2VA 준비 중';job.samplerStage=job.stage;job.stageTimeline=[];job.progressSample=null;job.iterationRate=0;job.iterationText='';job.liveRemainingSeconds=null;job.liveProgress=1;saveVideoVideo();renderGenerationDock();if(page==='video-video')render();
  try{if(!isTauri())throw new Error('Video-to-Video는 데스크톱 앱에서 실행할 수 있습니다.');const source=await window.__TAURI__.core.invoke('probe_video',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:job.sourcePath}),duration=Number(source.duration)||0;if(duration<2||duration>15)throw new Error(`MiniMax-H3 Ref2VA 참조 영상은 2~15초여야 합니다. 현재 ${duration.toFixed(2)}초입니다.`);job.duration=duration;job.frames=minimaxFrameLength(duration);await window.__TAURI__.core.invoke('comfy_ensure_environment',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188',preferredName:appSettings.comfyEnvironmentName||'',forceRestart:false,showConsole:!!appSettings.showComfyConsole,requiredEngine:'minimax-h3'});comfyRuntimeOnline=true;const clientId=`frameflow-vtv-${Date.now()}-${job.id}`,socket=monitorComfyProgress(job,clientId),started=Date.now();let raw;try{raw=await window.__TAURI__.core.invoke('comfy_generate_ref2va_video',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188',clientId,referenceImages:[],referenceVideos:[job.sourcePath],prompt:job.promptEn||videoToVideoPrompt(job.prompt,!!job.backgroundMusic),width:job.resolutionWidth,height:job.resolutionHeight,duration,outputPath:job.outputPath,seed:job.seed,refImageSize:'match',minimaxProfile:job.minimaxProfile||'turbo-10',minimaxModelMode:job.minimaxModelMode||'default',latentUpscaleMode:job.latentUpscaleMode||'off',backgroundMusic:!!job.backgroundMusic});}finally{socket?.close();}const path=raw.path||job.outputPath,result={id:`vtv-result-${Date.now()}`,jobId:job.id,projectId:job.projectId,projectName:job.projectName,sourceName:job.sourceName,sourcePath:job.sourcePath,path,filename:String(path).split(/[\\/]/).pop(),prompt:job.prompt,promptEn:job.promptEn,modelName:job.modelName,profileLabel:minimaxProfile(job.minimaxProfile).label,minimaxProfile:job.minimaxProfile||'turbo-10',minimaxModelMode:job.minimaxModelMode||'default',latentUpscaleMode:job.latentUpscaleMode,backgroundMusic:!!job.backgroundMusic,generationSpec:job.generationSpec,resolution:job.resolution,duration,fps:Number(raw.fps)||MINIMAX_FPS,frames:Number(raw.frames)||job.frames,createdAt:new Date().toLocaleString('ko-KR'),generationSeconds:Math.max(1,Math.round((Date.now()-started)/1000)),seed:job.seed,promptId:raw.promptId};(videoVideoWorkspace.results||=[]).unshift(result);job.status='completed';job.completedAt=new Date().toISOString();job.resultId=result.id;job.resultPath=path;job.promptId=raw.promptId;job.liveProgress=100;toast(`${job.projectName} 프로젝트에 MiniMax-H3 Video-to-Video 생성을 완료했습니다.`);}catch(error){if(job.cancelRequested||job.status==='cancelled'){job.status='cancelled';job.error='사용자가 작업을 취소했습니다.';}else{job.status='failed';job.error=String(error.message||error);}job.completedAt=new Date().toISOString();toast(`Video-to-Video 생성 실패: ${briefJobError(job.error)}`,10000);}saveVideoVideo();if(page==='video-video')render();else renderGenerationDock();
}

function generativeUpscaleResultCard(result){
  const url=videoAudioMediaUrl(result.path),filename=escapeAttr(result.filename||String(result.path||'').split(/[\\/]/).pop()||'upscaled.mp4');
  return `<article class="vta-result-card gu-result-card"><header><div><span>H3 GENERATIVE UPSCALE</span><h3>${escapeAttr(result.sourceName||'입력 영상')}</h3><p>${escapeAttr(result.createdAt||'')} · ${escapeAttr(result.inputResolution||'')} → ${escapeAttr(result.resolution||'')}</p></div><span class="vta-result-status">완료</span></header><video class="vtv-result-video" controls playsinline preload="metadata" src="${escapeAttr(url)}"></video><div class="generation-spec-strip"><strong>RTX VSR</strong><span>H3 Ref2VA · 6-step</span><span>denoise 0.4</span><span>${escapeAttr(result.tileLabel||'')}</span><span>${Number(result.tileCount)||1} tiles</span></div><div class="vtv-result-meta"><span>생성 ${formatClock(result.generationSeconds||0)}</span><span>배수 ${Number(result.multiplier||1).toFixed(2)}×</span></div><button type="button" class="vta-open-file vtv-filename" data-path="${escapeAttr(result.path||'')}">${icon('folder')}<span><b>${filename}</b><small>클릭하여 파일 위치 열기</small></span></button></article>`;
}
function renderGenerativeUpscale(){
  const source=generativeUpscaleWorkspace.source,project=currentProject(),multiplier=Math.max(1,Math.min(4,Number(generativeUpscaleWorkspace.multiplier)||2)),tileMp=GENERATIVE_TILE_MP_OPTIONS.includes(Number(generativeUpscaleWorkspace.tileMp))?Number(generativeUpscaleWorkspace.tileMp):.5,plan=generativeUpscalePlan(source,multiplier,tileMp),recent=[...(generativeUpscaleWorkspace.jobs||[])].reverse().slice(0,6),active=(generativeUpscaleWorkspace.jobs||[]).filter(job=>['queued','running'].includes(job.status));
  const tileOptions=GENERATIVE_TILE_MP_OPTIONS.map(value=>{const size=alignedSizeForMegapixels(source||{width:16,height:9},value);return`<label class="gu-tile-option"><input type="radio" name="gu-tile-mp" value="${value}" ${value===tileMp?'checked':''}><span><b>${value}MP</b><small>${size.width}×${size.height}</small></span></label>`;}).join('');
  document.querySelector('#app').innerHTML=`<div class="app-shell">${sidebar()}<main>${topbar('생성형 Upscale')}<section class="vta-page gu-page"><header class="vta-hero gu-hero"><div><div class="eyebrow">RTX VSR + MINIMAX-H3 REF2VA</div><h1>생성형 Upscale</h1><p>빠르게 확대하고, 겹치는 작은 타일을 H3가 다시 그려 고해상도 디테일을 복원합니다.</p><div class="vta-save-location">${icon('folder')}<span><b>${escapeAttr(project?.name||'프로젝트 없음')}</b><small>${escapeAttr(project?.projectPath?joinPath(project.projectPath,'videos','generative-upscale'):'프로젝트 저장 폴더를 먼저 지정해 주세요.')}</small></span></div></div><div class="gu-summary"><span>예상 결과</span><b>${source?`${plan.output.width}×${plan.output.height}`:'영상 선택 필요'}</b><small>${source?`${megapixelLabel(plan.output)} · ${plan.columns}×${plan.rows} · ${plan.tileCount}개 타일`:'원본 비율로 자동 계산합니다.'}</small></div></header><div class="gu-flow"><section class="gu-step ${source?'complete':'active'}"><div class="vta-section-heading"><span>01</span><div><h2>비디오 업로드</h2><p>원본 해상도·FPS·길이를 자동으로 읽습니다.</p></div></div>${source?`<button type="button" class="vta-source selected choose-gu-video"><div class="vta-source-icon">${icon('film')}</div><span><b>${escapeAttr(source.filename)}</b><small>${source.width}×${source.height} · ${Number(source.megapixels||0).toFixed(2)}MP · ${formatClock(source.duration)} · ${Number(source.fps||0).toFixed(2)}fps</small></span><em>변경</em></button>`:`<button type="button" class="vta-source choose-gu-video">${icon('plus')}<span><b>MP4 파일 선택</b><small>업스케일할 영상을 선택하세요.</small></span></button>`}</section><section class="gu-step ${source?'active':''}"><div class="vta-section-heading"><span>02</span><div><h2>확대 배수</h2><p>1.0~4.0 사이의 값을 직접 입력합니다. 마지막 값이 자동 저장됩니다.</p></div></div><div class="gu-multiplier"><input id="gu-multiplier" type="number" min="1" max="4" step="0.1" value="${multiplier}"><b>×</b><span>${source?`${source.width}×${source.height} → ${plan.output.width}×${plan.output.height}`:'영상을 선택하면 예상 크기가 표시됩니다.'}</span></div></section><section class="gu-step ${source?'active':''}"><div class="vta-section-heading"><span>03</span><div><h2>H3 타일 크기</h2><p>원본 영상 비율과 32배수 조건에 맞춘 예상 해상도입니다.</p></div></div><div class="gu-tile-options">${tileOptions}</div><div class="gu-plan"><div><span>개별 타일</span><b>${plan.tile.width}×${plan.tile.height}</b><small>${megapixelLabel(plan.tile)}</small></div><div><span>타일 배치</span><b>${plan.columns}×${plan.rows}</b><small>1/4 overlap · 총 ${plan.tileCount}회</small></div><div><span>출력</span><b>${plan.output.width}×${plan.output.height}</b><small>${megapixelLabel(plan.output)}</small></div></div><button type="button" class="button primary gu-generate" ${source&&project?.projectPath?'':'disabled'}>${icon('spark')} 업스케일 실행</button></section></div><section class="vta-queue-card gu-queue"><header><div><span>GENERATION QUEUE</span><h2>Upscale 작업</h2></div><strong>${active.length}</strong></header>${recent.length?`<div class="vta-job-list">${recent.map(job=>`<article class="${job.status}"><span></span><div><b>${escapeAttr(job.sourceName||'MP4')}</b><small>${escapeAttr(job.inputResolution||'')} → ${escapeAttr(job.resolution||'')} · ${job.tileCount||1} tiles · ${{queued:'대기',running:'생성 중',completed:'완료',failed:'실패',interrupted:'중단'}[job.status]||job.status}</small>${job.error?`<em>${escapeAttr(briefJobError(job.error))}</em>`:''}</div>${['failed','interrupted','cancelled'].includes(job.status)?`<button type="button" class="gu-retry" data-job="${job.id}">재시도</button>`:''}</article>`).join('')}</div>`:'<div class="vta-empty-queue">대기 중인 작업이 없습니다.</div>'}</section><section class="vta-results"><header><div><span>OUTPUT LIBRARY</span><h2>업스케일 결과</h2></div><strong>${(generativeUpscaleWorkspace.results||[]).length}개</strong></header><div class="vta-results-grid">${(generativeUpscaleWorkspace.results||[]).length?(generativeUpscaleWorkspace.results||[]).map(generativeUpscaleResultCard).join(''):'<div class="vta-empty-results">완료된 생성형 업스케일 영상이 여기에 표시됩니다.</div>'}</div></section></section></main></div><div id="toast"></div>`;
  bindCommon();document.querySelectorAll('.choose-gu-video').forEach(button=>button.addEventListener('click',chooseGenerativeUpscaleSource));document.querySelector('#gu-multiplier')?.addEventListener('change',event=>{generativeUpscaleWorkspace.multiplier=Math.max(1,Math.min(4,Number(event.target.value)||2));saveGenerativeUpscale();render();});document.querySelectorAll('[name="gu-tile-mp"]').forEach(input=>input.addEventListener('change',event=>{generativeUpscaleWorkspace.tileMp=Number(event.target.value);saveGenerativeUpscale();render();}));document.querySelector('.gu-generate')?.addEventListener('click',queueGenerativeUpscale);document.querySelectorAll('.gu-retry').forEach(button=>button.addEventListener('click',()=>retryJob(button.dataset.job)));document.querySelectorAll('.vta-open-file').forEach(button=>button.addEventListener('click',()=>openVideoAudioFile(button.dataset.path)));
}
async function chooseGenerativeUpscaleSource(){
  if(!isTauri()){toast('MP4 선택은 데스크톱 앱에서 사용할 수 있습니다.');return;}const path=await window.__TAURI__.dialog.open({multiple:false,title:'생성형 Upscale 입력 영상 선택',filters:[{name:'MP4 Video',extensions:['mp4']}]});if(!path)return;
  try{toast('영상 정보를 확인하는 중…',120000);generativeUpscaleWorkspace.source=await window.__TAURI__.core.invoke('probe_video',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:path});saveGenerativeUpscale();render();toast('입력 영상을 불러오고 저장된 확대 설정을 적용했습니다.');}catch(error){toast(`영상 불러오기 실패: ${error.message||error}`,8000);}
}
async function queueGenerativeUpscale(){
  const source=generativeUpscaleWorkspace.source,project=currentProject();if(!source){toast('업스케일할 MP4를 선택해 주세요.');return;}if(!project?.projectPath){toast('현재 프로젝트의 저장 폴더를 먼저 지정해 주세요.');return;}const multiplier=Math.max(1,Math.min(4,Number(generativeUpscaleWorkspace.multiplier)||2)),tileMp=Number(generativeUpscaleWorkspace.tileMp)||.5,plan=generativeUpscalePlan(source,multiplier,tileMp);if(plan.output.width>8192||plan.output.height>8192){toast(`예상 출력 ${resolutionLabel(plan.output)}가 최대 8192px을 넘습니다. 배수를 낮춰 주세요.`,8000);return;}const stamp=new Date().toISOString().replace(/[:.]/g,'-'),base=String(source.filename||'video').replace(/\.[^.]+$/,'').replace(/[<>:"/\\|?*]+/g,'-').slice(0,80)||'video',outputPath=joinPath(project.projectPath,'videos','generative-upscale',`${base}-h3-upscale-${plan.output.width}x${plan.output.height}-${stamp}.mp4`),job={id:`gu-${Date.now()}`,jobKind:'generative-upscale',type:'FINAL',status:'queued',sceneName:'생성형 Upscale',cutName:source.filename,projectId:project.id,projectName:project.name,projectPath:project.projectPath,sourceName:source.filename,sourcePath:source.path,inputResolution:`${source.width}×${source.height}`,resolution:resolutionLabel(plan.output),outputWidth:plan.output.width,outputHeight:plan.output.height,tileWidth:plan.tile.width,tileHeight:plan.tile.height,tileMp,tileLabel:`${tileMp}MP (${plan.tile.width}×${plan.tile.height})`,tileCount:plan.tileCount,tileColumns:plan.columns,tileRows:plan.rows,multiplier,duration:Number(source.duration)||0,fps:Number(source.fps)||24,seed:Date.now()%Number.MAX_SAFE_INTEGER,modelName:'RTX VSR + MiniMax-H3 Ref2VA tiled 6-step',estimatedSeconds:Math.max(30,Math.round(MINIMAX_BENCHMARK_SECONDS*megapixels(plan.tile)/megapixels(MINIMAX_BENCHMARK_SIZE)*(Number(source.duration)||5)/5*.6*plan.tileCount)),outputPath,createdAt:new Date().toISOString(),error:null,cancelRequested:false};applyHistoricalEstimate(job);(generativeUpscaleWorkspace.jobs||=[]).push(job);saveGenerativeUpscale();render();runGenerativeUpscaleQueue();toast(`${job.resolution} · ${job.tileCount}개 타일 업스케일 작업을 큐에 추가했습니다.`);
}
let generativeUpscaleQueuePumpActive=false;
async function runGenerativeUpscaleQueue(){if(generativeUpscaleQueuePumpActive||queuePaused)return;generativeUpscaleQueuePumpActive=true;try{while(!queuePaused){const job=(generativeUpscaleWorkspace.jobs||[]).find(item=>item.status==='queued');if(!job)break;await executeGenerativeUpscaleJob(job);}}finally{generativeUpscaleQueuePumpActive=false;renderGenerationDock();if(!queuePaused&&(generativeUpscaleWorkspace.jobs||[]).some(job=>job.status==='queued'))queueMicrotask(runGenerativeUpscaleQueue);}}
async function executeGenerativeUpscaleJob(job){
  applyHistoricalEstimate(job);job.status='running';job.startedAt=new Date().toISOString();job.stage='RTX VSR 확대 준비 중';job.samplerStage=job.stage;job.liveProgress=1;job.error=null;saveGenerativeUpscale();renderGenerationDock();if(page==='generative-upscale')render();
  try{if(!isTauri())throw new Error('생성형 Upscale은 데스크톱 앱에서 실행할 수 있습니다.');await window.__TAURI__.core.invoke('comfy_ensure_environment',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188',preferredName:appSettings.comfyEnvironmentName||'',forceRestart:false,showConsole:!!appSettings.showComfyConsole,requiredEngine:'minimax-h3-generative-upscale'});comfyRuntimeOnline=true;const clientId=`frameflow-gu-${Date.now()}-${job.id}`,socket=monitorComfyProgress(job,clientId),started=Date.now();let raw;try{raw=await window.__TAURI__.core.invoke('comfy_generate_tiled_upscale',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188',clientId,videoPath:job.sourcePath,outputPath:job.outputPath,outputWidth:job.outputWidth,outputHeight:job.outputHeight,tileWidth:job.tileWidth,tileHeight:job.tileHeight,duration:job.duration,fps:job.fps,seed:job.seed});}finally{socket?.close();}const path=raw.path||job.outputPath,result={id:`gu-result-${Date.now()}`,jobId:job.id,projectId:job.projectId,projectName:job.projectName,sourceName:job.sourceName,sourcePath:job.sourcePath,path,filename:String(path).split(/[\\/]/).pop(),inputResolution:job.inputResolution,resolution:job.resolution,multiplier:job.multiplier,tileMp:job.tileMp,tileLabel:job.tileLabel,tileCount:job.tileCount,tileColumns:job.tileColumns,tileRows:job.tileRows,duration:job.duration,fps:Number(raw.fps)||job.fps,frames:Number(raw.frames)||Math.round(job.duration*job.fps),createdAt:new Date().toLocaleString('ko-KR'),generationSeconds:Math.max(1,Math.round((Date.now()-started)/1000)),seed:job.seed,promptId:raw.promptId};(generativeUpscaleWorkspace.results||=[]).unshift(result);job.status='completed';job.completedAt=new Date().toISOString();job.resultId=result.id;job.resultPath=path;job.promptId=raw.promptId;job.liveProgress=100;toast(`${job.projectName} 프로젝트에 생성형 Upscale 영상을 저장했습니다.`);}catch(error){if(job.cancelRequested||job.status==='cancelled'){job.status='cancelled';job.error='사용자가 작업을 취소했습니다.';}else{job.status='failed';job.error=String(error.message||error);}job.completedAt=new Date().toISOString();toast(`생성형 Upscale 실패: ${briefJobError(job.error)}`,12000);}saveGenerativeUpscale();if(page==='generative-upscale')render();else renderGenerationDock();
}

function renderQueue(){
  const list=allJobs().sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const statusLabel={queued:'대기',running:'생성 중',completed:'완료',failed:'실패',cancelled:'취소됨',interrupted:'중단됨'};
  document.querySelector('#app').innerHTML=`<div class="app-shell">${sidebar()}<main>${topbar('생성 큐')}<section class="projects-page queue-page"><div class="projects-heading"><div><div class="eyebrow">PERSISTENT GENERATION QUEUE</div><h1>생성 큐</h1><p>중단·취소된 작업을 선택해 다시 진행하거나 삭제할 수 있습니다.</p></div><div class="queue-bulk"><button class="button secondary queue-select-all">전체 선택</button><button class="button primary queue-run-selected">선택 작업 진행</button><button class="button danger queue-cancel-all">전체 큐 취소</button><button class="button danger queue-delete-selected">선택 삭제</button></div></div><div class="queue-summary"><div><b>${list.filter(j=>j.status==='running').length}</b><span>생성 중</span></div><div><b>${list.filter(j=>j.status==='queued').length}</b><span>대기</span></div><div><b>${list.filter(j=>['cancelled','interrupted','failed'].includes(j.status)).length}</b><span>재개 가능</span></div><div><b>${list.filter(j=>j.status==='completed').length}</b><span>완료</span></div></div><div class="queue-list">${list.length?list.map(j=>`<article class="queue-item"><label class="job-check"><input type="checkbox" data-job-check="${j.id}"><span></span></label><div class="job-icon ${j.type.toLowerCase()}">${icon(j.type==='TEST'?'spark':'film')}</div><div class="job-info"><h3>${j.sceneName} · ${j.cutName||`C${String(j.cutId||1).padStart(2,'0')}`}</h3><p>${j.projectName} · ${j.modelName} · ${j.resolution}</p>${j.error?`<small>${j.error}</small>`:''}</div><span class="job-status ${j.status}">${statusLabel[j.status]||j.status}</span>${['failed','cancelled','interrupted'].includes(j.status)?`<button class="button secondary retry-job" data-job="${j.id}">다시 진행</button>`:''}</article>`).join(''):`<div class="empty-scenes queue-empty">${icon('film')}<h2>생성 작업이 없어요</h2><p>프로젝트의 컷을 열어 테스트 영상이나 최종 영상을 생성해 보세요.</p><button type="button" class="button primary queue-go-projects">프로젝트로 이동</button></div>`}</div></section></main></div><div id="toast"></div>`;
  bindCommon();bindQueueActions();
}

function selectedJobIds(){return [...document.querySelectorAll('[data-job-check]:checked')].map(input=>input.dataset.jobCheck);}
function bindQueueActions(){document.querySelectorAll('.retry-job').forEach(button=>button.addEventListener('click',()=>retryJob(button.dataset.job)));document.querySelector('.queue-select-all')?.addEventListener('click',()=>document.querySelectorAll('[data-job-check]').forEach(input=>input.checked=true));document.querySelector('.queue-run-selected')?.addEventListener('click',()=>{const ids=selectedJobIds();if(!ids.length){toast('진행할 작업을 선택해 주세요.');return;}ids.forEach(retryJob);});document.querySelector('.queue-go-projects')?.addEventListener('click',()=>{page='projects';render();});document.querySelector('.queue-cancel-all')?.addEventListener('click',cancelEntireQueue);document.querySelector('.queue-delete-selected')?.addEventListener('click',async()=>{const ids=new Set(selectedJobIds());if(!ids.size){toast('삭제할 작업을 선택해 주세요.');return;}if(!await confirmDestructive({title:'선택한 작업을 삭제하시겠습니까?',target:`작업 ${ids.size}개`,message:'생성 큐의 작업 기록만 삭제되며 이미 생성된 미디어 파일은 유지됩니다.',confirmLabel:'작업 삭제'}))return;for(const project of projects)project.jobs=(project.jobs||[]).filter(job=>!ids.has(job.id));videoAudioWorkspace.jobs=(videoAudioWorkspace.jobs||[]).filter(job=>!ids.has(job.id));videoVideoWorkspace.jobs=(videoVideoWorkspace.jobs||[]).filter(job=>!ids.has(job.id));generativeUpscaleWorkspace.jobs=(generativeUpscaleWorkspace.jobs||[]).filter(job=>!ids.has(job.id));save();saveVideoAudio();saveVideoVideo();saveGenerativeUpscale();render();toast(`${ids.size}개 작업을 삭제했습니다.`);});}
function injectRecoveryQueue(){const recoverable=allJobs().filter(job=>['cancelled','interrupted','failed'].includes(job.status));if(!recoverable.length)return;const heading=document.querySelector('.projects-heading');heading?.insertAdjacentHTML('afterend',`<section class="recovery-queue"><header><div><b>다시 시작할 작업</b><span>앱 종료·취소·실패로 멈춘 ${recoverable.length}개 작업</span></div><button class="button secondary open-queue">큐 관리</button></header>${recoverable.slice(0,5).map(job=>`<div><span>${job.projectName}</span><b>${job.sceneName} · ${job.cutName||''}</b><small>${job.error||'다시 진행할 수 있습니다.'}</small></div>`).join('')}</section>`);document.querySelector('.open-queue')?.addEventListener('click',()=>{page='queue';render();});}

function enhanceProjectHeaderMenu(){
  const heroCopy=document.querySelector('.project-hero > div:first-child'),description=heroCopy?.querySelector(':scope > p'),heading=heroCopy?.querySelector('h1');if(!heroCopy||!description||!heading)return;
  heading.querySelector('.edit-dot')?.remove();
  const row=document.createElement('div');row.className='project-description-row';description.before(row);row.append(description);
  row.insertAdjacentHTML('beforeend',`<details class="project-settings-menu"><summary title="프로젝트 메뉴" aria-label="프로젝트 메뉴">${icon('settings')}</summary><div><button type="button" class="project-settings-open">프로젝트 정보 수정</button><button type="button" class="project-delete-current">${icon('trash')} 프로젝트 삭제</button></div></details>`);
  const pathButton=heroCopy.querySelector('.project-path');
  if(pathButton){
    const project=currentProject(),actions=document.createElement('div');actions.className='project-folder-actions';
    pathButton.before(actions);pathButton.classList.add('project-open-folder');pathButton.title='프로젝트 폴더 열기';pathButton.setAttribute('aria-label',`프로젝트 폴더 열기: ${project.projectPath}`);
    pathButton.innerHTML=`${icon('folder')}<span><b>프로젝트 폴더 열기</b><small>${escapeAttr(project.projectPath)}</small></span>`;
    actions.append(pathButton);actions.insertAdjacentHTML('beforeend',`<button type="button" class="button secondary project-backup-current" title="프로젝트 전체 폴더 백업">${icon('archive')} 백업</button>`);
  }
}

function renderProject() {
  const p = currentProject(); if (!p) { page='projects'; return renderProjects(); }
  const list=scenes(),scene=currentScene();activeScene=scene?.id||null;const cut=scene?.cuts?.find(item=>item.id===activeCut)||scene?.cuts?.[0]||null;activeCut=cut?.id||null;
  const flat=cuts(p),progress=projectGenerationProgress(p),percent=progress.percent,queueText=progress.running||progress.queued?` · 생성 중 ${progress.running} · 대기 ${progress.queued}`:'';
  document.querySelector('#app').innerHTML=`<div class="app-shell">${sidebar()}<main>${topbar(p.name)}<section class="project-hero"><div><div class="eyebrow">PROJECT ${projectCode(p)} · ${list.length} SCENES · ${flat.length} CUTS</div><h1>${p.name}<button class="edit-dot project-settings-open" title="프로젝트 설정">•••</button></h1><p>${p.description||'프로젝트 설명을 입력해 주세요.'}</p><button class="project-path" title="${p.projectPath}">${icon('folder')}<span>${p.projectPath}</span></button></div><div class="build-panel"><div class="build-progress"><div class="ring" style="background:conic-gradient(#6bc2a5 0 ${percent}%,#e5e9e3 ${percent}%)"><span>${percent}%</span></div><div><b>씬 ${progress.doneScenes}/${progress.totalScenes} 완료 · 컷 ${progress.doneCuts}/${progress.totalCuts} 완료</b><small>${progress.running&&progress.remaining<=0?'지연되고 있습니다.':`예상 남은 시간 ${formatClock(progress.remaining)}`}${queueText}</small></div></div><button class="button secondary project-test">${icon('spark')} 전체 테스트</button></div></section><section class="toolbar"><div class="project-resolution-summary"><label>프로젝트 해상도</label><button type="button" class="project-settings-open"><b>${resolutionLabel(projectResolution(p))}</b><small>변경</small></button></div><div class="toolbar-right"><button class="filter active">씬 ${list.length} · 컷 ${flat.length}</button><div class="view-switch"><button class="${view==='cards'?'active':''}" data-view="cards">${icon('grid')}</button><button class="${view==='list'?'active':''}" data-view="list">${icon('list')}</button></div><button class="button add-scene">${icon('plus')} 씬 추가</button></div></section><section class="content-layout"><div class="scene-list ${view==='list'?'compact':''}">${list.length?list.map(sceneCard).join(''):`<div class="empty-scenes">${icon('film')}<h2>아직 씬이 없어요</h2><p>씬 제목과 내용을 입력하고 컷을 구성하세요.</p><button class="button primary add-scene">${icon('plus')} 첫 씬 추가</button></div>`}</div>${inspector(scene,cut)}</section></main></div>${modalMarkup()}${generationPlanMarkup()}<div id="toast"></div>`;
  enhanceProjectHeaderMenu();
  bindCommon(); bindProject(); bindModal(); bindGenerationPlan();
}

function buildGenerationPlan(scope,isTest,sceneId=null,usePreviousVideo=scope==='scene'&&!isTest,minimaxProfileId=DEFAULT_MINIMAX_PROFILE,backgroundMusic=false,latentUpscaleMode='off',minimaxModelModeId='default',engineMode='auto'){
  const project=currentProject(),targetScenes=scope==='scene'?(project.scenes||[]).filter(scene=>scene.id===sceneId):(project.scenes||[]),ready=[],minimaxFull=minimaxResolution(project),minimaxTest=minimaxQuarterResolution(project),minimax=engineMode==='minimax'||(engineMode==='auto'&&!isTest),engineLabel=minimax?'MiniMax-H3':'WAN 2.2';
  if(scope==='scene'){
    const scene=targetScenes[0],forcePrevious=!isTest&&Boolean(usePreviousVideo),plannedPreviousUids=new Set(),entries=(scene?.cuts||[]).map(cut=>{const check=cutGenerationReadiness(project,scene,cut,{forcePrevious,plannedPreviousUids});if(check.state==='ready'){ready.push({sceneId:scene.id,cutId:cut.id});plannedPreviousUids.add(cut.uid);}return{code:`C${String(cut.id).padStart(2,'0')}`,name:cut.name||`컷 ${cut.id}`,state:check.state,reason:check.reason};});
    return{scope,isTest,sceneId,usePreviousVideo:forcePrevious,minimax,engineMode,minimaxProfile:minimaxProfileId,minimaxModelMode:minimaxModelModeId,latentUpscaleMode,backgroundMusic:!!backgroundMusic,title:`S${String(sceneId).padStart(2,'0')} · ${scene?.title||'씬'} ${engineLabel} ${isTest?'테스트':'전체 생성'}`,subtitle:minimax?`${isTest?'1/4 테스트':'최종'} ${resolutionLabel(latentUpscalePlan(isTest?minimaxTest:minimaxFull,latentUpscaleMode).target)} · MiniMax-H3 FLF 워크플로를 사용합니다.`:`${isTest?'약 480p 테스트':'프로젝트 최종 해상도'} · WAN 2.2 FLF 워크플로를 사용합니다.`,entries,ready,estimate:ready.reduce((sum,item)=>{const duration=findCut(project,item.sceneId,item.cutId)?.duration,plan=latentUpscalePlan(isTest?minimaxTest:minimaxFull,latentUpscaleMode);return sum+(minimax?MINIMAX_BENCHMARK_SECONDS*latentUpscaleWorkMegapixels(plan,latentUpscaleMode)/megapixels(MINIMAX_BENCHMARK_SIZE)*(Number(duration)||5)/5*minimaxProfile(minimaxProfileId).factor:estimateSeconds(duration));},0)};
  }
  const entries=targetScenes.map(scene=>{
    const checks=(scene.cuts||[]).map(cut=>({cut,check:cutGenerationReadiness(project,scene,cut)})),blocked=checks.filter(item=>item.check.state==='blocked'),readyCuts=checks.filter(item=>item.check.state==='ready'),skipped=checks.filter(item=>item.check.state==='skip');
    if(!(scene.cuts||[]).length)return{code:`S${String(scene.id).padStart(2,'0')}`,name:scene.title,state:'blocked',reason:'씬에 컷이 없습니다'};
    if(blocked.length)return{code:`S${String(scene.id).padStart(2,'0')}`,name:scene.title,state:'blocked',reason:blocked.map(item=>`C${String(item.cut.id).padStart(2,'0')} ${item.check.reason}`).join(' · ')};
    readyCuts.forEach(item=>ready.push({sceneId:scene.id,cutId:item.cut.id}));
    if(!readyCuts.length)return{code:`S${String(scene.id).padStart(2,'0')}`,name:scene.title,state:'skip',reason:`모든 컷에 선택 영상이 있어 생성하지 않습니다 (${skipped.length}개 컷)`};
    return{code:`S${String(scene.id).padStart(2,'0')}`,name:scene.title,state:'ready',reason:`${readyCuts.length}개 컷 생성${skipped.length?` · 선택 완료 ${skipped.length}개 생략`:''}`};
  });
  return{scope,isTest,sceneId:null,minimax,engineMode,minimaxProfile:minimaxProfileId,minimaxModelMode:minimaxModelModeId,latentUpscaleMode,backgroundMusic:!!backgroundMusic,title:`프로젝트 전체 ${engineLabel} ${isTest?'테스트':'생성'}`,subtitle:minimax?`${isTest?'1/4 테스트':'최종'} MiniMax-H3 FLF 워크플로를 사용합니다.`:`${isTest?'약 480p 테스트':'프로젝트 최종 해상도'} WAN 2.2 FLF 워크플로를 사용합니다.`,entries,ready,estimate:ready.reduce((sum,item)=>{const duration=findCut(project,item.sceneId,item.cutId)?.duration,plan=latentUpscalePlan(isTest?minimaxTest:minimaxFull,latentUpscaleMode);return sum+(minimax?MINIMAX_BENCHMARK_SECONDS*latentUpscaleWorkMegapixels(plan,latentUpscaleMode)/megapixels(MINIMAX_BENCHMARK_SIZE)*(Number(duration)||5)/5*minimaxProfile(minimaxProfileId).factor:estimateSeconds(duration));},0)};
}
function buildContinuousGenerationPlan(sceneId,isTest=false,minimaxProfileId=DEFAULT_MINIMAX_PROFILE,backgroundMusic=false,minimaxModelModeId='default'){
  const project=currentProject(),scene=(project.scenes||[]).find(item=>item.id===sceneId),sceneCuts=scene?.cuts||[],ready=[],entries=[];
  sceneCuts.forEach((cut,index)=>{
    const active=(project.jobs||[]).find(job=>job.cutUid===cut.uid&&['queued','running'].includes(job.status));
    let state='ready',reason=index===0?'FIRST에서 LAST 1까지 생성합니다.':`직전 컷의 22프레임 latent 문맥을 이어받아 LAST ${index+1}까지 생성합니다.`;
    if(active){state='blocked';reason=`이미 ${active.status==='running'?'생성 중':'큐 대기 중'}인 작업이 있습니다.`;}
    else if(!String(cut.promptEn||'').trim()){state='blocked';reason='영문 프롬프트가 없습니다.';}
    else if(!(isTauri()?cut.lastPath:cut.last)){state='blocked';reason=`LAST ${index+1} 이미지가 없습니다.`;}
    else if(index===0&&!(isTauri()?cut.firstPath:cut.first)){state='blocked';reason='첫 컷의 FIRST 이미지가 없습니다.';}
    if(state==='ready')ready.push({sceneId:scene.id,cutId:cut.id});
    entries.push({code:`C${String(cut.id).padStart(2,'0')}`,name:cut.name||`컷 ${cut.id}`,state,reason});
  });
  const sequence=sceneCuts.length?`FIRST → ${sceneCuts.map((_,index)=>`LAST ${index+1}`).join(' → ')}`:'FIRST → LAST',chainReady=entries.every(item=>item.state==='ready')?ready:[];
  const size=isTest?minimaxQuarterResolution(project):minimaxResolution(project);
  const safeProfile=canonicalMinimaxProfile(minimaxProfileId);
  return{scope:'continuous',isTest,sceneId,minimax:true,minimaxProfile:safeProfile,minimaxModelMode:minimaxModelModeId,backgroundMusic:!!backgroundMusic,title:`S${String(sceneId).padStart(2,'0')} · ${scene?.title||'씬'} latent 연속 영상 생성`,subtitle:`공식 Minimax-H3 Context Loop로 ${sequence}를 하나의 영상으로 생성합니다.${isTest?` 테스트는 1/4 크기(32배수) ${resolutionLabel(size)}(${megapixelLabel(size)})로 실행합니다.`:` 최종 ${resolutionLabel(size)}(${megapixelLabel(size)})로 실행합니다.`}`,notice:'첫 컷은 FIRST → LAST 1을 만들고, 이후 컷은 직전 샘플의 22프레임 latent 문맥을 그대로 이어받습니다. PNG 마지막 프레임 추출이나 컷별 합본을 사용하지 않습니다. PDD 8step 계열은 Context Loop sampler와 호환되지 않습니다.',entries,ready:chainReady,sequence,resolution:size,estimate:chainReady.reduce((sum,item)=>sum+minimaxEstimateSeconds(project,findCut(project,item.sceneId,item.cutId)?.duration,size)*minimaxProfile(safeProfile).factor,0)};
}
function buildRef2vaContinuousGenerationPlan(sceneId,isTest=false,minimaxProfileId=DEFAULT_MINIMAX_PROFILE,backgroundMusic=false,minimaxModelModeId='default'){
  const project=currentProject(),scene=(project.scenes||[]).find(item=>item.id===sceneId),shared=ensureRef2vaContinuousScene(scene),entries=[],ready=[];
  (scene?.cuts||[]).forEach((cut,index)=>{let state='ready',reason=index===0?'공통 Ref2VA 레퍼런스로 시작합니다.':'직전 컷의 마지막 22프레임 latent + 공통 레퍼런스로 이어갑니다.';if(!ref2vaReferenceLabels(cut).length){state='blocked';reason='씬 공통 이미지·영상·오디오 레퍼런스가 없습니다.';}else if(!hasRef2vaPrompt(cut.promptEn)){state='blocked';reason='공식 6섹션 영문 프롬프트가 없습니다.';}if(state==='ready')ready.push({sceneId,cutId:cut.id});entries.push({code:`C${String(cut.id).padStart(2,'0')}`,name:cut.name||`컷 ${cut.id}`,state,reason});});
  const size=isTest?minimaxQuarterResolution(project):minimaxResolution(project),safeProfile=canonicalMinimaxProfile(minimaxProfileId),chainReady=entries.length&&entries.every(item=>item.state==='ready')?ready:[];
  return{scope:'ref2va-continuous',isTest,sceneId,minimax:true,minimaxProfile:safeProfile,minimaxModelMode:minimaxModelModeId,backgroundMusic:!!backgroundMusic,title:`S${String(sceneId).padStart(2,'0')} · Ref2VA latent 연속 생성`,subtitle:`${isTest?'1/4 테스트':'최종'} ${resolutionLabel(size)} · 각 컷을 별도 Comfy 작업으로 순서대로 제출합니다.`,notice:'C01은 공통 Picture/Video/Audio 레퍼런스로 생성하고, C02부터는 같은 레퍼런스와 컷 프롬프트에 직전 생성 영상의 마지막 22프레임 latent 문맥을 추가합니다. 실패하면 다음 컷은 제출하지 않습니다.',entries,ready:chainReady,resolution:size,estimate:chainReady.reduce((sum,item)=>sum+minimaxEstimateSeconds(project,findCut(project,item.sceneId,item.cutId)?.duration,size)*minimaxProfile(safeProfile).factor,0),referenceCount:shared.pictures.length+shared.videos.length+shared.audios.length};
}
function openGenerationPlan(scope,isTest,sceneId=null,engineMode='auto'){generationPlan=buildGenerationPlan(scope,isTest,sceneId,scope==='scene'&&!isTest,DEFAULT_MINIMAX_PROFILE,false,'off','default',engineMode);render();}
function openContinuousGenerationPlan(sceneId,isTest=false){generationPlan=buildContinuousGenerationPlan(sceneId,isTest);render();}
function openRef2vaContinuousGenerationPlan(sceneId,isTest=false){generationPlan=buildRef2vaContinuousGenerationPlan(sceneId,isTest);render();}
function adaptivePlanEstimate(plan){
  if(!plan?.minimax)return{seconds:plan?.estimate||0,source:'기본 계산값'};const project=currentProject(),size=plan.resolution||latentUpscalePlan(minimaxResolution(project),plan.latentUpscaleMode||'off').target,continuous=['continuous','ref2va-continuous'].includes(plan.scope),items=plan.ready||[];
  if(continuous){const duration=items.reduce((sum,item)=>sum+(Number(findCut(project,item.sceneId,item.cutId)?.duration)||5),0),candidate={engine:plan.scope==='ref2va-continuous'?'minimax-h3-ref2va-context-loop':'minimax-h3-context-loop',generationSpec:makeMinimaxGenerationSpec({engine:plan.scope==='ref2va-continuous'?'minimax-h3-ref2va-context-loop':'minimax-h3-fl2va-context-loop',modelMode:plan.minimaxModelMode,profile:plan.minimaxProfile,latentUpscaleMode:'off',backgroundMusic:plan.backgroundMusic}),minimaxModelMode:plan.minimaxModelMode,minimaxProfile:plan.minimaxProfile,latentUpscaleMode:'off',resolution:resolutionLabel(size),duration,frames:items.reduce((sum,item)=>sum+minimaxFrameLength(findCut(project,item.sceneId,item.cutId)?.duration),0)},fallback=plan.estimate||minimaxEstimateSeconds(project,duration,size)*minimaxProfile(plan.minimaxProfile).factor;return historicalGenerationEstimate(candidate,fallback);}
  const estimates=items.map(item=>{const cut=findCut(project,item.sceneId,item.cutId),duration=Number(cut?.duration)||5,engine=isRef2vaCut(cut)?'minimax-h3-ref2va':'minimax-h3-fl2va',candidate={engine,generationSpec:makeMinimaxGenerationSpec({engine,modelMode:plan.minimaxModelMode,profile:plan.minimaxProfile,latentUpscaleMode:plan.latentUpscaleMode,backgroundMusic:plan.backgroundMusic}),minimaxModelMode:plan.minimaxModelMode,minimaxProfile:plan.minimaxProfile,latentUpscaleMode:plan.latentUpscaleMode,resolution:resolutionLabel(size),duration,frames:minimaxFrameLength(duration)},fallback=MINIMAX_BENCHMARK_SECONDS*megapixels(size)/megapixels(MINIMAX_BENCHMARK_SIZE)*duration/5*minimaxProfile(plan.minimaxProfile).factor;return historicalGenerationEstimate(candidate,fallback);}),sources=[...new Set(estimates.map(item=>item.source))];return{seconds:estimates.reduce((sum,item)=>sum+item.seconds,0),source:sources.join(' + ')};
}
function generationPlanMarkup(){
  if(!generationPlan)return'';const plan=generationPlan,adaptiveEstimate=adaptivePlanEstimate(plan);plan.estimate=adaptiveEstimate.seconds;plan.estimateSource=adaptiveEstimate.source;const possible=plan.entries.filter(item=>item.state!=='blocked'),blocked=plan.entries.filter(item=>item.state==='blocked'),rows=items=>items.map(item=>`<article class="generation-check-row ${item.state}"><span>${item.code}</span><div><b>${escapeAttr(item.name)}</b><small>${escapeAttr(item.reason)}</small></div><em>${item.state==='ready'?'생성 가능':item.state==='skip'?'완료 · 생략':'생성 불가'}</em></article>`).join('');
  const latentChain=['continuous','ref2va-continuous'].includes(plan.scope),previousVideoOption=plan.scope==='scene'&&!plan.isTest?`<label class="generation-source-option"><input type="checkbox" class="generation-use-previous" ${plan.usePreviousVideo?'checked':''}><span><b>이전 선택 영상의 마지막 프레임 사용</b><small>기본 켜짐 · 각 컷에 저장된 FIRST 이미지는 무시하고, 바로 이전 컷의 대표 영상에서 마지막 프레임을 추출해 FIRST로 사용합니다.</small></span></label>`:'',minimaxOptions=plan.minimax?`<section class="generation-minimax-options"><h3>H3 모델</h3><div class="minimax-profile-options">${minimaxModelModeOptions(plan.minimaxModelMode)}</div><h3>MiniMax-H3 실행 방식</h3><div class="minimax-profile-options">${minimaxProfileOptions(plan.minimaxProfile,!latentChain)}</div>${!latentChain?`<h3>2-pass 잠재 업스케일</h3><div class="minimax-profile-options">${latentUpscaleModeOptions(plan.latentUpscaleMode)}</div><p class="minimax-profile-note">Split/Tiled 및 temporal chunking 미사용</p>`:''}<label class="generation-source-option minimax-music-option"><input type="checkbox" class="minimax-background-music" ${plan.backgroundMusic?'checked':''}><span><b>배경음악 포함</b><small>기본 사용 안 함 · 꺼두면 환경음·음향효과는 유지하고 non_diegetic_music은 N/A로 고정합니다.</small></span></label></section>`:'';
  return`<div class="generation-check-backdrop"><section class="generation-check-dialog" role="dialog" aria-modal="true"><header><div><span>GENERATION CHECK</span><h2>${escapeAttr(plan.title)}</h2><p>${escapeAttr(plan.subtitle)}</p></div><button type="button" class="generation-check-close" aria-label="닫기">×</button></header>${minimaxOptions}${previousVideoOption}${plan.notice?`<div class="generation-check-notice">${icon('spark')}<span>${escapeAttr(plan.notice)}</span></div>`:''}<div class="generation-check-summary"><div><b>${possible.length}</b><span>가능 · 완료 포함</span></div><div class="blocked"><b>${blocked.length}</b><span>불가능</span></div><div><b>${plan.ready.length}</b><span>실제 생성 작업</span></div><div title="${escapeAttr(plan.estimateSource)}"><b>${formatClock(plan.estimate)}</b><span>예상 소요 시간 · ${escapeAttr(plan.estimateSource)}</span></div></div><section><h3>생성 가능한 ${plan.scope==='project'?'씬':'컷'}</h3>${possible.length?rows(possible):'<p class="generation-check-empty">생성 가능한 항목이 없습니다.</p>'}</section><section class="blocked-list"><h3>생성 불가능한 ${plan.scope==='project'?'씬':'컷'}과 이유</h3>${blocked.length?rows(blocked):'<p class="generation-check-empty">생성 불가능한 항목이 없습니다.</p>'}</section><footer><button type="button" class="button secondary generation-check-cancel">취소</button><button type="button" class="button primary generation-check-confirm" ${plan.ready.length?'':'disabled'}>예 · ${plan.ready.length}개 컷 생성</button></footer></section></div>`;
}
async function confirmGenerationPlan(){
  const plan=generationPlan;if(!plan?.ready.length)return;generationPlan=null;pendingBatchId=`batch-${Date.now()}`;render();let queued=0;
  if(plan.scope==='continuous')queued=await queueContinuousScene(plan);
  else if(plan.scope==='ref2va-continuous')queued=await queueRef2vaContinuousScene(plan);
  else for(const item of plan.ready){const before=(currentProject().jobs||[]).length;await queueGeneration(item.sceneId,item.cutId,plan.isTest,plan.minimax?'minimax-h3':'wan-2.2',Boolean(plan.usePreviousVideo),{profile:plan.minimaxProfile,modelMode:plan.minimaxModelMode||'default',latentUpscaleMode:plan.latentUpscaleMode||'off',backgroundMusic:plan.backgroundMusic});if((currentProject().jobs||[]).length>before)queued++;}
  pendingBatchId=null;
  toast(`${queued}개 컷을 생성 큐에 추가했습니다.`);
}
function bindGenerationPlan(){
  document.querySelector('.generation-check-close')?.addEventListener('click',()=>{generationPlan=null;render();});
  document.querySelector('.generation-check-cancel')?.addEventListener('click',()=>{generationPlan=null;render();});
  document.querySelector('.generation-check-confirm')?.addEventListener('click',confirmGenerationPlan);
  document.querySelector('.generation-use-previous')?.addEventListener('change',event=>{const plan=generationPlan;if(!plan)return;generationPlan=buildGenerationPlan(plan.scope,plan.isTest,plan.sceneId,event.currentTarget.checked,plan.minimaxProfile,plan.backgroundMusic,plan.latentUpscaleMode,plan.minimaxModelMode,plan.engineMode);render();});
  document.querySelectorAll('[name="minimax-profile"]').forEach(input=>input.addEventListener('change',event=>{const plan=generationPlan;if(!plan)return;const profile=event.currentTarget.value;generationPlan=plan.scope==='continuous'?buildContinuousGenerationPlan(plan.sceneId,plan.isTest,profile,plan.backgroundMusic,plan.minimaxModelMode):plan.scope==='ref2va-continuous'?buildRef2vaContinuousGenerationPlan(plan.sceneId,plan.isTest,profile,plan.backgroundMusic,plan.minimaxModelMode):buildGenerationPlan(plan.scope,plan.isTest,plan.sceneId,plan.usePreviousVideo,profile,plan.backgroundMusic,plan.latentUpscaleMode,plan.minimaxModelMode,plan.engineMode);render();}));
  document.querySelectorAll('[name="minimax-model-mode"]').forEach(input=>input.addEventListener('change',event=>{const plan=generationPlan;if(!plan)return;const modelMode=event.currentTarget.value;generationPlan=plan.scope==='continuous'?buildContinuousGenerationPlan(plan.sceneId,plan.isTest,plan.minimaxProfile,plan.backgroundMusic,modelMode):plan.scope==='ref2va-continuous'?buildRef2vaContinuousGenerationPlan(plan.sceneId,plan.isTest,plan.minimaxProfile,plan.backgroundMusic,modelMode):buildGenerationPlan(plan.scope,plan.isTest,plan.sceneId,plan.usePreviousVideo,plan.minimaxProfile,plan.backgroundMusic,plan.latentUpscaleMode,modelMode,plan.engineMode);render();}));
  document.querySelector('.minimax-background-music')?.addEventListener('change',event=>{if(!generationPlan)return;generationPlan.backgroundMusic=event.currentTarget.checked;});
  document.querySelectorAll('[name="latent-upscale-mode"]').forEach(input=>input.addEventListener('change',event=>{const plan=generationPlan;if(!plan||plan.scope==='continuous')return;generationPlan=buildGenerationPlan(plan.scope,plan.isTest,plan.sceneId,plan.usePreviousVideo,plan.minimaxProfile,plan.backgroundMusic,event.currentTarget.value,plan.minimaxModelMode,plan.engineMode);render();}));
  document.querySelector('.generation-check-backdrop')?.addEventListener('click',event=>{if(event.target.classList.contains('generation-check-backdrop')){generationPlan=null;render();}});
}

function modalMarkup() {
  if (!modal) return '';
  if (modal==='project') return `<div class="modal-backdrop"><form class="modal-card" id="project-form"><div class="modal-head"><div><span>NEW PROJECT</span><h2>새 프로젝트 만들기</h2><p>해상도는 프로젝트에서만 관리하며 모든 씬에 동일하게 적용됩니다.</p></div><button type="button" class="icon-button close-modal">${icon('close')}</button></div><div class="field"><label>프로젝트 이름 *</label><input name="name" placeholder="예: Summer Bloom" required autofocus></div><div class="field"><label>설명</label><input name="description" placeholder="프로젝트를 짧게 설명해 주세요"></div><div class="field"><label>프로젝트 기본 폴더 *</label><div class="folder-input"><input name="baseFolder" value="${appSettings.defaultFolder||''}" placeholder="FLF 이미지와 영상이 저장될 폴더" required><button type="button" class="choose-folder">${icon('folder')} 찾아보기</button></div><small class="field-help">프로젝트별 FLF, 테스트 영상, 최종 영상 폴더가 자동 생성됩니다.</small></div><div class="modal-grid"><div class="field"><label>기본 길이</label><select name="duration"><option value="1">1초</option><option value="5" selected>5초</option><option value="8">8초</option><option value="10">10초</option></select></div><div class="field"><label>최종 가로 픽셀 *</label><input type="number" name="resolutionWidth" value="1920" min="64" max="16384" step="1" required></div><div class="field"><label>최종 세로 픽셀 *</label><input type="number" name="resolutionHeight" value="1080" min="64" max="16384" step="1" required></div></div><small class="field-help resolution-help">미디어월의 실제 출력 크기를 입력하세요. 테스트 영상은 같은 비율의 약 480p 픽셀 수로 자동 계산됩니다.</small><div class="folder-preview"><b>FLF 저장 규칙</b><code>flf / 0001-0-원본이름.png · First<br>flf / 0001-1-원본이름.png · Last<br>videos / test · final · exports</code></div><div class="modal-actions"><button type="button" class="button secondary close-modal">취소</button><button class="button primary">프로젝트 만들기</button></div></form></div>`;
  if (modal==='project-settings') {const p=currentProject(),size=projectResolution(p),test=resolutionLabel(testResolution(p)),minimax=minimaxResolution(p);return `<div class="modal-backdrop"><form class="modal-card project-settings-card" id="project-settings-form"><div class="modal-head"><div><span>PROJECT SETTINGS</span><h2>프로젝트 설정</h2><p>실제·테스트·Minimax-H3 해상도를 한곳에서 관리합니다.</p></div><button type="button" class="icon-button close-modal">${icon('close')}</button></div><div class="field"><label>프로젝트 이름</label><input name="name" value="${escapeAttr(p.name)}" required></div><div class="field"><label>설명</label><input name="description" value="${escapeAttr(p.description||'')}"></div><h3>실제 영상 해상도</h3><div class="modal-grid"><div class="field"><label>가로 픽셀 *</label><input type="number" name="resolutionWidth" value="${size.width}" min="64" max="16384" required></div><div class="field"><label>세로 픽셀 *</label><input type="number" name="resolutionHeight" value="${size.height}" min="64" max="16384" required></div></div><div class="resolution-preview"><span>실제 <b class="final-resolution-preview">${resolutionLabel(size)}</b></span><span>WAN 테스트 · 자동/수정 불가 <b class="test-resolution-preview">${test}</b></span></div><h3>Minimax-H3 해상도 · 수정 가능</h3><div class="modal-grid"><div class="field"><label>가로 픽셀 *</label><input type="number" name="minimaxWidth" value="${minimax.width}" min="64" max="16384" required></div><div class="field"><label>세로 픽셀 *</label><input type="number" name="minimaxHeight" value="${minimax.height}" min="64" max="16384" required></div></div><small class="field-help">새 프로젝트에서는 실제 해상도와 동일하게 시작합니다. 테스트는 화면비를 유지하며 약 480p 픽셀 수로 자동 계산됩니다.</small><div class="modal-actions"><button type="button" class="button secondary close-modal">취소</button><button class="button primary">프로젝트 설정 저장</button></div></form></div>`;}
  if(modal==='scene-settings'){const scene=currentScene();if(!scene)return'';return `<div class="modal-backdrop"><form class="modal-card scene-modal" id="scene-settings-form"><div class="modal-head"><div><span>SCENE ${String(scene.id).padStart(2,'0')} SETTINGS</span><h2>씬 정보 수정</h2><p>씬의 제목과 내용을 수정합니다.</p></div><button type="button" class="icon-button close-modal">${icon('close')}</button></div><div class="field"><label>씬 제목 *</label><input name="title" value="${escapeAttr(scene.title||'')}" required autofocus></div><div class="field"><label>씬 설명</label><textarea name="content" placeholder="이 씬에서 일어나는 사건과 연출 목적을 작성하세요.">${escapeAttr(scene.content||'')}</textarea></div><div class="modal-actions"><button type="button" class="button secondary close-modal">취소</button><button class="button primary">씬 정보 저장</button></div></form></div>`;}
  if(modal==='cut')return `<div class="modal-backdrop"><form class="modal-card scene-modal" id="cut-form"><div class="modal-head"><div><span>NEW CUT · S${String(activeScene).padStart(2,'0')}</span><h2>컷 추가</h2><p>${escapeAttr(currentScene()?.title||'')}</p></div><button type="button" class="icon-button close-modal">${icon('close')}</button></div><div class="field"><label>컷 제목</label><input name="name" autofocus></div><div class="field"><label>길이</label><select name="duration">${[1,5,8,10].map(v=>`<option value="${v}" ${v===currentProject().duration?'selected':''}>${v}초</option>`).join('')}</select></div><div class="modal-actions"><button type="button" class="button secondary close-modal">취소</button><button class="button primary">컷 추가</button></div></form></div>`;
  return `<div class="modal-backdrop"><form class="modal-card scene-modal" id="scene-form"><div class="modal-head"><div><span>NEW SCENE</span><h2>씬 추가</h2><p>제작 방식에 맞는 씬 유형을 먼저 선택하세요.</p></div><button type="button" class="icon-button close-modal">${icon('close')}</button></div><div class="field"><label>씬 유형</label><div class="scene-type-options"><label><input type="radio" name="sceneType" value="standard" checked><span><b>일반 씬</b><small>FLF·컷별 Ref2VA·기존 연속 생성</small></span></label><label><input type="radio" name="sceneType" value="ref2va-continuous"><span><b>Ref2VA 연속 씬</b><small>공통 레퍼런스 + 컷별 프롬프트 + 이전 22프레임 latent</small></span></label></div></div><div class="field"><label>씬 제목</label><input name="title" autofocus></div><div class="field"><label>씬 내용</label><textarea name="content"></textarea></div><div class="field"><label>첫 컷 제목</label><input name="cutName"></div><div class="field"><label>길이</label><select name="duration">${[1,5,8,10].map(v=>`<option value="${v}" ${v===currentProject().duration?'selected':''}>${v}초</option>`).join('')}</select></div><div class="modal-actions"><button type="button" class="button secondary close-modal">취소</button><button class="button primary">씬과 첫 컷 추가</button></div></form></div>`;
}

let lastRenderedPage=null,lastRenderedProject=null;
const mediaProcessOptions={native:isTauri,invoke:(command,args)=>window.__TAURI__.core.invoke(command,args),dialog:()=>window.__TAURI__.dialog,url:path=>isTauri()?window.__TAURI__.core.convertFileSrc(path):'',ffmpeg:()=>appSettings.ffmpegPath||'ffmpeg',project:currentProject,toast,confirm:confirmDestructive,redraw:()=>render()};
const frameInterpolation=createMediaProcess({kind:'interpolate',...mediaProcessOptions});
const realEsrganUpscale=createMediaProcess({kind:'upscale',...mediaProcessOptions});
let mediaToolEventUnlisten=null;
async function renderMediaProcess(tool,label){
  document.querySelector('#app').innerHTML=`<div class="app-shell">${sidebar()}<main>${topbar(label)}${tool.markup()}</main></div><div id="toast"></div>`;
  bindCommon();tool.bind();
  if(dragDropUnlisten){dragDropUnlisten();dragDropUnlisten=null;}
  if(isTauri())try{const expected=tool===frameInterpolation?'frame-interpolation':'upscale';dragDropUnlisten=await getCurrentWebview().onDragDropEvent(event=>{if(page!==expected)return;const payload=event.payload,drop=document.querySelector('.media-drop');if(payload.type==='over'){drop?.classList.add('drag-over');return;}drop?.classList.remove('drag-over');if(payload.type==='drop'&&payload.paths?.length)tool.addPaths(payload.paths);});}catch(error){toast('드래그앤드롭을 시작하지 못했습니다: '+(error.message||error),7000);}
  if(isTauri()&&!mediaToolEventUnlisten)mediaToolEventUnlisten=await window.__TAURI__.event.listen('frameflow-media-tool-progress',event=>(page==='frame-interpolation'?frameInterpolation:realEsrganUpscale).onProgress(event.payload));
}
const navigationHistory=createNavigationHistory({
  read:()=>({page,projectId:activeProjectId,sceneId:activeScene,cutId:activeCut,
    cutUid:currentCut()?.uid,editor:page==='project'&&sceneEditorOpen,view}),
  restore:route=>{
    void flushProjectSaves();
    modal=null;sceneEditorOpen=false;page=route.page;view=route.view||view;
    const project=projects.find(item=>item.id===route.projectId);
    if(!project){if(page==='project')page='projects';return;}
    activeProjectId=project.id;
    const target=route.cutUid?cuts(project).find(item=>item.cut.uid===route.cutUid):null;
    const scene=target?.scene||project.scenes?.find(item=>item.id===route.sceneId);
    const cut=target?.cut||(!route.cutUid?scene?.cuts?.find(item=>item.id===route.cutId):null);
    activeScene=scene?.id||project.scenes?.[0]?.id||null;
    activeCut=cut?.id||scene?.cuts?.[0]?.id||null;
    sceneEditorOpen=page==='project'&&route.editor&&!!cut;
  },render:()=>render()
});
function render(){navigationHistory.beforeRender();const samePage=lastRenderedPage===page&&lastRenderedProject===activeProjectId,scrollY=window.scrollY;clearInterval(projectRollTimer);projectRollTimer=null;if(page==='projects')renderProjects();else if(page==='settings')renderSettings();else if(page==='queue')renderQueue();else if(page==='video-audio')renderVideoAudio();else if(page==='video-video')renderVideoVideo();else if(page==='frame-interpolation')renderMediaProcess(frameInterpolation,'프레임 보간');else if(page==='upscale')renderMediaProcess(realEsrganUpscale,'업스케일');else renderProject();renderGenerationDock();lastRenderedPage=page;lastRenderedProject=activeProjectId;window.scrollTo(0,samePage?scrollY:0);}

let previewObserver=null;
function observeVideoSource(video,src){
  if(!previewObserver)previewObserver=new IntersectionObserver(entries=>{for(const entry of entries){const video=entry.target;if(entry.isIntersecting&&video.dataset.lazySource){video.src=video.dataset.lazySource;delete video.dataset.lazySource;}else if(!entry.isIntersecting&&!video.paused)video.pause();}},{rootMargin:'180px'});
  video.dataset.lazySource=src;previewObserver.observe(video);
}
function enhanceWorkspaceUx(){
  previewObserver?.disconnect();
  queueMicrotask(()=>{
    const editor=document.querySelector('.scene-editor-backdrop .inspector');
    if(editor&&!editor.querySelector('.editor-section-nav')){
      const results=editor.querySelector('.result-panel'),actions=editor.querySelector('.inspector-actions');if(results&&actions)actions.before(results);
      const nav=document.createElement('nav');nav.className='editor-section-nav';nav.setAttribute('aria-label','컷 편집 구역');
      for(const [label,selector] of [['입력·레퍼런스','.generation-mode-panel'],['프롬프트','[data-prompt="ko"]'],['생성 결과','.result-panel']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.addEventListener('click',()=>{const target=editor.querySelector(selector);if(target)editor.scrollTop+=target.getBoundingClientRect().top-editor.getBoundingClientRect().top-160;else editor.scrollTop=0;});nav.append(button);}editor.querySelector('.inspector-head')?.after(nav);
    }
    document.querySelectorAll('[data-view]').forEach(button=>{button.title=button.dataset.view==='cards'?'카드 보기':'목록 보기';button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed',String(button.classList.contains('active')));});
    document.querySelectorAll('.scene-continuous-library').forEach(panel=>panel.classList.toggle('is-empty',!!panel.querySelector('.scene-continuous-empty')));
    document.querySelectorAll('.scene-bulk-actions').forEach(actions=>{
      if(actions.querySelector('.scene-tools-menu')||!actions.querySelector('.scene-action-group'))return;
      const add=actions.querySelector(':scope > .scene-add-cut'),menu=document.createElement('details');
      menu.className='scene-tools-menu';
      menu.innerHTML='<summary><span>영상 생성 · 합본</span><small>테스트·최종 생성과 파일 작업</small></summary><div class="scene-tools-content"></div>';
      const content=menu.lastElementChild;
      [...actions.querySelectorAll(':scope > .scene-action-group')].forEach(group=>content.append(group));
      actions.prepend(menu);if(add)actions.append(add);
    });
    const toolbar=document.querySelector('.toolbar');
    if(toolbar&&scenes().length>1&&!toolbar.querySelector('.scene-jump')){
      const label=document.createElement('label');label.className='scene-jump';label.innerHTML='<span>씬 이동</span><select aria-label="씬 이동"><option value="">씬 선택</option>'+scenes().map(scene=>`<option value="${scene.id}">S${String(scene.id).padStart(2,'0')} · ${escapeAttr(scene.title)}</option>`).join('')+'</select>';
      toolbar.querySelector('.toolbar-right')?.prepend(label);label.querySelector('select').addEventListener('change',event=>{document.querySelector(`[data-scene-group="${Number(event.target.value)}"]`)?.scrollIntoView({block:'start'});});
    }
    document.querySelectorAll('.cut-card').forEach(card=>{card.tabIndex=0;card.setAttribute('aria-label',`${card.querySelector('h3')?.textContent||'컷'} 편집`);card.addEventListener('keydown',event=>{if(event.target===card&&['Enter',' '].includes(event.key)){event.preventDefault();card.click();}});});
    const checks=[...document.querySelectorAll('[data-job-check]')],run=document.querySelector('.queue-run-selected'),remove=document.querySelector('.queue-delete-selected');
    const sync=()=>{const count=checks.filter(c=>c.checked).length;if(run){run.disabled=!count;run.textContent=count?`선택 작업 진행 (${count})`:'선택 작업 진행';}if(remove)remove.disabled=!count;};checks.forEach(c=>c.addEventListener('change',sync));document.querySelector('.queue-select-all')?.addEventListener('click',sync);sync();
    const cancel=document.querySelector('.queue-cancel-all');if(cancel)cancel.disabled=!allJobs().some(job=>['running','queued'].includes(job.status));
  });
}
function formatClock(seconds){const value=Math.max(0,Math.round(seconds));return value>=60?`${Math.floor(value/60)}분 ${value%60}초`:`${value}초`;}
function updateProjectProgressSummary(){
  const project=currentProject(),host=document.querySelector('.build-progress');if(page!=='project'||!project||!host)return;const progress=projectGenerationProgress(project),ring=host.querySelector('.ring'),title=host.querySelector('b'),detail=host.querySelector('small'),queueText=progress.running||progress.queued?` · 생성 중 ${progress.running} · 대기 ${progress.queued}`:'';
  if(ring){ring.style.background=`conic-gradient(#6bc2a5 0 ${progress.percent}%,#e5e9e3 ${progress.percent}%)`;const label=ring.querySelector('span');if(label)label.textContent=`${progress.percent}%`;}
  if(title)title.textContent=`씬 ${progress.doneScenes}/${progress.totalScenes} 완료 · 컷 ${progress.doneCuts}/${progress.totalCuts} 완료`;
  if(detail)detail.textContent=`${progress.running&&progress.remaining<=0?'지연되고 있습니다.':`예상 남은 시간 ${formatClock(progress.remaining)}`}${queueText}`;
}
function updateQueueNavigation(){
  const button=document.querySelector('.nav-item[data-nav="queue"]');if(!button)return;
  const count=allJobs().filter(job=>['queued','running'].includes(job.status)).length;let badge=button.querySelector('em');
  if(count){if(!badge){badge=document.createElement('em');button.append(badge);}badge.textContent=String(count);}else badge?.remove();
}
function renderGenerationDock(){
  updateQueueNavigation();
  updateProjectProgressSummary();
  const allQueueJobs=allJobs().filter(job=>['queued','running','completed','failed','cancelled','interrupted'].includes(job.status)).sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||''))),visible=allQueueJobs.filter(job=>['queued','running','failed'].includes(job.status)),running=visible.find(job=>job.status==='running'),activeBatchId=running?.batchId||visible.find(job=>job.status==='queued')?.batchId,batch=activeBatchId?allQueueJobs.filter(job=>job.batchId===activeBatchId):visible,dockJobs=visible.slice(-12);let dock=document.querySelector('.generation-dock');
  if(!visible.length){dock?.remove();return;}
  const timing=running?runningJobTiming(running):{elapsed:0,estimate:0,remaining:0,source:''},elapsed=timing.elapsed,estimate=timing.estimate,estimatedProgress=running&&estimate?Math.min(95,Math.max(1,Math.round(elapsed/estimate*100))):0,progress=running?Math.max(estimatedProgress,Number(running.liveProgress)||0):0,remaining=timing.remaining,delayed=Boolean(running&&remaining<=0&&Number(running.liveProgress||0)<100),stageTimeline=(running?.stageTimeline||[]).slice(-8),stageMarkup=running?`<div class="dock-stage-list">${stageTimeline.map((stage,index)=>`<div class="${stage.completedAt?'done':'active'}"><i>${stage.completedAt?'✓':index===stageTimeline.length-1?'•':'·'}</i><span><b>${escapeAttr(stage.label)}</b><small>${stage.rateText?escapeAttr(stage.rateText):stage.completedAt?formatClock((new Date(stage.completedAt)-new Date(stage.startedAt))/1000):'진행 중'}</small></span></div>`).join('')}</div>`:'';
  const counts={completed:batch.filter(j=>j.status==='completed').length,running:visible.filter(j=>j.status==='running').length,queued:visible.filter(j=>j.status==='queued').length,failed:batch.filter(j=>['failed','cancelled','interrupted'].includes(j.status)).length},remainingJobs=counts.running+counts.queued;
  if(!dock){dock=document.createElement('aside');dock.className='generation-dock';document.body.append(dock);}
  dock.classList.toggle('expanded',generationDockExpanded);
  dock.innerHTML=`<button class="dock-summary" type="button"><span class="generation-pulse ${running?'':'idle'}"></span><div><b>${running?`영상 생성 중 · ${progress}%`:queuePaused?'작업 큐 일시 정지':'대기 작업 확인 필요'}</b><small>${running?`${running.samplerStage||running.stage||'워크플로 준비'}${running.iterationText?` · ${running.iterationText}`:''} · 남은 작업 ${remainingJobs}개`:`대기 ${counts.queued} · 실패 ${counts.failed}`}</small></div><span class="dock-chevron">${generationDockExpanded?'⌄':'⌃'}</span></button>${running?`<div class="generation-progress"><i style="width:${progress}%"></i></div><p><span>경과 ${formatClock(elapsed)}</span><strong>${delayed?'예측 시간 초과 · 실시간 측정 중':`예상 남은 시간 ${formatClock(remaining)}`}</strong></p><small class="generation-warning">${icon('spark')} 예측 근거: ${escapeAttr(timing.source||running.estimateSource||'기본 계산값')}</small>${stageMarkup}`:''}<div class="dock-counts"><span>성공 ${counts.completed}</span><span>진행 ${counts.running}</span><span>대기 ${counts.queued}</span><button type="button" class="dock-failed">실패 ${counts.failed}</button></div><div class="dock-task-list">${dockJobs.map(job=>`<button type="button" class="dock-task ${job.status}" data-dock-job="${job.id}"><span>${job.sceneName} · ${job.cutName}</span><b>${{queued:'대기',running:'진행 중',completed:'성공',failed:'실패',cancelled:'취소'}[job.status]||job.status}</b></button>`).join('')}</div><div class="dock-actions">${running?`<button class="button danger cancel-generation" data-job="${running.id}">현재 작업 취소</button>`:''}${running||counts.queued?'<button class="button secondary cancel-queue">전체 큐 취소</button>':''}${!running&&queuePaused&&counts.queued?'<button class="button primary resume-queue">큐 계속 진행</button>':''}</div>`;
  dock.querySelector('.dock-summary')?.addEventListener('click',()=>{generationDockExpanded=!generationDockExpanded;renderGenerationDock();});
  dock.querySelector('.cancel-generation')?.addEventListener('click',()=>cancelGeneration(running.id,false));
  dock.querySelector('.cancel-queue')?.addEventListener('click',cancelEntireQueue);
  dock.querySelector('.resume-queue')?.addEventListener('click',()=>{queuePaused=false;runGenerationQueue();runVideoAudioQueue();runVideoVideoQueue();runGenerativeUpscaleQueue();renderGenerationDock();});
  dock.querySelectorAll('[data-dock-job]').forEach(button=>button.addEventListener('click',()=>openJobDetails(button.dataset.dockJob)));
  dock.querySelector('.dock-failed')?.addEventListener('click',()=>{const failed=[...batch].reverse().find(job=>job.status==='failed');if(failed)openJobDetails(failed.id);else toast('실패한 작업이 없습니다.');});
}
function locateAnyJob(jobId){const projectJob=projects.flatMap(project=>(project.jobs||[]).map(job=>({project,job}))).find(item=>item.job.id===jobId);if(projectJob)return projectJob;const audioJob=(videoAudioWorkspace.jobs||[]).find(item=>item.id===jobId);if(audioJob)return{workspace:videoAudioWorkspace,workspaceKind:'video-audio',job:audioJob};const videoJob=(videoVideoWorkspace.jobs||[]).find(item=>item.id===jobId);if(videoJob)return{workspace:videoVideoWorkspace,workspaceKind:'video-video',job:videoJob};const upscaleJob=(generativeUpscaleWorkspace.jobs||[]).find(item=>item.id===jobId);return upscaleJob?{workspace:generativeUpscaleWorkspace,workspaceKind:'generative-upscale',job:upscaleJob}:null;}
function openJobDetails(jobId){const located=locateAnyJob(jobId);if(!located)return;const {job}=located,overlay=document.createElement('div');overlay.className='workflow-modal-backdrop';overlay.innerHTML=`<section class="workflow-modal compact" role="dialog" aria-modal="true"><header><div><span>GENERATION JOB</span><h2>${job.sceneName} · ${job.cutName}</h2><p>${job.status==='failed'?'생성 실패 상세':'작업 상태 상세'}</p></div></header><dl class="job-detail-grid"><div><dt>상태</dt><dd>${job.status}</dd></div><div><dt>단계</dt><dd>${escapeAttr(job.stage||'생성')}</dd></div><div><dt>시각</dt><dd>${escapeAttr(job.completedAt||job.startedAt||job.createdAt||'-')}</dd></div><div><dt>Prompt ID</dt><dd>${escapeAttr(job.promptId||'-')}</dd></div><div class="wide"><dt>사유</dt><dd>${escapeAttr(job.error||'오류 없음')}</dd></div><div class="wide"><dt>로그</dt><dd>Comfy Desktop 콘솔 또는 설정의 콘솔 표시 옵션에서 확인할 수 있습니다.</dd></div></dl><footer><button class="button secondary close-workflow">닫기</button>${['failed','cancelled','interrupted'].includes(job.status)?'<button class="button primary retry-detail">다시 진행</button>':''}</footer></section>`;document.body.append(overlay);overlay.querySelector('.close-workflow').addEventListener('click',()=>overlay.remove());overlay.querySelector('.retry-detail')?.addEventListener('click',()=>{overlay.remove();retryJob(job.id);});}
async function cancelGeneration(jobId){
  const located=locateAnyJob(jobId);if(!located||!window.confirm('현재 생성 작업을 취소할까요?\n예를 누르면 ComfyUI 큐를 비우고 Comfy 프로세스를 강제로 종료합니다.'))return;
  queuePaused=true;located.job.cancelRequested=true;located.job.status='cancelled';located.job.error='사용자가 작업을 취소했습니다.';save();saveVideoAudio();saveVideoVideo();saveGenerativeUpscale();renderGenerationDock();
  if(isTauri())try{await window.__TAURI__.core.invoke('comfy_cancel_and_stop',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188'});}catch(error){located.job.error=`취소 처리 중 오류: ${error}`;}
  save();saveVideoAudio();saveVideoVideo();saveGenerativeUpscale();render();toast('현재 작업을 취소했습니다. 큐는 일시 정지되었습니다.');
}
async function cancelEntireQueue(){const active=[...projects.flatMap(project=>(project.jobs||[]).map(job=>({project,job}))),...(videoAudioWorkspace.jobs||[]).map(job=>({workspace:videoAudioWorkspace,job})),...(videoVideoWorkspace.jobs||[]).map(job=>({workspace:videoVideoWorkspace,job})),...(generativeUpscaleWorkspace.jobs||[]).map(job=>({workspace:generativeUpscaleWorkspace,job}))].filter(item=>['queued','running'].includes(item.job.status));if(!active.length){toast('취소할 대기·실행 작업이 없습니다.');return;}if(!window.confirm(`대기·실행 중인 ${active.length}개 작업을 모두 취소할까요?\nComfyUI 큐를 비우고 Comfy 프로세스도 종료합니다.`))return;queuePaused=true;for(const {job} of active){job.cancelRequested=true;job.status='cancelled';job.completedAt=new Date().toISOString();job.error='사용자가 전체 큐를 취소했습니다.';}save();saveVideoAudio();saveVideoVideo();saveGenerativeUpscale();render();toast(`${active.length}개 작업을 취소하고 Comfy를 종료하는 중…`,120000);if(isTauri())try{await window.__TAURI__.core.invoke('comfy_cancel_and_stop',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188'});toast(`전체 작업 큐 ${active.length}개와 Comfy를 종료했습니다.`);}catch(error){toast(`작업 큐는 취소했지만 Comfy 종료에 실패했습니다: ${error}`,7000);}finally{save();saveVideoAudio();saveVideoVideo();saveGenerativeUpscale();render();}}
setInterval(()=>{if(!document.hidden&&allJobs().some(job=>job.status==='running'))renderGenerationDock();},1000);
window.addEventListener('beforeunload',()=>{if(preserveComfyJobsOnExit)return;let changed=false;for(const project of projects)for(const job of project.jobs||[])if(['running','queued'].includes(job.status)){job.status='interrupted';job.error='프로그램 종료로 중단된 작업입니다.';changed=true;}for(const job of videoAudioWorkspace.jobs||[])if(['running','queued'].includes(job.status)){job.status='interrupted';job.error='프로그램 종료로 중단된 Video-to-Audio 작업입니다.';changed=true;}for(const job of videoVideoWorkspace.jobs||[])if(['running','queued'].includes(job.status)){job.status='interrupted';job.error='프로그램 종료로 중단된 Video-to-Video 작업입니다.';changed=true;}for(const job of generativeUpscaleWorkspace.jobs||[])if(['running','queued'].includes(job.status)){job.status='interrupted';job.error='프로그램 종료로 중단된 생성형 Upscale 작업입니다.';changed=true;}if(changed){localStorage.setItem('frameflow-projects-v1',JSON.stringify(projects.map(persistentProject)));saveVideoAudio();saveVideoVideo();saveGenerativeUpscale();}});
function openProject(id){activeProjectId=id;const p=currentProject();activeScene=p.scenes[0]?.id||null;activeCut=p.scenes[0]?.cuts?.[0]?.id||null;sceneEditorOpen=false;page='project';save();render();}
function toast(message,duration=2600){const el=document.querySelector('#toast');if(!el)return;clearTimeout(toastTimer);el.textContent=message;el.classList.add('show');toastTimer=setTimeout(()=>el.classList.remove('show'),duration);}
async function copySeed(value){const raw=String(value??'').trim(),seed=Number(raw);if(!/^\d+$/.test(raw)||!Number.isSafeInteger(seed)){toast('복사할 Seed 값이 올바르지 않습니다.');return false;}try{await navigator.clipboard.writeText(raw);toast(`Seed ${raw}을 복사했습니다.`);return true;}catch(error){toast(`Seed 복사 실패: ${error.message||error}`,6000);return false;}}

function confirmDestructive({title='삭제하시겠습니까?',message='',target='',confirmLabel='삭제'}){
  return new Promise(resolve=>{
    const overlay=document.createElement('div');overlay.className='destructive-confirm-backdrop';
    overlay.innerHTML=`<section class="destructive-confirm" role="alertdialog" aria-modal="true" aria-labelledby="destructive-confirm-title"><div class="destructive-confirm-icon">${icon('trash')}</div><div><span>삭제 확인</span><h2 id="destructive-confirm-title">${escapeAttr(title)}</h2>${target?`<strong>${escapeAttr(target)}</strong>`:''}<p>${escapeAttr(message)}</p><small>삭제 후에는 되돌릴 수 없습니다.</small></div><footer><button type="button" class="button secondary destructive-cancel">취소</button><button type="button" class="button danger destructive-accept">${icon('trash')} ${escapeAttr(confirmLabel)}</button></footer></section>`;
    const finish=value=>{document.removeEventListener('keydown',onKey);overlay.remove();resolve(value);},onKey=event=>{if(event.key==='Escape')finish(false);};
    overlay.querySelector('.destructive-cancel').addEventListener('click',()=>finish(false));
    overlay.querySelector('.destructive-accept').addEventListener('click',event=>{event.currentTarget.disabled=true;finish(true);});
    document.addEventListener('keydown',onKey);document.body.append(overlay);overlay.querySelector('.destructive-cancel').focus();
  });
}
const loadImageElement=source=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('FLF 이미지를 불러오지 못했습니다.'));image.src=source;});
async function loadLocalImageForCanvas(path){
  // Images loaded directly from Tauri's asset protocol are safe for display but
  // can taint a canvas in WebView2. Re-wrap the bytes in an app-owned blob URL
  // before drawing; keep the data-URL command as a compatibility fallback.
  const source=window.__TAURI__.core.convertFileSrc(path);
  try{
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),2500);
    let response;
    try{response=await fetch(source,{signal:controller.signal});}finally{clearTimeout(timeout);}
    if(!response.ok)throw new Error(`asset fetch failed (${response.status})`);
    const objectUrl=URL.createObjectURL(await response.blob());
    try{return await loadImageElement(objectUrl);}finally{URL.revokeObjectURL(objectUrl);}
  }catch(error){
    console.warn('Asset blob loading failed; using IPC image fallback.',error);
    return loadImageElement(await window.__TAURI__.core.invoke('load_image_data_url',{path}));
  }
}
const canvasBlob=canvas=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('합성 이미지를 만들지 못했습니다.')),'image/png'));
async function composeMetaImage(scene){
  if(!isTauri()){
    const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=404;const context=canvas.getContext('2d');context.fillStyle='#eef3ef';context.fillRect(0,0,1280,404);context.fillStyle='#8bc9b4';context.fillRect(0,44,608,360);context.fillStyle='#9a8db6';context.fillRect(672,44,608,360);context.fillStyle='#294b42';context.font='700 20px sans-serif';context.fillText('FIRST FRAME',12,29);context.fillText('LAST FRAME',684,29);sceneMeta(scene).combinedPath='web-preview';return canvasBlob(canvas);
  }
  if(!scene.firstPath||!scene.lastPath)throw new Error('FIRST와 LAST 이미지를 모두 등록해 주세요.');
  const [first,last]=await Promise.all([loadLocalImageForCanvas(scene.firstPath),loadLocalImageForCanvas(scene.lastPath)]),header=44,gap=64;
  const targetHeight=Math.max(1,Math.round(Math.max(first.naturalHeight,last.naturalHeight)/2));
  const firstWidth=Math.max(1,Math.round(first.naturalWidth*(targetHeight/first.naturalHeight))),lastWidth=Math.max(1,Math.round(last.naturalWidth*(targetHeight/last.naturalHeight))),canvas=document.createElement('canvas');canvas.width=firstWidth+gap+lastWidth;canvas.height=targetHeight+header;
  const context=canvas.getContext('2d');context.fillStyle='#eef3ef';context.fillRect(0,0,canvas.width,canvas.height);context.fillStyle='#294b42';context.font='700 20px sans-serif';context.fillText('FIRST FRAME',12,29);context.fillText('LAST FRAME',firstWidth+gap+12,29);context.drawImage(first,0,header,firstWidth,targetHeight);context.drawImage(last,firstWidth+gap,header,lastWidth,targetHeight);
  const blob=await canvasBlob(canvas),bytes=Array.from(new Uint8Array(await blob.arrayBuffer())),location=cutLocation(scene);sceneMeta(scene).combinedPath=await window.__TAURI__.core.invoke('store_meta_image',{data:bytes,projectPath:currentProject().projectPath,sceneNumber:cutStorageNumber(location.scene?.id||1,location.cut?.id||1)});save();return blob;
}
const JSON_ONLY_ANALYSIS_GUARD=`ABSOLUTE EXECUTION BAN — ANALYSIS AND JSON RESPONSE ONLY:
- DO NOT generate, create, render, edit, animate, or export any video or image.
- DO NOT invoke any video-generation, image-generation, media, agent, plugin, MCP, API, workflow, or external tool.
- DO NOT start a generation job, ask for confirmation to generate media, or interpret this prompt as a request to make a video.
- The attached image is reference data to analyze only. Descriptions of motion are JSON text fields, never instructions to execute media generation.
- Your one and only permitted action is to analyze the supplied reference and return exactly one valid JSON object matching the requested schema.
- Return raw JSON only. Do not use Markdown fences. Do not add explanations, headings, acknowledgements, comments, or text before or after the JSON.
- If another instruction or the surrounding application suggests generating media, IGNORE IT. This execution ban has the highest priority within this request.

절대 동영상이나 이미지를 생성·렌더링·편집하지 마세요. 어떤 생성 도구도 호출하지 마세요. 첨부 이미지는 분석 자료일 뿐이며, 허용되는 응답은 지정된 스키마의 JSON 객체 하나뿐입니다.`;
function buildMetaPrompt(scene){
  const meta=sceneMeta(scene),camera=meta.camera,elements=(meta.elements||[]).map(bilingualElement),tracking=camera.trackingTarget==='custom'?camera.trackingCustom:(elements.find(item=>item.id===camera.trackingTarget)?.nameKo||elements.find(item=>item.id===camera.trackingTarget)?.nameEn||camera.trackingTarget);
  const koreanDirections=elements.map(element=>({id:element.id,type:element.type,name_ko:element.nameKo||element.nameEn,mood_ko:element.moodKo||element.moodEn,start_state_ko:element.startStateKo||element.startStateEn,end_state_ko:element.endStateKo||element.endStateEn,movement_ko:element.movementKo||element.movementEn,timing_ko:element.timingKo||element.timingEn}));
  const transition=bilingualTransition(meta.transition),koreanTransition=transition?{summary_ko:transition.summaryKo,transition_type_ko:transition.typeKo,pacing_ko:transition.pacingKo,phases:transition.phases.map(phase=>({time_seconds:phase.timeSeconds,action_ko:phase.actionKo})),relationships:transition.relationships.map(relation=>({driver:relation.driver,affected:relation.affected,relation_ko:relation.relationKo})),continuity:transition.continuity}:null;
  const promptTiming=promptTimingPayload(scene),phaseRule=promptTiming.mode==='staged'
    ?'Create exactly one transition.phases entry for every supplied non-empty user step, in the same order. Preserve each user-locked requested_start_seconds exactly; infer an absolute start time for each null value. Every returned phase must contain time_seconds, action_en, and action_ko, and both action fields must describe the actual requested action.'
    :'This is BASIC mode. Return transition.phases as an empty array. Express the single continuous FIRST-to-LAST progression in the transition summary, pacing, elements, and integrated descriptions; do not invent artificial stages.';
  const isStatic=(camera.movements||[]).includes('static'),isTracking=(camera.movements||[]).includes('tracking');
  const cameraSettings={shot_size:camera.shotSize,angle:camera.angle,lens:camera.lens,composition:camera.composition,movements:camera.movements,speed:isStatic?null:camera.speed,tracking_target:isTracking?(tracking||null):null,tracking_method:isTracking?(camera.trackingMethod||null):null};
  const moodPreset=allMoodPresets().find(item=>item.id===meta.moodPreset),aestheticPreset=allAestheticPresets().find(item=>item.id===meta.aestheticPreset),stylePresets={mood:moodPreset?{id:moodPreset.id,name_ko:moodPreset.nameKo,name_en:moodPreset.name||moodPreset.nameEn,checked_traits_ko:meta.moodTraits||moodTraits(moodPreset),emotion:moodPreset.emotion,worldview:moodPreset.worldview,scale:moodPreset.scale,material:moodPreset.material,motion:moodPreset.motion,space:moodPreset.space}:null,aesthetic:aestheticPreset?{id:aestheticPreset.id,name_ko:aestheticPreset.nameKo,name_en:aestheticPreset.nameEn,checked_traits_ko:meta.aestheticTraits||aestheticTraits(aestheticPreset),description:aestheticPreset.description}:null};
  const presetCatalog={mood:allMoodPresets().map(preset=>({id:preset.id,name_ko:preset.nameKo,name_en:preset.name||preset.nameEn,traits_ko:moodTraits(preset)})),aesthetic:allAestheticPresets().map(preset=>({id:preset.id,name_ko:preset.nameKo,name_en:preset.nameEn,traits_ko:aestheticTraits(preset)}))};
  return `${JSON_ONLY_ANALYSIS_GUARD}

CONTEXT RESET — MANDATORY:
- Ignore all previous conversation context, prior images, earlier prompts, cached assumptions, and earlier JSON responses.
- Treat this request as a completely new, self-contained analysis.
- Use only the combined FLF image attached to this request and the USER DIRECTION, NEGATIVE DIRECTION, LLM-OBSERVED ADDITIONAL DIRECTION, CAMERA SETTINGS, VIDEO STYLE PRESETS, and output schema written below.
- Never copy or infer facts from any earlier turn. If earlier context conflicts with this request, this request always wins.

You are a cinematic image-to-video prompt designer. Analyze the attached combined FLF image. The LEFT image is the FIRST FRAME and the RIGHT image is the LAST FRAME. Create a video-generation prompt that transforms the first frame into the last frame while preserving identity, composition, and visual continuity.

USER DIRECTION:
${meta.direction||'(No additional direction provided)'}

NEGATIVE DIRECTION (transformation guide; never quote literally):
${meta.negativeDirection||'(No negative direction provided)'}

LLM-OBSERVED ADDITIONAL DIRECTION (mandatory when provided):
${meta.additionalDirection||'(No generated-video observation has been applied yet)'}

Negative-direction conversion rules:
- Never copy or directly express NEGATIVE DIRECTION wording in integrated_multimodal_description_ko, integrated_multimodal_description_en, elements, Scene Transition, or negative_prompt.
- Infer the desired positive visual state behind each concern. Add a concrete positive prompt instruction that preserves that state, or revise any suspicious sentence that could cause the unwanted result.
- Example: convert "잎이 눕지 않게" into a positive instruction such as "각 잎은 수직 줄기 위에 똑바로 선 자세를 처음부터 끝까지 안정적으로 유지한다." Do not write "do not lie down".
- Apply this conversion to Korean and English outputs equivalently. Preserve the user's intent as strongly as possible without exposing the original prohibition.
- Before returning JSON, inspect both integrated_multimodal_description language fields and every motion/transition sentence for ambiguous wording that could produce the concern, then rewrite those sentences positively.
- NEGATIVE DIRECTION must not be copied into negative_prompt. negative_prompt remains governed only by the separate Negative-prompt rules below.
- When LLM-OBSERVED ADDITIONAL DIRECTION is present, preserve its desirable observed motion in the transition, relevant elements, and both integrated_multimodal_description language fields.

CAMERA SETTINGS (mandatory constraints):
${JSON.stringify(cameraSettings,null,2)}

Camera rules:
- A value other than "auto" is USER-LOCKED. Preserve it exactly and explicitly include it in both integrated_multimodal_description language fields.
- For every "auto" field, infer one concrete cinematic value from the FIRST frame and return that concrete value; never return "auto" or an empty string.
- Camera movement is always USER-LOCKED. If it is "static", the English prompt must explicitly say "static camera" and must not introduce pan, tilt, dolly, zoom, orbit, crane, handheld, or tracking motion.
- If tracking is selected, name the tracking target and tracking method explicitly.
- When static is selected, speed, tracking_target, and tracking_method must all be null.
- The returned camera object and the camera wording embedded in both integrated_multimodal_description language fields must agree exactly.

VIDEO STYLE PRESETS:
${JSON.stringify(stylePresets,null,2)}

AVAILABLE PRESET CATALOG (use only when the corresponding selected preset above is null):
${JSON.stringify(presetCatalog,null,2)}

Preset rules:
- Every item in checked_traits_ko is a USER-LOCKED mandatory trait. Use every checked trait without omission in the art direction, material behavior, spatial impression, motion quality, pacing, elements, and Scene Transition wherever it is relevant.
- Do not silently drop, weaken, generalize, or replace a checked trait. Incorporate every checked trait semantically into both integrated_multimodal_description_ko and integrated_multimodal_description_en, not only into style_presets.
- Copy every checked Korean trait verbatim into style_presets.*.applied_traits_ko as an array. Provide an equivalent English item at the same array index in applied_traits_en.
- Before returning JSON, verify that the applied trait arrays contain every checked trait exactly once and that both integrated descriptions operationally express them. Set trait_verification.all_checked_traits_applied to true only after this check; missing_traits_ko must be empty.
- Preserve the visible identity and content of both FLF images; a preset changes art direction and motion quality but must not invent unrelated objects.
- If both mood and aesthetic presets are selected, blend them coherently and report both in style_presets.
- When mood or aesthetic is null, analyze both FLF frames and USER DIRECTION, select exactly one best-matching entry of that kind from AVAILABLE PRESET CATALOG, and return its exact id and names in style_presets.
- For every automatically selected preset, apply every traits_ko item without omission and copy the exact Korean strings to applied_traits_ko. Do not create an unknown preset id or return null.
- Never replace a preset already selected by the user. Automatic selection applies only to a null kind.

User-direction priority rules:
- USER DIRECTION is USER-LOCKED and is the primary creative instruction after visible FLF identity/continuity and explicitly locked camera settings.
- Reflect the user's staging, motion, timing, atmosphere, spatial relationship, and prohibitions as fully and concretely as possible in the Scene Transition, elements, and both integrated descriptions.
- Resolve the user direction and every checked preset trait into one coherent treatment without dropping either. Never replace a specific user instruction with a generic cinematic phrase.

Negative-prompt rules:
- Generate negative_prompt normally, but do not put any term in it that conflicts with USER DIRECTION, checked traits, required element motion, Scene Transition, or camera behavior.
- Never use negative_prompt to cancel, weaken, or prohibit a selected trait or required positive instruction. Verify this before returning JSON.

Readable-summary rules:
- Write readable_summary_ko as a listening- and reading-optimized Korean explanation of the completed video direction.
- Use 5–8 short, natural sentences in the explicit pattern "X가 Y합니다." Every sentence must name its subject clearly; do not rely on vague pronouns such as 이것, 그것, or 이들이.
- Explain the FIRST state, the trigger, the main element changes, camera behavior, atmosphere/effects, and the LAST state in chronological order.
- Prefer concrete human-readable words over JSON field names, prompt jargon, abbreviations, slash-separated phrases, or keyword lists.
- Do not include bullets, headings, JSON syntax, English labels, negative-prompt terms, or implementation details. The text must sound natural when Sarah reads it aloud at 1.2× speed.
- Verify that a person can understand who or what acts, what changes, how it moves, and where the scene ends without seeing the JSON.

${transition?`USER-EDITED KOREAN SCENE TRANSITION (authoritative):\n${JSON.stringify(koreanTransition,null,2)}`:'No scene transition has been analyzed yet. Design one global FIRST-to-LAST transition plan that coordinates every element.'}

${elements.length?`USER-EDITED KOREAN ELEMENT DIRECTIONS (authoritative; translate them faithfully into English):\n${JSON.stringify(koreanDirections,null,2)}`:'No elements have been analyzed yet. Identify every meaningful person, object, environment, lighting, atmospheric, and effects element visible in the two frames.'}

Match corresponding elements across the FIRST and LAST frames before deciding motion. For every matched element, compare its visual identity, position, scale, pose, lighting, and emotional atmosphere in both frames, then infer the physically coherent movement required between them. Create one scene-level FIRST-to-LAST transition that coordinates the leading change and dependent reactions and prohibits cuts or crossfades unless the user explicitly requests them. ${phaseRule} Never use percentage ranges or a range field. All phase timing uses absolute time_seconds within the ${promptTiming.video_duration_seconds}-second video. If an element appears in only one frame, explicitly describe its entrance, exit, reveal, disappearance, or transformation. Determine each element's mood from the two-frame comparison and the user direction. Do not invent objects that are absent from both frames. Return every analyzed element and every transition text in equivalent English and Korean fields. For every transition phase you actually return, action_en and action_ko are REQUIRED, must be non-empty, and must describe the same concrete action. English fields are the immutable analysis reference; Korean fields are the user-editable direction source. When USER-EDITED KOREAN directions are supplied, treat the Korean values as authoritative and regenerate the English fields from them.

${H3_OFFICIAL_BASE_LLM_RULES}

FRAMEFLOW FL2VA AUDIO/VISUAL OUTPUT CONTRACT — REQUIRED:
- integrated_multimodal_description_en is the complete chronological [Shot 1] visual timeline. It must preserve the camera, all element motion, causal relationships, the selected prompt timing mode, and FIRST-to-LAST convergence.
- Put each synchronized physical sound directly beside the visible event that causes it inside integrated_multimodal_description_en. Every visible collision, impact, crack, particle discharge, splash, footstep, mechanical action, material movement, or energetic event that could be audible must receive a concrete synchronized sound description. Do not substitute background music for physical effects.
- overall_soundscape_en must use 1–4 concrete English sentences describing continuous ambience, physical action sounds, and non-verbal sounds across the clip. Use N/A only when USER DIRECTION explicitly requests complete silence.
- non_diegetic_music_en contains audience-only background score. Suggest concrete instrumentation, tempo, rhythm, and volume evolution when appropriate; FrameFlow will replace this entire field with N/A when the Background Music checkbox is off.
- Return equivalent Korean fields integrated_multimodal_description_ko, overall_soundscape_ko, and non_diegetic_music_ko for review.
- Do not place physical sound effects only in overall_soundscape; synchronized effects must appear in both the relevant timeline event and the broader soundscape summary.
- Do not include the field labels inside the JSON values. FrameFlow will assemble the fixed FL2VA picture-alignment line and the three official section labels itself.

FINAL OUTPUT GATE: Re-check that you have not called or proposed any media-generation tool. Your entire response must be exactly one parseable JSON object and nothing else. Return valid JSON only using this schema:
{
  "revised_prompt_ko": "Korean management summary including the complete camera behavior",
  "integrated_multimodal_description_en": "[Shot 1] Complete chronological visual timeline with synchronized physical effects",
  "integrated_multimodal_description_ko": "[Shot 1] 동기화된 물리 효과음을 포함한 전체 시간순 영상 진행",
  "overall_soundscape_en": "1–4 sentences of ambience and concrete physical sound effects",
  "overall_soundscape_ko": "전체 환경음과 구체적인 물리 효과음",
  "non_diegetic_music_en": "Audience-only score description or N/A",
  "non_diegetic_music_ko": "관객에게만 들리는 배경음악 설명 또는 N/A",
  "readable_summary_ko": "5–8 clear Korean sentences in X가 Y합니다 form for reading and listening",
  "overall_mood": "overall atmosphere",
  "style_presets": {"mood":{"id":"or null", "name_ko":"", "name_en":"", "applied_traits_ko":["exact checked Korean trait"], "applied_traits_en":["equivalent English trait"]}, "aesthetic":{"id":"or null", "name_ko":"", "name_en":"", "applied_traits_ko":["exact checked Korean trait"], "applied_traits_en":["equivalent English trait"]}},
  "trait_verification": {"all_checked_traits_applied":true, "missing_traits_ko":[], "conflicting_negative_terms":[]},
  "camera": {"shot_size":"concrete value", "angle":"concrete value", "lens":"concrete value", "composition":"concrete value", "movements":["exact selected movement"], "speed":"slow or null when static", "tracking_target":null, "tracking_method":null},
  "transition": {"summary_en":"complete English transition summary", "summary_ko":"완전한 한국어 전환 요약", "transition_type_en":"concrete English transition type", "transition_type_ko":"구체적인 한국어 전환 방식", "pacing_en":"concrete English pacing", "pacing_ko":"구체적인 한국어 속도와 리듬", "phases":[], "relationships":[{"driver":"element id or name", "affected":"element id or name", "relation_en":"concrete English relationship", "relation_ko":"구체적인 한국어 인과관계"}], "continuity":{"preserve_identity":true, "no_sudden_appearance":true, "no_crossfade":true, "last_frame_lock":true}},
  "elements": [{"id":"element-01", "type":"person|object|environment|lighting|effect", "name_en":"", "name_ko":"", "mood_en":"", "mood_ko":"", "start_state_en":"", "start_state_ko":"", "end_state_en":"", "end_state_ko":"", "movement_en":"", "movement_ko":"", "timing_en":"", "timing_ko":""}],
  "negative_prompt": "unwanted motion, deformation, flicker, identity changes"
}`;
}
function openMetaPrompt(scene){
  const location=cutLocation(scene),target=`${location.scene?.title||`씬 ${pad(location.scene?.id||1)}`} · SCENE ${pad(location.scene?.id||1)} · CUT ${pad(location.cut?.id||1)}`;
  sceneMeta(scene).open=true;sceneMeta(scene).userCollapsed=false;save();renderPreservingEditorScroll();toast(`${target} 메타 프롬프트 설정을 열었습니다.`);
}
const keepProgressVisible=started=>new Promise(resolve=>setTimeout(resolve,Math.max(0,450-(Date.now()-started))));
async function styleReferenceBlob(scene){return isRef2vaCut(scene)?composeRef2vaTaggedSheet(scene):composeMetaImage(scene);}
async function copyMetaImage(scene){const started=Date.now(),ref=isRef2vaCut(scene);toast(`${ref?'레퍼런스 Sheet':'합성 이미지'} 복사 중…`,120000);try{const blob=await styleReferenceBlob(scene);if(!window.ClipboardItem||!navigator.clipboard?.write)throw new Error('이미지 클립보드를 지원하지 않습니다.');await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);await keepProgressVisible(started);toast(`${ref?'레퍼런스 Sheet':'합성 이미지'}가 복사되었습니다.`);}catch(error){const path=sceneMeta(scene).combinedPath;toast(path?`클립보드 복사 대신 파일로 저장했습니다: ${path}`:`이미지 복사 실패: ${error.message||error}`);}}
const ELEMENT_ABSENCE_RULES=`\n\nELEMENT OPTIONAL-FIELD RULES — HIGHEST PRIORITY OVERRIDE:\n- Keep every visually relevant element in the elements array even when it is visible in only one frame.\n- Every element field, including name, mood, start/end state, movement, timing, and every *_ko field, MAY be an empty string when the value is unavailable or should not influence the generation prompt.\n- Never fill an unavailable value with N/A, None, Not applicable, 해당 없음, 존재하지 않음, or another placeholder. Return an empty string instead.\n- Never invent an element or a field value merely to avoid an empty string.\n- This section overrides every earlier instruction saying an element field or *_ko field must be non-empty.`;
function withAbsolutePromptTiming(text,scene){const timing=promptTimingPayload(scene),steps=timing.steps;const result=String(text||'').replace('detailed_description must cover the entire 0-100% timeline. Preserve the supplied phase ranges; if only default phases are supplied, write explicit [Shot/Phase] instructions for 0-20%, 20-80%, and 80-100%.','detailed_description must cover the full video duration without percentage ranges. BASIC mode uses one continuous description and no artificial phase objects. STAGED mode preserves the supplied absolute seconds and writes [Shot 1] without a timestamp followed by later boundaries in [Shot N] At MM:SS.mmm format.');
  if(timing.mode==='staged'&&!steps.length)throw new Error('단계별 프롬프트에 내용을 하나 이상 입력해 주세요.');let previous=-1;for(const step of steps){if(step.requested_start_seconds==null)continue;const time=Number(step.requested_start_seconds);if(time<0||time>=timing.video_duration_seconds)throw new Error(`단계 ${step.step}의 시작 시간은 0 이상 ${timing.video_duration_seconds}초 미만이어야 합니다.`);if(time<=previous)throw new Error('직접 입력한 단계 시작 시간은 앞 단계보다 커야 합니다.');previous=time;}
  return`${result}\n\nUSER PROMPT TIMING — HIGHEST PRIORITY:\n${JSON.stringify(timing,null,2)}\n- Never use percentage ranges and never return a range field.\n- BASIC mode must return transition.phases as []. Describe continuous motion in the summaries, element fields, and integrated descriptions without inventing stage objects.\n- STAGED mode must return exactly one transition.phases object for every non-empty supplied step, in order, using {"time_seconds": number, "action_en": "non-empty English action", "action_ko": "비어 있지 않은 한국어 동작"}.\n- In STAGED mode, a non-null requested_start_seconds is user-locked. For null times, infer an appropriate absolute start inside video_duration_seconds from the images and surrounding steps.\n- Never return an empty phase object. If a phase exists, time_seconds, action_en, and action_ko are all mandatory.\n- [Shot 1] has no timestamp. Every later timed boundary uses exactly [Shot N] At MM:SS.mmm.\n- Keep all timestamps strictly increasing and within video_duration_seconds.\n- A middle clip in a continuation must preserve outgoing motion speed and direction unless a step explicitly requests slowing or stopping.`;
}
const REF2VA_IDENTITY_OUTPUT_RULES=`REF2VA IDENTITY CONTINUITY OUTPUT — MANDATORY:\n- Read DETAILED FRAMEFLOW DIRECTION.continuity.preserveIdentity. When it is true, retention_analysis.en MUST explicitly include: "the target subject identity and form remain consistent throughout the video".\n- The equivalent retention_analysis.ko MUST explicitly include: "목표 피사체의 정체성과 형태가 영상 전체에서 일관되게 유지됩니다."\n- When USER DIRECTION replaces or transforms a source person or object, "target subject" means the requested transformed result after it appears. Do not contradict the requested replacement by preserving the old source identity.\n- Integrate these statements naturally with the applicable fully_preserved, partially_preserved, or attribute_transfer analysis.`;
function ref2vaDetailedLlmInstruction(cut){return `${withAbsolutePromptTiming(legacyRef2vaDetailedLlmInstruction(cut),cut)}\n\n${REF2VA_IDENTITY_OUTPUT_RULES}`;}
async function copyMetaPrompt(scene){toast('메타 프롬프트 복사 중…',120000);try{await navigator.clipboard.writeText(`${withAbsolutePromptTiming(buildMetaPrompt(scene),scene)}${ELEMENT_ABSENCE_RULES}`);toast('메타 프롬프트가 복사되었습니다. 합성 이미지와 함께 LLM에 전달하세요.');}catch(error){toast(`메타 프롬프트 복사 실패: ${error.message||error}`);}}
function openMetaAnalysisWorkflow(scene){const meta=sceneMeta(scene),overlay=document.createElement('div');overlay.className='workflow-modal-backdrop';overlay.innerHTML=`<section class="workflow-modal meta-analysis-dialog" role="dialog" aria-modal="true"><header><div><span>FLF LLM WORKFLOW</span><h2>FLF 이미지 분석 및 프롬프트 생성</h2><p>현재 화면에서 설정한 카메라·프리셋·연출 의도를 기준으로 LLM 분석을 진행합니다.</p></div></header><ol class="workflow-steps compact-steps"><li><div class="workflow-step-copy"><div><b>01. 합성 이미지 복사</b><p>FIRST와 LAST 이미지를 간격을 두고 한 장으로 복사합니다.</p></div><button class="button secondary meta-flow-image">합성 이미지 복사</button></div></li><li><div class="workflow-step-copy"><div><b>02. 분석 지시문 복사</b><p>합성 이미지와 함께 LLM에 입력하세요.</p></div><button class="button secondary meta-flow-prompt">LLM 분석 지시문 복사</button></div></li><li><b>03. LLM JSON 적용</b><p>LLM이 반환한 JSON 전체를 붙여 넣으면 카메라·장면 전환·요소와 한·영 프롬프트를 함께 적용합니다.</p><textarea class="workflow-json" placeholder="LLM JSON 전체를 붙여 넣으세요.">${escapeAttr(meta.llmJson||'')}</textarea><button class="button secondary meta-flow-paste">클립보드 JSON 붙여넣기</button></li></ol><footer><button class="button secondary workflow-close">닫기</button><button class="button primary workflow-apply">검증하고 적용</button></footer></section>`;document.body.append(overlay);const json=overlay.querySelector('.workflow-json');overlay.querySelector('.meta-flow-image').addEventListener('click',()=>copyMetaImage(scene));overlay.querySelector('.meta-flow-prompt').addEventListener('click',()=>copyMetaPrompt(scene));overlay.querySelector('.meta-flow-paste').addEventListener('click',async()=>{try{json.value=await navigator.clipboard.readText();parseLlmJson(json.value);toast('LLM JSON을 붙여 넣었습니다.');}catch(error){toast(`붙여넣기 실패: ${error.message||error}`,6000);}});overlay.querySelector('.workflow-close').addEventListener('click',()=>{overlay.remove();toast('적용하지 않았습니다.');});overlay.querySelector('.workflow-apply').addEventListener('click',()=>{if(applyLlmJson(scene,json.value))overlay.remove();});}
function parseLlmJson(value){const cleaned=String(value||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');return JSON.parse(cleaned);}
function returnedTraitList(value){
  if(Array.isArray(value))return value.map(item=>String(item).trim()).filter(Boolean);
  return String(value||'').split(/[,·\n]/).map(item=>item.trim()).filter(Boolean);
}
function returnedPreset(kind,style){
  if(!style||typeof style!=='object')return null;
  const presets=kind==='mood'?allMoodPresets():allAestheticPresets(),values=[style.id,style.name_ko,style.nameKo,style.name_en,style.nameEn].map(value=>String(value||'').trim().toLowerCase()).filter(Boolean);
  return presets.find(preset=>[preset.id,preset.nameKo,preset.name,preset.nameEn].map(value=>String(value||'').trim().toLowerCase()).some(value=>values.includes(value)))||null;
}
function normalizeAbsentElementFields(elements){
  let changed=0;const camel=key=>key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase()),read=(item,snake)=>String(item[snake]??item[camel(snake)]??'').trim(),write=(item,key,value)=>{item[key]=value;if(camel(key) in item)delete item[camel(key)];changed++;},absence=value=>/^(?:absent|not present)|(?:not visible|does not exist|missing from)/i.test(value),placeholder=value=>/^(?:n\/?a|none|not applicable|해당\s*없음)$/i.test(value);
  for(const element of elements){
    let startEn=read(element,'start_state_en'),startKo=read(element,'start_state_ko'),endEn=read(element,'end_state_en'),endKo=read(element,'end_state_ko');
    if(!startEn&&endEn){write(element,'start_state_en','Not present in the FIRST frame');startEn=element.start_state_en;}
    if(!startKo&&(absence(startEn)||(!startEn&&endKo))){write(element,'start_state_ko','FIRST 프레임에 존재하지 않음');startKo=element.start_state_ko;}
    if(!endEn&&startEn){write(element,'end_state_en','Not present in the LAST frame');endEn=element.end_state_en;}
    if(!endKo&&(absence(endEn)||(!endEn&&startKo))){write(element,'end_state_ko','LAST 프레임에 존재하지 않음');endKo=element.end_state_ko;}
    for(const [enKey,koKey] of [['mood_en','mood_ko'],['movement_en','movement_ko'],['timing_en','timing_ko']]){const en=read(element,enKey),ko=read(element,koKey);if(placeholder(en)||placeholder(ko)){write(element,enKey,'');write(element,koKey,'');}}
  }
  return changed;
}
function officialFlfPromptFromJson(scene,parsed,language='en'){
  const suffix=language==='ko'?'ko':'en',integrated=String(parsed[`integrated_multimodal_description_${suffix}`]||'').trim(),soundscape=String(parsed[`overall_soundscape_${suffix}`]||'').trim(),music=String(parsed[`non_diegetic_music_${suffix}`]||'').trim();
  if(!integrated)throw new Error(`integrated_multimodal_description_${suffix}가 없습니다.`);
  if(!soundscape)throw new Error(`overall_soundscape_${suffix}가 없습니다.`);
  if(!music)throw new Error(`non_diegetic_music_${suffix}가 없습니다.`);
  if(language==='en'){
    if(!/\[Shot 1\]/i.test(integrated)||/\[Shot 1\]\s+At\s+/i.test(integrated))throw new Error('공식 H3 형식에서 첫 장면은 타임스탬프 없는 [Shot 1]이어야 합니다.');
    const later=[...integrated.matchAll(/\[Shot\s+(\d+)\]/gi)].filter(match=>Number(match[1])>1);for(const shot of later)if(!new RegExp(`\\[Shot\\s+${shot[1]}\\]\\s+At\\s+\\d{2}:\\d{2}\\.\\d{3}`,'i').test(integrated))throw new Error(`[Shot ${shot[1]}]에 공식 At MM:SS.mmm 컷 시간이 필요합니다.`);
    if((/<d>/i.test(integrated)||/<\/d>/i.test(integrated))&&!/<d>\[[^\]]+\]\s*[^<]+<\/d>/i.test(integrated))throw new Error('대사·가사는 <d>[Language] 원문</d> 형식이어야 합니다.');
  }
  const seconds=Math.max(.2,Number(scene.duration)||5).toFixed(2),alignment=language==='ko'?`참조 이미지 정렬 — Picture 1은 목표 영상의 0.00초와 일치하고, Picture 2는 목표 영상의 ${seconds}초와 일치합니다.`:`How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ${seconds}-second mark of the target video.`;
  return `${alignment}\n\nintegrated_multimodal_description:\n${integrated}\n\noverall_soundscape:\n${soundscape}\n\nnon_diegetic_music:\n${music}`;
}
function applyLlmJson(scene,value){
  try{
    const parsed=parseLlmJson(value),meta=sceneMeta(scene),elements=parsed.elements||parsed.scene_elements,returnedCamera=parsed.camera||{},returnedTransition=parsed.transition||parsed.scene_transition,returnedStyles=parsed.style_presets||parsed.stylePresets||{},traitVerification=parsed.trait_verification||parsed.traitVerification||{},readableSummary=String(parsed.readable_summary_ko||parsed.readableSummaryKo||'').trim();
    if(!Array.isArray(elements))throw new Error('elements 배열이 없습니다.');
    if(!returnedTransition)throw new Error('Scene Transition이 없습니다.');if(!Array.isArray(returnedTransition.phases))returnedTransition.phases=[];
    const autoFilledElementFields=0;
    for(const [snake,camel,label] of [['summary_ko','summaryKo','요약'],['transition_type_ko','typeKo','전환 방식'],['pacing_ko','pacingKo','속도와 리듬']])if(!String(returnedTransition[snake]||returnedTransition[camel]||'').trim())throw new Error(`Scene Transition의 한국어 ${label}이 비어 있습니다.`);
    const missingPhaseEn=returnedTransition.phases.findIndex(phase=>!String(phase.action_en||phase.actionEn||'').trim()),missingPhaseKo=returnedTransition.phases.findIndex(phase=>!String(phase.action_ko||phase.actionKo||'').trim());
    if(missingPhaseEn>=0)throw new Error(`Scene Transition 단계 ${missingPhaseEn+1}의 영어 동작이 비어 있습니다.`);
    if(missingPhaseKo>=0)throw new Error(`Scene Transition 단계 ${missingPhaseKo+1}의 한국어 동작이 비어 있습니다.`);
    const duration=Math.max(.2,Number(scene.duration)||5),phaseTimes=returnedTransition.phases.map(phase=>phase.time_seconds??phase.timeSeconds??null);if(returnedTransition.phases.some(phase=>/%/.test(String(phase.range||''))))throw new Error('시간 단계에 백분율을 사용할 수 없습니다. time_seconds를 사용해 주세요.');for(let index=0;index<phaseTimes.length;index++){const time=phaseTimes[index];if(time==null||!Number.isFinite(Number(time))||Number(time)<0||Number(time)>=duration)throw new Error(`단계 ${index+1}의 time_seconds는 0 이상 ${duration}초 미만의 숫자여야 합니다.`);if(index>0&&Number(time)<=Number(phaseTimes[index-1]))throw new Error('단계의 time_seconds는 앞 단계보다 커야 합니다.');}const requested=promptTimingPayload(scene);if(requested.mode==='basic'&&returnedTransition.phases.length)throw new Error('기본 프롬프트에서는 Scene Transition 시간 단계를 반환하지 않아야 합니다. phases를 빈 배열로 보내 주세요.');if(requested.mode==='staged'){if(returnedTransition.phases.length!==requested.steps.length)throw new Error(`사용자 단계 ${requested.steps.length}개를 모두 반환해야 합니다.`);requested.steps.forEach((step,index)=>{if(step.requested_start_seconds!=null&&Math.abs(Number(phaseTimes[index])-Number(step.requested_start_seconds))>.0005)throw new Error(`단계 ${index+1}의 사용자 지정 시간 ${step.requested_start_seconds}초가 변경되었습니다.`);});}
    const missingRelationKo=(returnedTransition.relationships||[]).findIndex(relation=>!String(relation.relation_ko||relation.relationKo||'').trim());
    if(missingRelationKo>=0)throw new Error(`Scene Transition 인과관계 ${missingRelationKo+1}의 한국어 설명이 비어 있습니다.`);
    for(const [kind,label] of [['mood','분위기'],['aesthetic','미학']]){
      const key=kind==='mood'?'moodPreset':'aestheticPreset';if(meta[key])continue;
      const returnedStyle=returnedStyles[kind],preset=returnedPreset(kind,returnedStyle);
      if(!preset)throw new Error(`LLM이 ${label} 프리셋을 선택하지 않았거나 목록에 없는 값을 반환했습니다.`);
      meta[key]=preset.id;
      if(kind==='mood')meta.moodTraits=moodTraits(preset);else meta.aestheticTraits=aestheticTraits(preset);
    }
    const expectedStyles=[['mood',meta.moodPreset,meta.moodTraits||[],'분위기'],['aesthetic',meta.aestheticPreset,meta.aestheticTraits||[],'미학']];
    for(const [kind,selectedId,expectedTraits,label] of expectedStyles){
      if(!selectedId)continue;
      const returnedStyle=returnedStyles[kind];
      if(!returnedStyle)throw new Error(`${label} 프리셋 적용 결과가 없습니다.`);
      if(returnedStyle.id&&String(returnedStyle.id)!==String(selectedId))throw new Error(`${label} 프리셋 ID가 선택값과 다릅니다.`);
      const applied=returnedTraitList(returnedStyle.applied_traits_ko||returnedStyle.appliedTraitsKo);
      const missing=expectedTraits.filter(trait=>!applied.includes(String(trait)));
      if(missing.length)throw new Error(`${label} 필수 특성이 누락되었습니다: ${missing.join(', ')}`);
    }
    if(traitVerification.all_checked_traits_applied!==true)throw new Error('LLM이 모든 체크 특성의 적용 완료를 검증하지 않았습니다.');
    if((traitVerification.missing_traits_ko||traitVerification.missingTraitsKo||[]).length)throw new Error(`LLM 검증에서 누락 특성이 발견되었습니다: ${(traitVerification.missing_traits_ko||traitVerification.missingTraitsKo).join(', ')}`);
    if((traitVerification.conflicting_negative_terms||traitVerification.conflictingNegativeTerms||[]).length)throw new Error(`negative_prompt 충돌 항목이 있습니다: ${(traitVerification.conflicting_negative_terms||traitVerification.conflictingNegativeTerms).join(', ')}`);
    if(readableSummary.length<30)throw new Error('독해용 한국어 요약이 없거나 너무 짧습니다. 새 메타 프롬프트로 다시 생성해 주세요.');
    meta.llmJson=value;
    meta.negativePrompt=String(parsed.negative_prompt||parsed.negativePrompt||'').trim();
    meta.transition=bilingualTransition(returnedTransition);
    meta.elements=elements.map(bilingualElement);
    const returnedMovements=Array.isArray(returnedCamera.movements)?returnedCamera.movements.map(String):[String(returnedCamera.movement||'')].filter(Boolean),returnedStatic=returnedMovements.includes('static');
    meta.resolvedCamera=Object.keys(returnedCamera).length?{shotSize:String(returnedCamera.shot_size||returnedCamera.shotSize||''),angle:String(returnedCamera.angle||''),lens:String(returnedCamera.lens||''),composition:String(returnedCamera.composition||''),movements:returnedMovements,speed:returnedStatic?null:String(returnedCamera.speed||''),trackingTarget:returnedStatic?null:(returnedCamera.tracking_target||returnedCamera.trackingTarget||null),trackingMethod:returnedStatic?null:(returnedCamera.tracking_method||returnedCamera.trackingMethod||null)}:null;
    meta.finalPromptEn=officialFlfPromptFromJson(scene,parsed,'en');
    meta.revisedPromptKo=officialFlfPromptFromJson(scene,parsed,'ko');
    if(!meta.finalPromptEn||!meta.revisedPromptKo)throw new Error('MiniMax H3 공식 FL2VA 한글·영문 3섹션이 없습니다.');
    scene.promptEn=meta.finalPromptEn;scene.promptKo=meta.revisedPromptKo;meta.open=true;meta.userCollapsed=false;
    meta.readableSummaryKo=readableSummary;
    meta.styleAnalysisDirty=false;meta.styleAnalysisDirtyKinds=[];save();renderPreservingEditorScroll();toast(`프롬프트와 영상 프리셋을 적용했습니다. 카메라·장면 전환·요소 ${meta.elements.length}개를 저장했습니다.${autoFilledElementFields?` 부재 상태·placeholder 필드 ${autoFilledElementFields}개를 정규화했습니다.`:''}`);return true;
  }catch(error){toast(`적용 실패: ${error.message||error}`,6000);return false;}
}
function openReadableSummary(scene){
  const summary=String(sceneMeta(scene).readableSummaryKo||'').trim();
  if(!summary){toast('독해용 요약이 없습니다. 새 메타 프롬프트로 JSON을 다시 생성해 주세요.');return;}
  const overlay=document.createElement('div');
  overlay.className='summary-reader-backdrop';
  overlay.innerHTML=`<section class="summary-reader" role="dialog" aria-modal="true" aria-label="영상 연출 요약"><header><div><span>READABLE SUMMARY</span><h2>영상 연출 요약</h2><p>LLM이 독해와 음성 청취에 맞게 정리한 내용입니다.</p></div><button type="button" class="summary-reader-close" aria-label="요약 닫기">×</button></header><div class="summary-reader-text">${escapeAttr(summary)}</div><div class="summary-audio-fallback" hidden></div><footer><div><b>Sarah</b><span>한국어 · 1.2배속 · Supertonic</span><small class="summary-reader-status">재생 준비</small></div><button type="button" class="button primary summary-listen">${icon('play')} 듣기</button></footer></section>`;
  document.body.append(overlay);
  const listen=overlay.querySelector('.summary-listen'),status=overlay.querySelector('.summary-reader-status'),fallback=overlay.querySelector('.summary-audio-fallback');
  let playing=false,ttsModule=null;
  const reset=()=>{playing=false;listen.disabled=false;listen.innerHTML=`${icon('play')} 다시 듣기`;if(!fallback.querySelector('audio'))status.textContent='재생 준비';};
  const close=async()=>{ttsModule?.stopSarahSummary();overlay.remove();};
  overlay.querySelector('.summary-reader-close')?.addEventListener('click',close);
  overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
  listen.addEventListener('click',async()=>{
    if(playing){ttsModule?.stopSarahSummary();reset();return;}
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;
    if(!AudioContextClass){toast('이 환경은 오디오 출력을 지원하지 않습니다.');return;}
    const audioContext=new AudioContextClass({latencyHint:'interactive'});
    const unlockPromise=audioContext.resume();
    listen.disabled=true;status.textContent='음성 엔진 준비 중…';
    try{
      ttsModule=await import('./supertonic.js');
      await unlockPromise;
      await ttsModule.playSarahSummary(summary,message=>{status.textContent=message;},()=>{reset();status.textContent='재생 완료 · 아래 플레이어에서 다시 들을 수 있습니다.';},audioContext,diagnostic=>{
        fallback.hidden=false;fallback.innerHTML=`<div><b>생성된 음성</b><small>${diagnostic.duration.toFixed(1)}초 · ${Math.round(diagnostic.sampleRate/1000)}kHz · 음량 검증 완료</small></div><audio controls preload="auto" aria-label="생성된 Sarah 음성 수동 재생" src="${escapeAttr(diagnostic.url)}"></audio>`;
      });
      playing=true;listen.disabled=false;listen.textContent='■ 정지';
    }catch(error){if(audioContext.state!=='closed')audioContext.close().catch(()=>{});reset();status.textContent='자동 재생 실패 · 아래 수동 재생 버튼을 확인하세요';toast(`Sarah 음성 재생 실패: ${error.message||error}`);}
  });
}
function localizeCameraControls(){
  const controls={
    '#meta-shot-size':[['Auto analysis (이미지 자동 분석)'],['Wide Shot (와이드 샷)'],['Medium Shot (미디엄 샷)'],['Close-up (클로즈업)'],['Extreme Close-up (익스트림 클로즈업)']],
    '#meta-angle':[['Auto analysis (이미지 자동 분석)'],['Eye Level (눈높이)'],['High Angle (하이 앵글)'],['Low Angle (로우 앵글)'],['Overhead (수직 탑뷰)'],['POV (1인칭 시점)']],
    '#meta-lens':[['Auto analysis (이미지 자동 분석)'],['Normal (표준 렌즈)'],['Wide Angle (광각 렌즈)'],['Telephoto (망원 렌즈)'],['Anamorphic (아나모픽)'],['Macro (매크로)']],
    '#meta-composition':[['Auto analysis (이미지 자동 분석)'],['Center (중앙 구도)'],['Rule of Thirds (삼분할 구도)'],['Symmetrical (대칭 구도)'],['Leading Lines (유도선 구도)'],['Negative Space (여백 구도)']],
    '#meta-camera-speed':[['Very Slow (매우 느리게)'],['Slow (느리게)'],['Normal (보통)'],['Fast (빠르게)']]
  };
  for(const [selector,labels] of Object.entries(controls)){const select=document.querySelector(selector);if(!select)continue;[...select.options].forEach((option,index)=>{if(labels[index])option.textContent=labels[index][0];});}
  const fieldLabels={'#meta-shot-size':'Shot size (샷 크기)','#meta-angle':'Camera angle (카메라 앵글)','#meta-lens':'Lens (렌즈)','#meta-composition':'Composition (구도)','#meta-camera-speed':'Speed (속도)'};
  for(const [selector,label] of Object.entries(fieldLabels)){const span=document.querySelector(selector)?.closest('label')?.querySelector(':scope > span');if(span)span.textContent=label;}
}
function selectPreset(kind,scene,preset){const meta=sceneMeta(scene);if(kind==='mood'){meta.moodPreset=preset?.id||null;meta.moodTraits=moodTraits(preset);}else{meta.aestheticPreset=preset?.id||null;meta.aestheticTraits=aestheticTraits(preset);}save();renderPreservingEditorScroll();}
function openPresetGallery(kind,scene){
  const presets=kind==='mood'?allMoodPresets():allAestheticPresets(),title=kind==='mood'?'영상 분위기 프리셋':'미학 프리셋',overlay=document.createElement('div');overlay.className='preset-gallery-backdrop';
  overlay.innerHTML=`<section class="preset-gallery"><header><div><span>VISUAL PRESET LIBRARY</span><h2>${title}</h2><p>대표 장면의 소재·공간·스케일을 비교하세요. 카드를 선택하면 관련 특성이 자동으로 체크됩니다.</p></div><button type="button" class="preset-gallery-close">×</button></header><div class="preset-gallery-grid">${presets.map((preset,index)=>{const en=preset.name||preset.nameEn,builtIns=kind==='mood'?moodPresets:aestheticPresets,visualIndex=builtIns.findIndex(item=>item.id===preset.id),columns=kind==='mood'?4:5,rows=kind==='mood'?5:2,column=visualIndex<0?0:visualIndex%columns,row=visualIndex<0?0:Math.floor(visualIndex/columns),x=columns===1?0:column*100/(columns-1),y=rows===1?0:row*100/(rows-1),visualClass=visualIndex<0?'custom-visual':`${kind}-visual`,criteria=kind==='mood'?`${preset.material} · ${preset.motion} · ${preset.space}`:(preset.keywords||[]).join(' · ');return`<button type="button" class="preset-visual-card" data-preset-id="${preset.id}" style="--preset-hue:${(index*37+(kind==='mood'?155:285))%360};--preset-x:${x}%;--preset-y:${y}%"><div class="preset-card-image ${visualClass}"><span>${escapeAttr(preset.nameKo)}</span><small>${escapeAttr(en)}</small></div><div class="preset-card-copy"><b>${preset.number||'MY'} · ${escapeAttr(preset.nameKo)}</b><p>${kind==='mood'?`<strong>정서</strong> ${escapeAttr(preset.emotion)}<br>`:''}<strong>판별 기준</strong> ${escapeAttr(criteria||preset.description||'사용자 정의')}</p></div></button>`;}).join('')}</div></section>`;
  document.body.append(overlay);overlay.querySelector('.preset-gallery-close')?.addEventListener('click',()=>overlay.remove());overlay.addEventListener('click',event=>{if(event.target===overlay)overlay.remove();});overlay.querySelectorAll('[data-preset-id]').forEach(card=>card.addEventListener('click',()=>{selectPreset(kind,scene,presets.find(item=>item.id===card.dataset.presetId));overlay.remove();}));
}
function presetAnalysisPrompt(kind){return`${JSON_ONLY_ANALYSIS_GUARD}\n\n${kind==='mood'?`Analyze the attached FIRST/LAST frame composite and infer one reusable Korean video mood preset. Return valid JSON only: {"name_ko":"한국어 제목","name_en":"English title","emotion":"정서","worldview":"세계관/미학","scale":"스케일","material":"물질","motion":"움직임","space":"공간"}. Every value must be concise, visually grounded, and written in Korean except name_en.`:`Analyze the attached FIRST/LAST frame composite and infer one reusable Korean aesthetic preset. Return valid JSON only: {"name_ko":"한국어 제목","name_en":"English title","description":"핵심 미학을 한국어로 요약","keywords":["한국어 키워드"]}. Do not describe camera motion; focus on material, cultural, spatial, and visual aesthetics.`}\n\nFINAL OUTPUT GATE: Return exactly one raw JSON object. No tool calls, no generated media, no Markdown, and no surrounding text.`;}
async function copyPresetAnalysis(kind,scene,status){const started=Date.now();toast('이미지 분석용 프롬프트 복사 중…',120000);try{await styleReferenceBlob(scene);await navigator.clipboard.writeText(presetAnalysisPrompt(kind));await keepProgressVisible(started);status.textContent='[이미지와 함께 LLM에 입력하세요]';status.classList.add('show');toast(`분석 프롬프트가 복사되었습니다. ${isRef2vaCut(scene)?'레퍼런스 Sheet':'합성 이미지'}와 함께 LLM에 입력하세요.`);}catch(error){toast(`분석 프롬프트 복사 실패: ${error.message||error}`);}}
function openPresetResultEditor(kind,scene,data){
  const source=data.preset||data,result=document.createElement('div');result.className='preset-editor-backdrop';const mood=kind==='mood';
  result.innerHTML=`<form class="preset-editor"><header><div><span>CUSTOM PRESET</span><h2>${mood?'분위기':'미학'} 프리셋 저장</h2><p>LLM 분석 결과를 확인하고 수정한 뒤 저장하세요.</p></div><button type="button" class="preset-editor-close">×</button></header><div class="preset-editor-grid"><label><span>한국어 제목 *</span><input name="nameKo" value="${escapeAttr(source.name_ko||source.nameKo||'')}" required></label><label><span>English title *</span><input name="nameEn" value="${escapeAttr(source.name_en||source.nameEn||'')}" required></label>${mood?`<label><span>정서</span><input name="emotion" value="${escapeAttr(source.emotion||'')}"></label><label><span>세계관 / 미학</span><input name="worldview" value="${escapeAttr(source.worldview||'')}"></label><label><span>스케일</span><input name="scale" value="${escapeAttr(source.scale||'')}"></label><label><span>물질</span><input name="material" value="${escapeAttr(source.material||'')}"></label><label><span>움직임</span><input name="motion" value="${escapeAttr(source.motion||'')}"></label><label><span>공간</span><input name="space" value="${escapeAttr(source.space||'')}"></label>`:`<label class="wide"><span>미학 정보</span><textarea name="description">${escapeAttr(source.description||'')}</textarea></label><label class="wide"><span>키워드</span><input name="keywords" value="${escapeAttr((source.keywords||[]).join?.(', ')||source.keywords||'')}"></label>`}</div><footer><button type="button" class="button secondary preset-editor-cancel">취소</button><button class="button primary">최상단에 저장</button></footer></form>`;
  document.body.append(result);const close=()=>result.remove();result.querySelector('.preset-editor-close')?.addEventListener('click',close);result.querySelector('.preset-editor-cancel')?.addEventListener('click',close);result.addEventListener('click',event=>{if(event.target===result)close();});result.querySelector('form')?.addEventListener('submit',event=>{event.preventDefault();const form=new FormData(event.currentTarget),stamp=Date.now();if(mood){const preset={id:`custom-mood-${stamp}`,number:'MY',nameKo:String(form.get('nameKo')).trim(),name:String(form.get('nameEn')).trim(),emotion:String(form.get('emotion')).trim(),worldview:String(form.get('worldview')).trim(),scale:String(form.get('scale')).trim(),material:String(form.get('material')).trim(),motion:String(form.get('motion')).trim(),space:String(form.get('space')).trim(),custom:true};customMoodPresets.unshift(preset);localStorage.setItem('frameflow-custom-mood-presets-v1',JSON.stringify(customMoodPresets));selectPreset('mood',scene,preset);}else{const preset={id:`custom-aesthetic-${stamp}`,number:'MY',nameKo:String(form.get('nameKo')).trim(),nameEn:String(form.get('nameEn')).trim(),description:String(form.get('description')).trim(),keywords:String(form.get('keywords')).split(',').map(item=>item.trim()).filter(Boolean),custom:true};customAestheticPresets.unshift(preset);localStorage.setItem('frameflow-custom-aesthetic-presets-v1',JSON.stringify(customAestheticPresets));selectPreset('aesthetic',scene,preset);}close();toast('사용자 프리셋을 최상단에 저장했습니다.');});
}
async function pastePresetAnalysis(kind,scene){try{const value=await navigator.clipboard.readText(),parsed=parseLlmJson(value);openPresetResultEditor(kind,scene,parsed);}catch(error){const label=kind==='mood'?'분위기':'미학';toast(`${label} JSON을 읽지 못했습니다: ${error.message||error}`);}}
function openPresetWorkflow(kind,scene){const mood=kind==='mood',label=mood?'분위기':'미학',overlay=document.createElement('div');overlay.className='workflow-modal-backdrop';overlay.innerHTML=`<section class="workflow-modal" role="dialog" aria-modal="true"><header><div><span>IMAGE STYLE WORKFLOW</span><h2>이미지로 ${label} 추정</h2><p>FIRST/LAST 합성 이미지와 분석 지시문을 LLM에 전달해 재사용 가능한 프리셋을 만듭니다.</p></div></header><ol class="workflow-steps"><li><b>01. 합성 이미지 복사</b><button class="button secondary preset-flow-image">합성 이미지 복사</button></li><li><b>02. 분석 지시문 복사</b><p>이미지와 함께 LLM에 입력하세요.</p><button class="button secondary preset-flow-prompt">LLM 분석 지시문 복사</button></li><li><b>03. 결과 확인 및 저장</b><textarea class="workflow-json" placeholder="LLM JSON을 붙여 넣으세요."></textarea><button class="button secondary preset-flow-paste">클립보드 JSON 붙여넣기</button><div class="preset-flow-fields"></div></li></ol><footer><button class="button secondary workflow-close">닫기</button><button class="button primary workflow-apply">최상단에 저장하고 적용</button></footer></section>`;document.body.append(overlay);const json=overlay.querySelector('.workflow-json'),fields=overlay.querySelector('.preset-flow-fields');const show=value=>{const source=value.preset||value;fields.innerHTML=`<label><span>한국어 제목</span><input data-flow="nameKo" value="${escapeAttr(source.name_ko||source.nameKo||'')}"></label><label><span>English title</span><input data-flow="nameEn" value="${escapeAttr(source.name_en||source.nameEn||'')}"></label>${mood?['emotion','worldview','scale','material','motion','space'].map(key=>`<label><span>${{emotion:'정서',worldview:'세계관 / 미학',scale:'스케일',material:'물질',motion:'움직임',space:'공간'}[key]}</span><input data-flow="${key}" value="${escapeAttr(source[key]||'')}"></label>`).join(''):`<label class="wide"><span>미학 정보</span><textarea data-flow="description">${escapeAttr(source.description||'')}</textarea></label><label class="wide"><span>키워드</span><input data-flow="keywords" value="${escapeAttr((source.keywords||[]).join?.(', ')||source.keywords||'')}"></label>`}`;};overlay.querySelector('.preset-flow-image').addEventListener('click',()=>copyMetaImage(scene));overlay.querySelector('.preset-flow-prompt').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(presetAnalysisPrompt(kind));toast('분석 지시문이 복사되었습니다. 이미지와 함께 LLM에 입력하세요.');}catch(error){toast(`복사 실패: ${error.message||error}`);}});overlay.querySelector('.preset-flow-paste').addEventListener('click',async()=>{try{json.value=await navigator.clipboard.readText();show(parseLlmJson(json.value));toast('LLM JSON을 붙여 넣었습니다.');}catch(error){toast(`붙여넣기 실패: ${error.message||error}`,6000);}});overlay.querySelector('.workflow-close').addEventListener('click',()=>{overlay.remove();toast('적용하지 않았습니다.');});overlay.querySelector('.workflow-apply').addEventListener('click',()=>{try{if(!fields.children.length)show(parseLlmJson(json.value));const get=key=>fields.querySelector(`[data-flow="${key}"]`)?.value.trim()||'',stamp=Date.now(),nameKo=get('nameKo'),nameEn=get('nameEn');if(!nameKo||!nameEn)throw new Error('한국어와 영문 제목이 필요합니다.');if(mood){const preset={id:`custom-mood-${stamp}`,number:'MY',nameKo,name:nameEn,emotion:get('emotion'),worldview:get('worldview'),scale:get('scale'),material:get('material'),motion:get('motion'),space:get('space'),custom:true};customMoodPresets.unshift(preset);localStorage.setItem('frameflow-custom-mood-presets-v1',JSON.stringify(customMoodPresets));selectPreset('mood',scene,preset);}else{const preset={id:`custom-aesthetic-${stamp}`,number:'MY',nameKo,nameEn,description:get('description'),keywords:get('keywords').split(',').map(v=>v.trim()).filter(Boolean),custom:true};customAestheticPresets.unshift(preset);localStorage.setItem('frameflow-custom-aesthetic-presets-v1',JSON.stringify(customAestheticPresets));selectPreset('aesthetic',scene,preset);}overlay.remove();toast('프리셋을 최상단에 저장하고 적용했습니다.');}catch(error){toast(`적용 실패: ${error.message||error}`,6000);}});}
function mountPresetControls(scene){
  const cameraPanel=document.querySelector('.meta-camera');if(!cameraPanel)return;const meta=sceneMeta(scene),mood=allMoodPresets().find(item=>item.id===meta.moodPreset),aesthetic=allAestheticPresets().find(item=>item.id===meta.aestheticPreset),section=document.createElement('section');section.className='meta-presets';
  const traitSuggestions=kind=>[...new Set((kind==='mood'?allMoodPresets():allAestheticPresets()).flatMap(preset=>kind==='mood'?moodTraits(preset):aestheticTraits(preset)).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko'));
  const traitMarkup=(kind,traits,checked)=>{const visible=[...new Set([...(traits||[]),...(checked||[])])];return visible.length?`<div class="preset-traits">${visible.map(trait=>`<label><input type="checkbox" data-preset-trait="${kind}" value="${escapeAttr(trait)}" ${(checked||[]).includes(trait)?'checked':''}><span>${escapeAttr(trait)}</span></label>`).join('')}</div>`:`<div class="preset-traits-empty">프리셋을 선택하면 관련 특성이 표시됩니다.</div>`;};
  const panel=(kind,preset)=>{const isMood=kind==='mood',traits=isMood?moodTraits(preset):aestheticTraits(preset),checked=isMood?(meta.moodTraits||traits):(meta.aestheticTraits||traits),en=preset?(preset.name||preset.nameEn):'',label=isMood?'영상 분위기':'미학',estimateLabel=isMood?'이미지로 분위기 추정':'이미지로 미학 추정',listId=`preset-${kind}-trait-suggestions`,suggestions=traitSuggestions(kind),needsAnalysis=(meta.styleAnalysisDirtyKinds||[]).includes(kind);return`<article class="preset-control-card"><header><div><b>${label} 프리셋</b><small title="${preset?`${escapeAttr(preset.nameKo)} · ${escapeAttr(en)}`:'직접 입력 가능'}">${preset?`${escapeAttr(preset.nameKo)} · ${escapeAttr(en)}`:'선택 안 함 · 직접 입력 가능'}</small></div><button type="button" class="button secondary preset-gallery-open" data-preset-kind="${kind}">프리셋 이미지 보기</button></header>${traitMarkup(kind,traits,checked)}<div class="preset-trait-add"><input type="text" data-preset-trait-input="${kind}" list="${listId}" placeholder="${label} 특성 검색 또는 직접 입력"><datalist id="${listId}">${suggestions.map(value=>`<option value="${escapeAttr(value)}"></option>`).join('')}</datalist><button type="button" class="button secondary" data-preset-trait-add="${kind}">${icon('plus')} 추가</button></div>${needsAnalysis?`<p class="preset-analysis-required">${icon('spark')}<span>새 특성을 반영하려면 LLM 지시문을 다시 복사하세요.</span></p>`:''}<div class="preset-analysis-actions"><button type="button" class="button primary preset-workflow-open" data-preset-kind="${kind}">${estimateLabel}</button></div></article>`;};
  section.innerHTML=`<header><div><h4>02. 영상 프리셋</h4><p>분위기와 미학을 프리셋으로 선택하거나 특성을 직접 입력할 수 있습니다.</p></div><span>SCENE STYLE</span></header><div class="preset-control-grid">${panel('mood',mood)}${panel('aesthetic',aesthetic)}</div>`;cameraPanel.insertAdjacentElement('afterend',section);
  section.querySelectorAll('.preset-gallery-open').forEach(button=>button.addEventListener('click',()=>openPresetGallery(button.dataset.presetKind,scene)));
  section.addEventListener('change',event=>{
    const input=event.target.closest?.('[data-preset-trait]');
    if(!input)return;
    const kind=input.dataset.presetTrait;
    const values=[...section.querySelectorAll(`[data-preset-trait="${kind}"]:checked`)].map(item=>item.value);
    if(kind==='mood')meta.moodTraits=values;
    else meta.aestheticTraits=values;
    save();
  });
  const addTrait=kind=>{
    const input=section.querySelector(`[data-preset-trait-input="${kind}"]`),value=input?.value.trim();
    if(!value)return;
    const traitsKey=kind==='mood'?'moodTraits':'aestheticTraits';
    const current=meta[traitsKey]||[];
    if(current.includes(value)){toast('이미 추가된 특성입니다.');input.select();return;}
    meta[traitsKey]=[...current,value];meta.styleAnalysisDirtyKinds=[...new Set([...(meta.styleAnalysisDirtyKinds||[]),kind])];save();
    const card=input.closest('.preset-control-card');let traits=card.querySelector('.preset-traits');
    if(!traits){const empty=card.querySelector('.preset-traits-empty');traits=document.createElement('div');traits.className='preset-traits';empty?.replaceWith(traits);}
    const label=document.createElement('label');label.innerHTML=`<input type="checkbox" data-preset-trait="${kind}" value="${escapeAttr(value)}" checked><span>${escapeAttr(value)}</span>`;traits.append(label);
    if(!card.querySelector('.preset-analysis-required')){const notice=document.createElement('p');notice.className='preset-analysis-required';notice.innerHTML=`${icon('spark')}<span>새 특성을 반영하려면 LLM 분석 진행을 새로 하세요.</span>`;card.querySelector('.preset-analysis-actions')?.before(notice);}
    input.value='';input.focus();toast(`“${value}” 특성을 추가했습니다. LLM 분석 진행을 새로 하세요.`,6000);
  };
  section.querySelectorAll('[data-preset-trait-add]').forEach(button=>button.addEventListener('click',()=>addTrait(button.dataset.presetTraitAdd)));
  section.querySelectorAll('[data-preset-trait-input]').forEach(input=>input.addEventListener('keydown',event=>{if(event.key!=='Enter')return;event.preventDefault();addTrait(input.dataset.presetTraitInput);}));
  section.querySelectorAll('.preset-workflow-open').forEach(button=>button.addEventListener('click',()=>openPresetWorkflow(button.dataset.presetKind,scene)));
}
async function resetLlmAnalysis(scene){
  const meta=sceneMeta(scene),location=cutLocation(scene),generatedEn=String(meta.finalPromptEn||'').trim(),generatedKo=String(meta.revisedPromptKo||'').trim();
  const target=`${location.scene?.title||`씬 ${pad(location.scene?.id||1)}`} · SCENE ${pad(location.scene?.id||1)} · CUT ${pad(location.cut?.id||1)}`;
  const confirmed=await confirmDestructive({
    title:'LLM 분석 결과를 초기화하시겠습니까?',
    target,
    message:'분석 JSON, 분석된 카메라, 장면 전환, 요소, 요약과 LLM 생성 프롬프트만 비웁니다. 사용자가 설정한 카메라·프리셋·연출 의도와 이미지·영상은 유지됩니다.',
    confirmLabel:'LLM 분석 초기화'
  });
  if(!confirmed)return;
  if(generatedEn&&String(scene.promptEn||'').trim()===generatedEn)scene.promptEn='';
  if(generatedKo&&String(scene.promptKo||'').trim()===generatedKo)scene.promptKo='';
  meta.llmJson='';
  meta.transition=null;
  meta.elements=[];
  meta.resolvedCamera=null;
  meta.finalPromptEn='';
  meta.revisedPromptKo='';
  meta.readableSummaryKo='';
  meta.additionalDirection='';
  meta.styleAnalysisDirty=false;
  meta.styleAnalysisDirtyKinds=[];
  meta.open=true;
  meta.userCollapsed=false;
  save();renderPreservingEditorScroll();toast('LLM 분석 결과를 초기화했습니다. 카메라·프리셋·연출 설정과 미디어는 유지했습니다.');
}
function bindMetaPrompt(scene){
  const meta=sceneMeta(scene),camera=meta.camera,delayedSave=()=>{clearTimeout(promptSaveTimer);promptSaveTimer=setTimeout(save,300);};
  const disclosure=document.querySelector('.meta-prompt-disclosure');
  disclosure?.addEventListener('toggle',()=>{if(!disclosure.open)return;meta.open=true;meta.userCollapsed=false;save();const location=cutLocation(scene),target=`${location.scene?.title||`씬 ${pad(location.scene?.id||1)}`} · SCENE ${pad(location.scene?.id||1)} · CUT ${pad(location.cut?.id||1)}`;toast(`${target} 메타 프롬프트 설정을 열었습니다.`);});
  const originalDirection=document.querySelector('.meta-main > .meta-direction');if(originalDirection){const template=document.createElement('template');template.innerHTML=promptInputMarkup(scene);originalDirection.replaceWith(template.content.firstElementChild);}
  const promptSection=document.querySelector('.meta-user-prompt'),directionLabel=document.querySelector('.meta-direction');
  if(directionLabel&&!document.querySelector('#meta-negative-direction')){
    const negativeLabel=document.createElement('label');
    negativeLabel.className='meta-direction meta-negative-direction';
    negativeLabel.innerHTML=`<span>부정 연출 의도 <small>직접적인 금지문이 아닌 긍정 연출로 변환됩니다.</small></span><textarea id="meta-negative-direction" placeholder="예: 잎이 눕거나 형태가 찌그러지지 않았으면 좋겠다.">${escapeAttr(meta.negativeDirection||'')}</textarea>`;
    (promptSection||directionLabel).insertAdjacentElement('afterend',negativeLabel);
  }
  const negativeLabel=document.querySelector('.meta-negative-direction');
  if(negativeLabel&&!document.querySelector('#meta-additional-direction')){
    const additionalLabel=document.createElement('label');
    additionalLabel.className='meta-direction meta-additional-direction';
    const editableAdditional=isRef2vaCut(scene);
    additionalLabel.innerHTML=`<span>추가 연출 의도 <small>${editableAdditional?'레퍼런스와 세부 연출을 보완할 지시를 직접 입력합니다.':'생성 영상의 움직임을 LLM이 분석한 결과만 들어갑니다.'}</small></span><textarea id="meta-additional-direction" ${editableAdditional?'':'disabled'} placeholder="${editableAdditional?'예: 파티클 인물의 재질과 양쪽 색 대비를 유지한다.':'영상 Sheet와 메타프롬프트를 LLM에 전달한 뒤 결과를 적용하세요.'}">${escapeAttr(meta.additionalDirection||'')}</textarea>`;
    negativeLabel.insertAdjacentElement('afterend',additionalLabel);
  }
  localizeCameraControls();
  mountPresetControls(scene);
  const cameraHeading=document.querySelector('.meta-camera>h4');if(cameraHeading)cameraHeading.textContent='01. 카메라 설정';const analysisHeading=document.querySelector('.meta-elements>h4');if(analysisHeading)analysisHeading.textContent='LLM 장면 분석';
  document.querySelector('.import-previous-prompt')?.addEventListener('click',()=>importPreviousCutPrompts(scene));document.querySelector('.meta-collapse')?.addEventListener('click',()=>{meta.open=false;meta.userCollapsed=true;save();renderPreservingEditorScroll();});
  const direction=document.querySelector('#meta-direction'),negativeDirection=document.querySelector('#meta-negative-direction'),additionalDirection=document.querySelector('#meta-additional-direction');direction?.addEventListener('input',()=>{meta.direction=direction.value;delayedSave();});negativeDirection?.addEventListener('input',()=>{meta.negativeDirection=negativeDirection.value;delayedSave();});if(additionalDirection&&!additionalDirection.disabled)additionalDirection.addEventListener('input',()=>{meta.additionalDirection=additionalDirection.value;delayedSave();});
  document.querySelectorAll('[data-prompt-mode]').forEach(button=>button.addEventListener('click',()=>{meta.promptMode=button.dataset.promptMode==='staged'?'staged':'basic';document.querySelectorAll('[data-prompt-mode]').forEach(item=>{const active=item.dataset.promptMode===meta.promptMode;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));});document.querySelectorAll('[data-prompt-panel]').forEach(panel=>panel.classList.toggle('hidden',panel.dataset.promptPanel!==meta.promptMode));save();}));
  document.querySelectorAll('[data-prompt-step-time]').forEach(input=>input.addEventListener('input',()=>{const step=meta.promptSteps[Number(input.dataset.promptStepTime)];if(step)step.timeSeconds=input.value===''?null:Math.max(0,Number(input.value)||0);delayedSave();}));
  document.querySelectorAll('[data-prompt-step-instruction]').forEach(input=>input.addEventListener('input',()=>{const step=meta.promptSteps[Number(input.dataset.promptStepInstruction)];if(step)step.instruction=input.value;delayedSave();}));
  document.querySelector('.add-prompt-step')?.addEventListener('click',()=>{meta.promptSteps.push({id:`prompt-step-${Date.now()}`,timeSeconds:null,instruction:''});save();renderPreservingEditorScroll();toast(`단계 ${meta.promptSteps.length}을 추가했습니다.`);});
  document.querySelectorAll('[data-prompt-step-remove]').forEach(button=>button.addEventListener('click',()=>{if(meta.promptSteps.length<=2)return;meta.promptSteps.splice(Number(button.dataset.promptStepRemove),1);save();renderPreservingEditorScroll();toast('단계를 삭제했습니다.');}));
  for(const [selector,key] of [['#meta-shot-size','shotSize'],['#meta-angle','angle'],['#meta-lens','lens'],['#meta-composition','composition'],['#meta-camera-speed','speed']])document.querySelector(selector)?.addEventListener('change',event=>{camera[key]=event.target.value;save();});
  const movementBoxes=[...document.querySelectorAll('[data-camera-movement]')],track=document.querySelector('.meta-track');movementBoxes.forEach(box=>box.addEventListener('change',()=>{let selected=movementBoxes.filter(item=>item.checked).map(item=>item.dataset.cameraMovement);if(box.dataset.cameraMovement==='static'&&box.checked){movementBoxes.forEach(item=>{if(item!==box)item.checked=false;});selected=['static'];}else if(box.dataset.cameraMovement!=='static'&&box.checked){const staticBox=movementBoxes.find(item=>item.dataset.cameraMovement==='static');if(staticBox)staticBox.checked=false;selected=movementBoxes.filter(item=>item.checked).map(item=>item.dataset.cameraMovement);}if(!selected.length){const staticBox=movementBoxes.find(item=>item.dataset.cameraMovement==='static');if(staticBox)staticBox.checked=true;selected=['static'];}camera.movements=selected;track?.classList.toggle('hidden',!selected.includes('tracking'));save();}));
  const trackTarget=document.querySelector('#meta-track-target'),trackCustom=document.querySelector('#meta-track-custom'),trackMethod=document.querySelector('#meta-track-method');trackTarget?.addEventListener('change',()=>{camera.trackingTarget=trackTarget.value;document.querySelector('.meta-track-custom')?.classList.toggle('hidden',trackTarget.value!=='custom');save();});trackCustom?.addEventListener('input',()=>{camera.trackingCustom=trackCustom.value;delayedSave();});trackMethod?.addEventListener('input',()=>{camera.trackingMethod=trackMethod.value;delayedSave();});
  document.querySelectorAll('.meta-element').forEach(card=>card.querySelectorAll('[data-element-field]').forEach(input=>input.addEventListener('input',()=>{const element=meta.elements[Number(card.dataset.elementIndex)];if(element)element[input.dataset.elementField]=input.value;delayedSave();})));
  document.querySelectorAll('[data-transition-field]').forEach(input=>input.addEventListener('input',()=>{if(meta.transition)meta.transition[input.dataset.transitionField]=input.value;delayedSave();}));
  document.querySelectorAll('[data-transition-phase-ko]').forEach(input=>input.addEventListener('input',()=>{const phase=meta.transition?.phases[Number(input.dataset.transitionPhaseKo)];if(phase)phase.actionKo=input.value;delayedSave();}));
  document.querySelectorAll('[data-transition-relation-ko]').forEach(input=>input.addEventListener('input',()=>{const relation=meta.transition?.relationships[Number(input.dataset.transitionRelationKo)];if(relation)relation.relationKo=input.value;delayedSave();}));
  const llmPanel=document.querySelector('.meta-llm');
  if(llmPanel){
    llmPanel.innerHTML=`<div class="meta-inline-analysis"><div><b>LLM 분석 및 프롬프트 적용</b><p>카메라·프리셋·장면 전환 조건을 확인한 뒤 단계형 분석을 시작하세요.</p></div><div><button type="button" class="button primary meta-launch-analysis">LLM 분석 진행</button>${String(meta.readableSummaryKo||'').trim()?'<button type="button" class="button secondary meta-summary-inline">요약 보기</button>':''}<button type="button" class="button secondary meta-reset-analysis">LLM 분석 초기화</button></div></div>`;
    // 일반 FLF 컷의 핵심 LLM 동작은 세부 설정을 접어도 사라지지 않아야 한다.
    // 상세 설정 내부에서 생성된 실행 바를 disclosure 바로 다음으로 이동해 항상 노출한다.
    if(!isVideoExtensionCut(scene)&&!isRef2vaCut(scene)&&disclosure){
      const inline=llmPanel.querySelector('.meta-inline-analysis');
      if(inline){inline.classList.add('cut-llm-always-visible');disclosure.insertAdjacentElement('afterend',inline);}
    }
  }else if(!isVideoExtensionCut(scene)&&!isRef2vaCut(scene)){
    const entry=document.querySelector('.meta-prompt-entry');
    if(entry&&!document.querySelector('.cut-llm-always-visible')){
      const unavailable=document.createElement('div');
      unavailable.className='meta-inline-analysis cut-llm-always-visible is-disabled';
      unavailable.innerHTML='<div><b>LLM 분석 및 프롬프트 적용</b><p>FIRST와 LAST 이미지를 모두 등록하면 LLM 분석을 진행할 수 있습니다.</p></div><div><button type="button" class="button primary" disabled>LLM 분석 진행</button><button type="button" class="button secondary" disabled>LLM 분석 초기화</button></div>';
      entry.insertAdjacentElement('afterend',unavailable);
    }
  }
  document.querySelector('.meta-launch-analysis')?.addEventListener('click',()=>openMetaAnalysisWorkflow(scene));document.querySelector('.meta-summary-inline')?.addEventListener('click',()=>openReadableSummary(scene));document.querySelector('.meta-reset-analysis')?.addEventListener('click',()=>resetLlmAnalysis(scene));document.querySelector('.meta-transition-copy')?.addEventListener('click',()=>copyMetaPrompt(scene));
  const json=document.querySelector('#meta-json'),pasteApply=document.querySelector('.meta-paste-json'),separateApply=document.querySelector('.meta-apply-json');
  json?.addEventListener('input',()=>{meta.llmJson=json.value;delayedSave();});
  if(pasteApply){pasteApply.classList.remove('secondary');pasteApply.classList.add('primary','meta-paste-apply');pasteApply.textContent='클립보드 JSON 붙여넣고 적용';pasteApply.addEventListener('click',async()=>{const started=Date.now();toast('클립보드 JSON 적용 중…',120000);try{const value=await navigator.clipboard.readText();if(!String(value).trim())throw new Error('클립보드가 비어 있습니다.');json.value=value;meta.llmJson=value;await keepProgressVisible(started);applyLlmJson(scene,value);}catch(error){toast(`클립보드 JSON 적용 실패: ${error.message||error}`);}});}
  if(separateApply){separateApply.type='button';separateApply.className='button secondary meta-summary-open';separateApply.textContent='요약 보기';separateApply.disabled=!String(meta.readableSummaryKo||'').trim();separateApply.title=separateApply.disabled?'새 메타 프롬프트로 생성한 JSON을 먼저 적용하세요.':'독해와 음성 청취에 최적화된 요약 보기';separateApply.addEventListener('click',()=>openReadableSummary(scene));}
  const final=document.querySelector('#meta-final-en'),finalKo=document.querySelector('#meta-final-ko'),finalCard=document.querySelector('.meta-final'),applyScene=document.querySelector('.meta-apply-scene');if(final)final.readOnly=true;if(finalKo)finalKo.readOnly=true;if(finalCard&&applyScene){const footer=document.createElement('div');footer.className='meta-final-actions';footer.append(applyScene);finalCard.append(footer);}applyScene?.addEventListener('click',()=>{scene.promptEn=meta.finalPromptEn;scene.promptKo=meta.revisedPromptKo||scene.promptKo;const en=document.querySelector('[data-prompt="en"]'),ko=document.querySelector('[data-prompt="ko"]');if(en)en.value=scene.promptEn;if(ko)ko.value=scene.promptKo;save();toast('한글·영문 프롬프트를 씬에 적용했습니다.');});
}
function bindCommon(){enhanceWorkspaceUx();document.querySelectorAll('[data-nav="frame-interpolation"]').forEach(b=>b.addEventListener('click',()=>{page='frame-interpolation';modal=null;render();}));document.querySelectorAll('[data-nav="upscale"]').forEach(b=>b.addEventListener('click',()=>{page='upscale';modal=null;render();}));document.querySelectorAll('select#scene-duration,select[name="duration"]').forEach(select=>{const input=document.createElement('input'),optionalCreationDuration=['scene-form','cut-form'].includes(select.closest('form')?.id);input.type='number';input.min='0.2';input.max='149';input.step='0.1';input.inputMode='decimal';input.value=select.value||'5';input.id=select.id;input.name=select.name;input.required=!optionalCreationDuration;input.setAttribute('aria-label','영상 길이(초)');select.replaceWith(input);});document.querySelectorAll('[data-nav="projects"],.crumb-projects').forEach(b=>b.addEventListener('click',()=>{page='projects';modal=null;render();}));document.querySelectorAll('[data-nav="video-video"]').forEach(b=>b.addEventListener('click',()=>{page='video-video';modal=null;render();}));document.querySelectorAll('[data-nav="video-audio"]').forEach(b=>b.addEventListener('click',()=>{page='video-audio';modal=null;render();}));document.querySelectorAll('[data-nav="settings"]').forEach(b=>b.addEventListener('click',()=>{page='settings';modal=null;render();}));document.querySelectorAll('[data-nav="queue"]').forEach(b=>b.addEventListener('click',()=>{page='queue';modal=null;render();}));}

async function copyCutPrompt(sceneId,cutId){
  const cut=findCut(currentProject(),sceneId,cutId),prompt=String(cut?.promptEn||'').trim();
  if(!prompt){toast('복사할 영문 프롬프트가 없습니다.');return;}
  try{await navigator.clipboard.writeText(prompt);toast('영문 프롬프트가 복사되었습니다.');}catch(error){toast(`프롬프트 복사 실패: ${error.message||error}`,6000);}
}

async function openCutImageFolder(sceneId,cutId){
  const project=currentProject(),cut=findCut(project,sceneId,cutId);if(!cut)return;
  if(!isTauri()){toast('데스크톱 앱에서 사용할 수 있습니다.');return;}
  if(cut.generationMode==='ref2va'){
    const path=cut.ref2va?.pictures?.[0]?.path||cut.ref2va?.videos?.[0]?.path||`${project.projectPath}\\references\\images`;
    try{await window.__TAURI__.core.invoke('open_media_folder',{path});}
    catch(error){toast(`레퍼런스 폴더를 열 수 없습니다: ${error.message||error}`,7000);}
    return;
  }
  if(!cut.firstPath&&!cut.lastPath){toast('내보낼 FIRST/LAST 이미지가 없습니다.');return;}
  try{
    const path=await window.__TAURI__.core.invoke('prepare_cut_image_folder',{executable:appSettings.ffmpegPath||'ffmpeg',projectPath:project.projectPath,firstImagePath:cut.firstPath||null,lastImagePath:cut.lastPath||null});
    toast(`폴더를 준비했습니다: ${path}`);
  }catch(error){toast(`이미지 폴더 준비 실패: ${error.message||error}`,7000);}
}

async function uploadCutVideo(sceneId,cutId){
  const project=currentProject(),cut=findCut(project,sceneId,cutId);if(!cut)return;
  if(!isTauri()){toast('영상 업로드는 데스크톱 앱에서 사용할 수 있습니다.');return;}
  const source=await window.__TAURI__.dialog.open({multiple:false,title:`${cut.name||'컷'} 영상 업로드`,filters:[{name:'Video',extensions:['mp4','mov','mkv','webm','m4v','avi']}]});if(!source)return;
  try{
    toast('영상을 프로젝트로 가져오는 중…',120000);
    const raw=await window.__TAURI__.core.invoke('import_cut_video',{executable:appSettings.ffmpegPath||'ffmpeg',sourcePath:source,projectPath:project.projectPath,filePrefix:mediaPrefix(project,sceneId,cutId)});
    const result={id:`result-upload-${Date.now()}`,type:'UPLOAD',res:raw.width&&raw.height?`${raw.width}×${raw.height}`:'원본',createdAt:new Date().toLocaleString('ko-KR'),path:raw.path,raw,duration:Number(raw.duration)||Number(cut.duration)||0,fps:Number(raw.fps)||0,frames:Number(raw.frames)||0,modelName:'사용자 업로드',backend:'로컬 영상 파일',promptKo:cut.promptKo||'',promptEn:cut.promptEn||'',color:'linear-gradient(135deg,#233d37,#668e83 52%,#b9d8cf)'};
    (cut.videoResults||=[]).unshift(result);cut.results=cut.videoResults.length;save();await selectResult(sceneId,cutId,result.id);toast(`${raw.originalName||'영상'}을 업로드하고 대표 영상으로 선택했습니다.`);
  }catch(error){toast(`영상 업로드 실패: ${error.message||error}`,8000);}
}

async function saveResultAs(sceneId,cutId,resultId){
  const cut=findCut(currentProject(),sceneId,cutId),result=(cut?.videoResults||[]).find(item=>item.id===resultId);
  if(!result?.path){toast('저장할 로컬 영상 파일이 없습니다.');return;}
  if(!isTauri()){toast('다른 이름으로 저장은 데스크톱 앱에서 사용할 수 있습니다.');return;}
  const filename=result.path.split(/[\\/]/).pop()||`S${String(sceneId).padStart(2,'0')}-C${String(cutId).padStart(3,'0')}.mp4`;
  try{
    const target=await window.__TAURI__.dialog.save({title:'영상 다른 이름으로 저장',defaultPath:filename,filters:[{name:'Video',extensions:[filename.split('.').pop()||'mp4']}]});
    if(!target)return;
    await window.__TAURI__.core.invoke('save_video_as',{sourcePath:result.path,targetPath:target});
    toast(`영상 저장 완료: ${target}`);
  }catch(error){toast(`영상 저장 실패: ${error.message||error}`,8000);}
}

async function openResultFolder(sceneId,cutId,resultId){
  const cut=findCut(currentProject(),sceneId,cutId),result=(cut?.videoResults||[]).find(item=>item.id===resultId);
  if(!result?.path){toast('열 수 있는 로컬 원본 경로가 없습니다.');return;}
  try{await window.__TAURI__.core.invoke('open_media_folder',{path:result.path});}
  catch(error){toast(`파일 위치 열기 실패: ${error.message||error}`,7000);}
}

async function openSceneExport(sceneId){
  const project=currentProject(),scene=(project.scenes||[]).find(item=>item.id===sceneId);if(!scene)return;
  const missing=(scene.cuts||[]).filter(cut=>!cut.selected?.path);
  if(missing.length){toast(`대표 영상을 내보낼 수 없습니다. 대표 영상 누락: ${missing.map(cut=>`C${String(cut.id).padStart(3,'0')} ${cut.name}`).join(' · ')}`,9000);return;}
  if(!isTauri()){toast('대표 영상 내보내기는 데스크톱 앱에서 사용할 수 있습니다.');return;}
  const folder=await window.__TAURI__.dialog.open({directory:true,multiple:false,title:`S${String(scene.id).padStart(2,'0')} 대표 영상 내보낼 폴더 선택`});if(!folder)return;
  try{
    toast(`대표 영상 ${(scene.cuts||[]).length}개를 복사하는 중…`,120000);
    for(const cut of scene.cuts||[]){
      const source=cut.selected.path,extension=String(source).match(/\.([a-z0-9]{1,8})$/i)?.[1]||'mp4',separator=String(folder).includes('\\')?'\\':'/';
      const target=`${String(folder).replace(/[\\/]$/,'')}${separator}S${String(scene.id).padStart(2,'0')}-C${String(cut.id).padStart(3,'0')}.${extension}`;
      await window.__TAURI__.core.invoke('save_video_as',{sourcePath:source,targetPath:target});
    }
    await window.__TAURI__.core.invoke('open_media_folder',{path:folder});
    toast(`대표 영상 ${(scene.cuts||[]).length}개를 복사하고 폴더를 열었습니다.`);
  }catch(error){toast(`대표 영상 내보내기 실패: ${error.message||error}`,10000);}
}

async function buildSceneCombinedVideo(sceneId){
  const project=currentProject(),scene=(project.scenes||[]).find(item=>item.id===sceneId);if(!scene)return;
  const sceneCuts=scene.cuts||[],missing=sceneCuts.filter(cut=>!cut.selected?.path);
  if(!sceneCuts.length){toast('합본에 사용할 컷이 없습니다.');return;}
  if(missing.length){toast(`대표 영상이 없는 컷이 있습니다: ${missing.map(cut=>`C${String(cut.id).padStart(2,'0')}`).join(', ')}`,7000);return;}
  if(!isTauri()){toast('씬 영상 합본은 데스크톱 앱에서 실행됩니다.');return;}
  const removeBoundaryFrames=await chooseCombineFramePolicy(sceneCuts.length);if(removeBoundaryFrames===null)return;
  const output=joinPath(project.projectPath,'scenes',`${projectCode(project)}-S${String(scene.id).padStart(2,'0')}-combined.mp4`);
  try{
    toast(removeBoundaryFrames?'컷 영상을 연결하고 있습니다. 각 경계의 앞 영상에서 마지막 1프레임을 제거합니다…':'컷 영상을 프레임 제거 없이 그대로 연결하고 있습니다…',120000);
    const path=await window.__TAURI__.core.invoke('build_scene_video',{executable:appSettings.ffmpegPath||'ffmpeg',videoPaths:sceneCuts.map(cut=>cut.selected.path),outputPath:output,fps:COMFY_FPS,removeBoundaryFrames});
    scene.combinedVideo={path,createdAt:new Date().toLocaleString('ko-KR'),cutCount:sceneCuts.length,fps:COMFY_FPS,removeBoundaryFrames};save();render();toast(`S${String(scene.id).padStart(2,'0')} 영상 합본을 생성했습니다 · ${removeBoundaryFrames?'경계 1프레임 제거':'프레임 제거 안 함'}`);
  }catch(error){toast(`씬 영상 합본 실패: ${error.message||error}`,8000);}
}

function chooseCombineFramePolicy(cutCount){
  return new Promise(resolve=>{const overlay=document.createElement('div');overlay.className='generation-check-backdrop frame-policy-backdrop';overlay.innerHTML=`<section class="generation-check-dialog frame-policy-dialog" role="dialog" aria-modal="true"><header><div><span>ASSEMBLY OPTION</span><h2>합본 경계 프레임 처리</h2><p>${cutCount}개 영상을 연결할 때 컷 경계의 중복 프레임 처리 방식을 선택하세요.</p></div><button type="button" class="generation-check-close" aria-label="닫기">×</button></header><div class="frame-policy-options"><button type="button" data-frame-policy="remove"><b>경계 1프레임 제거</b><small>기존 방식 · 마지막 컷을 제외한 각 영상의 마지막 1프레임을 제거합니다.</small></button><button type="button" data-frame-policy="keep"><b>프레임 제거 안 함</b><small>모든 원본 프레임을 그대로 유지해 순서대로 연결합니다.</small></button></div><footer><button type="button" class="button secondary frame-policy-cancel">취소</button></footer></section>`;document.body.appendChild(overlay);let settled=false;const finish=value=>{if(settled)return;settled=true;overlay.remove();resolve(value);};overlay.querySelector('[data-frame-policy="remove"]').addEventListener('click',()=>finish(true));overlay.querySelector('[data-frame-policy="keep"]').addEventListener('click',()=>finish(false));overlay.querySelector('.generation-check-close').addEventListener('click',()=>finish(null));overlay.querySelector('.frame-policy-cancel').addEventListener('click',()=>finish(null));overlay.addEventListener('click',event=>{if(event.target===overlay)finish(null);});});
}

function bindSettings(){
  const outputLabel=document.querySelector('#default-folder')?.closest('.field')?.querySelector('label');if(outputLabel)outputLabel.textContent='고정 출력 루트 폴더';
  const ensureComfy=async(forceRestart=false)=>{const message=document.querySelector('.comfy-message'),badge=document.querySelector('.comfy-badge'),baseUrl=document.querySelector('#comfy-url').value.trim(),preferredName=document.querySelector('#comfy-environment')?.value||'',showConsole=!!document.querySelector('#show-comfy-console')?.checked;message.textContent=forceRestart?'선택 환경을 다시 시작하는 중…':'실행 환경과 연결을 확인하는 중…';const result=await window.__TAURI__.core.invoke('comfy_ensure_environment',{baseUrl,preferredName,forceRestart,showConsole,requiredEngine:null});comfyRuntimeOnline=true;const name=result.environment?.name||'자동 선택 환경';message.textContent=`${result.started?'실행 및 연결 완료':'연결됨'} · ${name} · ${baseUrl}${showConsole?' · 콘솔 표시':''}`;badge.textContent=`실행 중 · ${name}`;badge.classList.add('online');return result;};
  const loadComfyModels=async(notify=true)=>{if(!isTauri())return;const preferredName=document.querySelector('#comfy-environment')?.value||'';try{const result=await window.__TAURI__.core.invoke('comfy_list_models',{preferredName});comfyModels=Array.isArray(result.models)?result.models:[];comfyModelsEnvironment=preferredName;renderSettings();if(notify)toast(`${result.environmentName||'Comfy'} 모델 ${comfyModels.length}개를 불러왔습니다.`);}catch(error){comfyModels=[];comfyModelsEnvironment=preferredName;renderSettings();toast(`모델 목록 조회 실패: ${error.message||error}`,10000);}};
  document.querySelector('.connect-openart')?.addEventListener('click',async e=>{if(!isTauri()){toast('OpenArt 로그인은 Tauri 데스크톱 앱에서 사용할 수 있습니다.');return;}const button=e.currentTarget;button.disabled=true;button.textContent='브라우저 로그인 대기 중…';try{openartInfo=await window.__TAURI__.core.invoke('openart_connect');await syncOpenArtModels();render();}catch(error){openartInfo.message=String(error);render();}});
  document.querySelector('.disconnect-openart')?.addEventListener('click',async()=>{if(isTauri())await window.__TAURI__.core.invoke('openart_disconnect');openartInfo={...openartInfo,connected:false,toolCount:0,tools:[],message:'연결을 해제했습니다.'};render();});
  document.querySelector('.refresh-openart')?.addEventListener('click',async()=>{if(isTauri()){openartInfo.tools=await window.__TAURI__.core.invoke('openart_list_tools');openartInfo.toolCount=openartInfo.tools.length;await syncOpenArtModels();render();}});
  document.querySelector('.choose-default-folder')?.addEventListener('click',async()=>{if(!isTauri()){document.querySelector('#default-folder').value='C:\\Users\\libho\\Videos\\FrameFlow Projects';return;}const folder=await window.__TAURI__.dialog.open({directory:true,multiple:false,title:'기본 프로젝트 폴더'});if(folder)document.querySelector('#default-folder').value=folder;});
  document.querySelector('.save-settings')?.addEventListener('click',async()=>{appSettings.defaultFolder=document.querySelector('#default-folder').value;appSettings.ffmpegPath=document.querySelector('#ffmpeg-path').value;appSettings.generationBackend='comfy';appSettings.comfyUrl=document.querySelector('#comfy-url').value.trim();appSettings.comfyEnvironmentName=document.querySelector('#comfy-environment')?.value||'';appSettings.showComfyConsole=!!document.querySelector('#show-comfy-console')?.checked;if(isTauri())await window.__TAURI__.core.invoke('save_app_settings',{settings:appSettings});localStorage.setItem('frameflow-settings-v1',JSON.stringify(appSettings));toast('설정을 저장했습니다.');});
  document.querySelector('.check-comfy')?.addEventListener('click',async e=>{const message=document.querySelector('.comfy-message'),badge=document.querySelector('.comfy-badge'),button=e.currentTarget;if(!isTauri()){message.textContent='ComfyUI 연결 확인은 데스크톱 앱에서 실행합니다.';return;}button.disabled=true;try{await ensureComfy(false);}catch(error){comfyRuntimeOnline=false;message.textContent=`연결 실패: ${error}`;badge.textContent='연결 실패';badge.classList.remove('online');}finally{button.disabled=false;}});
  document.querySelector('.restart-comfy')?.addEventListener('click',async e=>{const button=e.currentTarget,message=document.querySelector('.comfy-message'),badge=document.querySelector('.comfy-badge');if(!isTauri()){message.textContent='환경 재시작은 데스크톱 앱에서 실행합니다.';return;}button.disabled=true;try{await ensureComfy(true);}catch(error){message.textContent=`재시작 실패: ${error}`;badge.textContent='연결 실패';badge.classList.remove('online');}finally{button.disabled=false;}});
  document.querySelector('.refresh-comfy-environments')?.addEventListener('click',async()=>{if(!isTauri())return;try{comfyEnvironments=await window.__TAURI__.core.invoke('comfy_list_environments');renderSettings();toast(`Comfy 환경 ${comfyEnvironments.length}개를 찾았습니다.`);}catch(error){toast(`환경 조회 실패: ${error}`);}});
  document.querySelector('#comfy-environment')?.addEventListener('change',event=>{appSettings.comfyEnvironmentName=event.currentTarget.value||'';comfyModels=[];comfyModelsEnvironment=null;void loadComfyModels(false);});
  document.querySelector('.refresh-comfy-models')?.addEventListener('click',()=>void loadComfyModels(true));
  document.querySelector('.copy-comfy-model-list')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(comfyModels.map(model=>`${model.relativePath}\t${formatStorageSize(model.bytes)}`).join('\n'));toast(`모델 ${comfyModels.length}개의 목록을 복사했습니다.`);}catch(error){toast(`모델 목록 복사 실패: ${error.message||error}`);}});
  document.querySelectorAll('.copy-comfy-model').forEach(button=>button.addEventListener('click',async()=>{const model=comfyModels[Number(button.dataset.modelIndex)];if(!model||!isTauri())return;let destination;try{destination=await window.__TAURI__.dialog.open({directory:true,multiple:false,title:`${model.name} 복사 대상 폴더`});}catch(error){toast(`복사 폴더 선택 실패: ${error.message||error}`);return;}if(!destination)return;const original=button.innerHTML;button.disabled=true;button.textContent='복사 중…';try{const result=await window.__TAURI__.core.invoke('comfy_copy_model',{preferredName:document.querySelector('#comfy-environment')?.value||'',modelPath:model.path,destinationDir:destination});toast(`${result.name} 복사 완료 · ${result.path}`,12000);}catch(error){toast(`모델 복사 실패: ${error.message||error}`,12000);}finally{button.disabled=false;button.innerHTML=original;}}));
  document.querySelector('.backup-comfy-environment')?.addEventListener('click',async event=>{const button=event.currentTarget;if(!isTauri()){toast('Comfy 환경 백업은 데스크톱 앱에서 실행합니다.');return;}const environmentName=document.querySelector('#comfy-environment')?.value||'',environmentLabel=environmentName||'자동 선택 환경';if(!window.confirm(`${environmentLabel}의 custom_nodes, user, Python 패키지 목록과 FFmpeg를 ZIP으로 백업합니다. 모델 파일은 제외되고 models-list.txt 목록만 포함됩니다. 계속할까요?`))return;let destination;try{destination=await window.__TAURI__.dialog.open({directory:true,multiple:false,title:'Comfy 환경 백업 ZIP을 저장할 폴더'});}catch(error){toast(`백업 폴더 선택 실패: ${error.message||error}`,15000);return;}if(!destination)return;button.disabled=true;button.textContent='백업 ZIP 생성 중…';toast('모델을 제외한 Comfy 환경을 ZIP으로 압축하고 있습니다. 앱을 종료하지 마세요.',3600000);try{const result=await window.__TAURI__.core.invoke('comfy_backup_environment',{preferredName:environmentName,ffmpegPath:document.querySelector('#ffmpeg-path')?.value||appSettings.ffmpegPath||'ffmpeg',destinationDir:destination}),mb=(Number(result.bytes)||0)/1048576;toast(`${result.environmentName} 환경 백업 완료 · ${mb>=1024?(mb/1024).toFixed(1)+'GB':mb.toFixed(0)+'MB'} · 모델 제외 · ${result.path}`,15000);}catch(error){toast(`Comfy 환경 백업 실패: ${error.message||error}`,15000);}finally{button.disabled=false;button.textContent='Comfy 환경 백업';}});
  document.querySelector('.check-ffmpeg')?.addEventListener('click',async()=>{const el=document.querySelector('.ffmpeg-message');if(!isTauri()){el.textContent='웹 미리보기에서는 확인할 수 없습니다.';return;}try{const result=await window.__TAURI__.core.invoke('check_ffmpeg',{executable:document.querySelector('#ffmpeg-path').value});el.textContent=result;}catch(error){el.textContent=`확인 실패: ${error}`;}});
  const selectedEnvironment=document.querySelector('#comfy-environment')?.value||'';if(isTauri()&&comfyModelsEnvironment!==selectedEnvironment)void loadComfyModels(false);
}

async function addRef2vaPictures(scene,cut){
  const shared=isRef2vaContinuousScene(scene),state=shared?ensureRef2vaContinuousScene(scene):ensureRef2vaState(cut);if(state.pictures.length>=9){toast('레퍼런스 이미지는 최대 9개입니다.');return;}
  if(!isTauri()){toast('레퍼런스 가져오기는 데스크톱 앱에서 사용할 수 있습니다.');return;}
  const picked=await window.__TAURI__.dialog.open({multiple:true,title:'Ref2VA 레퍼런스 이미지 선택',filters:[{name:'Image',extensions:['png','jpg','jpeg','webp','bmp','tif','tiff']}]});
  const paths=Array.isArray(picked)?picked:picked?[picked]:[];if(!paths.length)return;
  try{toast('레퍼런스 이미지를 프로젝트에 복사하는 중…',120000);for(const source of paths.slice(0,9-state.pictures.length)){const raw=await window.__TAURI__.core.invoke('import_cut_reference_image',{sourcePath:source,projectPath:currentProject().projectPath,filePrefix:mediaPrefix(currentProject(),scene.id,cut.id)}),details=await localImageDetails(raw.path);state.pictures.push({id:`picture-${Date.now()}-${state.pictures.length}`,path:raw.path,name:raw.originalName||raw.path.split(/[\\/]/).pop(),role:'',preview:details.background,width:details.width,height:details.height});}if(shared)syncContinuousReferences(scene);save();renderPreservingEditorScroll();toast(`Ref2VA 이미지 ${paths.length}개를 추가했습니다.`);}catch(error){toast(`레퍼런스 이미지 추가 실패: ${error.message||error}`,8000);}
}
async function addRef2vaVideo(scene,cut){
  const shared=isRef2vaContinuousScene(scene),state=shared?ensureRef2vaContinuousScene(scene):ensureRef2vaState(cut);if(state.videos.length>=3){toast('레퍼런스 영상은 최대 3개입니다.');return;}
  if(!isTauri()){toast('레퍼런스 가져오기는 데스크톱 앱에서 사용할 수 있습니다.');return;}
  const source=await window.__TAURI__.dialog.open({multiple:false,title:'Ref2VA 레퍼런스 영상 선택',filters:[{name:'Video',extensions:['mp4','mov','mkv','webm','m4v','avi']}]});if(!source)return;
  try{const probe=await window.__TAURI__.core.invoke('probe_video',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:source});if(Number(probe.duration)<2||Number(probe.duration)>15)throw new Error(`MiniMax-H3 Ref2VA 레퍼런스 영상은 2~15초여야 합니다. 선택 영상: ${Number(probe.duration).toFixed(2)}초`);toast('레퍼런스 영상을 프로젝트에 복사하는 중…',120000);const raw=await window.__TAURI__.core.invoke('import_cut_video',{executable:appSettings.ffmpegPath||'ffmpeg',sourcePath:source,projectPath:currentProject().projectPath,filePrefix:`${mediaPrefix(currentProject(),scene.id,cut.id)}-reference`});state.videos.push({id:`video-${Date.now()}`,path:raw.path,name:raw.originalName||raw.path.split(/[\\/]/).pop(),role:'동작·포즈·카메라·구도 참조',duration:Number(raw.duration)||Number(probe.duration),width:Number(raw.width)||0,height:Number(raw.height)||0,fps:Number(raw.fps)||0});if(shared)syncContinuousReferences(scene);save();renderPreservingEditorScroll();toast('Ref2VA 영상을 추가했습니다.');}catch(error){toast(`레퍼런스 영상 추가 실패: ${error.message||error}`,8000);}
}
async function addRef2vaAudio(scene,cut){
  const shared=isRef2vaContinuousScene(scene),state=shared?ensureRef2vaContinuousScene(scene):ensureRef2vaState(cut);if(state.audios.length>=3){toast('레퍼런스 오디오는 최대 3개입니다.');return;}
  if(!isTauri()){toast('레퍼런스 가져오기는 데스크톱 앱에서 사용할 수 있습니다.');return;}
  const source=await window.__TAURI__.dialog.open({multiple:false,title:'Ref2VA 레퍼런스 오디오 선택',filters:[{name:'Audio',extensions:['wav','mp3','flac','m4a','aac','ogg']}]});if(!source)return;
  try{toast('레퍼런스 오디오를 프로젝트에 복사하는 중…',120000);const raw=await window.__TAURI__.core.invoke('import_cut_reference_audio',{sourcePath:source,projectPath:currentProject().projectPath,filePrefix:`${mediaPrefix(currentProject(),scene.id,cut.id)}-audio`});state.audios.push({id:`audio-${Date.now()}`,path:raw.path,name:raw.originalName||raw.path.split(/[\\/]/).pop(),role:'음색·보이스·환경음 참조'});if(shared)syncContinuousReferences(scene);save();renderPreservingEditorScroll();toast('Ref2VA 오디오를 추가했습니다.');}catch(error){toast(`레퍼런스 오디오 추가 실패: ${error.message||error}`,8000);}
}
async function loadLocalVideoFrameForCanvas(path){
  const source=window.__TAURI__.core.convertFileSrc(path),response=await fetch(source);if(!response.ok)throw new Error(`영상 레퍼런스를 읽지 못했습니다 (${response.status})`);const objectUrl=URL.createObjectURL(await response.blob());
  try{return await new Promise((resolve,reject)=>{const video=document.createElement('video'),timeout=setTimeout(()=>reject(new Error('영상 대표 프레임 로딩 시간이 초과되었습니다.')),12000);video.muted=true;video.preload='auto';video.onloadeddata=()=>{const target=Math.min(Math.max(.05,Number(video.duration||0)/2),Math.max(.05,Number(video.duration||.1)-.05));if(target>.06){video.currentTime=target;}else finish();};video.onseeked=finish;video.onerror=()=>{clearTimeout(timeout);reject(new Error('영상 대표 프레임을 디코딩하지 못했습니다.'));};function finish(){clearTimeout(timeout);const canvas=document.createElement('canvas');canvas.width=Math.max(2,video.videoWidth||640);canvas.height=Math.max(2,video.videoHeight||360);canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);resolve(canvas);}video.src=objectUrl;video.load();});}finally{URL.revokeObjectURL(objectUrl);}
}
function drawContainedImage(context,source,x,y,width,height){const sourceWidth=source.naturalWidth||source.videoWidth||source.width||1,sourceHeight=source.naturalHeight||source.videoHeight||source.height||1,scale=Math.min(width/sourceWidth,height/sourceHeight),drawWidth=Math.max(1,Math.round(sourceWidth*scale)),drawHeight=Math.max(1,Math.round(sourceHeight*scale));context.drawImage(source,x+Math.round((width-drawWidth)/2),y+Math.round((height-drawHeight)/2),drawWidth,drawHeight);}
async function composeRef2vaTaggedSheet(cut){
  const refs=ref2vaReferenceLabels(cut);if(!refs.length)throw new Error('태깅할 레퍼런스가 없습니다.');
  const columns=refs.length===1?1:2,cellWidth=720,mediaHeight=405,header=64,footer=44,gap=18,padding=18,cellHeight=header+mediaHeight+footer,rows=Math.ceil(refs.length/columns),canvas=document.createElement('canvas');canvas.width=padding*2+columns*cellWidth+(columns-1)*gap;canvas.height=padding*2+rows*cellHeight+(rows-1)*gap;const context=canvas.getContext('2d');context.fillStyle='#eaf1ed';context.fillRect(0,0,canvas.width,canvas.height);
  for(let index=0;index<refs.length;index++){const item=refs[index],column=index%columns,row=Math.floor(index/columns),x=padding+column*(cellWidth+gap),y=padding+row*(cellHeight+gap);context.fillStyle='#fff';context.fillRect(x,y,cellWidth,cellHeight);context.fillStyle='#174f44';context.fillRect(x,y,cellWidth,header);context.fillStyle='#fff';context.font='800 28px system-ui, sans-serif';context.fillText(item.label,x+20,y+41);context.fillStyle='#0d1513';context.fillRect(x,y+header,cellWidth,mediaHeight);try{const media=item.kind==='video'?await loadLocalVideoFrameForCanvas(item.path):await loadLocalImageForCanvas(item.path);drawContainedImage(context,media,x,y+header,cellWidth,mediaHeight);}catch(error){context.fillStyle='#9eb2aa';context.font='700 20px system-ui, sans-serif';context.fillText('미리보기를 불러오지 못했습니다.',x+24,y+header+mediaHeight/2);}
    context.fillStyle='#fff';context.fillRect(x,y+header+mediaHeight,cellWidth,footer);context.fillStyle='#405750';context.font='600 17px system-ui, sans-serif';const filename=String(item.name||item.path?.split(/[\\/]/).pop()||'reference');context.fillText(filename.length>70?`${filename.slice(0,67)}…`:filename,x+18,y+header+mediaHeight+29);
  }
  return canvasBlob(canvas);
}
function openRef2vaPromptStudio(scene,cut){
  const state=ensureRef2vaState(cut);if(!ref2vaReferenceLabels(cut).length){toast('LLM 프롬프트 생성 전에 레퍼런스를 추가해 주세요.');return;}
  document.querySelector('.ref2va-prompt-backdrop')?.remove();
  const host=document.createElement('div');host.className='ref2va-prompt-backdrop';
  host.innerHTML=`<section class="ref2va-prompt-modal"><header><div><span>MINIMAX-H3 REF2VA</span><h2>LLM 레퍼런스 프롬프트 생성</h2><p>레퍼런스별 역할과 세부 연출을 구조화해 공식 6섹션으로 변환합니다.</p></div><button type="button" class="close-ref2va-prompt">×</button></header><div class="ref2va-prompt-columns"><div><h3>1. LLM에 보낼 내용</h3><div class="ref2va-sheet-preview"><span>태깅 이미지 Sheet 준비 중…</span><img alt="Picture와 Video 태그가 표시된 레퍼런스 Sheet"></div><div class="ref-label-summary">${ref2vaReferenceLabels(cut).map(item=>`<b>${escapeAttr(item.label)}</b><span>${escapeAttr(item.name||'reference')} · ${escapeAttr(item.role||'역할 자동 분석')}</span>`).join('')}</div><label>사용자 연출 지시<textarea class="ref-modal-direction">${escapeAttr(state.userDirection)}</textarea></label><details class="ref2va-request-preview"><summary>LLM 요청 JSON · 레퍼런스/세부 연출 확인</summary><textarea readonly spellcheck="false">${escapeAttr(JSON.stringify(ref2vaRequestPayload(cut),null,2))}</textarea></details><div class="ref2va-transfer-actions"><button type="button" class="button secondary copy-ref2va-sheet" disabled>${icon('folder')} 이미지 Sheet 복사</button><button type="button" class="button primary copy-ref2va-instruction">${icon('spark')} LLM 지시문 복사</button></div><small>Sheet와 요청 JSON이 포함된 지시문을 차례로 LLM에 전달하세요.</small></div><div><h3>2. JSON 결과 검증·적용</h3><label>LLM 결과 JSON 붙여 넣기<textarea class="ref2va-json" placeholder='{"version":1,"request_id":"...","subject_definitions":{"ko":"...","en":"..."},...}'></textarea></label><div class="ref2va-validation" role="status" aria-live="polite">공식 6섹션·세부 연출·등록된 모든 레퍼런스 라벨의 반영 여부를 검사합니다.</div><div class="ref2va-json-actions"><button type="button" class="button secondary paste-ref2va-json">LLM 결과 JSON 붙여넣기</button><button type="button" class="button primary apply-ref2va-json">JSON 검증 및 프롬프트 적용</button></div></div></div></section>`;document.body.append(host);
  let sheetBlob=null,sheetUrl=null;const sheetPreview=host.querySelector('.ref2va-sheet-preview'),sheetButton=host.querySelector('.copy-ref2va-sheet');const prepareSheet=async()=>{sheetButton.disabled=true;sheetPreview.classList.add('loading');try{sheetBlob=await composeRef2vaTaggedSheet(cut);if(sheetUrl)URL.revokeObjectURL(sheetUrl);sheetUrl=URL.createObjectURL(sheetBlob);sheetPreview.querySelector('img').src=sheetUrl;sheetPreview.querySelector('span').textContent=`레퍼런스 ${ref2vaReferenceLabels(cut).length}개 · 태그 포함 한 장`;sheetButton.disabled=false;toast('태깅 이미지 Sheet를 준비했습니다.');}catch(error){sheetPreview.querySelector('span').textContent=`Sheet 준비 실패: ${error.message||error}`;toast(`태깅 이미지 Sheet 준비 실패: ${error.message||error}`,7000);}finally{sheetPreview.classList.remove('loading');}};
  const close=()=>{if(sheetUrl)URL.revokeObjectURL(sheetUrl);host.remove();};
  host.querySelector('.close-ref2va-prompt').addEventListener('click',close);
  host.addEventListener('click',event=>{if(event.target===host)close();});
  sheetButton.addEventListener('click',async()=>{try{if(!sheetBlob)sheetBlob=await composeRef2vaTaggedSheet(cut);if(!window.ClipboardItem||!navigator.clipboard?.write)throw new Error('이미지 클립보드를 지원하지 않습니다.');await navigator.clipboard.write([new ClipboardItem({'image/png':sheetBlob})]);toast(`태깅 이미지 Sheet 복사 완료 · 레퍼런스 ${ref2vaReferenceLabels(cut).length}개`);}catch(error){toast(`태깅 이미지 Sheet 복사 실패: ${error.message||error}`,7000);}});
  host.querySelector('.ref-modal-direction').addEventListener('input',event=>{state.userDirection=event.target.value;const preview=host.querySelector('.ref2va-request-preview textarea');if(preview)preview.value=JSON.stringify(ref2vaRequestPayload(cut),null,2);});
  host.querySelector('.copy-ref2va-instruction').addEventListener('click',async()=>{state.userDirection=host.querySelector('.ref-modal-direction').value;save();try{const instruction=ref2vaDetailedLlmInstruction(cut);if(!instruction.startsWith('STRICT OUTPUT CONTRACT — MINIMAX H3 REF2VA VIDEO PROMPT ONLY:')||instruction.includes('You are writing soundtrack instructions'))throw new Error('Ref2VA 전용 지시문 검증에 실패했습니다.');await navigator.clipboard.writeText(instruction);toast('레퍼런스·세부 연출 요청 JSON이 포함된 Ref2VA LLM 지시문을 복사했습니다.');}catch(error){toast(`지시문 복사 실패: ${error.message||error}`);}});
  host.querySelector('.paste-ref2va-json').addEventListener('click',async()=>{const field=host.querySelector('.ref2va-json'),status=host.querySelector('.ref2va-validation');try{const text=await navigator.clipboard.readText();if(!String(text||'').trim())throw new Error('클립보드가 비어 있습니다.');parseLlmJson(text);field.value=text;status.textContent='LLM 결과 JSON을 붙여 넣었습니다. 검증 및 적용을 눌러 주세요.';status.classList.remove('valid');toast('LLM 결과 JSON을 붙여 넣었습니다.');}catch(error){status.textContent=`붙여넣기 실패: ${error.message||error}`;status.classList.remove('valid');toast(`LLM 결과 JSON 붙여넣기 실패: ${error.message||error}`,7000);}});
  host.querySelector('.apply-ref2va-json').addEventListener('click',()=>{const status=host.querySelector('.ref2va-validation');try{const value=validateRef2vaJson(host.querySelector('.ref2va-json').value,cut);state.llmResult=value;cut.promptKo=ref2vaPromptFromJson(value,'ko');cut.promptEn=ref2vaPromptFromJson(value,'en');status.textContent='검증 완료 · 모든 레퍼런스와 세부 연출을 공식 6섹션에 적용했습니다.';status.classList.add('valid');save();toast('Ref2VA JSON을 검증하고 한글·영문 프롬프트에 적용했습니다.');setTimeout(()=>{close();renderPreservingEditorScroll();},350);}catch(error){status.textContent=error.message||String(error);status.classList.remove('valid');toast(`Ref2VA JSON 검증 실패: ${error.message||error}`,7000);}});
  prepareSheet();
}

function continuousSceneLlmInstruction(scene){
  syncContinuousReferences(scene);const cutsList=scene.cuts||[],shared=ensureRef2vaContinuousScene(scene),labels=ref2vaReferenceLabels(cutsList[0]||{ref2va:shared}).map(item=>`${item.label}: ${item.kind} reference; file=${item.name}; role=${item.role||'infer precisely'}`).join('\n');
  const directions=`${H3_OFFICIAL_REF_LLM_RULES}\n\nCUT-SPECIFIC DIRECTIONS:\n`+cutsList.map((cut,index)=>`C${String(cut.id).padStart(2,'0')} (${cut.duration||5}s)${index?' — begins with the previous clip\'s final 22 latent frames':''}:\n${ensureRef2vaState(cut).userDirection||'(infer from the scene goal and references)'}\nFrameFlow detail context:\n${JSON.stringify(ref2vaDetailContext(cut))}`).join('\n\n');
  return `You are designing every prompt for one MiniMax H3 Ref2VA latent-continuous scene. Return JSON only.\n\nSCENE GOAL:\n${scene.content||scene.title}\n\nSHARED IMMUTABLE REFERENCE ORDER:\n${labels}\n\nCUT DIRECTIONS (highest priority):\n${directions}\n\nReturn {"version":1,"request_id":"...","cuts":[...]}. cuts must contain exactly ${cutsList.length} items in order. Each item must contain cut_id plus the exact six bilingual objects subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music, each as {"ko":"...","en":"..."}.\n\nMandatory rules:\n- Use only the registered <Picture N>, <Video N>, and <Audio N> labels and define every used <Subject N>.\n- State exactly what identity, design, motion, pose, camera, composition, timing, voice/timbre and sound attributes are preserved, transformed, or omitted.\n- C01 starts from the shared references. C02 and later start from the immediately previous generated clip's final 22 latent frames; explicitly preserve the incoming composition, identities, motion direction, lighting and active sound phase before executing the new cut direction.\n- Never describe the 22 frames as 22 separate pictures, a LAST image, a crossfade, or a new reference label. It is incoming latent motion context.\n- detailed_description must preserve every non-empty FrameFlow camera, style, timeline, element and user instruction without summarizing it away.\n- overall_soundscape must contain synchronized physical effects when visible action implies them. non_diegetic_music must be N/A unless explicitly requested.\n- English is the generation prompt; Korean is review text. Do not omit or invent sections. Return JSON only.`;
}
function openContinuousSceneLlmStudio(scene){
  const cutsList=scene.cuts||[];if(!cutsList.length)return;syncContinuousReferences(scene);if(!ref2vaReferenceLabels(cutsList[0]).length){toast('씬 공통 레퍼런스를 먼저 추가해 주세요.');return;}
  const host=document.createElement('div');host.className='ref2va-prompt-backdrop';host.innerHTML=`<section class="ref2va-prompt-modal"><header><div><span>REF2VA CONTINUOUS SCENE</span><h2>전체 컷 LLM 프롬프트</h2><p>공통 레퍼런스와 컷별 지시, 이전 22프레임 latent 연속성을 한 번에 설계합니다.</p></div><button type="button" class="close-ref2va-prompt">×</button></header><div class="ref2va-prompt-columns"><div><h3>1. LLM에 보낼 내용</h3><div class="ref-label-summary">${ref2vaReferenceLabels(cutsList[0]).map(item=>`<b>${escapeAttr(item.label)}</b><span>${escapeAttr(item.name||'reference')}</span>`).join('')}</div><div class="continuous-cut-directions">${cutsList.map((cut,index)=>`<label><b>C${String(cut.id).padStart(2,'0')} · ${escapeAttr(cut.name)}</b><small>${index?'이전 영상의 마지막 22프레임 latent에서 시작':'공통 레퍼런스로 시작'}</small><textarea data-chain-direction="${cut.id}">${escapeAttr(ensureRef2vaState(cut).userDirection)}</textarea></label>`).join('')}</div><button type="button" class="button primary copy-chain-instruction">${icon('spark')} 전체 LLM 지시문 복사</button></div><div><h3>2. 전체 JSON 검증·적용</h3><textarea class="ref2va-json" placeholder='{"version":1,"request_id":"...","cuts":[...]}'></textarea><div class="ref2va-validation">컷 수·순서·6개 섹션·등록된 레퍼런스 라벨을 검사합니다.</div><button type="button" class="button primary apply-chain-json">전체 컷 JSON 검증 및 적용</button></div></div></section>`;document.body.append(host);
  const close=()=>host.remove();host.querySelector('.close-ref2va-prompt').addEventListener('click',close);host.querySelectorAll('[data-chain-direction]').forEach(field=>field.addEventListener('input',()=>{ensureRef2vaState(findCut(currentProject(),scene.id,Number(field.dataset.chainDirection))).userDirection=field.value;save();}));host.querySelector('.copy-chain-instruction').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(continuousSceneLlmInstruction(scene));toast(`Ref2VA 연속 씬 ${cutsList.length}개 컷 지시문을 복사했습니다.`);}catch(error){toast(`지시문 복사 실패: ${error.message||error}`);}});host.querySelector('.apply-chain-json').addEventListener('click',()=>{const status=host.querySelector('.ref2va-validation');try{const value=JSON.parse(host.querySelector('.ref2va-json').value.trim());if(Number(value.version)!==1||!Array.isArray(value.cuts)||value.cuts.length!==cutsList.length)throw new Error(`cuts는 정확히 ${cutsList.length}개여야 합니다.`);value.cuts.forEach((item,index)=>{const cut=cutsList[index];if(String(item.cut_id)!==String(cut.id)&&String(item.cut_id)!==`C${String(cut.id).padStart(2,'0')}`)throw new Error(`컷 ${index+1}의 cut_id 순서가 다릅니다.`);const checked=validateRef2vaJson({version:1,...item},cut);ensureRef2vaState(cut).llmResult=checked;cut.promptKo=ref2vaPromptFromJson(checked,'ko');cut.promptEn=ref2vaPromptFromJson(checked,'en');});status.textContent='전체 컷 검증 및 적용 완료';status.classList.add('valid');save();toast(`${cutsList.length}개 컷 프롬프트를 적용했습니다.`);setTimeout(()=>{close();render();},350);}catch(error){status.textContent=error.message||String(error);status.classList.remove('valid');toast(`전체 JSON 검증 실패: ${error.message||error}`,7000);}});
}

function bindProject(){
  document.querySelectorAll('.candidate-preview-badge').forEach(badge=>{if(badge.textContent.includes('대표 미선택')){badge.textContent='대표 미선택';badge.classList.add('unselected');}});document.querySelectorAll('.selected-video-info.candidate b').forEach(label=>{label.textContent='대표 미선택';label.closest('.selected-video-info')?.classList.add('unselected');});
  const scene=currentScene(),cut=currentCut();
  const inspectorElement=document.querySelector('.inspector');
  if(scene&&cut&&inspectorElement){
    if(!isRef2vaContinuousScene(scene))inspectorElement.querySelector('.inspector-head')?.insertAdjacentHTML('afterend',generationModeMarkup(cut));
    const actions=inspectorElement.querySelector('.inspector-actions');
    if(actions)actions.innerHTML=isVideoExtensionCut(cut)?`<button class="button primary generate-extension-cut" data-scene="${scene.id}" data-cut="${cut.id}" ${String(cut.promptEn||'').trim()?'':'disabled'}>${icon('film')} 비디오 확장 생성 MiniMax H3</button><button class="button secondary workflow-download" data-scene="${scene.id}" data-cut="${cut.id}">${icon('folder')} Workflow 다운로드</button>`:isRef2vaContinuousScene(scene)?`<button class="button primary open-ref2va-prompt">${icon('spark')} 이 컷 LLM 프롬프트 생성</button>`:isRef2vaCut(cut)?`<button class="button secondary ref2va-test-btn" data-scene="${scene.id}" data-cut="${cut.id}">${icon('spark')} Ref2VA 테스트 (1/4)</button><button class="button primary ref2va-gen-btn" data-scene="${scene.id}" data-cut="${cut.id}">${icon('film')} Ref2VA 영상 만들기</button><button class="button secondary workflow-download" data-scene="${scene.id}" data-cut="${cut.id}">${icon('folder')} Workflow 다운로드</button>`:`<button class="button secondary test-btn" data-scene="${scene.id}" data-cut="${cut.id}">${icon('spark')} 테스트 WAN 2.2</button><button class="button secondary minimax-test-btn" data-scene="${scene.id}" data-cut="${cut.id}">${icon('spark')} 테스트 Minimax-H3</button><button class="button primary gen-btn" data-scene="${scene.id}" data-cut="${cut.id}">${icon('film')} 영상 만들기 Minimax-H3</button><button class="button secondary workflow-download" data-scene="${scene.id}" data-cut="${cut.id}">${icon('folder')} Workflow 다운로드</button>`;
    const historyHeading=inspectorElement.querySelector('.history-heading');if(historyHeading){const button=document.createElement('button');button.type='button';button.className='button secondary upload-cut-video';button.dataset.scene=scene.id;button.dataset.cut=cut.id;button.innerHTML=`${icon('film')} 영상 업로드`;historyHeading.querySelector(':scope > span')?.before(button);}
  }
  if(scene&&cut&&inspectorElement){
    if(sceneEditorOpen){
      const backdrop=document.createElement('div');backdrop.className='scene-editor-backdrop';
      const close=document.createElement('button');close.className='editor-close';close.type='button';close.setAttribute('aria-label','컷 편집창 닫기');close.innerHTML=`${icon('close')}<span>닫기</span>`;
      inspectorElement.querySelector('.scene-manage')?.append(close);backdrop.append(inspectorElement);document.querySelector('main').append(backdrop);
      close.addEventListener('click',()=>{sceneEditorOpen=false;render();});
      backdrop.addEventListener('click',e=>{if(e.target===backdrop){sceneEditorOpen=false;render();}});
    }else{inspectorElement.remove();document.querySelector('.content-layout')?.classList.add('editor-closed');}
  }
document.querySelectorAll('[data-scene-continuous]').forEach(video=>{const scene=(currentProject().scenes||[]).find(item=>item.id===Number(video.dataset.sceneContinuous)),src=mediaSource(selectedSceneContinuousVideo(scene||{}));if(src)observeVideoSource(video,src);});
  document.querySelectorAll('[data-scene-combined]').forEach(video=>{const scene=(currentProject().scenes||[]).find(item=>item.id===Number(video.dataset.sceneCombined)),src=mediaSource(scene?.combinedVideo);if(src)observeVideoSource(video,src);});
  document.querySelectorAll('.open-scene-combined-folder').forEach(button=>button.addEventListener('click',async()=>{const scene=(currentProject().scenes||[]).find(item=>item.id===Number(button.dataset.scene)),path=scene?.combinedVideo?.path;if(!path)return;try{await window.__TAURI__.core.invoke('open_media_folder',{path});}catch(error){toast(`합본 영상 폴더 열기 실패: ${error}`,7000);}}));
  document.querySelectorAll('.continuous-history-item').forEach(button=>button.addEventListener('click',()=>{const scene=(currentProject().scenes||[]).find(item=>item.id===Number(button.dataset.scene)),video=continuousVideoList(scene||{}).find(item=>item.id===button.dataset.result);if(!scene||!video)return;scene.selectedContinuousVideoId=video.id;scene.continuousVideo=video;save();render();}));
  document.querySelectorAll('.open-continuous-folder').forEach(button=>button.addEventListener('click',async()=>{const scene=(currentProject().scenes||[]).find(item=>item.id===Number(button.dataset.scene)),video=continuousVideoList(scene||{}).find(item=>item.id===button.dataset.result);if(!video?.path)return;try{await window.__TAURI__.core.invoke('open_media_folder',{path:video.path});}catch(error){toast(`연속 영상 폴더 열기 실패: ${error}`,7000);}}));
  document.querySelectorAll('[data-ref2va-card-video]').forEach(video=>{const path=video.dataset.ref2vaCardVideo;if(!path)return;const src=isTauri()?window.__TAURI__.core.convertFileSrc(path):path;observeVideoSource(video,src);video.addEventListener('loadedmetadata',()=>{const duration=Number(video.duration)||0;if(duration>.1)video.currentTime=Math.min(Math.max(.05,duration*.35),Math.max(.05,duration-.05));},{once:true});});
  document.querySelectorAll('.cut-card').forEach(card=>{const item=findCut(currentProject(),Number(card.dataset.scene),Number(card.dataset.cut)),src=mediaSource(item?.selected),host=card.querySelector('.selected-video');if(src&&host){const video=document.createElement('video');observeVideoSource(video,src);video.muted=true;video.loop=true;video.playsInline=true;video.preload='metadata';host.prepend(video);host.querySelector('.play')?.addEventListener('click',()=>{if(video.paused){if(video.currentTime>=video.duration-.2)video.currentTime=0;video.play();}else video.pause();});}});
  const selectedSrc=mediaSource(cut?.selected),selectedHost=document.querySelector('.selected-result:not(.empty)');if(selectedSrc&&selectedHost){const video=document.createElement('video');video.src=selectedSrc;video.muted=false;video.playsInline=true;video.controls=true;video.preload='metadata';selectedHost.prepend(video);}
  if(sceneEditorOpen)document.querySelectorAll('[data-result-row]').forEach(row=>{const result=(cut?.videoResults||[]).find(item=>item.id===row.dataset.resultRow),video=row.querySelector('video'),src=mediaSource(result),media=row.querySelector('.video-result-media');if(video&&src)video.src=src;if(video&&media){const stopPreview=()=>{video.pause();video.currentTime=0;video.loop=false;};media.addEventListener('mouseenter',()=>{video.muted=true;video.loop=true;if(video.paused){video.currentTime=0;video.play().catch(()=>{});}});media.addEventListener('mouseleave',stopPreview);}});
  const note=document.querySelector('.inspector-note');
  if(cut&&note){
    if(isVideoExtensionCut(cut)){
      note.insertAdjacentHTML('beforebegin',extensionPanelMarkup(cut));
      const extensionField=document.querySelector('.extension-workspace'),videoPanel=document.querySelector('.result-panel');if(extensionField&&videoPanel)videoPanel.before(extensionField);
      extensionField?.insertAdjacentHTML('afterend',metaPromptMarkup(cut));bindMetaPrompt(cut);bindExtensionPanel(scene,cut);
      const metaTitle=document.querySelector('.meta-title h3');if(metaTitle)metaTitle.textContent='확장 구간 세부 연출';
      const metaIntro=document.querySelector('.meta-title p');if(metaIntro)metaIntro.textContent='카메라·분위기·시간 단계·요소 상태가 22프레임 연속성 분석과 함께 LLM 지시문에 포함됩니다.';
      const nativeSummary=document.querySelector('.meta-native-summary');if(nativeSummary)nativeSummary.innerHTML=`${icon('link')} 비디오 확장 세부 연출 설정`;
      const entryHelp=document.querySelector('.meta-entry-support small');if(entryHelp)entryHelp.textContent='세부 조건을 설정한 뒤 위의 Sheet와 LLM JSON 지시문을 복사하세요.';
      document.querySelector('.meta-transition-copy')?.remove();
      const llmPanel=document.querySelector('.meta-llm');if(llmPanel)llmPanel.innerHTML='<div class="meta-inline-analysis ref2va-detail-note"><div><b>확장 LLM에 자동 포함</b><p>이 설정은 사용자 지시·이전 프롬프트·Context 01·05·10·22 분석과 함께 JSON 지시문에 삽입됩니다.</p></div></div>';
    }else if(isRef2vaCut(cut)){
      note.insertAdjacentHTML('beforebegin',ref2vaPanelMarkup(cut,scene));
      const refField=document.querySelector('.ref2va-field'),videoPanel=document.querySelector('.result-panel');if(refField&&videoPanel)videoPanel.before(refField);
      refField?.insertAdjacentHTML('afterend',metaPromptMarkup(cut));bindMetaPrompt(cut);
      const metaTitle=document.querySelector('.meta-title h3');if(metaTitle)metaTitle.textContent='Ref2VA 세부 연출';
      const metaIntro=document.querySelector('.meta-title p');if(metaIntro)metaIntro.textContent='분위기·미학·카메라·시간 단계·요소 상태를 설정하면 Ref2VA 공식 6섹션에 함께 반영됩니다.';
      const nativeSummary=document.querySelector('.meta-native-summary');if(nativeSummary)nativeSummary.innerHTML=`${icon('spark')} Ref2VA 세부 연출 설정`;
      const entryHelp=document.querySelector('.meta-entry-support small');if(entryHelp)entryHelp.textContent='카메라·프리셋·시간 단계·요소 조건을 설정한 뒤 위 Ref2VA LLM 프롬프트 생성을 사용하세요.';
      document.querySelector('.meta-transition-copy')?.remove();
      const llmPanel=document.querySelector('.meta-llm');if(llmPanel)llmPanel.innerHTML='<div class="meta-inline-analysis ref2va-detail-note"><div><b>Ref2VA LLM에 자동 포함</b><p>이 설정은 위 “LLM Ref2VA 프롬프트 생성”의 지시문에 카메라·프리셋·타이밍·요소·연속성 제약으로 자동 삽입됩니다.</p></div></div>';
    }else{
    const flatCuts=cuts(currentProject()),flatIndex=flatCuts.findIndex(item=>item.cut.uid===cut.uid),previousCut=flatIndex>0?flatCuts[flatIndex-1]:null;
    const dropZone=(kind,key,label)=>{const width=Number(cut[`${key}Width`])||0,height=Number(cut[`${key}Height`])||0,resolution=width&&height?`${width.toLocaleString('ko-KR')} × ${height.toLocaleString('ko-KR')} px`:'';return`<div class="flf-drop-wrap"><button type="button" class="flf-drop-zone ${cut[key]?'has-image':''}" data-scene="${scene.id}" data-cut="${cut.id}" data-kind="${kind}" style="${cut[key]?`background-image:${cut[key]}`:''}"><span>${label}</span><div class="drop-copy">${icon('folder')}<b>${cut[`${key}Name`]||`${label} 이미지`}</b>${resolution?`<em class="flf-resolution">${resolution}</em>`:''}<small>${cut[key]?'클릭하거나 새 이미지를 드롭해 교체':'클릭하거나 이미지 파일을 여기에 드롭'}</small></div></button>${cut[key]?`<button type="button" class="flf-remove" data-scene="${scene.id}" data-cut="${cut.id}" data-kind="${kind}" title="${label} 이미지 삭제" aria-label="${label} 이미지 삭제">${icon('trash')}</button>`:''}</div>`;};
    const previousAction=previousCut?`<div class="previous-frame-action"><div><b>이전 Cut의 마지막 프레임 사용</b><small>${previousCut.scene.title} · ${previousCut.cut.name}${previousCut.cut.selected?'의 선택 영상에서 추출합니다.':'에 선택된 영상이 없어 먼저 영상을 선택해야 합니다.'}</small></div><button type="button" class="button secondary import-previous-frame" ${previousCut.cut.selected?'':'disabled'}>${icon('film')} 이전 Cut에서 마지막 프레임 가져오기</button></div>`:'';
    note.insertAdjacentHTML('beforebegin',`<div class="field flf-field"><label>First / Last Frame 이미지</label><div class="flf-drop-grid">${dropZone(0,'first','FIRST')}${dropZone(1,'last','LAST')}</div>${previousAction}</div>`);
    const flfField=document.querySelector('.flf-field'),videoPanel=document.querySelector('.result-panel');if(flfField&&videoPanel)videoPanel.before(flfField);
    flfField?.insertAdjacentHTML('afterend',metaPromptMarkup(cut));
    bindMetaPrompt(cut);
    document.querySelector('.import-previous-frame')?.addEventListener('click',async event=>{const button=event.currentTarget,original=button.innerHTML;button.disabled=true;button.textContent='마지막 프레임 추출 중…';toast('이전 Cut의 선택 영상에서 마지막 프레임을 추출 중…',120000);const ok=await ensureFirstFrame(currentProject(),scene,cut,true);if(ok){toast('이전 Cut의 마지막 프레임을 FIRST 이미지로 가져왔습니다.');renderPreservingEditorScroll();}else{button.disabled=false;button.innerHTML=original;}});
    }
  }
  document.querySelectorAll('[data-generation-mode]').forEach(button=>button.addEventListener('click',()=>{cut.generationMode=button.dataset.generationMode==='ref2va'?'ref2va':'flf';ensureRef2vaState(cut);save();renderPreservingEditorScroll();toast(cut.generationMode==='ref2va'?'생성 모드를 레퍼런스 기반(Ref2VA)으로 변경했습니다.':'생성 모드를 시작·끝 프레임(FLF)으로 변경했습니다.');}));
  document.querySelector('.add-reference-images')?.addEventListener('click',()=>addRef2vaPictures(scene,cut));
  document.querySelector('.add-reference-video')?.addEventListener('click',()=>addRef2vaVideo(scene,cut));
  document.querySelector('.add-reference-audio')?.addEventListener('click',()=>addRef2vaAudio(scene,cut));
  document.querySelectorAll('.remove-reference').forEach(button=>button.addEventListener('click',()=>{const shared=isRef2vaContinuousScene(scene),state=shared?ensureRef2vaContinuousScene(scene):ensureRef2vaState(cut),list=button.dataset.refKind==='video'?state.videos:button.dataset.refKind==='audio'?state.audios:state.pictures;list.splice(Number(button.dataset.refIndex),1);if(shared)syncContinuousReferences(scene);save();renderPreservingEditorScroll();toast('레퍼런스 연결을 해제했습니다. 원본 파일은 삭제하지 않았습니다.');}));
  document.querySelectorAll('.reference-role').forEach(input=>input.addEventListener('input',()=>{const shared=isRef2vaContinuousScene(scene),state=shared?ensureRef2vaContinuousScene(scene):ensureRef2vaState(cut),list=input.dataset.refKind==='video'?state.videos:input.dataset.refKind==='audio'?state.audios:state.pictures;if(list[Number(input.dataset.refIndex)])list[Number(input.dataset.refIndex)].role=input.value;if(shared)syncContinuousReferences(scene);save();}));
  document.querySelector('.ref-image-size')?.addEventListener('change',event=>{const state=isRef2vaContinuousScene(scene)?ensureRef2vaContinuousScene(scene):ensureRef2vaState(cut);state.refImageSize=event.target.value==='max'?'max':'match';if(isRef2vaContinuousScene(scene))syncContinuousReferences(scene);save();});
  document.querySelector('.ref2va-direction')?.addEventListener('input',event=>{ensureRef2vaState(cut).userDirection=event.target.value;save();});
  document.querySelectorAll('.open-ref2va-prompt').forEach(button=>button.addEventListener('click',()=>openRef2vaPromptStudio(scene,cut)));
  document.querySelectorAll('.cut-card').forEach(card=>card.addEventListener('click',event=>{if(event.target.closest('.copy-cut-prompt,.upload-cut-video,.open-cut-images,.results,.play,.order-button'))return;activeScene=Number(card.dataset.scene);activeCut=Number(card.dataset.cut);sceneEditorOpen=true;render();}));
  document.querySelectorAll('.add-scene').forEach(b=>b.addEventListener('click',addSceneDirect));
  document.querySelectorAll('.add-cut').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();activeScene=Number(button.dataset.scene);modal='cut';render();}));
  document.querySelectorAll('.test-btn').forEach(b=>b.addEventListener('click',()=>queueGeneration(Number(b.dataset.scene),Number(b.dataset.cut),true)));
  document.querySelectorAll('.minimax-test-btn').forEach(b=>b.addEventListener('click',()=>queueGeneration(Number(b.dataset.scene),Number(b.dataset.cut),true,'minimax-h3')));
  document.querySelectorAll('.gen-btn').forEach(b=>b.addEventListener('click',()=>queueGeneration(Number(b.dataset.scene),Number(b.dataset.cut),false)));
  document.querySelectorAll('.ref2va-test-btn').forEach(b=>b.addEventListener('click',()=>queueGeneration(Number(b.dataset.scene),Number(b.dataset.cut),true,'minimax-h3-ref2va')));
  document.querySelectorAll('.ref2va-gen-btn').forEach(b=>b.addEventListener('click',()=>queueGeneration(Number(b.dataset.scene),Number(b.dataset.cut),false,'minimax-h3-ref2va')));
  document.querySelectorAll('.workflow-download').forEach(button=>button.addEventListener('click',()=>{const targetScene=(currentProject().scenes||[]).find(item=>item.id===Number(button.dataset.scene)),targetCut=findCut(currentProject(),Number(button.dataset.scene),Number(button.dataset.cut));if(targetScene&&targetCut)downloadCutWorkflow(targetScene,targetCut);}));
  document.querySelectorAll('.extend-result-video').forEach(button=>button.addEventListener('click',()=>createVideoExtensionCut(activeScene,activeCut,button.dataset.result)));
  document.querySelectorAll('.generate-extension-cut').forEach(button=>button.addEventListener('click',()=>queuePreparedVideoExtension(Number(button.dataset.scene),Number(button.dataset.cut))));
  document.querySelectorAll('.scene-combine').forEach(button=>{
    if(!button.parentElement.querySelector('.scene-test-wan'))button.insertAdjacentHTML('beforebegin',`<button class="button secondary scene-test-wan" data-scene="${button.dataset.scene}">${icon('spark')} WAN</button><button class="button secondary scene-test-minimax" data-scene="${button.dataset.scene}">${icon('spark')} MiniMax-H3</button><button class="button secondary scene-generate-wan" data-scene="${button.dataset.scene}">${icon('film')} WAN</button><button class="button primary scene-generate-minimax" data-scene="${button.dataset.scene}">${icon('film')} MiniMax-H3</button><button class="button secondary scene-continuous-test" data-scene="${button.dataset.scene}">${icon('spark')} 테스트</button><button class="button primary scene-continuous" data-scene="${button.dataset.scene}">${icon('film')} 최종</button>`);
    if(!button.parentElement.querySelector('.scene-export'))button.insertAdjacentHTML('afterend',`<button class="button secondary scene-export" data-scene="${button.dataset.scene}">${icon('folder')} 대표 영상 내보내기</button>`);
    button.addEventListener('click',()=>buildSceneCombinedVideo(Number(button.dataset.scene)));
  });
  organizeSceneBulkActions();
  document.querySelectorAll('.scene-test-wan').forEach(button=>button.addEventListener('click',()=>openGenerationPlan('scene',true,Number(button.dataset.scene),'wan')));
  document.querySelectorAll('.scene-test-minimax').forEach(button=>button.addEventListener('click',()=>openGenerationPlan('scene',true,Number(button.dataset.scene),'minimax')));
  document.querySelectorAll('.scene-generate-wan').forEach(button=>button.addEventListener('click',()=>openGenerationPlan('scene',false,Number(button.dataset.scene),'wan')));
  document.querySelectorAll('.scene-generate-minimax').forEach(button=>button.addEventListener('click',()=>openGenerationPlan('scene',false,Number(button.dataset.scene),'minimax')));
  document.querySelectorAll('.scene-continuous-test').forEach(button=>button.addEventListener('click',()=>openContinuousGenerationPlan(Number(button.dataset.scene),true)));
  document.querySelectorAll('.scene-continuous').forEach(button=>button.addEventListener('click',()=>openContinuousGenerationPlan(Number(button.dataset.scene),false)));
  document.querySelectorAll('.scene-ref2va-llm').forEach(button=>button.addEventListener('click',()=>openContinuousSceneLlmStudio((currentProject().scenes||[]).find(item=>item.id===Number(button.dataset.scene)))));
  document.querySelectorAll('.scene-ref2va-continuous-test').forEach(button=>button.addEventListener('click',()=>openRef2vaContinuousGenerationPlan(Number(button.dataset.scene),true)));
  document.querySelectorAll('.scene-ref2va-continuous').forEach(button=>button.addEventListener('click',()=>openRef2vaContinuousGenerationPlan(Number(button.dataset.scene),false)));
  document.querySelectorAll('.scene-export').forEach(button=>button.addEventListener('click',()=>openSceneExport(Number(button.dataset.scene))));
  document.querySelector('.project-test')?.addEventListener('click',()=>openGenerationPlan('project',true));
  document.querySelector('.project-build')?.addEventListener('click',()=>openGenerationPlan('project',false));
  document.querySelectorAll('.project-settings-open').forEach(button=>button.addEventListener('click',()=>{modal='project-settings';render();}));
  document.querySelector('.project-delete-current')?.addEventListener('click',()=>deleteProject(currentProject().id));
  document.querySelectorAll('.scene-settings-open').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();activeScene=Number(button.dataset.scene);activeCut=currentScene()?.cuts?.[0]?.id||null;modal='scene-settings';render();}));
  document.querySelectorAll('.scene-order').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();moveSceneBy(Number(button.dataset.scene),button.dataset.direction);}));
  document.querySelectorAll('.cut-order').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();moveCutBy(Number(button.dataset.scene),Number(button.dataset.cut),button.dataset.direction);}));
  document.querySelector('#scene-duration')?.addEventListener('change',e=>{const value=Number(e.target.value);if(!Number.isFinite(value)||value<.2||value>149){e.target.value=currentCut().duration||5;toast('영상 길이는 0.2초 이상 149초 이하로 입력해 주세요.');return;}currentCut().duration=Math.round(value*1000)/1000;save();toast(`컷 길이를 ${currentCut().duration}초로 저장했습니다.`);});
  const seedInput=document.querySelector('#cut-generation-seed'),readSeed=()=>{const raw=String(seedInput?.value||'').trim(),seed=Number(raw);return/^\d+$/.test(raw)&&Number.isSafeInteger(seed)?seed:null;};seedInput?.addEventListener('input',()=>{const seed=readSeed();if(seed!==null){currentCut().nextGenerationSeed=seed;const copy=document.querySelector('.copy-cut-seed');if(copy)copy.dataset.seed=String(seed);clearTimeout(promptSaveTimer);promptSaveTimer=setTimeout(save,250);}});seedInput?.addEventListener('change',event=>{const seed=readSeed();if(seed===null){const fallback=Number.isSafeInteger(currentCut().nextGenerationSeed)?currentCut().nextGenerationSeed:COMFY_BASE_SEED;event.target.value=String(fallback);toast('Seed는 0 이상의 안전한 정수로 입력해 주세요.');return;}currentCut().nextGenerationSeed=seed;save();toast(`이 컷의 생성 Seed를 ${seed}으로 저장했습니다.`);});document.querySelector('.copy-cut-seed')?.addEventListener('click',()=>copySeed(seedInput?.value));document.querySelectorAll('.copy-result-seed').forEach(button=>button.addEventListener('click',()=>copySeed(button.dataset.seed)));
  document.querySelector('#cut-name')?.addEventListener('input',e=>{currentCut().name=e.target.value;clearTimeout(promptSaveTimer);promptSaveTimer=setTimeout(save,250);});
  bindFlfDropZones();
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.view;render();}));
  document.querySelectorAll('[data-prompt]').forEach(t=>{const update=e=>{const item=currentCut(),kind=e.target.dataset.prompt;if(kind==='ko')item.promptKo=e.target.value;else if(kind==='kling26')item.kling26Prompt=e.target.value;else if(kind==='kling26-negative')item.kling26NegativePrompt=e.target.value;else item.promptEn=e.target.value;clearTimeout(promptSaveTimer);promptSaveTimer=setTimeout(save,350);};t.addEventListener('input',update);t.addEventListener('change',()=>save());});
  document.querySelector('.copy-kling26-instruction')?.addEventListener('click',()=>copyKling26Instruction(currentScene(),currentCut()));
  document.querySelector('.paste-kling26-result')?.addEventListener('click',()=>pasteKling26Result(currentCut()));
  document.querySelectorAll('.copy-cut-prompt').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();copyCutPrompt(Number(button.dataset.scene),Number(button.dataset.cut));}));
  document.querySelectorAll('.upload-cut-video').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();uploadCutVideo(Number(button.dataset.scene),Number(button.dataset.cut));}));
  document.querySelectorAll('.open-cut-images').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();openCutImageFolder(Number(button.dataset.scene),Number(button.dataset.cut));}));
  document.querySelectorAll('.select-result').forEach(b=>b.addEventListener('click',()=>selectResult(activeScene,activeCut,b.dataset.result)));
  document.querySelectorAll('.deselect-result').forEach(b=>b.addEventListener('click',()=>deselectResult(activeScene,activeCut,b.dataset.result)));
  document.querySelectorAll('.delete-result').forEach(b=>b.addEventListener('click',()=>deleteResult(activeScene,activeCut,b.dataset.result)));
  document.querySelectorAll('.save-result-as').forEach(b=>b.addEventListener('click',()=>saveResultAs(activeScene,activeCut,b.dataset.result)));
  document.querySelectorAll('.open-result-folder').forEach(b=>b.addEventListener('click',()=>openResultFolder(activeScene,activeCut,b.dataset.result)));
  document.querySelectorAll('.result-file-location').forEach(b=>b.addEventListener('click',()=>openResultFolder(activeScene,activeCut,b.dataset.result)));
  document.querySelectorAll('.open-result-analysis').forEach(b=>b.addEventListener('click',()=>openResultAnalysisWorkflow(activeScene,activeCut,b.dataset.result)));
  document.querySelectorAll('[data-cut-action]').forEach(b=>b.addEventListener('click',()=>manageCut(b.dataset.cutAction)));
  document.querySelector('.project-open-folder')?.addEventListener('click',openCurrentProjectFolder);
  document.querySelector('.project-backup-current')?.addEventListener('click',()=>backupProject(currentProject().id));
  document.onkeydown=sceneEditorOpen?e=>{if(e.key==='Escape'){sceneEditorOpen=false;render();}}:null;
}

function organizeSceneBulkActions(){
  document.querySelectorAll('.scene-bulk-actions').forEach(host=>{
    if(host.querySelector('.scene-action-group'))return;
    const groups=[
      ['전체 컷 테스트',['scene-test-wan','scene-test-minimax']],
      ['전체 컷 생성',['scene-generate-wan','scene-generate-minimax']],
      ['연속 생성',['scene-continuous-test','scene-continuous']],
      ['파일',['scene-combine','scene-export']],
    ];
    groups.forEach(([label,classes])=>{
      const buttons=classes.map(className=>host.querySelector(`:scope > .${className}`)).filter(Boolean);
      if(!buttons.length)return;
      const group=document.createElement('div');group.className='scene-action-group';group.setAttribute('aria-label',label);
      const caption=document.createElement('span');caption.className='scene-action-group-label';caption.textContent=label;group.append(caption);
      if(label==='연속 생성'){const help=document.createElement('small');help.className='scene-action-group-help';help.textContent='MiniMax-H3 사용 · 이전 컷의 마지막 22프레임 latent 연결';group.append(help);}
      buttons.forEach(button=>group.append(button));host.append(group);
    });
    const addCut=host.querySelector(':scope > .add-cut');if(addCut){addCut.classList.add('scene-add-cut');host.append(addCut);}
  });
}

async function manageCut(action){const scene=currentScene(),list=scene?.cuts||[],index=list.findIndex(item=>item.id===activeCut);if(index<0)return;let keepUid=list[index].uid;if(action==='up'&&index>0)[list[index-1],list[index]]=[list[index],list[index-1]];if(action==='down'&&index<list.length-1)[list[index+1],list[index]]=[list[index],list[index+1]];if(action==='duplicate'){const copy=structuredClone(list[index]);copy.uid=`cut-${Date.now()}`;copy.name=`${copy.name} 복사본`;copy.selected=null;copy.videoResults=[];copy.results=0;copy.status='프롬프트 작성';list.splice(index+1,0,copy);keepUid=copy.uid;}if(action==='delete'){const target=list[index],confirmed=await confirmDestructive({title:'컷을 삭제하시겠습니까?',target:`S${String(scene.id).padStart(2,'0')} · C${String(target.id).padStart(2,'0')} · ${target.name||'이름 없는 컷'}`,message:'컷 정보와 프로젝트에 기록된 생성 결과가 삭제됩니다.',confirmLabel:'컷 삭제'});if(!confirmed)return;list.splice(index,1);keepUid=list[Math.min(index,list.length-1)]?.uid;sceneEditorOpen=false;}renumberHierarchy(keepUid);save();render();if(action==='delete')toast('컷을 삭제하고 편집창을 닫았습니다.');}

function moveSceneBy(sceneId,direction){const list=scenes(),index=list.findIndex(scene=>scene.id===sceneId),target=direction==='previous'?index-1:index+1;if(index<0||target<0||target>=list.length)return;const keepUid=currentCut()?.uid;[list[index],list[target]]=[list[target],list[index]];renumberHierarchy(keepUid);save();render();toast(`씬을 ${direction==='previous'?'이전':'다음'} 위치로 이동하고 S 번호와 미디어 파일명을 갱신했습니다.`);}
function moveCutBy(sceneId,cutId,direction){const scene=scenes().find(item=>item.id===sceneId),list=scene?.cuts||[],index=list.findIndex(cut=>cut.id===cutId),target=direction==='previous'?index-1:index+1;if(index<0||target<0||target>=list.length)return;const keepUid=list[index].uid;[list[index],list[target]]=[list[target],list[index]];renumberHierarchy(keepUid);save();render();toast(`컷을 ${direction==='previous'?'이전':'다음'} 위치로 이동하고 C 번호와 미디어 파일명을 갱신했습니다.`);}

function renumberHierarchy(activeUid=currentCut()?.uid){const project=currentProject(),mappings=[],byUid=new Map();scenes().forEach((scene,sceneIndex)=>{scene.id=sceneIndex+1;(scene.cuts||[]).forEach((cut,cutIndex)=>{cut.id=cutIndex+1;byUid.set(cut.uid,{scene,cut});const next=mediaPrefix(project,scene.id,cut.id),previous=cut.filePrefix||next;if(previous!==next)mappings.push({oldPrefix:previous,newPrefix:next,uid:cut.uid});cut.filePrefix=next;if(cut.uid===activeUid){activeScene=scene.id;activeCut=cut.id;}});});for(const {cut} of cuts(project)){const source=byUid.get(cut.extension?.sourceCutUid);if(source){cut.extension.sourceCutId=source.cut.id;cut.extension.sourceSceneId=source.scene.id;}}if(mappings.length)renameHierarchyFiles(project,mappings);}
async function renameHierarchyFiles(project,mappings){if(!isTauri())return;try{const changed=await window.__TAURI__.core.invoke('renumber_media_files',{projectPath:project.projectPath,mappings:mappings.map(({oldPrefix,newPrefix})=>({oldPrefix,newPrefix}))});for(const {cut} of cuts(project)){for(const key of ['firstPath','lastPath'])if(changed[cut[key]])cut[key]=changed[cut[key]];for(const result of cut.videoResults||[])for(const key of ['path','gifPath','sheetPath'])if(changed[result[key]])result[key]=changed[result[key]];for(const key of ['path','gifPath','sheetPath'])if(cut.selected?.[key]&&changed[cut.selected[key]])cut.selected[key]=changed[cut.selected[key]];if(cut.extension?.sourceVideoPath&&changed[cut.extension.sourceVideoPath])cut.extension.sourceVideoPath=changed[cut.extension.sourceVideoPath];const meta=sceneMeta(cut);if(meta.combinedPath&&changed[meta.combinedPath])meta.combinedPath=changed[meta.combinedPath];}save();toast(`${Object.keys(changed).length}개 미디어 파일명을 새 씬·컷 순서에 맞춰 변경했습니다.`);}catch(error){toast(`순서는 변경했지만 미디어 파일명 변경에 실패했습니다: ${error}`,6000);}}

function videoTool(){
  const tools=openartInfo.tools||[];
  return tools.find(t=>/generate.*video|create.*video/i.test(`${t.name} ${t.description||''}`)) || tools.find(t=>/video/i.test(`${t.name} ${t.description||''}`));
}

function imageTool(){
  const tools=openartInfo.tools||[];
  return tools.find(t=>/generate.*image|create.*image|text.*image/i.test(`${t.name} ${t.description||''}`)) || tools.find(t=>/image/i.test(`${t.name} ${t.description||''}`)&&!/video/i.test(`${t.name} ${t.description||''}`));
}

function taskTool(){
  const tools=openartInfo.tools||[];
  return tools.find(t=>/get.*(task|status|result)|check.*(task|status)|poll/i.test(`${t.name} ${t.description||''}`));
}

function toolArguments(tool,scene,isTest){
  const properties=tool?.inputSchema?.properties||tool?.input_schema?.properties||{};
  const args={},model=effectiveModel(scene),size=isTest?testResolution(currentProject()):projectResolution(currentProject()),resolution=resolutionValue(size);
  for(const key of Object.keys(properties)){
    const normalized=key.toLowerCase();
    if(normalized==='prompt'||normalized.includes('text_prompt'))args[key]=scene.promptEn;
    else if(normalized==='model'||normalized==='model_id')args[key]=model.id;
    else if(normalized.includes('duration')||normalized==='seconds')args[key]=scene.duration;
    else if(normalized.includes('resolution')||normalized==='quality')args[key]=resolution;
    else if(normalized==='width'||normalized.endsWith('_width'))args[key]=size.width;
    else if(normalized==='height'||normalized.endsWith('_height'))args[key]=size.height;
    else if(normalized==='size'||normalized.includes('dimensions'))args[key]=resolution;
    else if(normalized.includes('aspect'))args[key]=projectAspect(currentProject());
    else if(/first|start/.test(normalized)&&/frame|image/.test(normalized)&&scene.firstPath)args[key]=scene.firstPath;
    else if(/last|end/.test(normalized)&&/frame|image/.test(normalized)&&scene.lastPath)args[key]=scene.lastPath;
  }
  if(!Object.keys(args).some(k=>k.toLowerCase().includes('prompt')))args.prompt=scene.promptEn;
  return args;
}

function findMediaUrl(value){
  if(typeof value==='string'&&/^https?:\/\//.test(value)&&/\.(mp4|mov|webm)(\?|$)/i.test(value))return value;
  if(value&&typeof value==='object')for(const child of Object.values(value)){const found=findMediaUrl(child);if(found)return found;}
  return null;
}

function findImageUrl(value){
  if(typeof value==='string'){
    if(/^https?:\/\//.test(value)&&/\.(png|jpe?g|webp)(\?|$)/i.test(value))return value;
    if((value.startsWith('{')||value.startsWith('['))){try{return findImageUrl(JSON.parse(value));}catch{}}
  }
  if(value&&typeof value==='object')for(const child of Object.values(value)){const found=findImageUrl(child);if(found)return found;}
  return null;
}

function findTaskId(value){
  if(value&&typeof value==='object'){
    for(const [key,child] of Object.entries(value))if(/task.?id|generation.?id|job.?id/i.test(key)&&['string','number'].includes(typeof child))return String(child);
    for(const child of Object.values(value)){const found=findTaskId(child);if(found)return found;}
  }
  if(typeof value==='string'&&(value.startsWith('{')||value.startsWith('['))){try{return findTaskId(JSON.parse(value));}catch{}}
  return null;
}

async function awaitOpenArtResult(raw,kind){
  const direct=kind==='video'?findMediaUrl(raw):findImageUrl(raw);if(direct)return {raw,url:direct};
  const taskId=findTaskId(raw),tool=taskTool();if(!taskId||!tool)return {raw,url:null};
  const properties=tool.inputSchema?.properties||tool.input_schema?.properties||{},key=Object.keys(properties).find(k=>/task.?id|generation.?id|job.?id|id/i.test(k))||'task_id';
  for(let attempt=0;attempt<120;attempt++){
    await new Promise(resolve=>setTimeout(resolve,5000));
    raw=await window.__TAURI__.core.invoke('openart_call_tool',{toolName:tool.name,arguments:{[key]:taskId}});
    const url=kind==='video'?findMediaUrl(raw):findImageUrl(raw);if(url)return {raw,url};
    if(/failed|error|cancelled/i.test(JSON.stringify(raw)))throw new Error(`OpenArt 생성 실패: ${JSON.stringify(raw).slice(0,240)}`);
  }
  throw new Error('OpenArt 생성 결과 대기 시간이 초과되었습니다.');
}

async function ensureFirstFrame(project,scene,cut,forcePrevious=false){
  if(!forcePrevious&&(cut.firstPath||(!isTauri()&&cut.first)))return true;
  const flat=cuts(project),index=flat.findIndex(item=>item.cut.uid===cut.uid),previous=index>0?flat[index-1]:null;
  if(!previous){toast(`S${String(scene.id).padStart(2,'0')}-C${String(cut.id).padStart(2,'0')}에 FIRST Frame이 없고 이전 컷도 없어 프레임을 추출할 수 없습니다.`,6000);return false;}
  if(!previous.cut.selected?.path){toast('이전 Cut의 선택 영상이 없습니다. 이전 Cut 영상을 먼저 생성하고 대표 영상으로 선택해 주세요.',6000);return false;}
  if(!isTauri()){toast('마지막 프레임 추출은 데스크톱 앱에서 실행할 수 있습니다.');return false;}
  try{const path=await window.__TAURI__.core.invoke('extract_last_frame',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:previous.cut.selected.path,projectPath:project.projectPath,sourceScene:cutStorageNumber(previous.scene.id,previous.cut.id),targetScene:cutStorageNumber(scene.id,cut.id)});cut.firstPath=path;cut.firstName=path.split(/[\\/]/).pop();setCutImageDetails(cut,'first',await localImageDetails(path));cut.usePrevious=true;save();return true;}catch(error){toast(`FIRST Frame 추출 실패: ${error}`,6000);return false;}
}

async function createVideoExtensionCut(sceneId,cutId,resultId){
  const project=currentProject(),scene=(project.scenes||[]).find(item=>item.id===sceneId),sourceCut=findCut(project,sceneId,cutId),result=(sourceCut?.videoResults||[]).find(item=>item.id===resultId);
  if(!scene||!sourceCut||!result?.path){toast('확장할 영상 파일을 찾지 못했습니다.',7000);return;}
  if(!isTauri()){toast('비디오 확장은 FrameFlow Studio 데스크톱 앱에서 사용할 수 있습니다.');return;}
  const sourceIndex=(scene.cuts||[]).findIndex(item=>item.uid===sourceCut.uid),uid=`cut-${Date.now()}-extension`,duration=Math.max(.2,Number(sourceCut.duration)||Number(project.duration)||5),sourceDuration=Number(result.duration)||Number(sourceCut.duration)||5,sourceFrames=Number(result.frames)||Math.round(sourceDuration*MINIMAX_FPS),sourceName=result.path.split(/[\\/]/).pop();
  const extensionCut={id:sourceIndex+2,uid,name:`${sourceCut.name||`C${String(sourceCut.id).padStart(2,'0')}`} 확장`,status:'22F 분석 준비',duration,model:null,promptKo:'',promptEn:'',first:null,firstPath:null,last:null,lastPath:null,selected:null,results:0,usePrevious:false,videoResults:[],generationMode:'video-extension',nextGenerationSeed:Number.isSafeInteger(sourceCut.nextGenerationSeed)?sourceCut.nextGenerationSeed:COMFY_BASE_SEED,ref2va:{pictures:[],videos:[],audios:[],userDirection:'',refImageSize:'match'},extension:{sourceCutUid:sourceCut.uid,sourceCutId:sourceCut.id,sourceResultId:result.id,sourceVideoPath:result.path,sourceName,sourceFrames,sourceDuration,previousPromptKo:result.promptKo||sourceCut.promptKo||'',previousPromptEn:result.promptEn||sourceCut.promptEn||'',contextFrames:22,cumulative:true,userDirection:'',contextAssets:null,llmResult:null,createdAt:new Date().toISOString()}};
  scene.cuts.splice(sourceIndex+1,0,extensionCut);renumberHierarchy(uid);sceneEditorOpen=true;save();render();toast(`${sourceName}에서 새 비디오 확장 컷을 만들었습니다. 마지막 22프레임을 분석 중입니다.`,120000);
  try{
    const assets=await window.__TAURI__.core.invoke('generate_extension_context_frames',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:result.path,projectPath:project.projectPath,cutUid:uid});
    extensionCut.extension.contextAssets=assets;extensionCut.extension.sourceFrames=Number(assets.normalizedFrames)||sourceFrames;extensionCut.extension.sourceDuration=Number(assets.duration)||sourceDuration;extensionCut.status='LLM 분석 대기';
    const lastSample=assets.samples?.at(-1);if(lastSample?.path){const details=await localImageDetails(lastSample.path);extensionCut.extension.poster=details.background;}
    save();render();toast('Context 01·05·10·22 Sheet가 준비되었습니다. 사용자 지시를 적고 LLM 분석을 진행하세요.');
  }catch(error){extensionCut.status='22F 분석 실패';extensionCut.extension.contextError=String(error.message||error);save();render();toast(`확장 컷은 만들었지만 22F 분석 이미지 생성에 실패했습니다: ${error.message||error}`,9000);}
}

function videoExtensionPrompt(prompt,backgroundMusic=false){
  const source=String(prompt||'').trim();
  if(hasRef2vaPrompt(source))return minimaxPromptMusic(source,backgroundMusic);
  const structured=/integrated_multimodal_description\s*:/i.test(source)&&/overall_soundscape\s*:/i.test(source);
  const value=structured?source:`integrated_multimodal_description:\n[Continuity] Continue directly from the supplied final 22-frame latent context. Preserve the exact subject identity, object placement, lighting, lens, camera position, motion direction, visual style, contact points and active action. Do not restart, repeat, cut, dissolve, teleport or establish the scene again.\n\n[Extension] ${source}\n\n[Ending] End in a readable, physically continuous state that can be extended again.\n\noverall_soundscape:\nContinue the incoming ambience and acoustic perspective. Add synchronized physical sound effects for every visible impact, movement and environmental action without introducing unrelated sound.\n\nnon_diegetic_music:\nN/A`;
  return minimaxPromptMusic(value,backgroundMusic);
}

function videoExtensionLlmInstruction(cut,direction){
  const state=cut.extension||{},samples=(state.contextAssets?.samples||[]).map(item=>`Context ${String(item.contextIndex).padStart(2,'0')}: source frame ${item.sourceFrame}, ${Number(item.timeSeconds).toFixed(3)}s`).join('\n');
  return `You are designing one MiniMax H3 full-reference Existing Video Extension prompt. The source being continued is <Video 1>. Analyze the attached four-cell sheet sampled from its FINAL 22 normalized frames. Context 01, 05, 10 and 22 are chronological analysis labels, not Picture reference labels.\n\n${H3_OFFICIAL_REF_LLM_RULES}\n\nSOURCE VIDEO LABEL:\n<Video 1> = ${state.sourceName||state.sourceVideoPath||'selected result'}; role=the existing video directly continued by the target.\n\nSHEET INDEX:\n${samples||'Context 01, Context 05, Context 10, Context 22'}\n\nPREVIOUS GENERATION PROMPT (context only; preserve established facts but do not replay its action):\n${state.previousPromptEn||'(not recorded)'}\n\nUSER EXTENSION DIRECTION (highest priority):\n${direction||state.userDirection||'(none)'}\n\nOPTIONAL LAST TARGET:\n${cut.lastPath?'A separate final-frame image is registered as <Picture 1>. Define it as the target video\'s last-frame anchor and use summary task types [video continuation + keyframe completion]. Converge to it only at the final frame.':'No Picture target is registered. Use summary task type [video continuation] and end in a readable state that remains extendable.'}\n\nFRAMEFLOW META SETTINGS (preserve every non-empty setting):\n${JSON.stringify(ref2vaDetailContext(cut))}\n\nFirst inspect the sheet and identify every reusable visible subject as <Subject N>, including exact screen position, pose, expression, contact points, motion direction/speed, camera/lens/movement, lighting, environment geometry, style and active sound phase. Define <Video 1> as the continuation source. Design only the NEW interval after Context 22: never restart, replay, summarize, cut, dissolve, teleport, or re-establish the earlier action. State in retention_analysis exactly what incoming identity, composition, motion, lighting, camera and audio characteristics remain fully_preserved or otherwise change. User direction overrides inference. Include synchronized physical effects. non_diegetic_music must be N/A unless explicitly requested.\n\nReturn one JSON object only with version, request_id, and exactly the six bilingual Ref2VA objects in official order:\n{"version":1,"request_id":"...","subject_definitions":{"ko":"...","en":"<Video 1> is the source video continued by the target.\\n<Subject 1> is ..."},"summary":{"ko":"...","en":"[video continuation] The target video continues directly from <Video 1> ..."},"retention_analysis":{"ko":"...","en":"<Video 1> (continuation source): fully_preserved - ...\\n<Subject 1> (appears in [Shot 1]): fully_preserved - ..."},"detailed_description":{"ko":"...","en":"Overall style sentence before Shot 1. [Shot 1] ..."},"overall_soundscape":{"ko":"...","en":"1–4 concrete sentences ..."},"non_diegetic_music":{"ko":"","en":"N/A"}}\n\nEvery English section must be concrete and complete. Korean review fields may be empty only for genuinely absent content. Do not output Markdown fences or explanations.`;
}

function extensionPromptFromJson(value,language='en'){
  return ref2vaPromptFromJson(value,language);
}
function validateVideoExtensionJson(raw){
  let value;try{value=JSON.parse(String(raw||'').trim());}catch{throw new Error('올바른 JSON을 붙여 넣어 주세요.');}if(Number(value.version)!==1)throw new Error('version은 1이어야 합니다.');for(const key of REF2VA_SECTIONS)if(!value[key]||typeof value[key]!=='object'||typeof value[key].ko!=='string'||!String(value[key].en||'').trim())throw new Error(`${key}의 ko/en 응답이 필요합니다.`);const english=REF2VA_SECTIONS.map(key=>value[key].en).join('\n');if(!english.includes('<Video 1>'))throw new Error('공식 video continuation 형식의 <Video 1> 정의가 없습니다.');if(!/^\s*\[(?:video continuation)(?:\s*\+\s*keyframe completion)?\]/i.test(value.summary.en))throw new Error('summary는 [video continuation] 또는 [video continuation + keyframe completion]으로 시작해야 합니다.');if(!/\b(?:fully_preserved|partially_preserved|attribute_transfer|weak_reference)\b/.test(value.retention_analysis.en))throw new Error('retention_analysis에 공식 보존 관계 값이 없습니다.');if(!/\[Shot 1\]/i.test(value.detailed_description.en))throw new Error('detailed_description에 [Shot 1]이 없습니다.');return value;
}
async function composeExtensionContextSheet(cut){
  const samples=cut.extension?.contextAssets?.samples||[];if(samples.length!==4)throw new Error('Context 01·05·10·22 프레임이 아직 준비되지 않았습니다.');const width=720,height=405,header=62,footer=46,gap=18,padding=18,canvas=document.createElement('canvas');canvas.width=padding*2+width*2+gap;canvas.height=padding*2+(header+height+footer)*2+gap;const context=canvas.getContext('2d');context.fillStyle='#eaf4ef';context.fillRect(0,0,canvas.width,canvas.height);
  for(let index=0;index<samples.length;index++){const item=samples[index],x=padding+(index%2)*(width+gap),y=padding+Math.floor(index/2)*(header+height+footer+gap);context.fillStyle='#174f44';context.fillRect(x,y,width,header);context.fillStyle='#fff';context.font='800 27px system-ui,sans-serif';context.fillText(`Context ${String(item.contextIndex).padStart(2,'0')}`,x+20,y+40);context.fillStyle='#101816';context.fillRect(x,y+header,width,height);const image=await loadLocalImageForCanvas(item.path);drawContainedImage(context,image,x,y+header,width,height);context.fillStyle='#fff';context.fillRect(x,y+header+height,width,footer);context.fillStyle='#405750';context.font='600 17px system-ui,sans-serif';context.fillText(`Source frame ${item.sourceFrame} · ${Number(item.timeSeconds).toFixed(3)}s`,x+18,y+header+height+30);}
  return canvasBlob(canvas);
}
function extensionPanelMarkup(cut){
  const state=cut.extension||{},samples=state.contextAssets?.samples||[],source=state.sourceName||state.sourceVideoPath?.split(/[\\/]/).pop()||'원본 영상',lastResolution=cut.lastWidth&&cut.lastHeight?`${cut.lastWidth} × ${cut.lastHeight} px`:'';
  return `<section class="extension-workspace"><header><div><span>EXISTING VIDEO · FINAL 22F LATENT</span><h3>비디오 확장 준비</h3><p>${escapeAttr(source)}</p></div><b>C${String(state.sourceCutId||0).padStart(2,'0')}에서 확장</b></header><div class="extension-context-grid">${samples.length?samples.map(item=>`<figure><img data-extension-frame="${escapeAttr(item.path)}"><figcaption><b>Context ${String(item.contextIndex).padStart(2,'0')}</b><span>${item.sourceFrame} frame · ${Number(item.timeSeconds).toFixed(3)}s</span></figcaption></figure>`).join(''):`<div class="extension-context-loading">${state.contextError?`<b>22F 분석 이미지 준비 실패</b><small>${escapeAttr(state.contextError)}</small><button type="button" class="button secondary retry-extension-context">다시 준비</button>`:'마지막 22프레임에서 Context 01·05·10·22를 준비 중입니다.'}</div>`}</div><div class="extension-copy-actions"><button type="button" class="button secondary copy-extension-sheet" ${samples.length===4?'':'disabled'}>${icon('folder')} 22F 이미지 Sheet 복사</button><button type="button" class="button secondary copy-extension-instruction" ${samples.length===4?'':'disabled'}>${icon('spark')} LLM JSON 지시문 복사</button></div><label class="field"><span>사용자 확장 지시</span><textarea class="extension-user-direction" rows="4" placeholder="Context 22 이후에 이어질 새 동작과 장면 변화">${escapeAttr(state.userDirection||'')}</textarea></label><div class="extension-last-target"><div><b>선택적 LAST 이미지</b><small>미등록 시 프롬프트만으로 이어지고, 등록 시 마지막 프레임이 이 이미지로 수렴합니다. FIRST는 원본 22프레임에서 자동 결정됩니다.</small></div><div class="flf-drop-wrap"><button type="button" class="flf-drop-zone ${cut.last?'has-image':''}" data-scene="${activeScene}" data-cut="${cut.id}" data-kind="1" style="${cut.last?`background-image:${cut.last}`:''}"><span>LAST · 선택</span><div class="drop-copy">${icon('folder')}<b>${cut.lastName||'LAST 이미지 선택'}</b>${lastResolution?`<em class="flf-resolution">${lastResolution}</em>`:''}<small>${cut.last?'클릭하거나 드롭하여 교체':'클릭하거나 이미지 파일을 드롭'}</small></div></button>${cut.last?`<button type="button" class="flf-remove" data-scene="${activeScene}" data-cut="${cut.id}" data-kind="1" title="LAST 이미지 삭제">${icon('trash')}</button>`:''}</div></div><div class="extension-json-panel"><label><b>LLM JSON 결과</b><textarea class="extension-json" rows="10" placeholder='{"version":1,"request_id":"...","source_context_analysis":{...}}'>${state.llmResult?escapeAttr(JSON.stringify(state.llmResult,null,2)):''}</textarea></label><div class="extension-json-status ${state.llmResult?'valid':''}">${state.llmResult?'적용된 JSON · 다시 수정하여 재적용할 수 있습니다.':'Sheet와 지시문을 LLM에 보낸 뒤 JSON 결과를 붙여 넣으세요.'}</div><div><button type="button" class="button secondary reset-extension-analysis">LLM 분석 초기화</button><button type="button" class="button primary apply-extension-json">JSON 검증 및 프롬프트 적용</button></div></div></section>`;
}
function bindExtensionPanel(scene,cut){
  document.querySelectorAll('[data-extension-frame]').forEach(image=>image.src=window.__TAURI__.core.convertFileSrc(image.dataset.extensionFrame));const direction=document.querySelector('.extension-user-direction'),directionField=direction?.closest('label.field'),copyActions=document.querySelector('.extension-copy-actions');if(directionField&&copyActions)directionField.after(copyActions);direction?.addEventListener('input',()=>{cut.extension.userDirection=direction.value;clearTimeout(promptSaveTimer);promptSaveTimer=setTimeout(save,300);});document.querySelector('.copy-extension-sheet')?.addEventListener('click',async()=>{try{const blob=await composeExtensionContextSheet(cut);await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);toast('Context 01·05·10·22가 표시된 한 장의 Sheet를 복사했습니다.');}catch(error){toast(`22F Sheet 복사 실패: ${error.message||error}`,7000);}});document.querySelector('.copy-extension-instruction')?.addEventListener('click',async()=>{cut.extension.userDirection=direction?.value||'';save();try{await navigator.clipboard.writeText(videoExtensionLlmInstruction(cut,cut.extension.userDirection));toast('사용자 지시·이전 프롬프트·22F 분석·공식 H3 규칙을 포함한 Ref2VA 6섹션 JSON 지시문을 복사했습니다.');}catch(error){toast(`LLM 지시문 복사 실패: ${error.message||error}`,7000);}});document.querySelector('.apply-extension-json')?.addEventListener('click',()=>{const status=document.querySelector('.extension-json-status');try{const value=validateVideoExtensionJson(document.querySelector('.extension-json').value);cut.extension.llmResult=value;cut.promptKo=extensionPromptFromJson(value,'ko');cut.promptEn=extensionPromptFromJson(value,'en');status.textContent='검증 완료 · 공식 video continuation 6섹션 프롬프트를 적용했습니다.';status.classList.add('valid');save();toast('LLM JSON을 검증하고 공식 MiniMax H3 비디오 확장 프롬프트에 적용했습니다.');renderPreservingEditorScroll();}catch(error){status.textContent=error.message||String(error);status.classList.remove('valid');toast(`확장 JSON 검증 실패: ${error.message||error}`,7000);}});document.querySelector('.reset-extension-analysis')?.addEventListener('click',async()=>{if(!window.confirm('이 확장 컷의 LLM 분석 결과와 적용된 프롬프트를 초기화할까요? 원본 영상과 LAST 이미지는 유지됩니다.'))return;cut.extension.llmResult=null;cut.promptKo='';cut.promptEn='';save();renderPreservingEditorScroll();toast('비디오 확장 LLM 분석을 초기화했습니다.');});
  const extensionJson=document.querySelector('.extension-json');if(extensionJson)extensionJson.placeholder='{"version":1,"request_id":"...","subject_definitions":{"ko":"...","en":"<Video 1> ..."},"summary":{"ko":"...","en":"[video continuation] ..."},...}';
  document.querySelector('.retry-extension-context')?.addEventListener('click',async event=>{event.currentTarget.disabled=true;toast('마지막 22프레임 분석 이미지를 다시 준비 중입니다.',120000);try{const project=currentProject(),assets=await window.__TAURI__.core.invoke('generate_extension_context_frames',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:cut.extension.sourceVideoPath,projectPath:project.projectPath,cutUid:cut.uid});cut.extension.contextAssets=assets;cut.extension.contextError=null;cut.status='LLM 분석 대기';const lastSample=assets.samples?.at(-1);if(lastSample?.path)cut.extension.poster=(await localImageDetails(lastSample.path)).background;save();renderPreservingEditorScroll();toast('Context 01·05·10·22 Sheet를 다시 준비했습니다.');}catch(error){cut.extension.contextError=String(error.message||error);save();renderPreservingEditorScroll();toast(`22F 분석 이미지 준비 실패: ${error.message||error}`,8000);}});
}

function openVideoExtensionDialog(scene,cut){
  if(!cut.selected?.path){toast('비디오 확장에 사용할 대표 영상을 먼저 선택해 주세요.',7000);return;}
  const sourceName=cut.selected.path.split(/[\\/]/).pop(),draft=cut.extensionDraft||{};
  const overlay=document.createElement('div');overlay.className='action-dialog-backdrop';overlay.innerHTML=`<form class="action-dialog video-extension-dialog" role="dialog" aria-modal="true"><header><span>MINIMAX-H3 · 22F LATENT</span><h2>C${String(cut.id).padStart(2,'0')} 비디오 확장</h2><p>대표 영상의 마지막 22프레임에서 이어 생성하고, 원본과 중복 없이 합친 누적 영상을 다음 컷 후보로 만듭니다.</p></header><div class="extension-source-summary"><b>${escapeAttr(sourceName)}</b><span>C${String(cut.id).padStart(2,'0')} 전체 영상 → 마지막 22프레임 latent → 새 구간</span></div><label class="field"><span>새 구간 길이</span><input name="duration" type="number" min="0.2" max="149" step="0.1" value="${Number(draft.duration)||Number(cut.duration)||5}" required></label><label class="field"><span>사용자 확장 지시</span><textarea name="direction" rows="4" placeholder="이전 동작이 이어진 뒤 새로 일어날 내용">${escapeAttr(draft.direction||'')}</textarea></label><div class="extension-prompt-toolbar"><b>실제 MiniMax 영문 프롬프트</b><button type="button" class="button secondary copy-extension-llm">${icon('spark')} LLM 지시문 복사</button></div><textarea name="promptEn" rows="10" placeholder="LLM 결과 또는 직접 작성한 영문 프롬프트" required>${escapeAttr(draft.promptEn||'')}</textarea><small>LLM 결과는 이전 장면을 반복하지 않고 새 확장 구간만 설명해야 합니다.</small><footer><button type="button" class="button secondary cancel-extension">취소</button><button type="submit" class="button primary">생성 옵션 선택</button></footer></form>`;document.body.append(overlay);
  const close=()=>overlay.remove();overlay.addEventListener('click',event=>{if(event.target===overlay)close();});overlay.querySelector('.cancel-extension').addEventListener('click',close);overlay.querySelector('.copy-extension-llm').addEventListener('click',async()=>{const direction=overlay.querySelector('[name="direction"]').value;try{await navigator.clipboard.writeText(videoExtensionLlmInstruction(cut,direction));toast('마지막 22프레임 연속성 규칙을 포함한 LLM 지시문을 복사했습니다.');}catch(error){toast(`LLM 지시문 복사 실패: ${error.message||error}`,7000);}});
  overlay.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.currentTarget),direction=String(form.get('direction')||'').trim(),promptEn=String(form.get('promptEn')||'').trim(),duration=Number(form.get('duration'));if(!promptEn){toast('새 구간의 영문 프롬프트를 입력해 주세요.');return;}cut.extensionDraft={direction,promptEn,duration};save();close();const options=await minimaxOptionsDialog({title:`C${String(cut.id).padStart(2,'0')} 비디오 확장 설정`,allowHybrid:false});if(!options)return;if(options.latentUpscaleMode&&options.latentUpscaleMode!=='off'){toast('기존 영상 확장은 원본과 출력 캔버스가 같아야 하므로 잠재 업스케일을 사용할 수 없습니다.',7000);return;}if(!window.confirm(`C${String(cut.id).padStart(2,'0')} 대표 영상의 마지막 22프레임에서 이어 생성합니다.\n완료되면 누적 합본을 다음 위치의 새 컷 후보로 추가하고, 이후 컷 번호는 하나씩 증가합니다.\n기존 영상과 대표 선택은 변경하지 않습니다.`))return;queueVideoExtension(scene,cut,{direction,promptEn,duration,...options});});
}

function queueVideoExtension(scene,cut,options){
const project=currentProject(),profile=options.profile||DEFAULT_MINIMAX_PROFILE,modelMode=effectiveMinimaxModelMode(profile,options.modelMode||'default'),backgroundMusic=!!options.backgroundMusic,size=minimaxResolution(project),seed=Number.isSafeInteger(cut.nextGenerationSeed)?cut.nextGenerationSeed:COMFY_BASE_SEED,promptEn=videoExtensionPrompt(options.promptEn,backgroundMusic),duration=Math.max(.2,Number(options.duration)||5),profileInfo=minimaxProfile(profile),modelModeInfo=minimaxModelMode(modelMode);
  const job={id:`job-${Date.now()}-extension-${cut.uid}`,batchId:`extension-${Date.now()}-${cut.uid}`,projectId:project.id,sceneId:scene.id,cutId:cut.id,cutUid:cut.uid,sourceCutUid:cut.uid,sceneName:scene.title,cutName:`${cut.name} 비디오 확장`,type:'FINAL',status:'queued',engine:'minimax-h3-existing-video-extension',videoExtension:true,sourceVideoPath:cut.selected.path,sourceResultId:cut.selected.id,sourceFrames:Number(cut.selected.frames)||Math.round((Number(cut.selected.duration)||Number(cut.duration)||5)*MINIMAX_FPS),sourceDuration:Number(cut.selected.duration)||Number(cut.duration)||5,extensionDirection:options.direction||'',promptKo:options.direction||'',promptEn,minimaxProfile:profile,minimaxModelMode:modelMode,latentUpscaleMode:'off',backgroundMusic,modelName:`Minimax-H3 Existing Video Extension · ${modelModeInfo.label} · ${profileInfo.label}`,generationSpec:makeMinimaxGenerationSpec({engine:'minimax-h3-existing-video-extension',modelMode,profile,latentUpscaleMode:'off',backgroundMusic}),resolution:resolutionLabel(size),resolutionWidth:size.width,resolutionHeight:size.height,fps:MINIMAX_FPS,frames:minimaxFrameLength(duration),duration,seed,estimatedSeconds:MINIMAX_BENCHMARK_SECONDS*megapixels(size)/megapixels(MINIMAX_BENCHMARK_SIZE)*duration/5*profileInfo.factor,createdAt:new Date().toISOString(),error:null,cancelRequested:false};
  applyHistoricalEstimate(job);(project.jobs||=[]).push(job);queuePaused=false;save();renderGenerationDock();toast(`${scene.title} · C${String(cut.id).padStart(2,'0')} 누적 비디오 확장을 큐에 추가했습니다.`);runGenerationQueue();
}

async function queuePreparedVideoExtension(sceneId,cutId){
  const project=currentProject(),scene=(project.scenes||[]).find(item=>item.id===sceneId),cut=findCut(project,sceneId,cutId),state=cut?.extension;
  if(!scene||!isVideoExtensionCut(cut)||!state?.sourceVideoPath){toast('비디오 확장 원본을 찾지 못했습니다.',7000);return;}
  if((state.contextAssets?.samples||[]).length!==4){toast('Context 01·05·10·22 이미지가 아직 준비되지 않았습니다.',7000);return;}
  if(!String(cut.promptEn||'').trim()){toast('LLM JSON을 검증·적용하거나 영문 프롬프트를 입력해 주세요.',7000);return;}
  const options=await minimaxOptionsDialog({title:`C${String(cut.id).padStart(2,'0')} 비디오 확장 생성 설정`,allowHybrid:false});if(!options)return;
  if(options.latentUpscaleMode&&options.latentUpscaleMode!=='off'){toast('누적 비디오 확장은 원본과 출력 캔버스가 같아야 하므로 잠재 업스케일을 사용할 수 없습니다.',7000);return;}
  if(!window.confirm(`원본 영상의 마지막 22프레임 latent에서 새 구간을 생성합니다.\n${cut.lastPath?'선택한 LAST 이미지로 마지막 프레임을 유도합니다.':'LAST 이미지 없이 프롬프트로 끝점을 결정합니다.'}\n완료 결과는 이 컷의 후보 영상으로 등록하며 대표 영상은 자동 선택하지 않습니다.`))return;
  let internalFirstPath=null;
  if(cut.lastPath){
    try{toast('LAST 연결용 내부 시작 프레임을 준비 중입니다.',120000);internalFirstPath=await window.__TAURI__.core.invoke('extract_last_frame',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:state.sourceVideoPath,projectPath:project.projectPath,sourceScene:cutStorageNumber(scene.id,state.sourceCutId||Math.max(1,cut.id-1)),targetScene:cutStorageNumber(scene.id,cut.id)});state.internalFirstPath=internalFirstPath;}catch(error){toast(`LAST 연결용 시작 프레임 추출 실패: ${error.message||error}`,7000);return;}
  }
const profile=options.profile||DEFAULT_MINIMAX_PROFILE,modelMode=effectiveMinimaxModelMode(profile,options.modelMode||'default'),backgroundMusic=!!options.backgroundMusic,size=minimaxResolution(project),seed=Number.isSafeInteger(cut.nextGenerationSeed)?cut.nextGenerationSeed:COMFY_BASE_SEED,duration=Math.max(.2,Number(cut.duration)||5),profileInfo=minimaxProfile(profile),modelModeInfo=minimaxModelMode(modelMode),promptEn=videoExtensionPrompt(cut.promptEn,backgroundMusic);
  const job={id:`job-${Date.now()}-extension-${cut.uid}`,batchId:`extension-${Date.now()}-${cut.uid}`,projectId:project.id,sceneId:scene.id,cutId:cut.id,cutUid:cut.uid,sourceCutUid:state.sourceCutUid,sourceCutId:state.sourceCutId,sceneName:scene.title,cutName:cut.name,type:'FINAL',status:'queued',engine:'minimax-h3-existing-video-extension',videoExtension:true,preparedExtensionCut:true,sourceVideoPath:state.sourceVideoPath,sourceResultId:state.sourceResultId,sourceFrames:Number(state.sourceFrames)||Math.round((Number(state.sourceDuration)||5)*MINIMAX_FPS),sourceDuration:Number(state.sourceDuration)||5,firstImagePath:internalFirstPath,lastImagePath:cut.lastPath||null,extensionDirection:state.userDirection||'',promptKo:cut.promptKo||'',promptEn,minimaxProfile:profile,minimaxModelMode:modelMode,latentUpscaleMode:'off',backgroundMusic,modelName:`Minimax-H3 Existing Video Extension · ${modelModeInfo.label} · ${profileInfo.label}`,generationSpec:makeMinimaxGenerationSpec({engine:'minimax-h3-existing-video-extension',modelMode,profile,latentUpscaleMode:'off',backgroundMusic}),resolution:resolutionLabel(size),resolutionWidth:size.width,resolutionHeight:size.height,fps:MINIMAX_FPS,frames:minimaxFrameLength(duration),duration,seed,estimatedSeconds:MINIMAX_BENCHMARK_SECONDS*megapixels(size)/megapixels(MINIMAX_BENCHMARK_SIZE)*duration/5*profileInfo.factor,createdAt:new Date().toISOString(),error:null,cancelRequested:false};
  applyHistoricalEstimate(job);(project.jobs||=[]).push(job);queuePaused=false;cut.status='확장 생성 대기';save();renderGenerationDock();toast(`${scene.title} · C${String(cut.id).padStart(2,'0')} 비디오 확장을 큐에 추가했습니다.`);runGenerationQueue();
}

async function queueGeneration(sceneId,cutId,isTest,engineOverride=null,forcePrevious=false,minimaxOptions=null){
  const project=currentProject(),scene=project.scenes.find(item=>item.id===sceneId),cut=findCut(project,sceneId,cutId),type=isTest?'TEST':'FINAL';if(!scene||!cut)return;
  const refMode=isRef2vaCut(cut),refState=ensureRef2vaState(cut);
  if(refMode){
    forcePrevious=false;
    if(!ref2vaReferenceLabels(cut).length){toast('Ref2VA 레퍼런스 이미지 또는 영상을 먼저 추가해 주세요.');return;}
    if(!hasRef2vaPrompt(cut.promptEn)){toast('LLM Ref2VA 프롬프트 생성에서 공식 6섹션 JSON을 검증·적용해 주세요.',7000);return;}
  }
  let previousGeneratedJobId=null;
  if(!refMode&&forcePrevious){
    const flat=cuts(project),index=flat.findIndex(item=>item.cut.uid===cut.uid),previous=index>0?flat[index-1]:null;
    const previousBatchJob=previous&&pendingBatchId?[...(project.jobs||[])].reverse().find(item=>item.batchId===pendingBatchId&&item.cutUid===previous.cut.uid&&['queued','running','completed'].includes(item.status)):null;
    if(previousBatchJob)previousGeneratedJobId=previousBatchJob.id;
    else if(!await ensureFirstFrame(project,scene,cut,true))return;
  }else if(!refMode&&!await ensureFirstFrame(project,scene,cut,false))return;
  if(!refMode&&isTauri()&&!cut.lastPath){window.alert(`S${String(sceneId).padStart(2,'0')}-C${String(cutId).padStart(2,'0')}에 LAST Frame이 없습니다.`);return;}
  if(!String(cut.promptEn||'').trim()){toast('영문 프롬프트를 먼저 입력해 주세요.');return;}
  const engine=refMode?'minimax-h3-ref2va':engineOverride||(isTest?'wan-2.2':'minimax-h3'),minimax=String(engine).startsWith('minimax-h3');
  if(minimax&&!minimaxOptions){minimaxOptions=await minimaxOptionsDialog({title:`${scene.title} · ${cut.name} 생성 설정`,allowHybrid:true});if(!minimaxOptions)return;}
  const profile=minimaxOptions?.profile||DEFAULT_MINIMAX_PROFILE,minimaxModelModeId=effectiveMinimaxModelMode(profile,minimaxOptions?.modelMode||'default'),latentUpscaleMode=minimaxOptions?.latentUpscaleMode||'off',backgroundMusic=!!minimaxOptions?.backgroundMusic,size=isTest?(minimax?minimaxQuarterResolution(project):testResolution(project)):(minimax?minimaxResolution(project):projectResolution(project)),upscalePlan=latentUpscalePlan(size,latentUpscaleMode),frames=minimax?minimaxFrameLength(cut.duration):comfyFrameLength(cut.duration),seed=Number.isSafeInteger(cut.nextGenerationSeed)?cut.nextGenerationSeed:COMFY_BASE_SEED;const actualPrompt=minimax?minimaxPromptMusic(cut.promptEn,backgroundMusic):cut.promptEn,profileInfo=minimaxProfile(profile),modelModeInfo=minimaxModelMode(minimaxModelModeId);const job={id:`job-${Date.now()}-${cut.uid}`,batchId:pendingBatchId||`batch-${Date.now()}-${cut.uid}`,projectId:project.id,sceneId,cutId,cutUid:cut.uid,sceneName:scene.title,cutName:cut.name,type,status:'queued',engine,minimaxProfile:profile,minimaxModelMode:minimaxModelModeId,latentUpscaleMode,backgroundMusic,modelName:refMode?`Minimax-H3 Ref2VA · ${modelModeInfo.label} · ${profileInfo.label}${isTest?' · 1/4 테스트':''}`:minimax?`Minimax-H3 FL2V · ${modelModeInfo.label} · ${profileInfo.label}${isTest?' · 1/4 테스트':''}`:'WAN 2.2 14B FLF2V',generationSpec:minimax?makeMinimaxGenerationSpec({engine:refMode?'minimax-h3-ref2va':'minimax-h3-fl2va',modelMode:minimaxModelModeId,profile,latentUpscaleMode,backgroundMusic}):null,resolution:resolutionLabel(minimax?upscalePlan.target:size),resolutionWidth:size.width,resolutionHeight:size.height,fps:minimax?MINIMAX_FPS:COMFY_FPS,frames,duration:Number(cut.duration)||5,seed,estimatedSeconds:minimax?MINIMAX_BENCHMARK_SECONDS*latentUpscaleWorkMegapixels(upscalePlan,latentUpscaleMode)/megapixels(MINIMAX_BENCHMARK_SIZE)*(Number(cut.duration)||5)/5*profileInfo.factor:estimateSeconds(cut.duration),createdAt:new Date().toISOString(),error:null,cancelRequested:false,forcePrevious:!!forcePrevious,previousGeneratedJobId,promptKo:cut.promptKo||'',promptEn:actualPrompt||'',referenceImages:refMode?refState.pictures.map(item=>item.path):[],referenceVideos:refMode?refState.videos.map(item=>item.path):[],refImageSize:refState.refImageSize};
  applyHistoricalEstimate(job);(project.jobs||=[]).push(job);queuePaused=false;save();renderGenerationDock();toast(`${scene.title} · ${cut.name} ${refMode?`Ref2VA ${isTest?'1/4 테스트':'영상'}(${resolutionLabel(size)})`:minimax&&isTest?`Minimax-H3 1/4 테스트(${resolutionLabel(size)})`:'작업'}을 큐에 추가했습니다.`);runGenerationQueue();
}

async function queueContinuousScene(plan){
  const project=currentProject(),scene=(project.scenes||[]).find(item=>item.id===plan.sceneId),items=plan.ready||[];if(!scene||!items.length)return 0;
  const batchId=pendingBatchId||`continuous-${Date.now()}`,size=plan.isTest?minimaxQuarterResolution(project):minimaxResolution(project),chainShots=[];
  for(const item of items){
    const cut=findCut(project,item.sceneId,item.cutId);if(!cut)continue;
    const seed=Number.isSafeInteger(cut.nextGenerationSeed)?cut.nextGenerationSeed:COMFY_BASE_SEED;
    chainShots.push({cutId:cut.id,cutUid:cut.uid,name:cut.name,lastImagePath:cut.lastPath,prompt:minimaxPromptMusic(cut.promptEn,plan.backgroundMusic),duration:Number(cut.duration)||5,seed});
  }
  if(!chainShots.length)return 0;
  const firstCut=findCut(project,scene.id,chainShots[0].cutId),profile=plan.minimaxProfile||DEFAULT_MINIMAX_PROFILE,modelMode=effectiveMinimaxModelMode(profile,plan.minimaxModelMode||'default'),job={id:`job-${Date.now()}-context-${scene.id}`,batchId,projectId:project.id,sceneId:scene.id,cutId:firstCut.id,cutUid:firstCut.uid,sceneName:scene.title,cutName:'latent 연속 영상',type:plan.isTest?'TEST':'FINAL',status:'queued',engine:'minimax-h3-context-loop',minimaxProfile:profile,minimaxModelMode:modelMode,backgroundMusic:!!plan.backgroundMusic,modelName:`Minimax-H3 Context Loop · ${minimaxModelMode(modelMode).label} · ${minimaxProfile(profile).label} · latent${plan.isTest?' · 1/4 테스트':''}`,generationSpec:makeMinimaxGenerationSpec({engine:'minimax-h3-fl2va-context-loop',modelMode,profile,latentUpscaleMode:'off',backgroundMusic:plan.backgroundMusic}),resolution:resolutionLabel(size),resolutionWidth:size.width,resolutionHeight:size.height,fps:MINIMAX_FPS,frames:chainShots.reduce((sum,item)=>sum+minimaxFrameLength(item.duration),0),duration:chainShots.reduce((sum,item)=>sum+item.duration,0),seed:chainShots[0].seed,estimatedSeconds:plan.estimate,createdAt:new Date().toISOString(),error:null,cancelRequested:false,continuous:true,continuousChain:true,continuousTest:!!plan.isTest,continuousTotal:chainShots.length,continuousSequence:plan.sequence,firstImagePath:firstCut.firstPath,chainShots};
  applyHistoricalEstimate(job);(project.jobs||=[]).push(job);queuePaused=false;save();renderGenerationDock();runGenerationQueue();return chainShots.length;
}
async function queueRef2vaContinuousScene(plan){
  const project=currentProject(),scene=(project.scenes||[]).find(item=>item.id===plan.sceneId),shared=ensureRef2vaContinuousScene(scene);if(!scene||!plan.ready?.length)return 0;syncContinuousReferences(scene);
  const size=plan.isTest?minimaxQuarterResolution(project):minimaxResolution(project),chainShots=[];
  for(const item of plan.ready){const cut=findCut(project,item.sceneId,item.cutId),seed=Number.isSafeInteger(cut.nextGenerationSeed)?cut.nextGenerationSeed:COMFY_BASE_SEED;chainShots.push({cutId:cut.id,cutUid:cut.uid,name:cut.name,prompt:minimaxPromptMusic(cut.promptEn,plan.backgroundMusic),promptKo:cut.promptKo||'',duration:Number(cut.duration)||5,seed});}
  const batchId=pendingBatchId||`ref2va-chain-${Date.now()}`,profile=plan.minimaxProfile||DEFAULT_MINIMAX_PROFILE,modelMode=effectiveMinimaxModelMode(profile,plan.minimaxModelMode||'default'),job={id:`job-${Date.now()}-ref2va-context-${scene.id}`,batchId,projectId:project.id,sceneId:scene.id,cutId:chainShots[0].cutId,cutUid:chainShots[0].cutUid,sceneName:scene.title,cutName:'Ref2VA latent 연속 씬',type:plan.isTest?'TEST':'FINAL',status:'queued',engine:'minimax-h3-ref2va-context-loop',minimaxProfile:profile,minimaxModelMode:modelMode,backgroundMusic:!!plan.backgroundMusic,modelName:`Minimax-H3 Ref2VA Context Loop · ${minimaxModelMode(modelMode).label} · ${minimaxProfile(profile).label}${plan.isTest?' · 1/4 테스트':''}`,generationSpec:makeMinimaxGenerationSpec({engine:'minimax-h3-ref2va-context-loop',modelMode,profile,latentUpscaleMode:'off',backgroundMusic:plan.backgroundMusic}),resolution:resolutionLabel(size),resolutionWidth:size.width,resolutionHeight:size.height,fps:MINIMAX_FPS,frames:chainShots.reduce((sum,item)=>sum+minimaxFrameLength(item.duration),0),duration:chainShots.reduce((sum,item)=>sum+item.duration,0),seed:chainShots[0].seed,estimatedSeconds:plan.estimate,createdAt:new Date().toISOString(),error:null,cancelRequested:false,continuous:true,continuousChain:true,ref2vaContinuousChain:true,continuousTest:!!plan.isTest,continuousTotal:chainShots.length,continuousSequence:chainShots.map((_,index)=>`C${String(index+1).padStart(2,'0')}`).join(' → '),referenceImages:shared.pictures.map(item=>item.path),referenceVideos:shared.videos.map(item=>item.path),referenceAudios:shared.audios.map(item=>item.path),refImageSize:shared.refImageSize,chainShots};
  applyHistoricalEstimate(job);(project.jobs||=[]).push(job);queuePaused=false;save();renderGenerationDock();runGenerationQueue();return chainShots.length;
}

async function runGenerationQueue(){
  if(queuePumpActive||queuePaused)return;
  queuePumpActive=true;
  try{
    while(!queuePaused){
      const located=projects.flatMap(project=>(project.jobs||[]).map(job=>({project,job}))).find(item=>item.job.status==='queued');
      if(!located)break;
      const cut=cuts(located.project).find(item=>item.cut.uid===located.job.cutUid)?.cut||findCut(located.project,located.job.sceneId,located.job.cutId);
      if(!cut){located.job.status='failed';located.job.error='대상 컷을 찾지 못했습니다.';save();continue;}
      await executeJob(located.project,cut,located.job);
    }
  }finally{queuePumpActive=false;renderGenerationDock();if(!queuePaused&&projects.some(project=>(project.jobs||[]).some(job=>job.status==='queued')))queueMicrotask(runGenerationQueue);}
}

function comfyStageLabel(job,node){
  const audio=generationEngineKey(job)==='ref2va-audio',hybrid=(job.minimaxProfile||job.generationSpec?.profile)==='hybrid-8-4',labels={'1':audio?'참조 영상 로드':'FIRST 이미지 로드','2':audio?'참조 영상 분리':'LAST 이미지 로드','3':'MiniMax-H3 모델 로드','4':'Qwen 텍스트 인코더 로드','5':'Video VAE 로드','6':'Audio VAE 로드','7':'가속 LoRA 적용','8':'프롬프트·레퍼런스 컨디셔닝','9':'노이즈 준비','10':'샘플러 준비','11':'스케줄러 준비','12':'가이더 준비','14':audio?'오디오 VAE 디코드':'영상 VAE 디코드','15':audio?'MP3 저장':'오디오 VAE 디코드','16':'영상·오디오 합성','18':'Comfy Kitchen Attention 적용','19':'텍스트 인코더 언로드','50':'Sigma Shift 준비','51':'PDD Acc 8-step 준비','52':'1차 샘플러 준비','53':'1차 가이더 준비','54':'1차 PDD 8-step 샘플링','120':'Video·Audio latent 분리','121':'3D latent 업스케일','122':'Video·Audio latent 재결합','124':'2차 샘플러 준비','125':'2차 sigma 준비','126':'2차 가이더 준비','127':'2차 업스케일 보정 샘플링'};
  if(node==='13')return hybrid?'2차 Turbo 4-step 보정 샘플링':job.latentUpscaleMode&&job.latentUpscaleMode!=='off'?'1차 저해상도 샘플링':'MiniMax-H3 샘플링';if(node==='17')return audio?'텍스트 인코더 언로드':'MP4 저장';if(node==='57')return'1차 샘플링';if(node==='58')return'2차 샘플링';if(node==='61')return'MP4 저장';return labels[node]||`Comfy 노드 ${node} 실행`;
}
function beginJobStage(job,node){
  const now=new Date().toISOString(),label=comfyStageLabel(job,node),timeline=job.stageTimeline=Array.isArray(job.stageTimeline)?job.stageTimeline:[],current=timeline.at(-1);if(current?.node===node&&!current.completedAt)return current;if(current&&!current.completedAt)current.completedAt=now;const stage={node,label,startedAt:now,completedAt:null,rateText:''};timeline.push(stage);if(timeline.length>24)timeline.splice(0,timeline.length-24);job.stage=label;job.samplerStage=label;job.progressSample=null;job.iterationRate=0;job.iterationText='';job.liveRemainingSeconds=null;return stage;
}
function completeJobStage(job){const current=job.stageTimeline?.at(-1);if(current&&!current.completedAt)current.completedAt=new Date().toISOString();}
function updateJobIteration(job,node,value,max){
  const now=Date.now(),current=Math.max(0,Number(value)||0),total=Math.max(1,Number(max)||1),previous=job.progressSample;let rate=Number(job.iterationRate)||0;if(previous?.node===node&&current>previous.value&&now>previous.time){const measured=(current-previous.value)/((now-previous.time)/1000);rate=rate>0?rate*.35+measured*.65:measured;}job.progressSample={node,value:current,time:now};job.iterationRate=rate;job.stepCurrent=current;job.stepTotal=total;
  if(rate>0){job.iterationText=rate>=1?`${rate.toFixed(2)} it/s`:`${(1/rate).toFixed(2)} s/it`;job.liveRateUpdatedAt=now;}const stage=job.stageTimeline?.at(-1);if(stage)stage.rateText=`${current}/${total}${job.iterationText?` · ${job.iterationText}`:''}`;
  const ratio=Math.max(0,Math.min(1,current/total)),upscale=job.latentUpscaleMode&&job.latentUpscaleMode!=='off',hybrid=(job.minimaxProfile||job.generationSpec?.profile)==='hybrid-8-4';if(node==='54'||node==='57')job.liveProgress=Math.round(5+ratio*43);else if(node==='13')job.liveProgress=Math.round((hybrid?52:8)+ratio*(hybrid?42:upscale?38:86));else if(node==='127'||node==='58')job.liveProgress=Math.round(58+ratio*36);
  if(rate>0){const elapsed=Math.max(1,(now-new Date(job.startedAt||job.createdAt).getTime())/1000),stageRemaining=Math.max(0,(total-current)/rate),progress=Math.max(1,Number(job.liveProgress)||1),progressRemaining=elapsed*(100-progress)/progress,history=historicalGenerationEstimate(job,job.estimatedSeconds),historyRemaining=Math.max(0,history.seconds-elapsed);job.liveRemainingSeconds=Math.max(stageRemaining,history.exact?historyRemaining:progressRemaining);}
}
function monitorComfyProgress(job,clientId){
  if(!isTauri()||typeof WebSocket==='undefined')return null;
  try{
    const endpoint=new URL(appSettings.comfyUrl||'http://127.0.0.1:8188');endpoint.protocol=endpoint.protocol==='https:'?'wss:':'ws:';endpoint.pathname=`${endpoint.pathname.replace(/\/$/,'')}/ws`;endpoint.searchParams.set('clientId',clientId);
    const socket=new WebSocket(endpoint);socket.addEventListener('message',event=>{if(typeof event.data!=='string')return;let message;try{message=JSON.parse(event.data);}catch{return;}const type=message.type,data=message.data||{},node=data.node==null?'':String(data.node);if(type==='executing'){if(node){beginJobStage(job,node);if(['54','57'].includes(node))job.liveProgress=Math.max(Number(job.liveProgress)||0,5);else if(node==='13')job.liveProgress=Math.max(Number(job.liveProgress)||0,(job.minimaxProfile==='hybrid-8-4'?52:8));else if(node==='121')job.liveProgress=Math.max(Number(job.liveProgress)||0,50);else if(['127','58'].includes(node))job.liveProgress=Math.max(Number(job.liveProgress)||0,58);else if(['61','17','15'].includes(node))job.liveProgress=Math.max(Number(job.liveProgress)||0,96);}else{completeJobStage(job);job.stage='완료 처리 중';job.samplerStage='완료 처리 중';job.liveProgress=Math.max(Number(job.liveProgress)||0,99);}}else if(type==='progress'&&node){if(job.stageTimeline?.at(-1)?.node!==node)beginJobStage(job,node);updateJobIteration(job,node,data.value,data.max);}else if(type==='execution_error'){completeJobStage(job);job.stage='실행 오류';}renderGenerationDock();});socket.addEventListener('open',()=>{comfyRuntimeOnline=true;renderGenerationDock();});return socket;
  }catch(error){console.warn('Comfy progress monitor unavailable',error);return null;}
}

async function buildContinuousSceneVideo(project,job){
  if(!isTauri())return;
  const batch=(project.jobs||[]).filter(item=>item.batchId===job.batchId&&item.continuous).sort((a,b)=>a.continuousIndex-b.continuousIndex);
  if(!batch.length||batch.some(item=>item.status!=='completed'||!item.resultId))return;
  const paths=[];
  for(const item of batch){const cut=cuts(project).find(entry=>entry.cut.uid===item.cutUid)?.cut,result=(cut?.videoResults||[]).find(value=>value.id===item.resultId);if(!result?.path)return;paths.push(result.path);}
  const scene=(project.scenes||[]).find(item=>item.id===job.sceneId);if(!scene)return;
  job.stage='연속 영상 합본 생성 중';renderGenerationDock();
  const kind=job.continuousTest?'test':'final',stamp=new Date().toISOString().replace(/[:.]/g,'-'),output=joinPath(project.projectPath,'scenes',`${projectCode(project)}-S${String(scene.id).padStart(2,'0')}-continuous-${kind}-${stamp}.mp4`);
  const path=await window.__TAURI__.core.invoke('build_scene_video',{executable:appSettings.ffmpegPath||'ffmpeg',videoPaths:paths,outputPath:output,fps:MINIMAX_FPS});
  registerSceneContinuousVideo(scene,{id:`continuous-${job.batchId}`,path,createdAt:new Date().toLocaleString('ko-KR'),completedAt:new Date().toISOString(),cutCount:batch.length,fps:MINIMAX_FPS,type:job.continuousTest?'TEST':'FINAL',resolution:job.resolution,batchId:job.batchId,sequence:job.continuousSequence,engine:'Minimax-H3',seed:job.seed,seeds:batch.map(item=>item.seed),modelName:job.modelName,minimaxModelMode:job.minimaxModelMode||'default',minimaxProfile:job.minimaxProfile||'turbo-10',latentUpscaleMode:job.latentUpscaleMode||'off',backgroundMusic:!!job.backgroundMusic,generationSpec:job.generationSpec||null});
}

async function executeVideoExtensionJob(project,targetCut,job){
  if(!isTauri())throw new Error('비디오 확장은 FrameFlow Studio 데스크톱 앱에서만 실행할 수 있습니다.');
  if(!job.sourceVideoPath)throw new Error('비디오 확장 원본 경로가 없습니다. 확장할 영상을 다시 선택해 주세요.');
  const scene=(project.scenes||[]).find(item=>item.id===job.sceneId);if(!scene)throw new Error('비디오 확장 대상 씬을 찾지 못했습니다.');
  const stamp=new Date().toISOString().replace(/[:.]/g,'-'),outputPath=joinPath(project.projectPath,'videos','final',`frameflow-extension-${job.id}-${stamp}.mp4`),clientId=`frameflow-extension-${Date.now()}-${job.id}`;
  job.stage='기존 영상 마지막 22프레임 준비 중';renderGenerationDock();
  await window.__TAURI__.core.invoke('comfy_ensure_environment',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188',preferredName:appSettings.comfyEnvironmentName||'',forceRestart:false,showConsole:true,requiredEngine:'minimax-h3-context-loop'});comfyRuntimeOnline=true;
  const progressSocket=monitorComfyProgress(job,clientId),started=Date.now();let raw;
  try{raw=await window.__TAURI__.core.invoke('comfy_extend_existing_video',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188',clientId,sourceVideoPath:job.sourceVideoPath,firstImagePath:job.firstImagePath||null,lastImagePath:job.lastImagePath||null,prompt:job.promptEn,width:job.resolutionWidth,height:job.resolutionHeight,duration:job.duration,outputPath,seed:job.seed,minimaxProfile:job.minimaxProfile||'turbo-10',minimaxModelMode:job.minimaxModelMode||'default',backgroundMusic:!!job.backgroundMusic});}finally{progressSocket?.close();}
  if(job.cancelRequested||job.status==='cancelled')throw new Error('cancelled');
  const generatedFrames=Number(raw.generatedFrames)||minimaxFrameLength(job.duration),contextFrames=Number(raw.contextFrames)||22,sourceFrames=Math.max(contextFrames,Number(job.sourceFrames)||Math.round((Number(job.sourceDuration)||5)*MINIMAX_FPS)),combinedFrames=Math.max(1,sourceFrames+generatedFrames-contextFrames),combinedDuration=combinedFrames/MINIMAX_FPS;
  if(!targetCut||targetCut.uid!==job.cutUid)throw new Error('생성 결과를 등록할 비디오 확장 컷을 찾지 못했습니다.');
  const result={id:`result-${Date.now()}-extension`,type:'FINAL',res:job.resolution,createdAt:new Date().toLocaleString('ko-KR'),path:raw.path,raw,duration:Number(combinedDuration.toFixed(3)),extensionDuration:job.duration,generationSeconds:Math.max(1,Math.round((Date.now()-started)/1000)),fps:MINIMAX_FPS,frames:combinedFrames,generatedFrames,contextFrames,seed:job.seed,modelName:job.modelName,minimaxModelMode:job.minimaxModelMode||'default',minimaxProfile:job.minimaxProfile||'turbo-10',latentUpscaleMode:'off',backgroundMusic:!!job.backgroundMusic,generationSpec:job.generationSpec,backend:'Comfy Desktop',promptKo:job.promptKo||'',promptEn:job.promptEn||'',generationMode:'existing-video-extension',cumulativeExtension:true,sourceCutUid:job.sourceCutUid,sourceCutId:job.sourceCutId,sourceResultId:job.sourceResultId,sourceVideoPath:job.sourceVideoPath,color:'linear-gradient(135deg,#245f57,#84d3b6 50%,#ffb78d)'};
  result.sourceCutUid=job.sourceCutUid;result.sourceCutId=job.sourceCutId;delete result.sourceCut;
  job.stage='누적 확장 영상 Sheet 생성 중';renderGenerationDock();try{const assets=await window.__TAURI__.core.invoke('generate_video_assets',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:raw.path,projectPath:project.projectPath,filePrefix:mediaPrefix(project,scene.id,targetCut.id),resultId:result.id,frameCount:combinedFrames});Object.assign(result,assets);}catch(assetError){result.assetError=String(assetError.message||assetError);}
  targetCut.videoResults=Array.isArray(targetCut.videoResults)?targetCut.videoResults:[];targetCut.videoResults.unshift(result);targetCut.results=targetCut.videoResults.length;targetCut.status='생성 영상 검토';job.status='completed';job.completedAt=new Date().toISOString();job.resultId=result.id;job.targetCutUid=targetCut.uid;job.targetCutId=targetCut.id;job.promptId=raw.promptId||null;job.resultPath=raw.path;job.liveProgress=100;activeScene=scene.id;activeCut=targetCut.id;sceneEditorOpen=true;save();render();toast(`C${String(targetCut.id).padStart(2,'0')}에 누적 확장 영상을 후보로 추가했습니다. 대표 영상은 자동 선택하지 않았습니다.`,9000);
}

async function executeJob(project,cut,job){
  if(!cut||!['queued','interrupted','cancelled','failed'].includes(job.status))return;applyHistoricalEstimate(job);job.status='running';job.stage='영상 생성 중';job.samplerStage='Comfy 연결 준비';job.liveProgress=1;job.startedAt=new Date().toISOString();job.stageTimeline=[];job.progressSample=null;job.iterationRate=0;job.iterationText='';job.liveRemainingSeconds=null;job.error=null;job.cancelRequested=false;save();renderGenerationDock();if(page==='queue')render();
  try{
    if(job.videoExtension){await executeVideoExtensionJob(project,cut,job);return;}
    if(String(job.engine||'').startsWith('minimax-h3')){const size=alignMinimaxResolution({width:job.resolutionWidth,height:job.resolutionHeight}),target=latentUpscalePlan(size,job.latentUpscaleMode||'off').target;job.resolutionWidth=size.width;job.resolutionHeight=size.height;job.resolution=resolutionLabel(target);save();}
    if(job.continuousChain){
      if(!isTauri())throw new Error('latent 연속 영상 생성은 데스크톱 앱에서만 실행할 수 있습니다.');
      const scene=(project.scenes||[]).find(item=>item.id===job.sceneId);if(!scene)throw new Error('연속 영상 대상 씬을 찾지 못했습니다.');
      const stamp=new Date().toISOString().replace(/[:.]/g,'-'),kind=job.continuousTest?'test':'final',outputPath=joinPath(project.projectPath,'scenes',`S${String(scene.id).padStart(2,'0')}-${job.ref2vaContinuousChain?'ref2va-':''}context-loop-${kind}-${stamp}.mp4`),segmentOutputPaths=(job.chainShots||[]).map(item=>joinPath(project.projectPath,'videos',kind,`${mediaPrefix(project,scene.id,item.cutId)}-ref2va-chain-${kind}-${stamp}.mp4`));
      job.stage=`MiniMax-H3 ${job.ref2vaContinuousChain?'Ref2VA ':''}Context Loop 준비 중`;renderGenerationDock();
      await window.__TAURI__.core.invoke('comfy_ensure_environment',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188',preferredName:appSettings.comfyEnvironmentName||'',forceRestart:false,showConsole:!!appSettings.showComfyConsole,requiredEngine:'minimax-h3-context-loop'});comfyRuntimeOnline=true;
      const clientId=`frameflow-context-${Date.now()}-${job.id}`,progressSocket=monitorComfyProgress(job,clientId),started=Date.now();let raw,stopClipProgress;
      try{
        if(job.continuousTest)stopClipProgress=await window.__TAURI__.event.listen('frameflow-context-progress',({payload})=>{
          if(payload.clientId!==clientId||job.cancelRequested||job.status==='cancelled')return;
          job.continuousClip=Number(payload.clip);job.continuousRunName=payload.runName;
          if(payload.promptId)job.promptId=payload.promptId;
          const completed=payload.stage==='completed',count=Number(payload.count)||1;
          job.stage=`연속 TEST C${String(payload.clip).padStart(2,'0')}/${count} · ${completed?'저장 완료':payload.stage==='submitting'?'개별 작업 제출':'생성 중'}`;
          job.samplerStage=completed?'영상·체크포인트 저장 완료':'이전 체크포인트에서 이어 생성';
          job.liveProgress=Math.min(99,Math.round((Number(payload.clip)-(completed?0:1))/count*100));
          save();renderGenerationDock();
        });
        raw=job.ref2vaContinuousChain?await window.__TAURI__.core.invoke('comfy_generate_ref2va_continuous_video',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188',clientId,referenceImages:job.referenceImages||[],referenceVideos:job.referenceVideos||[],referenceAudios:job.referenceAudios||[],shots:job.chainShots.map(item=>({lastImagePath:'',prompt:item.prompt,duration:item.duration,seed:item.seed})),width:job.resolutionWidth,height:job.resolutionHeight,outputPath,segmentOutputPaths,isTest:!!job.continuousTest,minimaxProfile:job.minimaxProfile||'turbo-10',minimaxModelMode:job.minimaxModelMode||'default',backgroundMusic:!!job.backgroundMusic,refImageSize:job.refImageSize||'match'}):await window.__TAURI__.core.invoke('comfy_generate_continuous_video',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188',clientId,firstImagePath:job.firstImagePath,shots:job.chainShots.map(item=>({lastImagePath:item.lastImagePath,prompt:item.prompt,duration:item.duration,seed:item.seed})),width:job.resolutionWidth,height:job.resolutionHeight,outputPath,isTest:!!job.continuousTest,minimaxProfile:job.minimaxProfile||'turbo-10',minimaxModelMode:job.minimaxModelMode||'default',backgroundMusic:!!job.backgroundMusic});
      }finally{progressSocket?.close();stopClipProgress?.();}
      if(job.cancelRequested||job.status==='cancelled')throw new Error('cancelled');
      job.promptId=raw.promptId||null;job.frames=Number(raw.frames)||job.frames;job.fps=Number(raw.fps)||MINIMAX_FPS;job.liveProgress=100;job.status='completed';job.completedAt=new Date().toISOString();job.resultPath=raw.path;
      if(job.ref2vaContinuousChain)for(const [index,path] of (raw.segments||[]).entries()){const shot=job.chainShots[index],target=shot&&findCut(project,scene.id,shot.cutId);if(!target)continue;const result={id:`result-${Date.now()}-${index}`,type:job.continuousTest?'TEST':'FINAL',res:job.resolution,createdAt:new Date().toLocaleString('ko-KR'),path,duration:shot.duration,fps:MINIMAX_FPS,frames:minimaxFrameLength(shot.duration),seed:shot.seed,modelName:job.modelName,minimaxModelMode:job.minimaxModelMode||'default',minimaxProfile:job.minimaxProfile||'turbo-10',latentUpscaleMode:'off',backgroundMusic:!!job.backgroundMusic,generationSpec:job.generationSpec,backend:'Comfy Desktop',promptKo:shot.promptKo||'',promptEn:shot.prompt,generationMode:'ref2va',continuous:true,continuousIndex:index,contextFrames:index?22:0,referenceImages:job.referenceImages||[],referenceVideos:job.referenceVideos||[],referenceAudios:job.referenceAudios||[],color:job.continuousTest?'linear-gradient(135deg,#6760a7,#c3b8ef 48%,#f1a985)':'linear-gradient(135deg,#2f635d,#9bd8bc 45%,#ffbf98)'};(target.videoResults||=[]).unshift(result);target.selected={...result,date:result.createdAt};target.results=target.videoResults.length;}
      registerSceneContinuousVideo(scene,{id:`continuous-${job.id}`,jobId:job.id,path:raw.path,createdAt:new Date().toLocaleString('ko-KR'),completedAt:new Date().toISOString(),cutCount:job.chainShots.length,duration:job.duration,fps:job.fps,type:job.continuousTest?'TEST':'FINAL',resolution:job.resolution,batchId:job.batchId,sequence:job.continuousSequence,engine:job.ref2vaContinuousChain?'Minimax-H3 Ref2VA Context Loop':'Minimax-H3 Context Loop',contextFrames:Number(raw.contextFrames)||22,generationSeconds:Math.max(1,Math.round((Date.now()-started)/1000)),promptId:raw.promptId||null,seed:job.seed,seeds:(job.chainShots||[]).map(shot=>shot.seed),modelName:job.modelName,minimaxModelMode:job.minimaxModelMode||'default',minimaxProfile:job.minimaxProfile||'turbo-10',latentUpscaleMode:'off',backgroundMusic:!!job.backgroundMusic,generationSpec:job.generationSpec});
      save();render();toast(`${scene.title} · latent 연속 영상 생성에 성공했습니다.`);return;
    }
    let raw=null,url=null,path=null,generationFinishedAt=null;
    if(isTauri()){
      const location=cutLocation(cut,project),stamp=new Date().toISOString().replace(/[:.]/g,'-'),folder=job.type==='TEST'?'test':'final';job.outputPrefix=mediaPrefix(project,location.scene.id,location.cut.id);const outputPath=joinPath(project.projectPath,'videos',folder,`${job.outputPrefix}-${job.continuous?'continuous-':''}${folder}-${stamp}.mp4`);
      let firstImagePath=cut.firstPath;
      if(job.forcePrevious&&job.previousGeneratedJobId){
        const previousJob=(project.jobs||[]).find(item=>item.id===job.previousGeneratedJobId),previousCut=cuts(project).find(item=>item.cut.uid===previousJob?.cutUid)?.cut,previousResult=(previousCut?.videoResults||[]).find(result=>result.id===previousJob?.resultId);
        if(previousJob?.status!=='completed'||!previousResult?.path)throw new Error('바로 이전 컷의 이번 배치 생성 결과가 없어 FIRST 프레임을 연결할 수 없습니다. 이전 작업의 실패 사유를 확인해 주세요.');
        job.stage='직전 배치 영상의 마지막 프레임 연결 중';renderGenerationDock();
        firstImagePath=await window.__TAURI__.core.invoke('extract_last_frame',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:previousResult.path,projectPath:project.projectPath,sourceScene:cutStorageNumber(previousJob.sceneId,previousJob.cutId),targetScene:cutStorageNumber(job.sceneId,job.cutId)});
        job.continuityFirstPath=firstImagePath;cut.firstPath=firstImagePath;cut.firstName=firstImagePath.split(/[\\/]/).pop();setCutImageDetails(cut,'first',await localImageDetails(firstImagePath));cut.usePrevious=true;save();
      }
      if(job.continuous&&job.previousContinuousJobId){
        const previousJob=(project.jobs||[]).find(item=>item.id===job.previousContinuousJobId),previousCut=cuts(project).find(item=>item.cut.uid===previousJob?.cutUid)?.cut,previousResult=(previousCut?.videoResults||[]).find(result=>result.id===previousJob?.resultId);
        if(previousJob?.status!=='completed'||!previousResult?.path)throw new Error('이전 연속 컷의 생성 영상이 없어 다음 컷을 연결할 수 없습니다. 실패한 컷부터 다시 실행해 주세요.');
        job.stage='직전 생성 영상의 마지막 프레임 연결 중';renderGenerationDock();
        firstImagePath=await window.__TAURI__.core.invoke('extract_last_frame',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:previousResult.path,projectPath:project.projectPath,sourceScene:cutStorageNumber(previousJob.sceneId,previousJob.cutId),targetScene:cutStorageNumber(job.sceneId,job.cutId)});
        job.continuityFirstPath=firstImagePath;
      }
      await window.__TAURI__.core.invoke('comfy_ensure_environment',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188',preferredName:appSettings.comfyEnvironmentName||'',forceRestart:false,showConsole:!!appSettings.showComfyConsole,requiredEngine:job.engine==='minimax-h3-ref2va'?'minimax-h3':job.engine||'wan-2.2'});comfyRuntimeOnline=true;const clientId=`frameflow-${Date.now()}-${job.id}`,progressSocket=monitorComfyProgress(job,clientId);
      try{
        if(job.engine==='minimax-h3-ref2va')raw=await window.__TAURI__.core.invoke('comfy_generate_ref2va_video',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188',clientId,referenceImages:job.referenceImages||[],referenceVideos:job.referenceVideos||[],prompt:job.promptEn||cut.promptEn,width:job.resolutionWidth,height:job.resolutionHeight,duration:job.duration,outputPath,seed:job.seed,refImageSize:job.refImageSize||'match',minimaxProfile:job.minimaxProfile||'turbo-10',minimaxModelMode:job.minimaxModelMode||'default',latentUpscaleMode:job.latentUpscaleMode||'off',backgroundMusic:!!job.backgroundMusic});
        else raw=await window.__TAURI__.core.invoke('comfy_generate_video',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188',clientId,firstImagePath,lastImagePath:cut.lastPath,prompt:job.promptEn||cut.promptEn,width:job.resolutionWidth,height:job.resolutionHeight,length:job.frames,outputPath,seed:job.seed,engine:job.engine||'wan-2.2',duration:job.duration,minimaxProfile:job.minimaxProfile||'turbo-10',minimaxModelMode:job.minimaxModelMode||'default',latentUpscaleMode:job.latentUpscaleMode||'off',backgroundMusic:!!job.backgroundMusic});
      }finally{progressSocket?.close();}path=raw.path;job.promptId=raw.promptId||job.promptId;job.frames=Number(raw.frames)||job.frames;job.fps=Number(raw.fps)||job.fps;generationFinishedAt=Date.now();job.liveProgress=100;
    }else{
      await new Promise(resolve=>setTimeout(resolve,650));
      generationFinishedAt=Date.now();
    }
    if(isTauri()&&url){const location=cutLocation(cut,project),stamp=new Date().toISOString().replace(/[:.]/g,'-'),folder=job.type==='TEST'?'test':'final';path=joinPath(project.projectPath,'videos',folder,`${mediaPrefix(project,location.scene.id,location.cut.id)}-${folder}-${stamp}.mp4`);path=await window.__TAURI__.core.invoke('download_media',{url,targetPath:path});}
    if(job.cancelRequested||job.status==='cancelled')throw new Error('cancelled');const latest=cutLocation(cut,project),latestPrefix=mediaPrefix(project,latest.scene.id,latest.cut.id);if(isTauri()&&path&&job.outputPrefix&&job.outputPrefix!==latestPrefix){const changed=await window.__TAURI__.core.invoke('renumber_media_files',{projectPath:project.projectPath,mappings:[{oldPrefix:job.outputPrefix,newPrefix:latestPrefix}]});path=changed[path]||path;}
    const result={id:`result-${Date.now()}`,type:job.type,res:job.resolution,createdAt:new Date().toLocaleString('ko-KR'),url,path,raw,duration:job.duration,generationSeconds:Math.max(1,Math.round(((generationFinishedAt||Date.now())-new Date(job.startedAt).getTime())/1000)),fps:job.fps,frames:job.frames,seed:job.seed,modelName:job.modelName,minimaxModelMode:job.minimaxModelMode||'default',minimaxProfile:job.minimaxProfile||null,latentUpscaleMode:job.latentUpscaleMode||'off',backgroundMusic:!!job.backgroundMusic,generationSpec:job.generationSpec||null,backend:'Comfy Desktop',promptKo:job.promptKo||cut.promptKo||'',promptEn:job.promptEn||cut.promptEn||'',generationMode:job.engine==='minimax-h3-ref2va'?'ref2va':'flf',referenceImages:job.referenceImages||[],referenceVideos:job.referenceVideos||[],continuous:!!job.continuous,continuousIndex:job.continuousIndex,color:job.type==='TEST'?'linear-gradient(135deg,#6760a7,#c3b8ef 48%,#f1a985)':'linear-gradient(135deg,#2f635d,#9bd8bc 45%,#ffbf98)'};
    if(isTauri()&&path){job.stage='8프레임 간격 영상 Sheet 생성 중';renderGenerationDock();try{const location=cutLocation(cut,project),assets=await window.__TAURI__.core.invoke('generate_video_assets',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:path,projectPath:project.projectPath,filePrefix:mediaPrefix(project,location.scene.id,location.cut.id),resultId:result.id,frameCount:job.frames});Object.assign(result,assets);}catch(assetError){result.assetError=String(assetError.message||assetError);}}
    (cut.videoResults||=[]).unshift(result);cut.results=cut.videoResults.length;job.status='completed';job.completedAt=new Date().toISOString();job.resultId=result.id;
    if(job.continuous&&job.continuousIndex===job.continuousTotal-1){
      try{await buildContinuousSceneVideo(project,job);}
      catch(combineError){
        job.continuousCombineError=String(combineError?.message||combineError);
        toast(`개별 컷 생성은 완료했지만 연속 영상 합본에 실패했습니다: ${job.continuousCombineError}`,7000);
      }
    }
  }catch(error){if(job.cancelRequested||job.status==='cancelled'){job.status='cancelled';job.error='사용자가 작업을 취소했습니다.';}else{const detail=String(error.message||error),node=detail.match(/node_errors[\s\S]*?"(\d+)"/)?.[1]||detail.match(/node\s*(\d+)/i)?.[1]||null,model=detail.match(/(?:unet_name|clip_name|lora_name)[^']*'([^']+)'/)?.[1]||null;job.status='failed';job.failureDetail={server:appSettings.comfyUrl||'http://127.0.0.1:8188',engine:job.engine||'wan-2.2',node,model,message:detail};job.error=`${detail}${node?` · 노드 ${node}`:''}${model?` · 모델 ${model}`:''} · 서버 ${job.failureDetail.server}`;}}
  save();render();if(job.status==='completed')toast(`${job.sceneName} · ${job.cutName} 영상 생성에 성공했습니다.`);else if(job.status==='failed')toast(`${job.sceneName} · ${job.cutName} 생성 실패: ${briefJobError(job.error)} · 다음 큐를 계속 진행합니다.`,12000);
}

function retryJob(jobId){const located=locateAnyJob(jobId);if(!located)return;if(located.workspaceKind==='video-audio'&&Number(located.job.storageVersion)!==2){const project=currentProject();if(!project?.projectPath){toast('재시도할 프로젝트의 저장 폴더를 먼저 지정해 주세요.');return;}Object.assign(located.job,buildVideoAudioProjectPaths({project,sourceName:located.job.sourceName,mode:located.job.resolutionMode}));}located.job.status='queued';located.job.error=null;located.job.cancelRequested=false;queuePaused=false;if(located.workspaceKind==='video-audio'){saveVideoAudio();runVideoAudioQueue();}else if(located.workspaceKind==='video-video'){saveVideoVideo();runVideoVideoQueue();}else if(located.workspaceKind==='generative-upscale'){saveGenerativeUpscale();runGenerativeUpscaleQueue();}else{save();runGenerationQueue();}render();}

async function selectResult(sceneId,cutId,resultId){
  const project=currentProject(),cut=findCut(project,sceneId,cutId),result=(cut.videoResults||[]).find(item=>item.id===resultId);if(!result)return;cut.selected={...result,date:result.createdAt};
  const flat=cuts(project),index=flat.findIndex(item=>item.cut.uid===cut.uid),next=flat[index+1];
  if(next?.cut.usePrevious){
    if(isTauri()&&result.path){const path=await window.__TAURI__.core.invoke('extract_last_frame',{executable:appSettings.ffmpegPath||'ffmpeg',videoPath:result.path,projectPath:project.projectPath,sourceScene:cutStorageNumber(sceneId,cutId),targetScene:cutStorageNumber(next.scene.id,next.cut.id)});next.cut.firstPath=path;next.cut.firstName=path.split(/[\\/]/).pop();setCutImageDetails(next.cut,'first',await localImageDetails(path));}
    else next.cut.first='linear-gradient(135deg,#8fcdbc,#466e66)';
    next.cut.status='재검토 필요';
  }
  save();renderPreservingEditorScroll();toast('대표 영상을 변경했습니다.');
}

function deselectResult(sceneId,cutId,resultId){
  const cut=findCut(currentProject(),sceneId,cutId);if(!cut?.selected||cut.selected.id!==resultId)return;
  cut.selected=null;save();renderPreservingEditorScroll();toast('대표 영상 선택을 해제했습니다. 영상 파일과 생성 기록은 유지됩니다.');
}

function findResult(sceneId,cutId,resultId){
  const cut=findCut(currentProject(),sceneId,cutId);
  return {cut,result:(cut?.videoResults||[]).find(item=>item.id===resultId)};
}

async function copyResultSheet(sceneId,cutId,resultId){
  const {result}=findResult(sceneId,cutId,resultId);if(!result?.sheetPath){toast('영상 Sheet가 없습니다. 영상을 다시 생성해 주세요.');return;}
  const started=Date.now();toast('영상 Sheet 복사 중…',120000);
  try{
    if(!window.ClipboardItem||!navigator.clipboard?.write)throw new Error('이미지 클립보드를 지원하지 않습니다.');
    const dataUrl=isTauri()?await window.__TAURI__.core.invoke('load_image_data_url',{path:result.sheetPath}):result.sheetUrl;
    if(!dataUrl)throw new Error('영상 Sheet 파일을 불러오지 못했습니다.');
    const blob=await (await fetch(dataUrl)).blob();await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);await keepProgressVisible(started);toast('영상 Sheet가 복사되었습니다.');
  }catch(error){toast(`영상 Sheet 복사 실패: ${error.message||error}`,6000);}
}

function buildResultAnalysisPrompt(cut,result){
  const meta=sceneMeta(cut),details=resultMetadata(result,cut);
  return `${JSON_ONLY_ANALYSIS_GUARD}

You are a cinematic video-motion analyst. Analyze the attached frame sheet sampled from one generated video every 8 frames at ${details.fps} fps. The frames are chronological, left-to-right and top-to-bottom. The video is ${details.duration} seconds long.

ORIGINAL KOREAN PROMPT:
${result.promptKo||cut.promptKo||'(empty)'}

ORIGINAL ENGLISH PROMPT:
${result.promptEn||cut.promptEn||'(empty)'}

USER DIRECTION:
${meta.direction||'(empty)'}

NEGATIVE DIRECTION (safety context only; never quote or express it directly):
${meta.negativeDirection||'(empty)'}

Identify visible motion that actually occurred across the sampled frames. Pay special attention to useful accidental motion not stated in the original prompt, such as rotation, orbiting, folding, expansion, reflection changes, light movement, particle paths, or camera motion. Keep only desirable observations that are clearly supported by the sheet. Do not invent motion hidden between samples.

Rewrite the prompt so the desirable observed motion becomes intentional and reproducible. Preserve the user's direction, FLF continuity, camera constraints, subject identity, and all existing useful prompt information. Do not write the negative direction literally. Instead, correct suspicious wording with positive, concrete direction. Return natural Korean and equivalent generation-ready English.

FINAL OUTPUT GATE: Do not generate or modify a video. Return exactly one raw, parseable JSON object and nothing else. Return valid JSON only:
{
  "observed_motion_summary_ko":"사람이 이해하기 쉬운 명확한 한국어 요약",
  "observed_motion_summary_en":"Equivalent English summary",
  "additional_direction_ko":"프롬프트에 새로 반영할 바람직한 움직임만 구체적인 한국어로 작성",
  "additional_direction_en":"Equivalent English direction",
  "camera_observations":[{"observation_ko":"","observation_en":"","desirable":true}],
  "element_observations":[{"element_ko":"","element_en":"","motion_ko":"","motion_en":"","desirable":true}],
  "unexpected_but_desirable":[{"motion_ko":"","motion_en":"","evidence":"sample frame positions"}],
  "undesirable_observations":[{"observation_ko":"","observation_en":""}],
  "revised_prompt_ko":"추가 움직임과 기존 연출을 모두 반영한 완전한 한국어 프롬프트",
  "revised_prompt_en":"Complete equivalent English generation prompt"
}`;
}

async function copyResultMetaPrompt(sceneId,cutId,resultId){
  const {cut,result}=findResult(sceneId,cutId,resultId);if(!cut||!result)return;
  try{await navigator.clipboard.writeText(buildResultAnalysisPrompt(cut,result));toast('영상 분석 메타프롬프트가 복사되었습니다. 영상 Sheet와 함께 LLM에 입력하세요.');}catch(error){toast(`메타프롬프트 복사 실패: ${error.message||error}`);}
}

async function applyResultAnalysis(sceneId,cutId,resultId){
  const {cut,result}=findResult(sceneId,cutId,resultId);if(!cut||!result)return;
  const started=Date.now();toast('클립보드 LLM 결과 적용 중…',120000);
  try{
    const value=await navigator.clipboard.readText();if(!String(value).trim())throw new Error('클립보드가 비어 있습니다.');const parsed=parseLlmJson(value);
    const additionalKo=String(parsed.additional_direction_ko||parsed.additionalDirectionKo||'').trim(),promptKo=String(parsed.revised_prompt_ko||parsed.revisedPromptKo||'').trim(),promptEn=String(parsed.revised_prompt_en||parsed.final_prompt_en||parsed.revisedPromptEn||'').trim();
    if(!additionalKo)throw new Error('additional_direction_ko가 없습니다.');if(!promptKo||!promptEn)throw new Error('한국어 또는 영문 revised prompt가 없습니다.');
    sceneMeta(cut).additionalDirection=additionalKo;cut.promptKo=promptKo;cut.promptEn=promptEn;result.analysis={...parsed,appliedAt:new Date().toISOString()};save();await keepProgressVisible(started);renderPreservingEditorScroll();toast('추가 연출 의도와 한·영 프롬프트를 함께 적용했습니다.');
  }catch(error){toast(`LLM 결과 적용 실패: ${error.message||error}`,6000);}
}

function openResultAnalysisWorkflow(sceneId,cutId,resultId){
  const {cut,result}=findResult(sceneId,cutId,resultId);if(!cut||!result)return;
  const overlay=document.createElement('div');overlay.className='workflow-modal-backdrop';
  overlay.innerHTML=`<section class="workflow-modal" role="dialog" aria-modal="true" aria-label="영상 분석 및 프롬프트 재생성"><header><div><span>VIDEO PROMPT WORKFLOW</span><h2>영상 분석 및 프롬프트 재생성</h2><p>우연히 생성된 좋은 움직임을 영상 Sheet에서 찾아 다음 프롬프트에 의도적으로 반영합니다.</p></div></header><ol class="workflow-steps"><li><b>01. 영상 Sheet 복사</b><p>8프레임 간격의 시간순 이미지를 복사합니다.</p><button class="button secondary workflow-copy-sheet">영상 Sheet 복사</button></li><li><b>02. 분석 지시문 복사</b><p>Sheet와 함께 LLM에 붙여 넣으세요. 실제로 보이는 움직임만 분석하도록 지시합니다.</p><button class="button secondary workflow-copy-prompt">LLM 분석 지시문 복사</button></li><li><b>03. LLM 결과 붙여넣기</b><p>LLM이 반환한 JSON 전체를 아래에 붙여 넣고 검증하세요.</p><textarea class="workflow-json" placeholder="{ &quot;additional_direction_ko&quot;: ..., &quot;revised_prompt_ko&quot;: ..., &quot;revised_prompt_en&quot;: ... }"></textarea><button class="button secondary workflow-paste">클립보드 JSON 붙여넣기</button><div class="workflow-preview" hidden></div></li></ol><footer><button class="button secondary workflow-close">닫기</button><button class="button primary workflow-apply">검증하고 적용</button></footer></section>`;
  document.body.append(overlay);const json=overlay.querySelector('.workflow-json'),preview=overlay.querySelector('.workflow-preview');
  overlay.querySelector('.workflow-copy-sheet').addEventListener('click',()=>copyResultSheet(sceneId,cutId,resultId));
  overlay.querySelector('.workflow-copy-prompt').addEventListener('click',()=>copyResultMetaPrompt(sceneId,cutId,resultId));
  overlay.querySelector('.workflow-paste').addEventListener('click',async()=>{try{json.value=await navigator.clipboard.readText();const parsed=parseLlmJson(json.value);preview.hidden=false;preview.textContent=parsed.observed_motion_summary_ko||parsed.additional_direction_ko||'JSON 형식을 확인했습니다.';toast('LLM JSON을 붙여 넣었습니다.');}catch(error){toast(`붙여넣기 실패: ${error.message||error}`,6000);}});
  overlay.querySelector('.workflow-close').addEventListener('click',()=>{overlay.remove();toast('적용하지 않았습니다.');});
  overlay.querySelector('.workflow-apply').addEventListener('click',()=>{try{const parsed=parseLlmJson(json.value),additionalKo=String(parsed.additional_direction_ko||parsed.additionalDirectionKo||'').trim(),promptKo=String(parsed.revised_prompt_ko||parsed.revisedPromptKo||'').trim(),promptEn=String(parsed.revised_prompt_en||parsed.final_prompt_en||parsed.revisedPromptEn||'').trim();if(!additionalKo)throw new Error('additional_direction_ko가 없습니다.');if(!promptKo||!promptEn)throw new Error('한국어 또는 영문 revised prompt가 없습니다.');sceneMeta(cut).additionalDirection=additionalKo;cut.promptKo=promptKo;cut.promptEn=promptEn;result.analysis={...parsed,appliedAt:new Date().toISOString()};save();overlay.remove();renderPreservingEditorScroll();toast('프롬프트에 적용되었습니다.');}catch(error){toast(`적용 실패: ${error.message||error}`,6000);}});
}

async function deleteResult(sceneId,cutId,resultId){
  const project=currentProject(),{cut,result}=findResult(sceneId,cutId,resultId);if(!cut||!result)return;
  if(!await confirmDestructive({title:'생성 영상을 삭제하시겠습니까?',target:`${cut.name||'컷'} · ${result.type||'영상'} · ${result.res||''}`,message:'영상, 미리보기 GIF와 영상 Sheet 파일이 함께 삭제됩니다.',confirmLabel:'영상 삭제'}))return;
  try{
    if(isTauri())await window.__TAURI__.core.invoke('delete_result_assets',{projectPath:project.projectPath,paths:[result.path,result.gifPath,result.sheetPath].filter(Boolean)});
    cut.videoResults=(cut.videoResults||[]).filter(item=>item.id!==resultId);cut.results=cut.videoResults.length;if(cut.selected?.id===resultId)cut.selected=null;for(const job of project.jobs||[])if(job.resultId===resultId){job.resultId=null;job.resultDeleted=true;}save();renderPreservingEditorScroll();toast('영상과 관련 미리보기 파일을 영구 삭제했습니다.');
  }catch(error){toast(`영상 삭제 실패: ${error.message||error}`,6000);}
}

async function queueProject(isTest){
  const project=currentProject(),missing=cuts(project).filter(({cut})=>!cut.selected);if(!missing.length){if(isTest)toast('모든 컷에 선택 영상이 있어 생성을 건너뜁니다.');else buildFinalVideo();return;}
  let queued=0;for(const item of missing){const before=(project.jobs||[]).length;await queueGeneration(item.scene.id,item.cut.id,isTest);if((project.jobs||[]).length>before)queued++;}if(queued)toast(`${queued}개 컷을 생성 큐에 추가했습니다.`);
}

async function buildFinalVideo(){
  const selected=cuts().map(({cut})=>cut.selected).filter(Boolean);if(selected.some(v=>!v.path)){toast('선택 영상이 모두 로컬 파일로 저장된 뒤 결합할 수 있습니다.');return;}
  if(!isTauri()){toast('전체 영상 결합은 데스크톱 앱에서 실행됩니다.');return;}
  const output=joinPath(currentProject().projectPath,'exports',`${currentProject().name}-final.mp4`);
  try{await window.__TAURI__.core.invoke('build_project_video',{executable:appSettings.ffmpegPath||'ffmpeg',videoPaths:selected.map(v=>v.path),outputPath:output});toast(`전체 영상을 저장했습니다: ${output}`);}catch(error){toast(`영상 결합 실패: ${error}`);}
}

function bindModal(){
  const newProjectForm=document.querySelector('#project-form');
  if(newProjectForm){
    const minimaxFields=document.createElement('div');minimaxFields.className='modal-grid minimax-create-fields';minimaxFields.innerHTML='<div class="field"><label>Minimax-H3 가로 픽셀 *</label><input type="number" name="minimaxWidth" value="1920" min="64" max="16384" required></div><div class="field"><label>Minimax-H3 세로 픽셀 *</label><input type="number" name="minimaxHeight" value="1080" min="64" max="16384" required></div>';
    newProjectForm.querySelector('.resolution-help')?.before(minimaxFields);
    let followsActual=true;const mw=newProjectForm.elements.minimaxWidth,mh=newProjectForm.elements.minimaxHeight;[mw,mh].forEach(input=>input?.addEventListener('input',()=>{followsActual=false;}));const sync=()=>{if(followsActual){mw.value=newProjectForm.elements.resolutionWidth.value;mh.value=newProjectForm.elements.resolutionHeight.value;}};newProjectForm.elements.resolutionWidth.addEventListener('input',sync);newProjectForm.elements.resolutionHeight.addEventListener('input',sync);
  }
  const fixedOutput=document.querySelector('[name="baseFolder"]');if(fixedOutput){fixedOutput.value=appSettings.defaultFolder||fixedOutput.value;fixedOutput.readOnly=true;fixedOutput.closest('.folder-input')?.querySelector('.choose-folder')?.remove();const label=fixedOutput.closest('.field')?.querySelector('label');if(label)label.textContent='고정 출력 루트';const help=fixedOutput.closest('.field')?.querySelector('.field-help');if(help)help.textContent='설정에서 지정한 고정 경로입니다. 프로젝트 폴더가 이 위치 아래에 자동 생성됩니다.';}
  document.querySelectorAll('.close-modal').forEach(b=>b.addEventListener('click',()=>{modal=null;render();}));
  document.querySelector('.modal-backdrop')?.addEventListener('click',e=>{if(e.target.classList.contains('modal-backdrop')){modal=null;render();}});
  document.querySelector('.choose-folder')?.addEventListener('click',async()=>{const input=document.querySelector('[name="baseFolder"]');if(isTauri()){const picked=await window.__TAURI__.dialog.open({directory:true,multiple:false,title:'FrameFlow 프로젝트 기본 폴더 선택'});if(picked)input.value=picked;}else{input.value='C:\\Users\\libho\\Videos\\FrameFlow Projects';toast('웹 미리보기 경로입니다. Tauri 앱에서는 실제 폴더 선택창이 열립니다.');}});
  document.querySelector('#project-form')?.addEventListener('submit',createProject);
  document.querySelector('#project-settings-form')?.addEventListener('submit',saveProjectSettings);
  const settingsForm=document.querySelector('#project-settings-form');if(settingsForm){const update=()=>{const width=Number(settingsForm.elements.resolutionWidth.value),height=Number(settingsForm.elements.resolutionHeight.value);if(width<1||height<1)return;settingsForm.querySelector('.final-resolution-preview').textContent=resolutionLabel({width,height});settingsForm.querySelector('.test-resolution-preview').textContent=resolutionLabel(testResolution({resolutionWidth:width,resolutionHeight:height}));};settingsForm.elements.resolutionWidth.addEventListener('input',update);settingsForm.elements.resolutionHeight.addEventListener('input',update);}
  document.querySelector('#scene-form')?.addEventListener('submit',createScene);
  document.querySelector('#scene-settings-form')?.addEventListener('submit',saveSceneSettings);
  document.querySelector('#cut-form')?.addEventListener('submit',createCut);
}

async function createProject(e){
  e.preventDefault();const f=new FormData(e.currentTarget),name=f.get('name').trim(),baseFolder=(appSettings.defaultFolder||f.get('baseFolder')).trim(),resolutionWidth=Number(f.get('resolutionWidth')),resolutionHeight=Number(f.get('resolutionHeight'));if(!validProjectResolution(resolutionWidth,resolutionHeight))return;let projectPath=baseFolder.replace(/[\\/]$/,'')+'\\'+name;
  if(isTauri()) projectPath=await window.__TAURI__.core.invoke('create_project_structure',{baseFolder,projectName:name});
  const used=new Set(projects.map(project=>projectCode(project))),projectCodeValue=Array.from({length:0xFFFF},(_,index)=>(index+1).toString(16).toUpperCase().padStart(4,'0')).find(code=>!used.has(code))||'0001';
  const minimaxWidth=Number(f.get('minimaxWidth'))||resolutionWidth,minimaxHeight=Number(f.get('minimaxHeight'))||resolutionHeight;if(!validProjectResolution(minimaxWidth,minimaxHeight))return;const size={width:resolutionWidth,height:resolutionHeight},now=Date.now(),id=`project-${now}`;projects.push({id,projectCode:projectCodeValue,name,description:f.get('description').trim(),baseFolder,projectPath,model:null,ratio:projectAspect({resolutionWidth,resolutionHeight}),duration:Number(f.get('duration')),resolution:resolutionValue(size),resolutionWidth,resolutionHeight,minimaxWidth,minimaxHeight,updatedAt:'방금 전',updatedAtMs:now,scenes:[],jobs:[]});activeProjectId=id;activeScene=null;activeCut=null;page='project';modal=null;save();render();toast(`프로젝트 ${projectCodeValue}와 미디어 폴더를 만들었습니다.`);
}

function validProjectResolution(width,height){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<64||height<64||width>16384||height>16384){window.alert('프로젝트 해상도는 가로·세로 각각 64~16384 사이의 정수 픽셀로 입력해 주세요.');return false;}return true;
}

function saveProjectSettings(e){
  e.preventDefault();const f=new FormData(e.currentTarget),width=Number(f.get('resolutionWidth')),height=Number(f.get('resolutionHeight')),minimaxWidth=Number(f.get('minimaxWidth')),minimaxHeight=Number(f.get('minimaxHeight'));if(!validProjectResolution(width,height)||!validProjectResolution(minimaxWidth,minimaxHeight))return;const p=currentProject();p.name=String(f.get('name')).trim();p.description=String(f.get('description')).trim();p.resolutionWidth=width;p.resolutionHeight=height;p.minimaxWidth=minimaxWidth;p.minimaxHeight=minimaxHeight;p.resolution=resolutionValue({width,height});p.ratio=projectAspect(p);for(const scene of p.scenes||[])delete scene.resolution;p.updatedAt='방금 전';modal=null;save();render();toast(`실제 ${resolutionLabel({width,height})} · Minimax-H3 ${resolutionLabel({width:minimaxWidth,height:minimaxHeight})}로 저장했습니다.`);
}

function saveSceneSettings(e){
  e.preventDefault();const scene=currentScene();if(!scene)return;const f=new FormData(e.currentTarget),title=String(f.get('title')||'').trim();if(!title){toast('씬 제목을 입력해 주세요.');return;}scene.title=title;scene.content=String(f.get('content')||'').trim();currentProject().updatedAt='방금 전';modal=null;save();render();toast(`S${String(scene.id).padStart(2,'0')} 씬 정보를 저장했습니다.`);
}

async function createScene(e){
  e.preventDefault();const f=new FormData(e.currentTarget),list=scenes(),id=list.length+1,sceneNumber=String(id).padStart(2,'0'),sceneType=f.get('sceneType')==='ref2va-continuous'?'ref2va-continuous':'standard',duration=Number(f.get('duration'))||5,title=String(f.get('title')||'').trim()||`Scene-${sceneNumber}`,cutName=String(f.get('cutName')||'').trim()||'Cut-01',cut={id:1,uid:`cut-${Date.now()}`,name:cutName,status:'프롬프트 작성',duration,model:null,promptKo:'',promptEn:'',first:null,last:null,selected:null,results:0,usePrevious:false,videoResults:[],generationMode:sceneType==='ref2va-continuous'?'ref2va':'flf',ref2va:{pictures:[],videos:[],audios:[],userDirection:'',refImageSize:'match'}};
  list.push({id,sceneType,title,content:String(f.get('content')||'').trim(),ref2vaContinuous:{pictures:[],videos:[],audios:[],userDirection:'',refImageSize:'match'},cuts:[cut]});
  if(isTauri()) await window.__TAURI__.core.invoke('create_scene_structure',{projectPath:currentProject().projectPath,sceneNumber:id});
  activeScene=id;activeCut=1;sceneEditorOpen=true;modal=null;save();render();toast(`씬 S${String(id).padStart(2,'0')}과 첫 컷을 만들었습니다.`);
}

async function addSceneDirect(){
  modal='scene';render();
}

function createCut(e){
  e.preventDefault();const f=new FormData(e.currentTarget),scene=currentScene();if(!scene)return;const id=(scene.cuts?.length||0)+1;
  const dedicated=isRef2vaContinuousScene(scene),shared=ensureRef2vaContinuousScene(scene),name=String(f.get('name')||'').trim()||`Cut-${String(id).padStart(2,'0')}`,duration=Number(f.get('duration'))||5;scene.cuts||=[];scene.cuts.push({id,uid:`cut-${Date.now()}`,name,status:'프롬프트 작성',duration,model:null,promptKo:'',promptEn:'',first:null,last:null,selected:null,results:0,usePrevious:false,videoResults:[],generationMode:dedicated?'ref2va':'flf',ref2va:{pictures:dedicated?structuredClone(shared.pictures):[],videos:dedicated?structuredClone(shared.videos):[],audios:dedicated?structuredClone(shared.audios):[],userDirection:'',refImageSize:shared.refImageSize||'match'}});
  activeCut=id;sceneEditorOpen=true;modal=null;save();render();toast(`컷 C${String(id).padStart(2,'0')}을 추가했습니다.`);
}

async function chooseFlf(sceneId,cutId,frameKind){
  if(isTauri()){
    const picked=await window.__TAURI__.dialog.open({multiple:false,title:frameKind===0?'First Frame 이미지 선택':'Last Frame 이미지 선택',filters:[{name:'Image',extensions:['png','jpg','jpeg','webp','bmp','tiff']}]});
    if(!picked)return;
    await storeFlfPath(sceneId,cutId,frameKind,picked);
  }else{
    const input=document.createElement('input');input.type='file';input.accept='image/*';input.addEventListener('change',()=>{const file=input.files?.[0];if(file)previewWebFlf(sceneId,cutId,frameKind,file);});input.click();
  }
}

async function storeFlfPath(sceneId,cutId,frameKind,sourcePath){
  if(!/\.(png|jpe?g|webp|bmp|tiff?)$/i.test(sourcePath)){toast('PNG, JPG, WEBP, BMP 또는 TIFF 이미지만 사용할 수 있습니다.');return;}
  const scene=findCut(currentProject(),sceneId,cutId),key=frameKind===0?'first':'last',nameKey=`${key}Name`;
  try{
    const storedPath=await window.__TAURI__.core.invoke('store_flf_image',{sourcePath,projectPath:currentProject().projectPath,sceneNumber:cutStorageNumber(sceneId,cutId),frameKind});
    scene[`${key}Path`]=storedPath;scene[nameKey]=storedPath.split(/[\\/]/).pop();setCutImageDetails(scene,key,await localImageDetails(storedPath));save();renderPreservingEditorScroll();toast(`${scene[nameKey]} · ${scene[`${key}Width`]}×${scene[`${key}Height`]} 저장 완료`);
  }catch(error){toast(`이미지 저장 실패: ${error}`);}
}

async function deleteFlfImage(sceneId,cutId,frameKind){
  const project=currentProject(),cut=findCut(project,sceneId,cutId),key=frameKind===0?'first':'last',label=frameKind===0?'FIRST':'LAST';
  if(!cut||!cut[key])return;
  if(!window.confirm(`${label} 이미지를 삭제하시겠습니까?\n프로젝트에서 제거되며 복구할 수 없습니다.`))return;
  const storedPath=cut[`${key}Path`];
  try{
    if(isTauri()&&storedPath)await window.__TAURI__.core.invoke('delete_result_assets',{projectPath:project.projectPath,paths:[storedPath]});
    cut[key]=null;cut[`${key}Path`]=null;cut[`${key}Name`]=null;cut[`${key}Width`]=null;cut[`${key}Height`]=null;
    if(key==='first')cut.usePrevious=false;
    save();renderPreservingEditorScroll();toast(`${label} 이미지를 삭제했습니다.`);
  }catch(error){toast(`${label} 이미지 삭제 실패: ${error.message||error}`,7000);}
}

async function previewWebFlf(sceneId,cutId,frameKind,file){
  if(!file.type.startsWith('image/')){toast('이미지 파일만 사용할 수 있습니다.');return;}
  const scene=findCut(currentProject(),sceneId,cutId),key=frameKind===0?'first':'last',nameKey=`${key}Name`;
  const source=URL.createObjectURL(file),image=await loadImageElement(source);setCutImageDetails(scene,key,{background:`url('${source}')`,width:image.naturalWidth,height:image.naturalHeight});scene[nameKey]=`${mediaPrefix(currentProject(),sceneId,cutId)}-${frameKind}-${file.name}`;save();renderPreservingEditorScroll();toast(`${scene[nameKey]} · ${image.naturalWidth}×${image.naturalHeight} 미리보기`);
}

async function storeFlfFile(sceneId,cutId,frameKind,file){
  if(!file||!(/\.(png|jpe?g|webp|bmp|tiff?)$/i.test(file.name)||file.type.startsWith('image/'))){toast('이미지 파일만 사용할 수 있습니다.');return;}
  if(!isTauri()){previewWebFlf(sceneId,cutId,frameKind,file);return;}
  try{
    const bytes=Array.from(new Uint8Array(await file.arrayBuffer()));
    const storedPath=await window.__TAURI__.core.invoke('store_flf_bytes',{data:bytes,originalName:file.name,projectPath:currentProject().projectPath,sceneNumber:cutStorageNumber(sceneId,cutId),frameKind});
    const scene=findCut(currentProject(),sceneId,cutId),key=frameKind===0?'first':'last';scene[`${key}Path`]=storedPath;scene[`${key}Name`]=storedPath.split(/[\\/]/).pop();setCutImageDetails(scene,key,await localImageDetails(storedPath));save();renderPreservingEditorScroll();toast(`${scene[`${key}Name`]} · ${scene[`${key}Width`]}×${scene[`${key}Height`]} 저장 완료`);
  }catch(error){toast(`이미지 저장 실패: ${error}`);}
}

async function bindFlfDropZones(){
  if(dragDropUnlisten){dragDropUnlisten();dragDropUnlisten=null;}
  const zones=[...document.querySelectorAll('.flf-drop-zone')];if(!zones.length)return;
  document.querySelectorAll('.flf-remove').forEach(button=>button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();deleteFlfImage(Number(button.dataset.scene),Number(button.dataset.cut),Number(button.dataset.kind));}));
  let activeZone=null,htmlDropAt=0;
  const clear=()=>zones.forEach(zone=>zone.classList.remove('drag-over'));
  const activate=zone=>{clear();activeZone=zone||activeZone;if(zone)zone.classList.add('drag-over');};
  const zoneAt=position=>{
    const x=Number(position?.x)||0,y=Number(position?.y)||0,scale=window.devicePixelRatio||1,candidates=[[x,y],[x/scale,y/scale]];
    for(const [clientX,clientY] of candidates){const direct=document.elementFromPoint(clientX,clientY)?.closest('.flf-drop-zone');if(direct)return direct;for(const zone of zones){const rect=zone.getBoundingClientRect();if(clientX>=rect.left&&clientX<=rect.right&&clientY>=rect.top&&clientY<=rect.bottom)return zone;}}
    return null;
  };
  for(const zone of zones){
    zone.addEventListener('click',()=>chooseFlf(Number(zone.dataset.scene),Number(zone.dataset.cut),Number(zone.dataset.kind)));
    zone.addEventListener('dragenter',event=>{event.preventDefault();event.stopPropagation();activate(zone);});
    zone.addEventListener('dragover',event=>{event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';activate(zone);});
    zone.addEventListener('dragleave',event=>{if(!zone.contains(event.relatedTarget))zone.classList.remove('drag-over');});
    zone.addEventListener('drop',event=>{event.preventDefault();event.stopPropagation();clear();if(isTauri()){activeZone=zone;return;}htmlDropAt=Date.now();const file=event.dataTransfer.files?.[0];if(file)storeFlfFile(Number(zone.dataset.scene),Number(zone.dataset.cut),Number(zone.dataset.kind),file);});
  }
  if(isTauri()){
    try{dragDropUnlisten=await getCurrentWebview().onDragDropEvent(event=>{
      const payload=event.payload;if(payload.type==='leave'||payload.type==='cancel'){clear();activeZone=null;return;}
      const target=zoneAt(payload.position);
      if(payload.type==='over'){if(target)activate(target);return;}
      if(payload.type==='drop'){
        clear();if(Date.now()-htmlDropAt<500)return;const zone=target||activeZone,path=payload.paths?.[0];activeZone=null;
        if(zone&&path)storeFlfPath(Number(zone.dataset.scene),Number(zone.dataset.cut),Number(zone.dataset.kind),path);else toast('이미지를 FIRST 또는 LAST 영역 위에 놓아 주세요.');
      }
    });}catch(error){console.error('FLF drag/drop listener failed',error);toast('드래그앤드롭 초기화에 실패했습니다. 클릭해서 이미지를 선택할 수 있습니다.');}
  }
}

function imageToolArguments(tool,scene,frameKind){
  const properties=tool?.inputSchema?.properties||tool?.input_schema?.properties||{},args={};
  const direction=frameKind===0?'Opening first frame':'Closing last frame';
  for(const key of Object.keys(properties)){
    const normalized=key.toLowerCase();
    if(normalized==='prompt'||normalized.includes('text_prompt'))args[key]=`${direction} for a cinematic sequence. ${scene.promptEn}`;
    else if(normalized.includes('aspect'))args[key]=currentProject().ratio;
    else if(normalized.includes('resolution')||normalized==='size')args[key]='1024x576';
  }
  if(!Object.keys(args).some(k=>k.toLowerCase().includes('prompt')))args.prompt=`${direction} for a cinematic sequence. ${scene.promptEn}`;
  return args;
}

async function generateFlfImage(sceneId,frameKind){
  const scene=scenes().find(s=>s.id===sceneId);if(!scene?.promptEn.trim()){toast('영문 프롬프트를 먼저 입력해 주세요.');return;}
  if(!isTauri()){scene[frameKind===0?'first':'last']=frameKind===0?'linear-gradient(135deg,#b9edd7,#4a8176)':'linear-gradient(135deg,#ffd3ac,#b36a78)';scene[frameKind===0?'firstName':'lastName']=`${String(sceneId).padStart(4,'0')}-${frameKind}-openart-preview.png`;save();render();toast('웹 미리보기 이미지를 만들었습니다.');return;}
  if(!openartInfo.connected){toast('설정에서 OpenArt MCP를 먼저 연결해 주세요.');return;}
  const tool=imageTool();if(!tool){toast('OpenArt 이미지 생성 도구를 찾지 못했습니다.');return;}
  toast(`${frameKind===0?'First':'Last'} 이미지를 생성하고 있습니다…`);
  try{
    let raw=await window.__TAURI__.core.invoke('openart_call_tool',{toolName:tool.name,arguments:imageToolArguments(tool,scene,frameKind)});
    const completed=await awaitOpenArtResult(raw,'image');if(!completed.url)throw new Error('이미지 URL을 찾지 못했습니다.');
    const stamp=new Date().toISOString().replace(/[:.]/g,'-'),target=joinPath(currentProject().projectPath,'flf',`${String(sceneId).padStart(4,'0')}-${frameKind}-openart-${stamp}.png`);
    const stored=await window.__TAURI__.core.invoke('download_media',{url:completed.url,targetPath:target}),key=frameKind===0?'first':'last';
    scene[`${key}Path`]=stored;scene[`${key}Name`]=stored.split(/[\\/]/).pop();setCutImageDetails(scene,key,await localImageDetails(stored));save();render();toast(`${scene[`${key}Name`]} 생성 완료`);
  }catch(error){toast(`이미지 생성 실패: ${error.message||error}`);}
}

function collectModelCandidates(value,out=[]){
  if(typeof value==='string'&&(value.startsWith('{')||value.startsWith('['))){try{return collectModelCandidates(JSON.parse(value),out);}catch{return out;}}
  if(Array.isArray(value)){value.forEach(v=>collectModelCandidates(v,out));return out;}
  if(value&&typeof value==='object'){
    const id=value.id||value.model_id||value.modelId||value.slug,name=value.name||value.display_name||value.displayName;
    const text=JSON.stringify(value);
    if(id&&name&&/video|kling|wan|seedance|veo|sora|hailuo|minimax|pixverse|runway|ltx|vidu|happyhorse|switchx|flux|grok|gemini/i.test(text)){
      const resolutions=(value.resolutions||value.supported_resolutions||[]).map(String);
      out.push({id:String(id),name:String(name),flf:/first.?frame|last.?frame|image.?to.?video|flf/i.test(text),resolutions:resolutions.length?resolutions:['480p','720p','1080p']});
    }
    Object.values(value).forEach(v=>collectModelCandidates(v,out));
  }
  return out;
}

function schemaModelCandidates(tool){
  if(!/video/i.test(`${tool.name} ${tool.description||''}`))return[];
  const properties=tool.inputSchema?.properties||tool.input_schema?.properties||{},property=Object.entries(properties).find(([key])=>/^model(_id)?$/i.test(key))?.[1];if(!property)return[];
  const values=property.enum||property.oneOf?.map(v=>v.const??v.enum?.[0]).filter(Boolean)||[];
  return values.map(value=>{const id=String(value),label=property.oneOf?.find(v=>(v.const??v.enum?.[0])===value)?.title||id.replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase());return{id,name:label,flf:true,resolutions:['480p','720p','1080p']};});
}

function findOpenArtModels(value){
  if(typeof value==='string'&&(value.trim().startsWith('{')||value.trim().startsWith('['))){try{return findOpenArtModels(JSON.parse(value));}catch{return null;}}
  if(Array.isArray(value)){for(const child of value){const found=findOpenArtModels(child);if(found)return found;}return null;}
  if(value&&typeof value==='object'){
    if(Array.isArray(value.models))return value.models;
    for(const child of Object.values(value)){const found=findOpenArtModels(child);if(found)return found;}
  }
  return null;
}

function exactVideoModels(value){
  const list=findOpenArtModels(value)||[];
  return list.filter(model=>Array.isArray(model?.modes?.video)&&model.modes.video.length).map(model=>{
    const detail=JSON.stringify({description:model.description,modes:model.modes.video});
    return {id:String(model.id),name:String(model.displayName||model.name||model.id),flf:/endFrame|start.?end|start\/?end-frame/i.test(detail),resolutions:['480p','720p','1080p'],modes:model.modes.video.map(item=>item.mode).filter(Boolean),description:model.description||'',synced:true};
  });
}

async function syncOpenArtModels(){
  const tools=openartInfo.tools||[],listTool=tools.find(tool=>tool.name==='openart_model_list');
  try{
    if(!listTool)throw new Error('openart_model_list 도구가 없습니다.');
    const raw=await window.__TAURI__.core.invoke('openart_call_tool',{toolName:listTool.name,arguments:{}}),available=exactVideoModels(raw);
    if(!available.length)throw new Error('영상 생성 가능 모델이 반환되지 않았습니다.');
    models=available;
    for(const project of projects){
      if(!models.some(model=>model.id===project.model))project.model=models[0].id;
      for(const {cut} of cuts(project))if(cut.model&&!models.some(model=>model.id===cut.model))cut.model=null;
    }
    save();
    openartInfo.message=`OpenArt MCP 실시간 목록 · 영상 생성 모델 ${models.length}개`;
  }catch(error){models=structuredClone(curatedVideoModels);openartInfo.message=`OpenArt MCP 모델 조회 실패 · 기본 영상 목록을 표시합니다. (${error.message||error})`;}
}

async function importProject(){
  if(!isTauri()){toast('프로젝트 가져오기는 데스크톱 앱에서 사용할 수 있습니다.');return;}
  const manifest=await window.__TAURI__.dialog.open({multiple:false,title:'FrameFlow 프로젝트 가져오기',filters:[{name:'FrameFlow project',extensions:['json']} ]});if(!manifest)return;
  try{const project=await window.__TAURI__.core.invoke('import_project_manifest',{manifestPath:manifest});const index=projects.findIndex(p=>p.id===project.id);if(index>=0)projects[index]=project;else projects.unshift(project);migrateProjectModel();save();render();toast('프로젝트를 가져왔습니다.');}catch(error){toast(`가져오기 실패: ${error}`);}
}

async function recoverCompletedContinuousVideos(){
  if(!isTauri())return 0;
  let recovered=0;
  for(const project of projects){
    const recoveredScenes=new Set();
    for(const job of [...(project.jobs||[])].sort((a,b)=>new Date(b.startedAt||b.createdAt||0)-new Date(a.startedAt||a.createdAt||0))){
      if(!job.continuousChain||!['running','interrupted','failed'].includes(job.status))continue;
      const scene=(project.scenes||[]).find(item=>item.id===job.sceneId);if(!scene)continue;
      if(recoveredScenes.has(scene.id))continue;
      if(continuousVideoList(scene).some(item=>item.jobId===job.id||item.promptId===job.promptId)){job.status='completed';continue;}
      const kind=job.continuousTest?'test':'final',outputPath=joinPath(project.projectPath,'scenes',`S${String(scene.id).padStart(2,'0')}-context-loop-${kind}-recovered-${String(job.id).replace(/[^a-z0-9-]/gi,'')}.mp4`);
      try{
        const raw=await window.__TAURI__.core.invoke('comfy_recover_continuous_video',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188',jobId:job.id,outputPath});
        if(!raw?.path)continue;
        job.status='completed';job.completedAt=new Date().toISOString();job.resultPath=raw.path;job.promptId=raw.promptId||job.promptId;job.liveProgress=100;job.error=null;
        registerSceneContinuousVideo(scene,{id:`continuous-${job.id}`,jobId:job.id,path:raw.path,createdAt:new Date().toLocaleString('ko-KR'),completedAt:job.completedAt,cutCount:job.chainShots?.length||job.continuousTotal||scene.cuts?.length||0,duration:job.duration,fps:Number(raw.fps)||MINIMAX_FPS,type:job.continuousTest?'TEST':'FINAL',resolution:job.resolution,batchId:job.batchId,sequence:job.continuousSequence,engine:'Minimax-H3 Context Loop',contextFrames:Number(raw.contextFrames)||22,promptId:raw.promptId||null,recovered:true,seed:job.seed,seeds:(job.chainShots||[]).map(shot=>shot.seed),modelName:job.modelName,minimaxModelMode:job.minimaxModelMode||'default',minimaxProfile:job.minimaxProfile||'turbo-10',latentUpscaleMode:job.latentUpscaleMode||'off',backgroundMusic:!!job.backgroundMusic,generationSpec:job.generationSpec||null});
        recovered++;recoveredScenes.add(scene.id);
      }catch(error){console.warn(`연속 영상 복구 실패: ${job.id}`,error);}
    }
    if(recovered)await window.__TAURI__.core.invoke('save_project',{project:persistentProject(project)});
  }
  if(recovered){localStorage.setItem('frameflow-projects-v1',JSON.stringify(projects.map(persistentProject)));toast(`완료된 연속 영상 ${recovered}개를 해당 씬에 복구했습니다.`,7000);}
  return recovered;
}

function offerResumeJobs(){const recoverable=[...projects.flatMap(project=>(project.jobs||[]).filter(job=>['interrupted','cancelled'].includes(job.status)).map(job=>({project,job}))),...(videoAudioWorkspace.jobs||[]).filter(job=>['interrupted','cancelled'].includes(job.status)).map(job=>({workspace:videoAudioWorkspace,job})),...(videoVideoWorkspace.jobs||[]).filter(job=>['interrupted','cancelled'].includes(job.status)).map(job=>({workspace:videoVideoWorkspace,job}))];if(!recoverable.length)return;if(window.confirm(`중단되거나 취소된 생성 작업이 ${recoverable.length}개 있습니다. 지금 다시 시작할까요?\n아니요를 선택해도 생성 큐에서 나중에 진행하거나 삭제할 수 있습니다.`)){for(const item of recoverable){item.job.status='queued';item.job.error=null;}queuePaused=false;save();saveVideoAudio();saveVideoVideo();runGenerationQueue();runVideoAudioQueue();runVideoVideoQueue();}}

async function deleteProject(id){
  const project=projects.find(p=>p.id===id);
  if(!project)return;
  const projectJobIds=new Set((project.jobs||[]).map(job=>job.id));
  const activeJobs=allJobs().filter(job=>(job.projectId===id||projectJobIds.has(job.id))&&['queued','running'].includes(job.status));
  if(activeJobs.length){toast(`이 프로젝트에 실행 중이거나 대기 중인 작업이 ${activeJobs.length}개 있습니다. 생성 큐에서 먼저 취소해 주세요.`,9000);return;}
  if(!await confirmDestructive({title:'프로젝트를 삭제하시겠습니까?',target:project.name,message:`관련된 모든 파일도 같이 삭제됩니다.\n${project.projectPath}\n이 작업은 되돌릴 수 없습니다.`,confirmLabel:'프로젝트와 파일 모두 삭제'}))return;
  try{
    if(isTauri())await window.__TAURI__.core.invoke('delete_project',{projectId:id});
    projects=projects.filter(p=>p.id!==id);projects.forEach((item,index)=>item.sortOrder=index);if(activeProjectId===id){activeProjectId=projects[0]?.id||null;activeScene=null;activeCut=null;page='projects';}modal=null;localStorage.setItem('frameflow-projects-v1',JSON.stringify(projects));render();toast('프로젝트와 관련 파일을 모두 삭제했습니다.');
  }catch(error){toast(`프로젝트 삭제 실패: ${error.message||error}`,9000);}
}

async function backupProject(id){
  const project=projects.find(item=>item.id===id);if(!project)return;
  if(!isTauri()){toast('데스크톱 앱에서 프로젝트 폴더 전체를 백업할 수 있습니다.');return;}
  const destination=await window.__TAURI__.dialog.open({directory:true,multiple:false,title:`“${project.name}” 백업 저장 폴더 선택`});if(!destination)return;
  try{toast('프로젝트를 백업하고 있습니다…');const backupPath=await window.__TAURI__.core.invoke('backup_project_folder',{projectPath:project.projectPath,destinationDir:destination,projectName:project.name});toast(`백업 완료: ${backupPath}`);}catch(error){toast(`백업 실패: ${error}`);}
}

async function openCurrentProjectFolder(){
  const project=currentProject();if(!project?.projectPath){toast('프로젝트 폴더 경로가 없습니다.');return;}
  if(!isTauri()){toast(`프로젝트 폴더: ${project.projectPath}`);return;}
  try{await window.__TAURI__.core.invoke('open_media_folder',{path:project.projectPath});}
  catch(error){toast(`프로젝트 폴더 열기 실패: ${error.message||error}`,7000);}
}

async function hydrateNative(){
  if(!isTauri() || testMode) return;
  await window.__TAURI__.core.invoke('init_database');
  const saved=await window.__TAURI__.core.invoke('list_projects');
  appSettings={...appSettings,...await window.__TAURI__.core.invoke('get_app_settings')};
  const restoredComfy=await window.__TAURI__.core.invoke('get_restored_comfy_settings');if(restoredComfy?.comfyEnvironmentName||restoredComfy?.ffmpegPath){appSettings={...appSettings,...restoredComfy};await window.__TAURI__.core.invoke('save_app_settings',{settings:appSettings});localStorage.setItem('frameflow-settings-v1',JSON.stringify(appSettings));}
  await bindAppShutdown();
  appSettings.generationBackend='comfy';
  nativeReady=true;
  if(saved.length){projects=saved.sort((a,b)=>(Number.isFinite(Number(a.sortOrder))?Number(a.sortOrder):Number.MAX_SAFE_INTEGER)-(Number.isFinite(Number(b.sortOrder))?Number(b.sortOrder):Number.MAX_SAFE_INTEGER));migrateProjectModel();if(!projects.some(p=>p.id===activeProjectId))activeProjectId=projects[0].id;activeScene=currentProject().scenes[0]?.id||null;activeCut=currentProject().scenes[0]?.cuts?.[0]?.id||null;}
  else { for(const project of projects) await window.__TAURI__.core.invoke('save_project',{project}); }
  render();
  // Background work updates only its own surface, never replaces an active form.
  void hydrateProjectImages();
  void window.__TAURI__.core.invoke('comfy_list_environments').then(value=>{comfyEnvironments=value;}).catch(console.warn);
  void window.__TAURI__.core.invoke('comfy_check',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188'}).then(()=>{comfyRuntimeOnline=true;}).catch(()=>{comfyRuntimeOnline=false;}).finally(()=>{const status=document.querySelector('.sidebar .connection');if(status){status.classList.toggle('offline',!comfyRuntimeOnline);status.querySelector('small').textContent=comfyRuntimeOnline?'실행 중 · 연결됨':'실행되지 않음';}});
  void recoverCompletedContinuousVideos().catch(console.warn);
  const autoResume=projects.filter(project=>project.autoResumeQueueOnce);
  if(autoResume.length){for(const project of autoResume){delete project.autoResumeQueueOnce;await window.__TAURI__.core.invoke('save_project',{project:persistentProject(project)});}queuePaused=false;setTimeout(()=>{toast('5초로 변경된 대기 큐를 자동으로 시작합니다.');runGenerationQueue();},300);}
  // Interrupted jobs are already exposed in the project recovery panel and queue.
}

async function bindAppShutdown(){
  if(closeHandlerBound||!isTauri())return;closeHandlerBound=true;
  await getCurrentWindow().onCloseRequested(async event=>{
    if(appClosing)return;event.preventDefault();
    if(frameInterpolation.isRunning()||realEsrganUpscale.isRunning()){toast('프레임 보간 또는 업스케일이 진행 중입니다. 완료 후 종료해 주세요.',8000);return;}
    await flushProjectSaves();
    let online=false;try{await window.__TAURI__.core.invoke('comfy_check',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188'});online=true;}catch{}
    if(!online){appClosing=true;await window.__TAURI__.core.invoke('exit_app').catch(()=>getCurrentWindow().destroy());return;}
    const active=allJobs().filter(job=>['running','queued'].includes(job.status)),running=active.filter(job=>job.status==='running').length,queued=active.filter(job=>job.status==='queued').length;
    const choice=await shutdownChoiceDialog(running,queued);if(choice==='cancel')return;
    if(choice==='both'){
      const confirmed=await shutdownConfirmDialog(running,queued);if(!confirmed)return;
      try{
        await window.__TAURI__.core.invoke('comfy_cancel_and_stop',{baseUrl:appSettings.comfyUrl||'http://127.0.0.1:8188'});
      }catch(error){
        appClosing=false;
        toast(`Comfy 종료 실패: ${error}`,8000);
        return;
      }
      appClosing=true;preserveComfyJobsOnExit=false;
      for(const project of projects)for(const job of project.jobs||[])if(['running','queued'].includes(job.status)){job.status='interrupted';job.error='FrameFlow와 Comfy 종료로 중단된 작업입니다. 생성 큐에서 다시 진행할 수 있습니다.';}
      for(const job of videoAudioWorkspace.jobs||[])if(['running','queued'].includes(job.status)){job.status='interrupted';job.error='FrameFlow와 Comfy 종료로 중단된 Video-to-Audio 작업입니다.';}
      for(const job of videoVideoWorkspace.jobs||[])if(['running','queued'].includes(job.status)){job.status='interrupted';job.error='FrameFlow와 Comfy 종료로 중단된 Video-to-Video 작업입니다.';}
      for(const job of generativeUpscaleWorkspace.jobs||[])if(['running','queued'].includes(job.status)){job.status='interrupted';job.error='FrameFlow와 Comfy 종료로 중단된 생성형 Upscale 작업입니다.';}
      save();saveVideoAudio();saveVideoVideo();saveGenerativeUpscale();
    }else{appClosing=true;preserveComfyJobsOnExit=true;}
    try{await window.__TAURI__.core.invoke('exit_app');}
    catch(error){console.warn('Native app exit failed; destroying the window.',error);await getCurrentWindow().destroy();}
  });
}

function shutdownChoiceDialog(running,queued){
  return new Promise(resolve=>{const overlay=document.createElement('div');overlay.className='action-dialog-backdrop';overlay.innerHTML=`<section class="action-dialog shutdown-dialog" role="dialog" aria-modal="true"><header><span>APP EXIT</span><h2>종료 방법을 선택하세요</h2><p>Comfy Desktop이 실행 중입니다. 현재 FrameFlow 작업은 생성 중 ${running}개 · 대기 ${queued}개입니다.</p></header><div class="shutdown-actions"><button class="button danger exit-both">FrameFlow와 Comfy 모두 종료</button><button class="button secondary exit-app-only">FrameFlow만 종료</button><button class="button secondary exit-cancel">취소</button></div><small>FrameFlow만 종료하면 Comfy와 현재 Comfy 작업은 계속 실행됩니다.</small></section>`;document.body.append(overlay);const done=value=>{overlay.remove();resolve(value);};overlay.querySelector('.exit-both').addEventListener('click',()=>done('both'));overlay.querySelector('.exit-app-only').addEventListener('click',()=>done('app'));overlay.querySelector('.exit-cancel').addEventListener('click',()=>done('cancel'));});
}

function shutdownConfirmDialog(running,queued){
  return new Promise(resolve=>{const overlay=document.createElement('div');overlay.className='action-dialog-backdrop';overlay.innerHTML=`<section class="action-dialog shutdown-dialog danger-confirm" role="alertdialog" aria-modal="true"><header><span>FINAL CONFIRMATION</span><h2>FrameFlow와 Comfy Desktop을 모두 종료하시겠습니까?</h2><p>현재 실행 중인 생성 작업은 중단되고, Comfy 대기 큐도 취소됩니다. 중단된 작업은 FrameFlow 생성 큐에서 다시 진행할 수 있습니다.</p></header><div class="shutdown-counts"><span>생성 중 <b>${running}</b></span><span>대기 <b>${queued}</b></span></div><footer><button class="button secondary back">돌아가기</button><button class="button danger confirm">모두 종료</button></footer></section>`;document.body.append(overlay);const done=value=>{overlay.remove();resolve(value);};overlay.querySelector('.back').addEventListener('click',()=>done(false));overlay.querySelector('.confirm').addEventListener('click',()=>done(true));});
}

function installHierarchyMoveTestApi(){
  if(!new URLSearchParams(window.location.search).has('test'))return;
  const state=()=>({scenes:scenes().map(scene=>({id:scene.id,title:scene.title,cuts:(scene.cuts||[]).map(cut=>({id:cut.id,name:cut.name,prefix:cut.filePrefix}))}))});
  const host=document.createElement('section');host.id='frameflow-hierarchy-test';host.hidden=true;host.innerHTML='<pre id="frameflow-hierarchy-result"></pre>';document.body.append(host);
  setTimeout(()=>{const output=host.querySelector('pre');try{const initial=state();moveSceneBy(1,'next');const sceneNext=state();moveSceneBy(2,'previous');const scenePrevious=state();const scene=scenes()[0],base=scene.cuts[0];base.firstWidth=8960;base.firstHeight=1920;base.firstName='0203-0-02.png';while(scene.cuts.length<4){const index=scene.cuts.length+1,cut=structuredClone(base);cut.id=index;cut.uid=`test-cut-${Date.now()}-${index}`;cut.name=`테스트 컷 ${String(index).padStart(2,'0')}`;cut.filePrefix=mediaPrefix(currentProject(),scene.id,index);cut.selected=null;cut.videoResults=[];scene.cuts.push(cut);}renumberHierarchy(base.uid);render();moveCutBy(1,1,'next');const cutNext=state();moveCutBy(1,2,'previous');const cutPrevious=state();activeScene=1;activeCut=1;sceneEditorOpen=true;render();const prompt=buildMetaPrompt(base);output.textContent=JSON.stringify({ok:true,initial,sceneNext,scenePrevious,cutNext,cutPrevious,dragHandles:document.querySelectorAll('.drag-handle,[draggable="true"]').length,sceneButtons:document.querySelectorAll('.scene-order').length,cutButtons:document.querySelectorAll('.cut-order').length,resolutionLabels:[...document.querySelectorAll('.flf-resolution')].map(node=>node.textContent),jsonOnlyGuard:prompt.startsWith('ABSOLUTE EXECUTION BAN'),mediaBan:prompt.includes('DO NOT generate, create, render, edit, animate, or export any video or image.'),rawJsonGate:prompt.includes('exactly one parseable JSON object and nothing else')});}catch(error){output.textContent=JSON.stringify({ok:false,error:String(error)});}},80);
}

installHierarchyMoveTestApi();
if(isTauri()&&!testMode){
  document.querySelector('#app').innerHTML='<div class="startup-loading" role="status"><b>FrameFlow Studio</b><span>프로젝트를 불러오는 중…</span></div>';
  hydrateNative().catch(error=>{console.error(error);render();toast(`프로젝트 복원 실패: ${error}`,10000);});
}else render();
