const socket = new WebSocket(process.argv[2]);
let id = 0;
const timer = setTimeout(() => process.exit(2), 60000);
const expression = `(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const status = await invoke('openart_connect');
  const tools = await invoke('openart_list_tools');
  const formTool = tools.find(tool => tool.name === 'openart_model_form_get');
  const raw = await invoke('openart_call_tool', { toolName: 'openart_model_list', arguments: {} });
  const text = raw.content?.find(item => item.text)?.text;
  const parsed = text ? JSON.parse(text) : raw.structuredContent?.result || raw;
  const all = parsed.models || [];
  const attempts = [];
  for (const model of ['kling-2-6', 'kling2-6', 'kling-2.6', 'kling2.6', 'kling-26']) {
    try {
      const result = await invoke('openart_call_tool', {
        toolName: 'openart_model_form_get',
        arguments: { model, mode: 'image2video' },
      });
      attempts.push({ model, ok: true, result });
    } catch (error) {
      attempts.push({ model, ok: false, error: String(error) });
    }
  }
  return JSON.stringify({
    connected: status.connected,
    checkedAt: new Date().toISOString(),
    formSchema: formTool?.inputSchema,
    totalModels: all.length,
    klingModels: all.filter(model => /kling/i.test(JSON.stringify(model))).map(model => ({ id: model.id, displayName: model.displayName, modes: model.modes })),
    hasKling26: all.some(model => /kling[^a-z0-9]*2[^a-z0-9]*6/i.test(String(model.id) + ' ' + String(model.displayName))),
    attempts,
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
