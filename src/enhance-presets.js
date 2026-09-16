import {pipelineSettings} from './enhance-pipeline.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function presetMarkup(presets,disabled=false){
  return `<fieldset class="enhance-saved-presets" ${disabled?'disabled':''}><legend>내 프리셋</legend><select data-preset-load aria-label="저장된 프리셋"><option value="">프리셋 불러오기</option>${presets.map((p,i)=>`<option value="${i}">${esc(p.name)}</option>`).join('')}</select><div><input data-preset-name aria-label="프리셋 이름" placeholder="프리셋 이름" maxlength="80"><button type="button" data-preset-save>프리셋 저장</button></div><small data-preset-message role="status"></small></fieldset>`;
}
export function bindPresets(root,{list,settings,store,apply,redraw}){
  root.querySelectorAll('.enhance-saved-presets').forEach(box=>{
    box.querySelector('[data-preset-save]').addEventListener('click',()=>{
      const name=box.querySelector('[data-preset-name]').value.trim(),message=box.querySelector('[data-preset-message]');
      if(!name){message.textContent='프리셋 이름을 입력하세요.';return;}
      if(list().some(p=>p.name.toLocaleLowerCase()===name.toLocaleLowerCase())){message.textContent='같은 이름이 있습니다. 다른 이름으로 저장하세요.';return;}
      store([...list(),{name,...settings()}]);redraw();
    });
    box.querySelector('[data-preset-load]').addEventListener('change',event=>{
      if(event.target.value==='')return;
      const p=list()[Number(event.target.value)];if(!p)return;
      apply({profile:p.profile,customSettings:{...p.customSettings},...pipelineSettings(p)});redraw();
    });
  });
}
