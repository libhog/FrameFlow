// Same-document history: navigation never reloads the app or restarts jobs.
export function createNavigationHistory({read, restore, render, win=window, doc=document}) {
  const session=`frameflow-${Date.now()}-${Math.random()}`;
  const positions=new Map();
  let current=null, sequence=0, replaying=false, revision=0;
  win.history.scrollRestoration='manual';
  const key=route=>JSON.stringify([route.page,route.projectId,route.editor,
    route.editor?route.cutUid||[route.sceneId,route.cutId]:null]);
  const position=()=>({x:win.scrollX,y:win.scrollY,
    editor:doc.querySelector('.scene-editor-backdrop .inspector')?.scrollTop||0});
  const remember=()=>{if(current)positions.set(current.id,position());};
  function beforeRender(){
    if(replaying)return;
    const route=read();
    if(current&&key(current.route)===key(route)){
      current.route=route;win.history.replaceState({frameflow:current},'');return;
    }
    revision++;
    remember();
    current={session,id:++sequence,route};
    if(sequence===1)win.history.replaceState({frameflow:current},'');
    else win.history.pushState({frameflow:current},'');
  }
  win.addEventListener('popstate',event=>{
    const entry=event.state?.frameflow;
    if(entry?.session!==session)return;
    remember();current=entry;
    const saved=positions.get(entry.id)||{x:0,y:0,editor:0};
    replaying=true;
    try{restore(entry.route);render();}finally{replaying=false;}
    const token=++revision;
    win.requestAnimationFrame(()=>{
      if(token!==revision)return;
      win.scrollTo(saved.x,saved.y);
      const editor=doc.querySelector('.scene-editor-backdrop .inspector');
      if(editor)editor.scrollTop=saved.editor;
    });
  });
  // Cancel browser defaults so one side-button press moves exactly one entry.
  for(const type of ['mousedown','mouseup','auxclick'])doc.addEventListener(type,event=>{
    if(event.button!==3&&event.button!==4)return;
    event.preventDefault();event.stopPropagation();
    if(type==='mouseup')win.history.go(event.button===3?-1:1);
  },true);
  doc.addEventListener('keydown',event=>{
    if(!event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||!['ArrowLeft','ArrowRight'].includes(event.key))return;
    event.preventDefault();
    win.history.go(event.key==='ArrowLeft'?-1:1);
  },true);
  return {beforeRender};
}
