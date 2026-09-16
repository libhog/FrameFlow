const socket = new WebSocket(process.argv[2]);
const imagePath = process.argv[3] || '';
let id = 0;
const send = (method, params = {}) => socket.send(JSON.stringify({ id: ++id, method, params }));
const timer = setTimeout(() => process.exit(2), 8000);

socket.addEventListener('open', () => send('Runtime.evaluate', {
  expression: `(async () => {
    const saved = await window.__TAURI__.core.invoke('list_projects');
    return JSON.stringify({
    title: document.title,
    scene: document.querySelector('.scene-name-input')?.value || document.querySelector('.scene-title h3')?.textContent,
    direct: (await window.__TAURI__.core.invoke('load_image_data_url', { path: ${JSON.stringify(imagePath)} })).slice(0, 40),
    saved: saved.flatMap(project => (project.scenes || []).map(scene => ({ id: scene.id, firstPath: scene.firstPath, first: scene.first, lastPath: scene.lastPath, last: scene.last }))),
    cards: [...document.querySelectorAll('.frame')].slice(0, 4).map(el => ({
      image: getComputedStyle(el).backgroundImage.startsWith('url("data:image/'),
      length: getComputedStyle(el).backgroundImage.length
    })),
    zones: [...document.querySelectorAll('.flf-drop-zone')].map(el => ({
      image: getComputedStyle(el).backgroundImage.startsWith('url("data:image/'),
      length: getComputedStyle(el).backgroundImage.length
    }))
  });})()`,
  returnByValue: true,
  awaitPromise: true
}));

socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id === 1) {
    console.log(JSON.stringify(message));
    clearTimeout(timer);
    socket.close();
  }
});

socket.addEventListener('close', () => process.exit(0));
