// Full-size, pixel-aligned comparison. DOM is independent of page redraws.
import {presetMarkup,bindPresets} from './enhance-presets.js';
import {pipelineMarkup,bindPipeline} from './enhance-pipeline.js';
export function createEnhanceCompare({invoke,url,settings,saveSettings,runtime,ffmpeg,toast,onClose,presetApi}){
  let modal=null,files=[],index=0,busy=false,jobId=null,closed=false;
  const cache=new Map(),views=new Map(),lastResults=new Map();
  let zoom=1,split=50,options=true,pan={x:0,y:0};
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fields=[['intensity','Intensity',0],['local_tone','Local tone',0],['local_structure','Local structure',0],['skin_structure','Skin structure',-1]];
  const names=['Faithful','Natural','Strong / Cinematic'];
  const key=()=>JSON.stringify([files[index].path,settings(),runtime()]);
  const remember=()=>views.set(files[index].path,{zoom,split,pan:{...pan}});
  function applyPosition(){
    if(!modal)return;
    const stage=modal.querySelector('.compare-stage'),file=files[index],dpr=window.devicePixelRatio||1;
    const width=file.width*zoom/dpr,height=file.height*zoom/dpr;
    const rect=stage.getBoundingClientRect();
    pan.x=width>rect.width?Math.max(rect.width-width,Math.min(0,pan.x)):(rect.width-width)/2;
    pan.y=height>rect.height?Math.max(rect.height-height,Math.min(0,pan.y)):(rect.height-height)/2;
    stage.style.setProperty('--compare-split',split+'%');
    modal.querySelectorAll('.compare-pixels').forEach(img=>{img.style.width=width+'px';img.style.height=height+'px';img.style.transform=`translate(${pan.x}px,${pan.y}px)`;});
    remember();
  }
  function render(){
    const file=files[index],s=settings(),result=cache.get(key())||lastResults.get(file.path);
    modal.innerHTML=`<header class="compare-toolbar"><div><b>${esc(file.filename)}</b><small>${index+1} / ${files.length} · ${file.kind==='video'?'첫 프레임':'이미지'} · ${file.width}×${file.height}</small></div><nav><button data-compare="prev" aria-label="이전 파일" ${busy||index===0?'disabled':''}>‹</button><button data-compare="next" aria-label="다음 파일" ${busy||index===files.length-1?'disabled':''}>›</button><button data-compare="100" aria-pressed="${zoom===1}">100%</button><button data-compare="200" aria-pressed="${zoom===2}">200%</button><button data-compare="options" aria-expanded="${options}">옵션 보기</button><button data-compare="close" aria-label="비교창 닫기">닫기</button></nav></header><div class="compare-stage">${result?`<img draggable="false" class="compare-pixels compare-after" src="${esc(url(result.path))}" alt="보정본"><div class="compare-before-clip"><img draggable="false" class="compare-pixels" src="${esc(url(result.beforePath))}" alt="원본"></div>`:''}<span class="compare-label left">원본</span><span class="compare-label right">보정본</span><div class="compare-handle" role="slider" tabindex="0" aria-label="원본 보정본 비교선" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${split}"><span>‹ ›</span></div><div class="compare-message" role="status">${busy?'첫 프레임 보정 중…':cache.has(key())?'':result?'설정 변경됨 · 설정 적용을 눌러 다시 비교':'비교 이미지를 준비하고 있습니다.'}</div></div><aside class="compare-options" ${options?'':'hidden'}>${pipelineMarkup(s,busy)}<div ${s.nrEnabled!==false?'':'hidden'}><label>NR 프리셋<select data-option="profile" ${busy?'disabled':''}>${[...names,'Custom'].map(n=>`<option ${s.profile===n?'selected':''}>${n}</option>`).join('')}</select></label>${s.profile==='Custom'?`<label>Profile<select data-option="baseProfile" ${busy?'disabled':''}>${names.map(n=>`<option ${s.customSettings.baseProfile===n?'selected':''}>${n}</option>`).join('')}</select></label>${fields.map(([k,label,min])=>`<label>${label}<output data-readout="${k}">${Number(s.customSettings[k]).toFixed(2)}</output><input data-option="${k}" type="range" min="${min}" max="3" step=".05" value="${s.customSettings[k]}" ${busy?'disabled':''}></label>`).join('')}`:''}</div>${presetMarkup(presetApi.list(),busy)}<small>Resolution · Full</small><button data-compare="apply" ${busy?'disabled':''}>설정 적용</button></aside><footer>이미지 드래그: 이동 · 가운데 손잡이: 비교선 이동 · 100%: 화면 픽셀 1:1</footer>`;
    bindPresets(modal,{...presetApi,redraw:render});
    bindPipeline(modal,{settings,save:saveSettings,redraw:render,dirty:()=>{modal.querySelector('.compare-message').textContent='설정 변경됨 · 설정 적용을 눌러 다시 비교';}});
    modal.querySelectorAll('[data-compare]').forEach(b=>b.addEventListener('click',()=>action(b.dataset.compare)));
    modal.querySelectorAll('[data-option]').forEach(input=>input.addEventListener(input.type==='range'?'input':'change',()=>{
      const s=settings(),k=input.dataset.option;
      if(k==='profile')s.profile=input.value;
      else if(k==='baseProfile'){const v=input.value==='Faithful'?[.7,.75,.75,-1]:input.value==='Natural'?[1,1,1,-1]:[1.65,1.4,1.5,1];s.customSettings={baseProfile:input.value,...Object.fromEntries(fields.map(([name],i)=>[name,v[i]]))};}
      else s.customSettings[k]=Number(input.value);
      saveSettings(s);
      if(input.type==='range'){modal.querySelector('[data-readout="'+k+'"]').textContent=Number(input.value).toFixed(2);modal.querySelector('.compare-message').textContent='설정 변경됨 · 현재 설정으로 비교를 눌러 적용';}
      else render();
    }));
    const stage=modal.querySelector('.compare-stage'),handle=modal.querySelector('.compare-handle');
    let drag=null;
    stage.addEventListener('pointerdown',e=>{
      if(e.button!==0)return;
      drag={split:!!e.target.closest('.compare-handle'),x:e.clientX,y:e.clientY,start:{...pan}};
      stage.setPointerCapture(e.pointerId);e.preventDefault();
    });
    stage.addEventListener('pointermove',e=>{
      if(!drag)return;
      if(drag.split){const r=stage.getBoundingClientRect();split=Math.max(0,Math.min(100,(e.clientX-r.left)/r.width*100));handle.setAttribute('aria-valuenow',String(Math.round(split)));}
      else pan={x:drag.start.x+e.clientX-drag.x,y:drag.start.y+e.clientY-drag.y};
      applyPosition();
    });
    stage.addEventListener('pointerup',()=>drag=null);stage.addEventListener('pointercancel',()=>drag=null);
    handle.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();split=Math.max(0,Math.min(100,split+(e.key==='ArrowLeft'?-1:1)));handle.setAttribute('aria-valuenow',String(split));applyPosition();}});
    applyPosition();
  }
  async function generate(){
    if(busy||closed)return;
    if(cache.has(key())){render();return;}
    busy=true;jobId='compare-'+Date.now();render();
    const currentKey=key(),file=files[index],s=settings();
    try{
      const result=await invoke('enhance_run',{jobId,...runtime(),sourcePath:file.path,outputDir:'',...s,preview:true,executable:ffmpeg(),batchFolder:null});
      if(closed){if(result.previewToken)await invoke('enhance_release_previews',{tokens:[result.previewToken]});return;}
      cache.set(currentKey,result);
      lastResults.set(file.path,result);
    }catch(error){if(!closed){toast(String(error.message||error));busy=false;render();modal.querySelector('.compare-message').textContent=String(error.message||error);return;}}
    finally{busy=false;jobId=null;}
    if(!closed)render();
  }
  async function action(type){
    if(type==='close'){
      closed=true;modal.close();modal.remove();modal=null;window.removeEventListener('resize',applyPosition);
      if(jobId)try{await invoke('enhance_cancel',{jobId});}catch(e){toast(String(e));}
      const tokens=[...cache.values()].map(r=>r.previewToken).filter(Boolean);
      cache.clear();lastResults.clear();
      if(tokens.length)try{await invoke('enhance_release_previews',{tokens});}catch(e){toast('미리보기 정리 실패: '+String(e));}
      onClose?.();
      return;
    }
    if(type==='options'){options=!options;render();return;}
    if(type==='100'||type==='200'){
      const next=Number(type)/100,ratio=next/zoom,r=modal.querySelector('.compare-stage').getBoundingClientRect();
      pan={x:r.width/2-(r.width/2-pan.x)*ratio,y:r.height/2-(r.height/2-pan.y)*ratio};zoom=next;render();return;
    }
    if(busy)return;
    if(type==='prev'||type==='next'){
      remember();index=Math.max(0,Math.min(files.length-1,index+(type==='prev'?-1:1)));
      const v=views.get(files[index].path);zoom=v?.zoom||1;split=v?.split??50;pan=v?.pan||{x:0,y:0};
      await generate();
    }else if(type==='apply'){await generate();}
  }
  return {
    isRunning:()=>busy,
    open(sources){
      if(busy||modal||!sources.length)return;
      files=sources.map(s=>({...s}));index=0;zoom=1;split=50;pan={x:0,y:0};closed=false;options=true;
      modal=document.createElement('dialog');modal.className='enhance-compare-dialog';modal.setAttribute('aria-label','원본 보정본 비교');
      document.body.append(modal);modal.showModal();
      modal.addEventListener('cancel',e=>{e.preventDefault();action('close');});
      window.addEventListener('resize',applyPosition);generate();
    }
  };
}
