import './media-enhance.css';
import {createEnhanceCompare} from './enhance-compare.js';
import {presetMarkup,bindPresets} from './enhance-presets.js';
import {pipelineSettings,pipelineMarkup,bindPipeline} from './enhance-pipeline.js';

const KEY='frameflow-media-enhance-v1';
const profiles=[['Faithful','약하게','원본 표현 중심'],['Natural','기본','자연스러운 보정'],['Strong / Cinematic','강하게','명암·질감 강조']];
const customDefaults={baseProfile:'Strong / Cinematic',intensity:1.65,local_tone:1.4,local_structure:1.5,skin_structure:1};
const sliders=[['intensity','Intensity',0],['local_tone','Local tone',0],['local_structure','Local structure',0],['skin_structure','Skin structure',-1]];
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createMediaEnhance({native,invoke,dialog,url,toast,redraw,project,ffmpeg,listen}){
  let state;
  try{state=JSON.parse(localStorage.getItem(KEY)||'{}');}catch{state={};}
  state={runtimeDir:'',pythonPath:'',outputDir:'',profile:'Faithful',results:[],...state};
  Object.assign(state,pipelineSettings(state));
  state.reshadePath=state.reshadePath||'';
  state.customSettings={...customDefaults,...state.customSettings};
  state.sources=[];
  if(!Array.isArray(state.presets))state.presets=[];
  if(!Array.isArray(state.batches))state.batches=(state.results||[]).map((result,index)=>({id:`legacy-${index}`,createdAt:result.createdAt,profile:result.profile,status:'completed',items:[{...result,status:'completed'}]}));
  delete state.source;delete state.results;
  for(const batch of state.batches){if(batch.status==='running')batch.status='interrupted';for(const item of batch.items||[])if(['pending','running'].includes(item.status))item.status='interrupted';}
  if(state.profile!=='Custom'&&!profiles.some(p=>p[0]===state.profile))state.profile='Faithful';
  let busy=false,checking=false,loading=false,runtimeReady=false,message='',job=null,comparison=null,stopRequested=false,activeResult=null;
  const save=()=>{const {sources,...persistent}=state;localStorage.setItem(KEY,JSON.stringify(persistent));};
  save();
  const selected=()=>state.sources.filter(source=>source.selected!==false);
  const getSettings=()=>({profile:state.profile,customSettings:{...state.customSettings},...pipelineSettings(state)});
  const presetApi={list:()=>state.presets,settings:getSettings,
    store:value=>{state.presets=value;save();},apply:value=>{Object.assign(state,value);save();}};
  const compareViewer=createEnhanceCompare({invoke,url,ffmpeg,toast,onClose:redraw,presetApi,
    settings:getSettings,
    saveSettings:value=>{Object.assign(state,value);save();},
    runtime:()=>({runtimeDir:state.runtimeDir,pythonPath:state.pythonPath,reshadePath:state.reshadePath})});
  const nrLabel=value=>value===true?'NR ON':value===false?'NR OFF':'NR 기록 없음';
  function settingsMarkup(){return `<fieldset class="enhance-profiles" ${busy?'disabled':''}><legend>프리셋</legend>${[...profiles,['Custom','Custom','직접 설정']].map(([id,label,detail])=>`<label><input type="radio" name="enhance-profile" value="${escape(id)}" ${state.profile===id?'checked':''}><span><b>${label}</b><small>${detail}</small></span></label>`).join('')}</fieldset>${state.profile==='Custom'?`<fieldset class="enhance-custom" ${busy?'disabled':''}><label for="enhance-base">Profile</label><select id="enhance-base">${profiles.map(([id])=>`<option ${state.customSettings.baseProfile===id?'selected':''}>${escape(id)}</option>`).join('')}</select>${sliders.map(([key,label,min])=>`<label for="enhance-${key}">${label}<output data-value="${key}">${Number(state.customSettings[key]).toFixed(2)}</output></label><input id="enhance-${key}" data-custom="${key}" type="range" min="${min}" max="3" step="0.05" value="${state.customSettings[key]}" aria-label="${label}">`).join('')}</fieldset>`:''}<p class="enhance-format">Resolution · Full (원본 해상도)</p>`;}
  function wipe(before,after,kind='image',width=16,height=9){
    const video=kind==='video';
    const layer=(path,cls)=>video?`<video class="${cls}" src="${escape(url(path))}" muted playsinline preload="metadata"></video>`:`<img class="${cls}" src="${escape(url(path))}" alt="${cls==='wipe-before'?'원본':'개선'}">`;
    return `<div class="enhance-wipe-group"><div class="enhance-wipe" style="--split:50%;aspect-ratio:${width}/${height}">${layer(after,'wipe-after')}${layer(before,'wipe-before')}<span class="wipe-tag before">원본</span><span class="wipe-tag after">결과</span><div class="wipe-divider"><span>‹ ›</span></div><input class="wipe-control" type="range" min="0" max="100" value="50" aria-label="원본과 결과 비교 위치"></div>${video?'<div class="wipe-playback"><button class="button secondary" data-wipe-play>재생</button><input type="range" data-wipe-seek min="0" max="100" value="0" step="0.1" aria-label="비교 영상 재생 위치"></div>':''}</div>`;
  }
  const labels={pending:'대기',running:'처리 중',completed:'완료',failed:'실패',cancelled:'취소',interrupted:'중단'};
  const metadata=source=>`${source.width}×${source.height} · ${source.kind==='image'?'이미지':`${Number(source.fps||0).toFixed(2)}fps · ${Number(source.duration||0).toFixed(1)}초`}`;
  function sourceList(){return `<h2><span>01</span> 이미지·영상 목록</h2><button class="enhance-source" data-enhance="source" ${busy||loading?'disabled':''}><b>${loading?'파일 정보 확인 중…':'파일 추가 · 여러 개 선택'}</b><small>PNG · JPG · WEBP · BMP · TIFF / MP4 · MOV · MKV · WEBM · AVI</small></button>${state.sources.length?`<div class="enhance-list-toolbar"><label><input type="checkbox" data-enhance-all ${selected().length===state.sources.length?'checked':''} ${busy||loading?'disabled':''}> 전체 선택 (${selected().length}/${state.sources.length})</label><button class="button secondary" data-enhance="clear" ${busy||loading?'disabled':''}>목록 비우기</button></div><ul class="enhance-file-list enhance-input-list">${state.sources.map((source,index)=>`<li><input type="checkbox" data-enhance-select="${index}" aria-label="${escape(source.filename)} 선택" ${source.selected!==false?'checked':''} ${busy||loading?'disabled':''}><div class="enhance-file-info"><b title="${escape(source.path)}">${escape(source.filename)}</b><small>${metadata(source)}</small></div><button class="button secondary" data-enhance-remove="${index}" ${busy||loading?'disabled':''}>제거</button></li>`).join('')}</ul>`:'<div class="enhance-empty">여러 파일을 선택하면 이곳에 목록으로 표시됩니다.</div>'}`;}
  function batchCard(batch){
    const completed=batch.items.filter(item=>item.status==='completed').length;
    return `<article class="enhance-card enhance-batch" data-batch="${escape(batch.id)}"><header><div><h3>${escape(batch.createdAt||'이전 결과')}</h3><small>${batch.reshadeEnabled?'ReShade · ':''}${batch.nrEnabled===false?'색상 보정':escape(batch.profile)} · ${nrLabel(batch.nrEnabled)} · ${batch.resolution||'기존 설정'} · 완료 ${completed}/${batch.items.length} · ${labels[batch.status]||batch.status}</small></div>${batch.folder?`<button class="button secondary" data-enhance-folder="${escape(batch.folder)}">결과 폴더 열기</button>`:''}</header><ul class="enhance-file-list enhance-output-list">${batch.items.map((item,index)=>`<li><span class="enhance-file-number">${index+1}</span><div class="enhance-file-info"><b>${escape(item.filename)}</b><small>${item.status==='completed'?`${item.width}×${item.height} · ${item.kind==='image'?'PNG':'MP4'}`:escape(item.error||'')}</small></div><span class="enhance-item-status ${item.status}">${labels[item.status]||item.status}</span>${item.status==='completed'?`<button class="button secondary" data-enhance-result="${escape(batch.id)}" data-index="${index}">보기</button><button class="button secondary" data-enhance-folder="${escape(item.path)}">파일 위치</button>`:''}</li>`).join('')}</ul>${activeResult?.batchId===batch.id?`<div class="enhance-result-preview">${wipe(batch.items[activeResult.index].sourcePath||batch.items[activeResult.index].beforePath,batch.items[activeResult.index].path,batch.items[activeResult.index].kind,batch.items[activeResult.index].width,batch.items[activeResult.index].height)}</div>`:''}</article>`;
  }
  const media=(path,kind,controls=true)=>kind==='video'?`<video src="${escape(url(path))}" ${controls?'controls':''} playsinline preload="metadata"></video>`:`<img src="${escape(url(path))}" alt="${controls?'개선 결과':'원본'}" loading="lazy">`;
  function markup(){
    const source=selected()[0],output=state.outputDir||defaultOutput(),disabled=busy||loading||checking;
    return `<section class="enhance-page"><header class="enhance-heading"><div class="eyebrow">NEURALSCREEN · EXPERIMENTAL</div><h1>이미지/영상 개선</h1><p>원본 해상도를 유지하면서 조명과 질감을 보정합니다. 원본 파일은 변경하지 않습니다.</p></header>
    <div class="field" ${state.reshadeEnabled?'':'hidden'}><label for="enhance-reshade">ReShade 6.8 Add-on DLL (비우면 앱 옆 tools/reshade에서 검색)</label><input id="enhance-reshade" value="${escape(state.reshadePath)}" ${busy?'disabled':''}></div><details class="enhance-runtime" ${!runtimeReady?'open':''}><summary>처리 런타임 연결 <span>${runtimeReady?'파일 확인 완료':'런타임 지정 필요'}</span></summary><div class="enhance-runtime-body"><p ${state.nrEnabled?'':'hidden'}>외부 NeuralScreen 폴더가 필요합니다. DLL은 앱에 포함되어 있지 않습니다. 현재 연결은 Windows 11 · RTX 50 계열 대상이며, 비공식 GPU 우회는 사용하지 않습니다.</p><div class="field" ${state.nrEnabled?'':'hidden'}><label for="enhance-runtime">NeuralScreen 폴더</label><div class="enhance-path"><input id="enhance-runtime" value="${escape(state.runtimeDir)}" ${busy?'disabled':''}><button class="button secondary" data-enhance="runtime" ${busy?'disabled':''}>폴더 선택</button></div></div><div class="field"><label for="enhance-python">Python 실행 파일</label><div class="enhance-path"><input id="enhance-python" value="${escape(state.pythonPath)}" placeholder="런타임 폴더에서 자동 검색" ${busy?'disabled':''}><button class="button secondary" data-enhance="python" ${busy?'disabled':''}>파일 선택</button></div></div><div class="enhance-runtime-actions"><button class="button secondary" data-enhance="check" ${busy||checking?'disabled':''}>${checking?'확인 중…':'연결 확인'}</button><small>Python 패키지: av · numpy · opencv-python</small></div></div></details>
    <div class="enhance-layout"><section class="enhance-card">${sourceList()}</section>
    <section class="enhance-card"><h2><span>02</span> 보정 설정</h2>${pipelineMarkup(state,busy)}<div ${state.nrEnabled?'':'hidden'}>${settingsMarkup()}</div>${presetMarkup(state.presets,busy)}<div class="field"><label for="enhance-output">결과 저장 폴더</label><div class="enhance-path"><input id="enhance-output" value="${escape(output)}" ${busy?'disabled':''}><button class="button secondary" data-enhance="output" ${busy?'disabled':''}>폴더 선택</button></div></div><p class="enhance-format">이미지: PNG · 영상: MP4 (H.264)<br>영상 타임스탬프 유지 · 오디오는 AAC로 저장 · HDR 미지원</p><div class="enhance-actions"><button class="button secondary" data-enhance="preview" ${disabled||!state.sources.length?'disabled':''}>비교하기</button><button class="button primary" data-enhance="run" ${disabled||!source||!output?'disabled':''}>${busy?'개선 중…':`선택 ${selected().length}개 개선 실행`}</button></div><p class="enhance-note">선택한 파일을 순서대로 처리하고 한 폴더에 저장합니다. 비교하기에서 업로드한 모든 파일의 첫 프레임을 확인할 수 있습니다.</p></section></div>
    <div class="enhance-status" role="status" aria-live="polite"><span>${escape(message||'런타임 연결 후 파일을 선택해 주세요.')}</span>${busy?`<progress max="100" value="${job?.percent||0}"></progress><button class="button secondary" data-enhance="cancel" ${stopRequested?'disabled':''}>${stopRequested?'취소 중…':'전체 취소'}</button>`:''}</div>
    ${comparison?`<section class="enhance-card enhance-comparison"><h2>미리보기 비교 <small>${escape(comparison.profile)} · ${nrLabel(comparison.nrEnabled)} · Full</small></h2>${wipe(comparison.beforePath,comparison.path,'image',comparison.width,comparison.height)}</section>`:''}
    <section class="enhance-results"><h2>개선 결과 <small>${state.batches.length}회 실행</small></h2>${state.batches.length?`<div class="enhance-batches">${state.batches.map(batchCard).join('')}</div>`:'<div class="enhance-empty">실행별 결과 카드 안에 처리된 파일 목록이 표시됩니다.</div>'}</section></section>`;
  }
  function defaultOutput(){const path=project()?.projectPath;return path?`${path}\\media-enhanced`:'';}
  async function select(kind){
    if(!native()){toast('파일 선택은 데스크톱 앱에서 사용할 수 있습니다.');return;}
    const directory=['runtime','output'].includes(kind);
    const path=await dialog().open({directory,multiple:kind==='source',title:kind==='source'?'개선할 이미지·영상 여러 개 선택':kind==='python'?'NeuralScreen Python 선택':'폴더 선택',...(!directory?{filters:[{name:kind==='python'?'Python':'이미지·영상',extensions:kind==='python'?['exe']:['png','jpg','jpeg','webp','bmp','tif','tiff','mp4','mov','mkv','webm','avi']}]}:{})});
    if(!path)return;
    if(kind==='source'){
      loading=true;message='파일 정보 확인 중…';redraw();
      const failures=[];let added=0;
      const key=value=>String(value).replace(/\\/g,'/').toLowerCase();
      try{
        for(const item of Array.isArray(path)?path:[path]){
          if(state.sources.some(source=>key(source.path)===key(item)))continue;
          try{const source=await invoke('enhance_probe',{sourcePath:item,executable:ffmpeg()});state.sources.push({...source,selected:true});added++;}
          catch(error){failures.push(`${String(item).split(/[\\/]/).pop()}: ${error.message||error}`);}
        }
        comparison=null;save();message=`${added}개 파일을 추가했습니다.${failures.length?`\n불러오기 실패 ${failures.length}개\n${failures.join('\n')}`:''}`;
      }finally{loading=false;redraw();}
    }else{
      state[kind==='runtime'?'runtimeDir':kind==='python'?'pythonPath':'outputDir']=path;
      if(kind==='runtime'||kind==='python')runtimeReady=false;
      save();redraw();
    }
  }
  async function check(){
    if(!native()){toast('런타임 확인은 데스크톱 앱에서 사용할 수 있습니다.');return;}
    checking=true;redraw();
    try{const result=await invoke('enhance_check_runtime',{runtimeDir:state.runtimeDir,pythonPath:state.pythonPath,reshadePath:state.reshadePath,...pipelineSettings(state)});state.pythonPath=result.pythonPath;state.reshadePath=result.reshadePath||state.reshadePath;runtimeReady=true;message=result.message;save();}
    catch(error){runtimeReady=false;throw error;}
    finally{checking=false;redraw();}
  }
  async function run(preview){
    const sources=selected().map(source=>({...source}));
    if(busy||checking||compareViewer.isRunning()||!sources.length||(preview&&sources.length!==1))return;
    await check();
    if(!runtimeReady)return;
    busy=true;stopRequested=false;job=null;message='처리 준비 중…';redraw();
    let unlisten,batch;
    const nrEnabled=state.nrEnabled,customSettings={...state.customSettings},pipeline=pipelineSettings(state);
    const profile=state.profile,outputDir=state.outputDir||defaultOutput(),id=`enhance-${Date.now()}`;
    try{
      unlisten=await listen('frameflow-enhance-progress',({payload})=>{
        if(payload.jobId!==job?.id)return;
        if(payload.type==='progress'){
          job.percent=((job.index+(payload.percent||0)/100)/sources.length)*100;
          message=`${job.index+1}/${sources.length} · ${job.filename} · ${payload.message}`;
          const status=document.querySelector('.enhance-status');
          if(status){status.querySelector('span').textContent=message;const progress=status.querySelector('progress');if(progress)progress.value=job.percent;}
        }
      });
      if(!preview){
        const folder=await invoke('enhance_create_batch',{outputDir});
        batch={id,folder:folder.path,profile,...pipeline,customSettings,resolution:'Full',createdAt:new Date().toLocaleString('ko-KR'),status:'running',items:sources.map(source=>({...source,status:'pending'}))};
        state.batches.unshift(batch);save();
      }
      for(let index=0;index<sources.length&&!stopRequested;index++){
        const source=sources[index],item=batch?.items[index];
        job={id:`${id}-${index+1}`,index,filename:source.filename,percent:index/sources.length*100};
        if(item)item.status='running';message=`${index+1}/${sources.length} · ${source.filename} 처리 중…`;save();redraw();
        try{
          const result=await invoke('enhance_run',{jobId:job.id,runtimeDir:state.runtimeDir,pythonPath:state.pythonPath,
            sourcePath:source.path,outputDir,profile,...pipeline,reshadePath:state.reshadePath,customSettings,preview,executable:ffmpeg(),batchFolder:batch?.folder||null});
          if(preview)comparison={...result,profile,nrEnabled,filename:source.filename};
          else {Object.assign(item,result,{status:'completed',filename:source.filename,sourcePath:source.path});
            state.sources=state.sources.filter(input=>input.path!==source.path);}
        }catch(error){
          if(preview)throw error;
          item.status=stopRequested?'cancelled':'failed';item.error=String(error.message||error);
        }
        save();
      }
      if(batch){
        for(const item of batch.items)if(item.status==='pending')item.status='cancelled';
        batch.status=stopRequested?'cancelled':batch.items.some(item=>item.status==='failed')?'failed':'completed';
        const done=batch.items.filter(item=>item.status==='completed').length,failed=batch.items.filter(item=>item.status==='failed').length;
        message=`처리 종료 · 완료 ${done}개 · 실패 ${failed}개${stopRequested?' · 나머지 취소':''}`;
      }else message=stopRequested?'미리보기를 취소했습니다.':'미리보기가 완료되었습니다.';
      save();toast(message);
    }catch(error){
      message=String(error.message||error);toast(message,10000);
      if(batch){batch.status='failed';for(const item of batch.items)if(['pending','running'].includes(item.status)){item.status='failed';item.error=message;}save();}
    }
    finally{
      unlisten?.();
      if(batch)try{
        await invoke('enhance_finish_batch',{folder:batch.folder,outputDir});
        if(!batch.items.some(item=>item.status==='completed'))batch.folder=null;
        save();
      }catch(error){message+='\n임시 폴더 정리 실패: '+String(error.message||error);}
      busy=false;job=null;redraw();
    }
  }
  function bind(){
    document.querySelector('#enhance-reshade')?.addEventListener('change',e=>{state.reshadePath=e.target.value;runtimeReady=false;save();});
    bindPipeline(document,{settings:getSettings,save:value=>{Object.assign(state,value);save();},redraw,dirty:()=>{runtimeReady=false;}});
    bindPresets(document,{...presetApi,redraw});
    const safe=action=>async()=>{try{await action();}catch(error){message=String(error.message||error);toast(message,9000);redraw();}};
    document.querySelectorAll('[data-enhance]').forEach(button=>button.addEventListener('click',safe(async()=>{
      const action=button.dataset.enhance;
      if(action==='check')return check();
      if(action==='preview'){if(checking||busy||compareViewer.isRunning())return;await check();if(runtimeReady)return compareViewer.open(state.sources);return;}
      if(action==='run')return run(false);
      if(action==='clear'){state.sources=[];comparison=null;save();redraw();return;}
      if(action==='cancel'){stopRequested=true;message='현재 작업과 대기 파일을 취소하는 중…';redraw();if(job)await invoke('enhance_cancel',{jobId:job.id});return;}
      return select(action);
    })));
    document.getElementById('enhance-base')?.addEventListener('change',event=>{const base=event.target.value;const values=base==='Faithful'?[.7,.75,.75,-1]:base==='Natural'?[1,1,1,-1]:[1.65,1.4,1.5,1];state.customSettings={baseProfile:base,...Object.fromEntries(sliders.map(([key],i)=>[key,values[i]]))};save();redraw();});
    document.querySelectorAll('[data-custom]').forEach(input=>input.addEventListener('input',()=>{state.customSettings[input.dataset.custom]=Number(input.value);document.querySelector('[data-value="'+input.dataset.custom+'"]').textContent=Number(input.value).toFixed(2);save();}));
    document.querySelectorAll('.wipe-control').forEach(input=>input.addEventListener('input',()=>input.closest('.enhance-wipe').style.setProperty('--split',input.value+'%')));
    document.querySelectorAll('.enhance-wipe-group').forEach(group=>{
      const before=group.querySelector('video.wipe-before'),after=group.querySelector('video.wipe-after'),button=group.querySelector('[data-wipe-play]'),seek=group.querySelector('[data-wipe-seek]');
      if(!after)return;
      button.addEventListener('click',async()=>{if(!after.paused){after.pause();before.pause();button.textContent='재생';return;}try{before.currentTime=after.currentTime;await Promise.all([after.play(),before.play()]);button.textContent='일시정지';}catch{after.pause();before.pause();button.textContent='재생';toast('비교 영상을 재생하지 못했습니다.');}});
      seek.addEventListener('input',()=>{if(Number.isFinite(after.duration)){after.currentTime=Number(seek.value)/100*after.duration;before.currentTime=after.currentTime;}});
      after.addEventListener('timeupdate',()=>{if(after.duration)seek.value=after.currentTime/after.duration*100;if(Math.abs(before.currentTime-after.currentTime)>.12)before.currentTime=after.currentTime;});
      after.addEventListener('ended',()=>{before.pause();button.textContent='재생';});
    });
    const updateSelection=()=>{comparison=null;save();redraw();};
    document.querySelector('[data-enhance-all]')?.addEventListener('change',event=>{state.sources.forEach(source=>source.selected=event.target.checked);updateSelection();});
    document.querySelectorAll('[data-enhance-select]').forEach(input=>input.addEventListener('change',()=>{state.sources[Number(input.dataset.enhanceSelect)].selected=input.checked;updateSelection();}));
    document.querySelectorAll('[data-enhance-remove]').forEach(button=>button.addEventListener('click',()=>{state.sources.splice(Number(button.dataset.enhanceRemove),1);updateSelection();}));
    for(const [id,key] of [['enhance-runtime','runtimeDir'],['enhance-python','pythonPath'],['enhance-output','outputDir']])document.getElementById(id)?.addEventListener('change',event=>{state[key]=event.target.value.trim();if(key!=='outputDir')runtimeReady=false;save();redraw();});
    document.querySelectorAll('[name="enhance-profile"]').forEach(input=>input.addEventListener('change',()=>{state.profile=input.value;comparison=null;save();redraw();}));
    document.querySelectorAll('[data-enhance-folder]').forEach(button=>button.addEventListener('click',safe(()=>invoke('open_media_folder',{path:button.dataset.enhanceFolder}))));
    document.querySelectorAll('[data-enhance-result]').forEach(button=>button.addEventListener('click',()=>{activeResult={batchId:button.dataset.enhanceResult,index:Number(button.dataset.index)};redraw();}));
  }
  return {markup,bind,isRunning:()=>busy||compareViewer.isRunning()};
}
