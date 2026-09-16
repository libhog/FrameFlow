export const colorDefaults={exposure:0,gamma:1,contrast:1,saturation:1};
export const colorFields=[['exposure','노출 (EV)',-3,3],['gamma','감마',.25,3],['contrast','대비',0,3],['saturation','채도',0,3]];
export function pipelineSettings(s){return {nrEnabled:s.nrEnabled!==false,reshadeEnabled:s.reshadeEnabled===true,reshadeSettings:{...colorDefaults,...s.reshadeSettings}};}
export function pipelineMarkup(s,busy=false){
  const mode=s.reshadeEnabled?(s.nrEnabled!==false?'both':'reshade'):'nr';
  return `<fieldset class="enhance-pipeline" ${busy?'disabled':''}><legend>처리 방식</legend><select data-pipeline-mode aria-label="처리 방식"><option value="nr" ${mode==='nr'?'selected':''}>NR만</option><option value="reshade" ${mode==='reshade'?'selected':''}>ReShade만</option><option value="both" ${mode==='both'?'selected':''}>ReShade → NR</option></select>${s.reshadeEnabled?`<div class="enhance-color">${colorFields.map(([k,label,min,max])=>`<label>${label}<output data-color-value="${k}">${Number(s.reshadeSettings[k]).toFixed(2)}</output><input type="range" data-color="${k}" aria-label="${label}" min="${min}" max="${max}" step=".05" value="${s.reshadeSettings[k]}"></label>`).join('')}<small>실제 ReShade FX 색상 보정 · 깊이/Feeder 효과 제외</small></div>`:''}</fieldset>`;
}
export function bindPipeline(root,{settings,save,redraw,dirty=()=>{}}){
  root.querySelector('[data-pipeline-mode]')?.addEventListener('change',e=>{save({nrEnabled:e.target.value!=='reshade',reshadeEnabled:e.target.value!=='nr'});redraw();dirty();});
  root.querySelectorAll('[data-color]').forEach(input=>input.addEventListener('input',()=>{const s=settings();save({reshadeSettings:{...s.reshadeSettings,[input.dataset.color]:Number(input.value)}});root.querySelector(`[data-color-value="${input.dataset.color}"]`).textContent=Number(input.value).toFixed(2);dirty();}));
}
