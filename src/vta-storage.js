const unsafeFilename=/[<>:"/\\|?*\u0000-\u001f]+/g;

export function safeVideoAudioStem(filename='video'){
  const raw=String(filename||'video').replace(/\.[^.]+$/,'').replace(unsafeFilename,'_').replace(/[. ]+$/g,'').trim();
  return (raw||'video').slice(0,120);
}

export function buildVideoAudioProjectPaths({project,sourceName,mode='0.05mp',stamp}){
  const projectPath=String(project?.projectPath||'').trim();
  if(!projectPath)throw new Error('현재 프로젝트의 저장 폴더가 없습니다. 프로젝트 정보를 먼저 확인해 주세요.');
  const separator=projectPath.includes('\\')?'\\':'/';
  const join=(...parts)=>parts.map((part,index)=>index===0?String(part).replace(/[\\/]$/,''):String(part).replace(/^[\\/]+|[\\/]+$/g,'')).join(separator);
  const stem=safeVideoAudioStem(sourceName),safeMode=String(mode||'0.05mp').replace(/[^a-z0-9.-]+/gi,'_');
  const safeStamp=String(stamp||new Date().toISOString().replace(/[:.]/g,'-')).replace(/[<>:"/\\|?*\u0000-\u001f]+/g,'-');
  const outputDir=join(projectPath,'audio','video-to-audio',stem,safeStamp);
  return{
    storageVersion:2,
    projectId:project?.id||null,
    projectName:project?.name||'프로젝트',
    projectPath,
    outputDir,
    referencePath:join(outputDir,`${stem}-${safeMode}-reference.mp4`),
    audioPath:join(outputDir,`${stem}-${safeMode}.mp3`),
    videoPath:join(outputDir,`${stem}-${safeMode}-CRF15.mp4`),
  };
}
