import * as ort from 'onnxruntime-web/wasm';
import { loadTextToSpeech, loadVoiceStyle, writeWavFile } from './vendor/supertonic-helper.js';

ort.env.wasm.numThreads = 1;

let runtimePromise;
let activeContext;
let activeSource;
let activeUrl;

async function loadSarah(onProgress){
  if(!runtimePromise){
    runtimePromise=(async()=>{
      onProgress?.('Supertonic 모델을 준비하고 있습니다…');
      const {textToSpeech}=await loadTextToSpeech('/supertonic/onnx',{
        executionProviders:['wasm'],
        graphOptimizationLevel:'all'
      },(name,current,total)=>onProgress?.(`음성 모델 준비 ${current}/${total} · ${name}`));
      onProgress?.('Sarah 음성을 불러오고 있습니다…');
      const style=await loadVoiceStyle(['/supertonic/voice_styles/F1.json']);
      return {textToSpeech,style};
    })().catch(error=>{runtimePromise=null;throw error;});
  }
  return runtimePromise;
}

export async function playSarahSummary(text,onProgress,onEnded,audioContext,onPrepared){
  stopSarahSummary();
  if(!audioContext)throw new Error('오디오 출력 장치를 활성화하지 못했습니다.');
  activeContext=audioContext;
  if(activeContext.state==='suspended')await activeContext.resume();
  const {textToSpeech,style}=await loadSarah(onProgress);
  onProgress?.('Sarah 음성을 1.2배속으로 생성하고 있습니다…');
  const {wav,duration}=await textToSpeech.call(text,'ko',style,8,1.2,0.24,(step,total)=>onProgress?.(`음성 생성 ${step}/${total}`));
  const wavLength=Math.floor(textToSpeech.sampleRate*duration[0]);
  const samples=Float32Array.from(wav.slice(0,wavLength));
  const peak=samples.reduce((maximum,value)=>Math.max(maximum,Math.abs(value)),0);
  const rms=Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/Math.max(1,samples.length));
  if(samples.length<textToSpeech.sampleRate/4)throw new Error('생성된 음성이 너무 짧습니다.');
  if(peak<0.001||rms<0.0001)throw new Error(`생성된 음성이 무음에 가깝습니다. (peak ${peak.toFixed(5)}, RMS ${rms.toFixed(5)})`);
  const buffer=writeWavFile(samples,textToSpeech.sampleRate);
  activeUrl=URL.createObjectURL(new Blob([buffer],{type:'audio/wav'}));
  onPrepared?.({url:activeUrl,duration:duration[0],peak,rms,sampleRate:textToSpeech.sampleRate});
  const decoded=await activeContext.decodeAudioData(buffer.slice(0));
  activeSource=activeContext.createBufferSource();
  const gain=activeContext.createGain();gain.gain.value=1;
  activeSource.buffer=decoded;activeSource.connect(gain);gain.connect(activeContext.destination);
  activeSource.addEventListener('ended',()=>{activeSource=null;onEnded?.();},{once:true});
  activeSource.start(0);
  onProgress?.(`Sarah · 1.2배속 재생 중 · ${duration[0].toFixed(1)}초`);
  return {url:activeUrl,duration:duration[0],peak,rms,sampleRate:textToSpeech.sampleRate};
}

export function stopSarahSummary(){
  if(activeSource){try{activeSource.stop();}catch{}activeSource.disconnect();activeSource=null;}
  if(activeContext){activeContext.close().catch(()=>{});activeContext=null;}
  if(activeUrl){URL.revokeObjectURL(activeUrl);activeUrl=null;}
}
