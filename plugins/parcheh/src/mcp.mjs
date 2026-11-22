#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { openClient } from './client.mjs';
import packageInfo from '../package.json' with { type: 'json' };

const path = { type: 'string', minLength: 1 };
const name = { type: 'string', minLength: 1 };
const room = { type: 'string', format: 'uuid' };
const browserOptions = {
  pointers:{type:'boolean',description:'Enable only when the user asks to share their cursor.'},
  actions:{type:'boolean',description:'Enable only when the user asks to share project actions or drawings.'},
  openPreview:{type:'boolean',description:'Open the personal project view in the desktop browser. Defaults to first entry.'},
};
const tools = [
  {
    name: 'preview_scope',
    description: 'Inspect a selected project locally before starting a room. Returns eligible paths and exclusion counts without transferring files.',
    properties: { source: path },
    required: process.env.PARCHEH_DESKTOP === '1' ? [] : ['source'],
  },
  {
    name: 'start_room',
    description: 'Share a selected project directory in a new parcheh room. Returns the invitation, browser link and local accepted workspace.',
    properties: { source: path, workspaceParent: path, displayName: name, ...browserOptions },
    required: process.env.PARCHEH_DESKTOP === '1' ? [] : ['source'],
  },
  {
    name: 'join_room',
    description: 'Join a parcheh room from a participant invitation and download its accepted project to a local workspace.',
    properties: { inviteUrl: { type: 'string', format: 'uri' }, workspaceParent: path, displayName: name, ...browserOptions },
    required: ['inviteUrl'],
  },
  {
    name: 'begin_turn',
    description: 'Create or reopen an isolated draft from accepted room source. Use list_draft and the scoped draft file tools in this chat, or native file tools if this app already has access to the returned workspace.',
    properties: { room },
    required: ['room'],
  },
  ...[
    ['list_draft', 'List eligible files in the current room draft.', {}, []],
    ['read_draft_file', 'Read a UTF-8 text file in the open draft using its relative path.', {path}, ['path']],
    ['write_draft_file', 'Write a UTF-8 text file (up to 512 KiB) in the open draft.', {path,content:{type:'string',maxLength:524288}}, ['path','content']],
    ['delete_draft_file', 'Remove a shared file from the open draft using its relative path.', {path}, ['path']],
  ].map(([name,description,properties,required]) => ({name,description,properties:{room,...properties},required:['room',...required]})),
  {
    name: 'finish_turn',
    description: 'Seal and submit the local draft changes. Retry this tool if the host has not acknowledged the sealed submission.',
    properties: { room },
    required: ['room'],
  },
  {
    name: 'configure_browser',
    description: 'Set this participant’s pointer or named action sharing when they request it. Both are off by default. Optionally select their local dev server or use appUrl="project" to return to the accepted static project.',
    properties: { room, pointers: { type: 'boolean' }, actions: { type: 'boolean' }, appUrl: path },
    required: ['room'],
  },
  {
    name: 'room_status',
    description: 'Read room members and the current accepted revision. Refresh the accepted local workspace when no turn is active.',
    properties: { room },
    required: ['room'],
  },
  {
    name: 'room_history',
    description: 'Read the attributed history of accepted room revisions.',
    properties: { room },
    required: ['room'],
  },
  {
    name: 'end_room',
    description: 'End the shared room if you are its host. Preserve the local source copies and unfinished draft.',
    properties: { room },
    required: ['room'],
  },
];
const toolList = tools.map(({ name, description, properties, required }) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
}));
const methods = new Map(tools.map((tool) => [tool.name, tool]));
const protocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const success = (id, result) => ({ jsonrpc: '2.0', id, result });

function checkedArguments(tool, args) {
  if (!isObject(args)) throw new Error('Tool arguments must be an object.');
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(tool.properties, key)) throw new Error('Unknown tool argument.');
    if (tool.properties[key].type === 'boolean') {
      if (typeof args[key] !== 'boolean') throw new Error(key + ' must be true or false.');
      continue;
    }
    if (key === 'content') {
      if (typeof args[key] !== 'string' || Buffer.byteLength(args[key]) > 524288) throw Error('Use native file tools for files over 512 KiB.');
      continue;
    }
    if (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 8192) {
      throw new Error(key + ' must be a nonempty string.');
    }
  }
  for (const key of tool.required) {
    if (!Object.hasOwn(args, key)) throw new Error(key + ' is required.');
  }
  return args;
}

let client;
let hasRoots = false;
let nextId = 0;
const rootWaiters = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
async function getRoots() {
  if (!hasRoots) return [];
  const id = 'parcheh:roots:' + ++nextId;
  const reply = await new Promise(resolve => {
    const timer = setTimeout(() => { rootWaiters.delete(id); resolve(null); }, 1800);
    rootWaiters.set(id, result => { clearTimeout(timer); resolve(result); });
    send({jsonrpc:'2.0',id,method:'roots/list',params:{}});
  });
  return (Array.isArray(reply?.roots) ? reply.roots : []).slice(0,64).flatMap(entry => {
    try { return [fileURLToPath(entry.uri)]; } catch { return []; }
  });
}
async function handle(message) {
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return failure(null, -32600, 'Invalid request.');
  }
  if (!Object.hasOwn(message, 'id')) return;
  const { id, method, params } = message;
  if (typeof id !== 'string' && !Number.isFinite(id)) return failure(null, -32600, 'Invalid request ID.');
  switch (method) {
    case 'initialize':
      if (!isObject(params) || typeof params.protocolVersion !== 'string') return failure(id, -32602, 'Invalid initialize parameters.');
      hasRoots = isObject(params.capabilities?.roots);
      return success(id, {
        protocolVersion: protocolVersions.includes(params.protocolVersion) ? params.protocolVersion : protocolVersions[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'parcheh', version: packageInfo.version },
      });
    case 'ping':
      return success(id, {});
    case 'tools/list':
      return success(id, { tools: toolList });
    case 'tools/call': {
      if (!isObject(params) || typeof params.name !== 'string' || !methods.has(params.name)) {
        return failure(id, -32602, 'Unknown parcheh tool or invalid tool call.');
      }
      try {
        const args = checkedArguments(methods.get(params.name), params.arguments ?? {});
        client ??= await openClient(process.env, {getRoots});
        const token = params._meta?.progressToken;
        function progress(value, message) {
          if (typeof token === 'string' || Number.isFinite(token)) {
            send({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:token,progress:value,total:100,message}});
          }
        }
        const result = await client[params.name](args, progress);
        return success(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
      } catch (error) {
        return success(id, { isError: true, content: [{ type: 'text', text: error.message || 'parcheh tool failed.' }] });
      }
    }
    default:
      return failure(id, -32601, 'Method not found.');
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdout.on('error', () => lines.close());
let queued = Promise.resolve();
for await (const line of lines) {
  if (!line.trim()) continue;
  let message;
  try {
    if (Buffer.byteLength(line) > 3_200_000) { send(failure(null, -32600, 'Request is too large.')); continue; }
    message = JSON.parse(line);
  } catch { send(failure(null, -32700, 'Parse error.')); continue; }
  if (isObject(message) && message.jsonrpc === '2.0' && !message.method && rootWaiters.has(message.id)) {
    const resolve = rootWaiters.get(message.id);
    rootWaiters.delete(message.id);
    resolve(message.result);
    continue;
  }
  queued = queued.then(async () => {
    const reply = await handle(message);
    if (reply) send(reply);
  }).catch(() => send(failure(message?.id ?? null, -32603, 'Internal error.')));
}
await queued;
await client?.close();
