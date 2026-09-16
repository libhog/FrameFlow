const socket = new WebSocket(process.argv[2]);
let id = 0;
const timer = setTimeout(() => process.exit(2), 30000);
const expression = `(async () => {
  const status = await window.__TAURI__.core.invoke('openart_connect');
  const modelList = await window.__TAURI__.core.invoke('openart_call_tool', { toolName: 'openart_model_list', arguments: {} });
  const parsed = JSON.parse(modelList.content.find(item => item.text)?.text || '{"models":[]}');
  return JSON.stringify({
    connected: status.connected,
    count: status.toolCount,
    videoModels: parsed.models.filter(model => model.modes?.video).map(model => ({ id: model.id, displayName: model.displayName, modes: model.modes.video.map(mode => mode.mode) }))
  });
})()`;

socket.addEventListener('open', () => {
  socket.send(JSON.stringify({ id: ++id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
});
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id !== 1) return;
  console.log(message.result?.result?.value || JSON.stringify(message));
  clearTimeout(timer);
  socket.close();
});
socket.addEventListener('close', () => process.exit(0));
