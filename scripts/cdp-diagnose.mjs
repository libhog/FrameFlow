const socket = new WebSocket(process.argv[2]);
let id = 0;
const send = (method, params = {}) => socket.send(JSON.stringify({ id: ++id, method, params }));
const timer = setTimeout(() => process.exit(2), 8000);

socket.addEventListener('open', () => {
  send('Runtime.enable');
  send('Runtime.evaluate', {
    expression: `JSON.stringify({ title: document.title, text: document.body?.innerText?.slice(0, 1000), html: document.querySelector('#app')?.innerHTML?.slice(0, 1000) })`,
    returnByValue: true,
  });
});

socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') console.log('EXCEPTION', JSON.stringify(message.params.exceptionDetails));
  if (message.method === 'Runtime.consoleAPICalled') console.log('CONSOLE', message.params.type, JSON.stringify(message.params.args));
  if (message.id === 2) {
    console.log('PAGE', message.result?.result?.value || JSON.stringify(message));
    setTimeout(() => { clearTimeout(timer); socket.close(); }, 600);
  }
});

socket.addEventListener('close', () => process.exit(0));
