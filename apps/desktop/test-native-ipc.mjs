import assert from 'node:assert/strict';
import vm from 'node:vm';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const scripts = JSON.parse(input);
assert.equal(Object.keys(scripts).length, 5);
let cases = 0;
for (const [os, source] of Object.entries(scripts)) {
  assert(!source.includes('__INVOKE_KEY__'));
  const createRealm = (child, failFetch = false, opaque = false) => {
    const calls = [];
    const callbacks = [];
    const window = {
      origin: opaque ? 'null' : 'http://localhost:41000',
      location: { origin: 'http://localhost:41000' },
      __TAURI_INTERNALS__: {
        convertFileSrc: (command, protocol) => `${protocol}://localhost/${command}`,
        runCallback: (id, data) => callbacks.push({ id, data })
      },
      ipc: { postMessage: (data) => calls.push({ transport: 'message', data: JSON.parse(data) }) }
    };
    window.top = child ? {} : window;
    const context = vm.createContext({
      window,
      Headers,
      console: { warn() {} },
      fetch: async (url, options) => {
        if (failFetch) throw new Error('Controlled custom-protocol refusal');
        calls.push({ transport: 'fetch', url, options });
        return new Response(JSON.stringify({ receipt: 'native-response' }), {
          headers: { 'content-type': 'application/json', 'Tauri-Response': 'ok' }
        });
      }
    });
    vm.runInContext(source, context);
    return { context, window, calls, callbacks };
  };
  const send = async (realm, payload, cmd = 'native_capabilities') => {
    vm.runInContext(
      `window.__TAURI_INTERNALS__.postMessage({cmd:${JSON.stringify(cmd)},callback:7,error:8,payload:${payload},options:{headers:{'x-fixture':'present'}}})`,
      realm.context
    );
    await new Promise((resolve) => setImmediate(resolve));
  };

  // Stronger than platforms that honor main-only injection: execute every initialization in the
  // child realm, matching the Windows and document-start Android behavior of the pinned engine.
  const child = createRealm(true);
  assert.equal(
    child.window.__TAURI_INTERNALS__.postMessage,
    undefined,
    `${os}: child acquired bridge`
  );
  assert.deepEqual(child.calls, []);
  cases += 1;

  const opaque = createRealm(false, false, true);
  assert.equal(
    opaque.window.__TAURI_INTERNALS__.postMessage,
    undefined,
    `${os}: opaque top-level document acquired bridge`
  );
  assert.deepEqual(opaque.calls, []);
  cases += 1;

  const main = createRealm(false);
  const descriptor = Object.getOwnPropertyDescriptor(
    main.window.__TAURI_INTERNALS__,
    'postMessage'
  );
  assert.equal(descriptor.configurable, false);
  assert.equal(descriptor.writable, false);
  assert(!main.window.__TAURI_INTERNALS__.postMessage.toString().includes('fixture-native-key'));
  await send(
    main,
    "{map:new Map([['one',1]]),bytes:new Uint8Array([2,3]),channel:{__TAURI_TO_IPC_KEY__:()=> '__CHANNEL__:9'}}"
  );
  assert.equal(main.calls.length, 1);
  const call = main.calls[0];
  const payload = call.transport === 'fetch' ? JSON.parse(call.options.body) : call.data.payload;
  assert.deepEqual(payload, { map: { one: 1 }, bytes: [2, 3], channel: '__CHANNEL__:9' });
  if (os === 'android') {
    assert.equal(call.transport, 'message');
    assert.equal(call.data.__TAURI_INVOKE_KEY__, 'fixture-native-key');
    assert.equal(call.data.cmd, 'native_capabilities');
  } else {
    assert.equal(call.transport, 'fetch');
    assert.equal(call.options.headers.get('Tauri-Invoke-Key'), 'fixture-native-key');
    assert.equal(call.options.headers.get('x-fixture'), 'present');
    assert.deepEqual(main.callbacks, [{ id: 7, data: { receipt: 'native-response' } }]);
  }
  cases += 1;

  const binary = createRealm(false);
  await send(binary, 'new Uint8Array([4,5,6]).buffer', 'plugin:__TAURI_CHANNEL__|fetch');
  assert.equal(binary.calls.length, 1);
  assert.equal(binary.calls[0].transport, 'fetch');
  assert.equal(binary.calls[0].options.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(Array.from(new Uint8Array(binary.calls[0].options.body)), [4, 5, 6]);
  assert.deepEqual(binary.callbacks, [{ id: 7, data: { receipt: 'native-response' } }]);
  cases += 1;

  const fallback = createRealm(false, true);
  await send(
    fallback,
    "{event:'task-ready',nested:new Uint8Array([8,9])}",
    'plugin:notification|notify'
  );
  assert.equal(fallback.calls.length, 1);
  assert.equal(fallback.calls[0].transport, 'message');
  assert.equal(fallback.calls[0].data.__TAURI_INVOKE_KEY__, 'fixture-native-key');
  assert.equal(fallback.calls[0].data.callback, 7);
  assert.equal(fallback.calls[0].data.error, 8);
  assert.deepEqual(fallback.calls[0].data.payload, { event: 'task-ready', nested: [8, 9] });
  assert.equal(fallback.calls[0].data.options.customProtocolIpcBlocked, os !== 'android');
  cases += 1;
}
console.log(JSON.stringify({ cases, platforms: Object.keys(scripts), subframeMessages: 0 }));
