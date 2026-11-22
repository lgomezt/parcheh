import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { openDocumentStore } from './document-store.mjs';
import { lockProject, prepareProject } from './project-continuity.mjs';
import { createHistory, scanTree } from './project.mjs';
import { projectAsset, projectAssetBytes, projectAssetPolicy } from './project-assets.mjs';
import { invalidDisplayName, normalizeDisplayName } from './display-name.mjs';

const assets = new Map([
  ['/project.js', 'project.js'],
  ['/invite.mjs', 'invite.mjs'],
  ['/display-name.mjs', new URL('./display-name.mjs', import.meta.url)],
  ['/join.js', 'join.js'],
  ['/browser-handoff.mjs', 'browser-handoff.mjs'],
  ['/app-bridge.mjs', 'app-bridge.mjs'],
]);
const downloads = new Set([
  'parcheh-claude-code-macos-arm64.zip',
  'parcheh-codex-macos-arm64.zip',
  'parcheh-claude-desktop-macos-arm64.mcpb',
  'parcheh-antigravity-macos-arm64.zip',
]);
const token = () => randomBytes(32).toString('base64url');
const fail = (status, message) => Object.assign(new Error(message), {status});
const identifier = /^[a-z][a-z0-9-]{0,47}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PEER_TIMEOUT = 3500;
const POINTER_TIMEOUT = 15_000;
const EDITING_TIMEOUT = 5 * 60_000;
const MiB = 1024 * 1024;
const MAX_SUBMIT_BYTES = 184 * MiB;
const MAX_BULK_BYTES = 256 * MiB;
const MAX_BULK_REQUESTS = 8;
const TRANSFER_TIMEOUT = 30_000;
const MAX_INVITE_PREVIEW_BYTES = 512 * 1024;
const MAX_INVITE_PREVIEW_SIDE = 1200;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const actionPayloads = new Map([['point', ['x','y']], ['segment', ['x','y','x2','y2']]]);
const unit = (value) => Number.isFinite(value) && value>=0 && value<=1;

function nameOf(value) {
  const name = normalizeDisplayName(value);
  if (!name) throw fail(400, invalidDisplayName);
  return name;
}
function fields(value, required, optional=[]) {
  if (!value || Array.isArray(value) || typeof value!=='object' ||
      !required.every(key=>Object.hasOwn(value,key)) ||
      Object.keys(value).some(key=>!required.includes(key) && !optional.includes(key))) throw fail(400,'Unexpected message fields.');
}
async function jsonBody(req, limit=4096) {
  if ((req.headers['content-type']||'').split(';')[0].trim()!=='application/json') throw fail(415,'Use application/json.');
  if (Number(req.headers['content-length'])>limit) throw fail(413,'Message exceeds limit.');
  const chunks=[]; let bytes=0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes+=chunk.length;
    if (bytes>limit) throw fail(413,'Message exceeds limit.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400,'Invalid JSON.'); }
}
function sameSecret(a,b) {
  if (typeof a!=='string') return false;
  const given=Buffer.from(a), known=Buffer.from(b);
  return given.length===known.length && timingSafeEqual(given,known);
}
function peerAddress(req) {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/,'');
  return address === '::1' ? '127.0.0.1' : address;
}
function checkPeer(record,req) {
  if (record && record.peer !== peerAddress(req)) throw fail(403,'Tab requires the same device connection.');
}
function loopback(host) {return ['127.0.0.1','localhost','::1','[::1]'].includes(host);}
function snapshotBytes({ rev, oid, tree }) {
  let bytes = Buffer.byteLength(JSON.stringify({ rev, oid, tree: {} }));
  for (const [path, entry] of Object.entries(tree)) {
    bytes += Buffer.byteLength(JSON.stringify(path)) + entry.data.length + 40;
  }
  return bytes;
}
function localAddress(host) {
  return loopback(host)||/^(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$/.test(host);
}
function publicAddress(bind, origin) {
  if (!origin) {
    if (!loopback(bind)) throw Error('Non-loopback hosting needs an explicit PARCHEH_PUBLIC_ORIGIN.');
    return null;
  }
  const url=new URL(origin);
  if (url.username||url.password||url.search||url.hash||url.pathname!=='/' ||
    !(url.protocol==='https:' || (url.protocol==='http:' && (loopback(url.hostname) ||
      process.env.PARCHEH_ALLOW_LAN_HTTP==='1' && localAddress(url.hostname))))) throw Error('Use an HTTPS public origin or opt in to a trusted private LAN.');
  if (url.protocol==='https:' && !loopback(bind)) throw Error('An HTTPS public origin requires a loopback listener behind the TLS proxy.');
  if (!loopback(bind) && process.env.PARCHEH_ALLOW_LAN_HTTP!=='1') throw Error('Listening outside loopback requires explicit private-LAN HTTP opt-in.');
  return url.origin;
}
function shareConfig(tree) {
  const data=tree['parcheh.share.json']?.data;
  if (!data || data.length>16000) return null;
  try {
    const v=JSON.parse(Buffer.from(data,'base64').toString());
    if (typeof v.surface!=='string'||!identifier.test(v.surface)||!Array.isArray(v.actions)||v.actions.length>40||
        v.actions.some(a=>typeof a!=='string'||!identifier.test(a))) return null;
    const actions=[...new Set(v.actions)];
    const payloads=v.payloads===undefined ? {} : v.payloads;
    if (!payloads || typeof payloads!=='object' || Array.isArray(payloads)
        || Object.entries(payloads).some(([action,type])=>!actions.includes(action)||!actionPayloads.has(type))) return null;
    let document;
    if (v.document !== undefined) {
      fields(v.document,['id','actions']);
      const {id,actions:ops}=v.document;
      if (typeof id!=='string' || !identifier.test(id) || !Array.isArray(ops) || !ops.length ||
          ops.length>actions.length || new Set(ops).size!==ops.length ||
          ops.some(op=>!actions.includes(op) || !Object.hasOwn(payloads,op))) return null;
      document={id,actions:ops};
    }
    const invitePreview = typeof v.invitePreview === 'string' ? v.invitePreview : null;
    return {surface:v.surface,actions,payloads,...(document && {document}),...(invitePreview && {invitePreview})};
  } catch { return null; }
}
function invitePreviewBytes(tree, path) {
  if (!path) return null;
  let file;
  try { file = projectAsset(tree, path.split('/').map(encodeURIComponent).join('/')); }
  catch { return null; }
  if (file?.type !== 'image/png' || file.data.length > Math.ceil(MAX_INVITE_PREVIEW_BYTES / 3) * 4) return null;
  const bytes = projectAssetBytes(file);
  if (bytes.length < 45 || bytes.length > MAX_INVITE_PREVIEW_BYTES ||
      !bytes.subarray(0, 8).equals(pngSignature) || bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 && width <= MAX_INVITE_PREVIEW_SIDE && height <= MAX_INVITE_PREVIEW_SIDE ? bytes : null;
}

function validatedPayload(config, actionId, payload) {
  const coordinates=actionPayloads.get(config.payloads[actionId]);
  fields(payload,coordinates);
  if (!coordinates.every(key=>unit(payload[key]))) throw fail(400,'Invalid action coordinates.');
  return Object.fromEntries(coordinates.map(key=>[key,payload[key]]));
}

async function asset(res, file, type, policy) {
  const data=await readFile(new URL(file, new URL('../web/v2/', import.meta.url)));
  res.writeHead(200,{'content-type':type+'; charset=utf-8','content-security-policy':policy});
  res.end(data);
}
const shellPolicy="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self' http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:*; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export async function startHost(options) {
  const lock = options.continuityHome && await lockProject(options.continuityHome,options.source);
  try { return await serveHost(options,lock); }
  catch (error) { lock?.close(); throw error; }
}

async function serveHost({source, storage, continuityHome, continueFromRoom, displayName, bind='127.0.0.1',port=0,publicOrigin,releaseDirectory=process.env.PARCHEH_RELEASE_DIR},lock) {
  if (bind==='[::1]') bind='::1';
  const advertised=publicAddress(bind,publicOrigin);
  const advertiseBoundPort=advertised && new URL(advertised).port==='0';
  if (advertiseBoundPort && !(Number(port)===0 && new URL(advertised).hostname===bind &&
      advertised.startsWith('http:') && localAddress(bind) && !loopback(bind))) {
    throw Error('A dynamic public port requires a matching private LAN interface and an ephemeral listener.');
  }
  if (!Number.isInteger(Number(port))||Number(port)<0||Number(port)>65535) throw Error('Invalid listening port.');
  const hostName=nameOf(displayName);
  const continuation=continuityHome && await prepareProject(continuityHome,source,continueFromRoom);
  const tree=continuation?.tree ?? await scanTree(source);
  await mkdir(dirname(storage),{recursive:true,mode:0o700});
  const history=await createHistory(storage,tree,hostName);
  let current=await history.head(), config=shareConfig(current.tree), currentBytes=snapshotBytes(current);
  let activeBulk=0, activeBytes=0;
  function reserveBulk(bytes, counted=true) {
    if (bytes>MAX_BULK_BYTES) throw fail(413,'Room transfer exceeds the size limit.');
    if ((counted && activeBulk>=MAX_BULK_REQUESTS) || activeBytes+bytes>MAX_BULK_BYTES) {
      throw fail(429,'Room transfers are busy. Retry shortly.');
    }
    if(counted) activeBulk++;
    activeBytes+=bytes;
    return ()=>{
      if(counted) activeBulk--;
      activeBytes-=bytes;
    };
  }
  function holdResponse(res, bytes, counted) {
    const release=reserveBulk(bytes,counted);
    const timer=setTimeout(()=>res.destroy(),TRANSFER_TIMEOUT);
    timer.unref();
    function finish() {
      clearTimeout(timer);
      res.off('finish',finish);
      res.off('close',finish);
      release();
    }
    res.once('finish',finish);
    res.once('close',finish);
  }
  let baseUrl, localBaseUrl, sequence=0;
  const scopeRules=Object.fromEntries(Object.entries(tree).filter(([path])=>path.split('/').at(-1)==='.gitignore'));
  const roomId = randomUUID();
  const inviteLifetime = 8 * 60 * 60 * 1000;
  let inviteSecret = token(), expires = Date.now() + inviteLifetime;
  let documents;
  function documentStore() {
    if (!documents) {
      const directory=resolve(storage)+'.documents';
      mkdirSync(directory,{recursive:true,mode:0o700});
      documents=openDocumentStore(join(directory,roomId+'.sqlite'));
    }
    return documents;
  }
  let assetToken=token();
  const members=[], grants=new Map(), pointers=new Map(), lastSeen=new Map(), actions=[];
  const sharingByMember=new Map(), editing=new Map(), joinReceipts=new Map();
  const handoffs = new Map();
  const handoffWindow = 10 * 60_000;
  function liveHandoff(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{48}$/.test(id)) throw fail(400,'Invalid tab handoff.');
    const now = Date.now();
    for (const [key, record] of handoffs) if (record.expires <= now) handoffs.delete(key);
    return handoffs.get(id);
  }
  const inviteUrl=()=>baseUrl+'/r/'+roomId+'#'+inviteSecret;
  const pointerStreams = new Set();
  function visiblePointers(member, now = Date.now()) {
    if (!sharingByMember.get(member.id).sharing.pointers) return [];
    return [...pointers.values()].filter(p => p.memberId !== member.id && p.surface === appSurface()
      && now-p.at < POINTER_TIMEOUT && now-(lastSeen.get(p.memberId) ?? 0) < PEER_TIMEOUT)
      .map(({at, ...pointer}) => pointer);
  }
  function publishPointers() {
    for (const client of pointerStreams) client.send();
  }
  function streamPointers(member, res) {
    if ([...pointerStreams].filter(client => client.id === member.id).length >= 2)
      throw fail(429,'Too many cursor streams.');
    res.writeHead(200, {'content-type':'application/x-ndjson', 'x-accel-buffering':'no'});
    let blocked = false, last;
    const client = {id:member.id, send(heartbeat = false) {
      if (blocked || res.destroyed) return;
      const snapshot = JSON.stringify({rev:current.rev, pointers:visiblePointers(member)});
      if (last === snapshot && !heartbeat) return;
      last = snapshot;
      // A slow connection retains only its current write. Drain samples fresh room state.
      blocked = !res.write(snapshot + '\n');
    }};
    pointerStreams.add(client);
    res.on('drain', () => { blocked = false; client.send(); });
    res.once('close', () => pointerStreams.delete(client));
    client.send();
  }
  function documentAccess(member,id) {
    if(!sharingByMember.get(member.id).sharing.actions) throw fail(403,'Action sharing is off.');
    if(!config?.document || id!==config.document.id) throw fail(409,'Unknown or changed shared document.');
    return config.document;
  }
  const assetPrefix=()=>'/project-assets/'+roomId+'/'+assetToken+'/'+current.rev+'/';
  const entryUrl=()=>Object.hasOwn(current.tree,'index.html') ? assetPrefix()+'index.html' : null;
  const appSurface=()=> 'app:'+(config?.surface ?? 'page')+':'+current.rev;
  function addMember(name) {
    if (members.length>=4) throw fail(409,'Room is full.');
    let label = name;
    for (let number = 2; members.some(m => m.name.toLowerCase() === label.toLowerCase()); number++) {
      const suffix = ' ' + number;
      label = Array.from(name).slice(0, 40 - suffix.length).join('').trimEnd() + suffix;
    }
    const member={id:randomUUID(),name:label};
    const memberToken=token(), browserToken=token();
    members.push(member); grants.set(memberToken,{member,role:'editor'});
    sharingByMember.set(member.id,{sharing:{pointers:true,actions:true},sharingEpoch:0,sharingActionSeq:sequence});
    grants.set(browserToken,{member,role:'browser'});
    return {roomId,memberToken,browserUrl:baseUrl+'/view/'+roomId+'#'+browserToken};
  }
  function record(member,msg) {
    if (msg?.kind==='hide-pointer' || msg?.kind==='leave') {
      fields(msg,['kind']);
      pointers.delete(member.id);
      if(msg.kind==='leave') lastSeen.delete(member.id);
      publishPointers();
      return;
    }
    if (msg?.surface!==appSurface()) throw fail(400,'Unknown or stale shared surface.');
    const { sharing }=sharingByMember.get(member.id);
    const event={memberId:member.id,name:member.name,surface:msg.surface};
    if (msg.kind==='pointer') {
      fields(msg,['kind','surface','x','y']);
      if (!unit(msg.x) || !unit(msg.y)) throw fail(400,'Invalid pointer.');
      if (!sharing.pointers) throw fail(403,'Pointer sharing is off.');
      lastSeen.set(member.id,Date.now());
      pointers.set(member.id,{...event,colorIndex:members.indexOf(member),x:msg.x,y:msg.y,at:Date.now()});
      publishPointers();
      return;
    }
    if (msg.kind!=='action' || !config?.actions.includes(msg.actionId) || config.document?.actions.includes(msg.actionId)) {
      throw fail(400,'Unknown or undeclared action.');
    }
    const coordinates=Object.hasOwn(config.payloads,msg.actionId) && actionPayloads.get(config.payloads[msg.actionId]);
    fields(msg,coordinates ? ['kind','surface','actionId','payload'] : ['kind','surface','actionId']);
    const payload=coordinates && validatedPayload(config,msg.actionId,msg.payload);
    if (!sharing.actions) throw fail(403,'Action sharing is off.');
    actions.push({...event,kind:'action',actionId:msg.actionId,seq:++sequence,...(payload && {payload})});
    if (actions.length>100) actions.shift();
  }

  function changeSharing(member,msg) {
    fields(msg,['pointers','actions']);
    if(typeof msg.pointers!=='boolean'||typeof msg.actions!=='boolean') throw fail(400,'Sharing settings must be true or false.');
    const prior=sharingByMember.get(member.id);
    const sharing={pointers:msg.pointers,actions:msg.actions};
    sharingByMember.set(member.id,{
      sharing,
      sharingEpoch:prior.sharingEpoch+Number(prior.sharing.actions!==sharing.actions),
      sharingActionSeq:sharing.actions&&!prior.sharing.actions ? sequence : prior.sharingActionSeq,
    });
    if(!sharing.pointers) pointers.delete(member.id);
    publishPointers();
    return {sharing};
  }

  const server=http.createServer({
    headersTimeout:10_000,
    requestTimeout:TRANSFER_TIMEOUT,
    connectionsCheckingInterval:1000,
  },async(req,res)=>{
    res.setHeader('cache-control','no-store'); res.setHeader('referrer-policy','no-referrer');
    res.setHeader('x-content-type-options','nosniff'); res.setHeader('x-frame-options','DENY');
    const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    try {
      const origin=baseUrl && [baseUrl,localBaseUrl].find((address)=>new URL(address).host===req.headers.host);
      if(!origin) throw fail(403,'Unknown host.');
      const url=new URL(req.url,'http://local');
      const path=url.pathname;
      if(req.method==='GET' && path==='/app-bridge.mjs') {
        res.setHeader('access-control-allow-origin','*');
        return await asset(res,assets.get(path),'text/javascript',shellPolicy);
      }
      if(req.method==='GET' && path.startsWith(assetPrefix()) && entryUrl()) {
        const prefix=assetPrefix();
        const file=projectAsset(current.tree,path.slice(prefix.length));
        if(!file) throw fail(404,'Unknown project asset.');
        holdResponse(res,file.data.length,false);
        res.removeHeader('x-frame-options');
        res.writeHead(200,{
          'content-type':file.type,
          'content-security-policy':projectAssetPolicy(origin,prefix),
          'access-control-allow-origin':'*',
        });
        return res.end(projectAssetBytes(file));
      }
      if(req.headers.origin && ![baseUrl,localBaseUrl].includes(req.headers.origin)) throw fail(403,'Unknown origin.');
      if(req.method==='GET') {
        if(path==='/r/'+roomId) return await asset(res,'join.html','text/html',shellPolicy + '; img-src blob:');
        if (path === '/downloads') {
          const files = releaseDirectory ? await Promise.all([...downloads].map(async name => {
            const stat = await lstat(join(releaseDirectory, name)).catch(() => null);
            return stat?.isFile() && stat.size > 0 ? name : null;
          })) : [];
          return json({ files: files.filter(Boolean) });
        }
        if(path.startsWith('/downloads/')) {
          const name=path.slice('/downloads/'.length);
          if(!releaseDirectory || !downloads.has(name)) throw fail(404,'Unknown download.');
          let file;
          try { file=await open(join(releaseDirectory,name),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
          catch { throw fail(404,'Download unavailable.'); }
          try {
            const info=await file.stat();
            if(!info.isFile()) throw fail(404,'Download unavailable.');
            holdResponse(res,info.size);
            res.writeHead(200,{'content-type':'application/octet-stream','content-length':info.size,
              'content-disposition':'attachment; filename="'+name+'"'});
            await pipeline(file.createReadStream({autoClose:false}),res);
          } finally { await file.close(); }
          return;
        }
        if(path==='/view/'+roomId) return await asset(res,'project.html','text/html',shellPolicy);
        if(assets.has(path)) return await asset(res,assets.get(path),'text/javascript',shellPolicy);
      }
      if (req.method === 'GET' && /^\/api\/rooms\/[^/]+\/invite-preview$/.test(path)) {
        const secret = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (path !== '/api/rooms/' + roomId + '/invite-preview' ||
            Date.now() > expires || !sameSecret(secret, inviteSecret)) throw fail(403,'Invalid or expired invitation.');
        const preview = invitePreviewBytes(current.tree, config?.invitePreview);
        if (!preview) return res.writeHead(204).end();
        holdResponse(res, preview.length);
        return res.writeHead(200, {'content-type':'image/png','content-length':preview.length}).end(preview);
      }
      const prefix='/api/rooms/'+roomId+'/';
      if (!path.startsWith(prefix)) throw fail(404,'Unknown room or endpoint.');
      const route=path.slice(prefix.length);
      if (['tab-register','tab-receive','tab-ack'].includes(route) && req.method === 'POST') {
        const msg = await jsonBody(req);
        fields(msg, ['id','receipt'],route === 'tab-register' ? [] : ['claim']);
        if (route !== 'tab-register' && !/^[a-f0-9]{48}$/.test(msg.claim)) throw fail(400,'Invalid tab claim.');
        const secret = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (Date.now() > expires || !sameSecret(secret, inviteSecret)) throw fail(403,'Invalid or expired invitation.');
        if (typeof msg.receipt !== 'string' || !/^[a-f0-9]{64}$/.test(msg.receipt)) throw fail(400,'Invalid receipt.');
        let record = liveHandoff(msg.id);
        checkPeer(record,req);
        if (route === 'tab-register' && !record) {
          if (handoffs.size >= 512) throw fail(429,'Too many waiting tabs.');
          record = {receipt:msg.receipt, peer:peerAddress(req), expires:Date.now()+handoffWindow};
          handoffs.set(msg.id,record);
        }
        if (!record) throw fail(410,'Expired tab handoff.');
        if (!sameSecret(msg.receipt,record.receipt)) throw fail(403,'Invalid receipt.');
        if (record.claim && record.claim !== msg.claim && route !== 'tab-register') throw fail(409,'Tab grant already claimed.');
        if (route === 'tab-ack' && record.claim === msg.claim) {
          record.delivered = true;
          delete record.browserToken;
          delete record.app;
          record.expires = Math.min(expires,Date.now()+handoffWindow);
        }
        if (route === 'tab-receive' && record.member && !record.delivered) {
          if (!record.claim) {
            record.claim = msg.claim;
            record.browserToken = token();
            grants.set(record.browserToken,{member:record.member,role:'browser'});
          }
          if (record.browserToken) return json({browserToken:record.browserToken,...(record.app && {app:record.app})});
        }
        return json({expires:record.expires});
      }
      if(route==='join' && req.method==='POST'){
        const msg=await jsonBody(req); fields(msg,['inviteSecret','displayName'],['requestId','handoff']);
        if (Date.now()>expires||!sameSecret(msg.inviteSecret,inviteSecret)) throw fail(403,'Invalid or expired invitation.');
        const tab = msg.handoff !== undefined ? liveHandoff(msg.handoff) : null;
        checkPeer(tab,req);
        if (msg.handoff !== undefined && !tab) throw fail(410,'Expired tab handoff.');
        if (tab && (!msg.requestId || (tab.requestId && tab.requestId !== msg.requestId) || tab.member)) {
          throw fail(409,'Tab already admitted.');
        }
        const name=nameOf(msg.displayName);
        if(msg.requestId===undefined) return json(addMember(name));
        if(typeof msg.requestId!=='string' || !uuid.test(msg.requestId)) throw fail(400,'Invalid join request ID.');
        const key=msg.requestId.toLowerCase();
        const previous=joinReceipts.get(key);
        if(previous && previous.name!==name) throw fail(409,'This join request already belongs to another name.');
        if(previous) {
          if (tab) tab.requestId = key;
          return json(previous.receipt);
        }
        const receipt=addMember(name);
        if (tab) tab.requestId = key;
        joinReceipts.set(key,{name,receipt});
        return json(receipt);
      }
      const grant=grants.get((req.headers.authorization||'').replace(/^Bearer /,''));
      if (!req.headers.authorization?.startsWith('Bearer ')||!grant) throw fail(403,'Room credential required.');
      const browser=['activity','live','pointers','config','document','invite'].includes(route);
      if (grant.role!==(browser?'browser':'editor')) throw fail(403,'Wrong credential for this operation.');
      if (route === 'tab-confirm' && req.method === 'POST') {
        const msg = await jsonBody(req);
        fields(msg,['id','inviteSecret'],['app']);
        if (Date.now() > expires || !sameSecret(msg.inviteSecret,inviteSecret)) throw fail(403,'Invalid or expired invitation.');
        const record = liveHandoff(msg.id);
        if (!record) throw fail(410,'Expired tab handoff.');
        checkPeer(record,req);
        if (record.requestId && joinReceipts.get(record.requestId)?.receipt.memberToken !== req.headers.authorization.slice(7)) throw fail(409,'Tab already admitted.');
        if (record.member && record.member !== grant.member) throw fail(409,'Tab already admitted.');
        let app;
        if (msg.app !== undefined) {
          try { app = new URL(msg.app); } catch { throw fail(400,'Invalid local preview.'); }
          if (!['http:','https:'].includes(app.protocol) || !['127.0.0.1','localhost'].includes(app.hostname) ||
              app.username || app.password || app.hash || [baseUrl,localBaseUrl].includes(app.origin)) throw fail(400,'Invalid local preview.');
        }
        if (!record.member) Object.assign(record,{member:grant.member,expires,...(app && {app:app.href})});
        return json({confirmed:true});
      }
      if (req.method==='GET') {
        if(route==='snapshot') {
          holdResponse(res,currentBytes);
          return json(current);
        }
        if(route==='scope') return json({tree:scopeRules});
        if(route==='history') return json({entries:await history.log()});
        const settings=sharingByMember.get(grant.member.id);
        if(route==='invite') return json({inviteUrl:inviteUrl()});
        if(route==='document') {
          const doc=documentAccess(grant.member,url.searchParams.get('documentId'));
          const cursor=url.searchParams.get('after');
          if(!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw fail(400,'Invalid document cursor.');
          return json(documentStore().read(doc.id,Number(cursor)));
        }
        if(route==='status') return json({
          roomId,rev:current.rev,oid:current.oid,members,previewAvailable:!!entryUrl(),
          browserMode:entryUrl() ? 'project' : 'source-only',sharing:settings.sharing,
        });
        if(route==='config') return json({rev:current.rev,config,entryUrl:entryUrl(),sharing:settings.sharing});
        if(route==='pointers') return streamPointers(grant.member,res);
        if(route==='live') {
          const now=Date.now();
          const surface=appSurface();
          if(now-(lastSeen.get(grant.member.id)??0)>=PEER_TIMEOUT) pointers.delete(grant.member.id);
          lastSeen.set(grant.member.id,now);
          for(const [id,lease] of editing) if(lease.expires<=now) editing.delete(id);
          const peers=members.filter(m=>m.id!==grant.member.id && now-(lastSeen.get(m.id)??0)<PEER_TIMEOUT);
          return json({
            rev:current.rev,self:grant.member,peers,...settings,actionSeq:sequence,
            documentHead:settings.sharing.actions && config?.document ? documentStore().head(config.document.id) : 0,
            editing:members.filter(m=>editing.has(m.id)).map(m=>({memberId:m.id,name:m.name})),
            actions:settings.sharing.actions ? actions.filter(e=>e.seq>settings.sharingActionSeq && e.surface===surface) : [],
            pointers:visiblePointers(grant.member,now),
          });
        }
      }
      if (req.method === 'POST' && route === 'host-invite') {
        if (grant.member !== members[0]) throw fail(403,'Only the host can renew an invitation.');
        fields(await jsonBody(req),[]);
        if (Date.now() > expires) {
          inviteSecret = token();
          expires = Date.now() + inviteLifetime;
        }
        return json({inviteUrl:inviteUrl()});
      }
      if(req.method==='POST' && route==='close'){
        if(grant.member.id!==members[0].id) throw fail(403,'Only the host can close the room.');
        fields(await jsonBody(req),[]);
        res.once('finish',()=>{setImmediate(close);}); return json({closed:true});
      }
      if(req.method==='POST' && route==='editing'){
        const msg=await jsonBody(req);
        fields(msg,['active','turn']);
        if(typeof msg.active!=='boolean' || typeof msg.turn!=='string' || !uuid.test(msg.turn)) throw fail(400,'Invalid editing lease.');
        if(msg.active) editing.set(grant.member.id,{turn:msg.turn,expires:Date.now()+EDITING_TIMEOUT});
        else if(editing.get(grant.member.id)?.turn===msg.turn) editing.delete(grant.member.id);
        return json({ok:true});
      }
      if(req.method==='POST' && route==='document'){
        const msg=await jsonBody(req);
        fields(msg,['documentId','id','actionId','payload'],['sharingEpoch']);
        if (Object.hasOwn(msg,'sharingEpoch') && msg.sharingEpoch !== sharingByMember.get(grant.member.id).sharingEpoch) {
          throw fail(409,'Drawing sharing changed before this operation was received.');
        }
        const doc=documentAccess(grant.member,msg.documentId);
        if(typeof msg.id!=='string' || !uuid.test(msg.id) || !doc.actions.includes(msg.actionId)) throw fail(400,'Invalid document operation.');
        const payload=validatedPayload(config,msg.actionId,msg.payload);
        return json(documentStore().append(doc.id,grant.member,msg.id.toLowerCase(),msg.actionId,payload));
      }
      if(req.method==='POST' && route==='sharing') return json(changeSharing(grant.member,await jsonBody(req)));
      if(req.method==='POST' && route==='activity'){
        record(grant.member,await jsonBody(req)); return json({ok:true});
      }
      if(req.method==='POST' && route==='submit'){
        const length=Number(req.headers['content-length'] ?? MAX_SUBMIT_BYTES);
        if(length>MAX_SUBMIT_BYTES) throw fail(413,'Message exceeds limit.');
        const release=reserveBulk(length);
        try {
          const msg=await jsonBody(req,MAX_SUBMIT_BYTES); fields(msg,['id','baseRev','changes']);
          if(typeof msg.id!=='string'||msg.id.length>100||!msg.id||!Number.isSafeInteger(msg.baseRev)||msg.baseRev<1) throw fail(400,'Invalid submission.');
          let receipt;
          try { receipt=await history.submit({...msg,author:grant.member.name}); }
          catch { throw fail(409,'Submission rejected. Check the base, changed paths, and submission ID.'); }
          if(receipt.rev>current.rev){
            const head=await history.head();
            if(head.rev>current.rev){
              current=head;config=shareConfig(head.tree);currentBytes=snapshotBytes(head);
              assetToken=token();pointers.clear();actions.length=0;publishPointers();
            }
          }
          return json(receipt);
        } finally {
          release();
        }
      }
      throw fail(404,'Unknown operation.');
    }catch(e){
      if(res.destroyed) return;
      if(res.headersSent) return res.end();
      if(!req.complete) res.shouldKeepAlive=false;
      if(e.status===429) res.setHeader('retry-after','1');
      return json({error:e.status?e.message:'Room operation failed.'},e.status||500);
    }
  });
  server.maxConnections=64;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(port),bind,resolve);});
  if(advertised?.startsWith('https:')&&!loopback(server.address().address)){
    await new Promise(resolve=>server.close(resolve));
    throw Error('An HTTPS public origin requires a loopback listener behind the TLS proxy.');
  }
  const localHost=bind==='0.0.0.0'?'127.0.0.1':(bind==='::'||bind==='::1'?'[::1]':bind);
  localBaseUrl='http://'+localHost+':'+server.address().port;
  baseUrl=advertiseBoundPort ? localBaseUrl : advertised || localBaseUrl;
  try {
    if (config?.document && continuation?.documents) {
      const file = await lstat(continuation.documents).catch(e => { if (e.code !== 'ENOENT') throw e; });
      if (file?.isFile()) documentStore().inherit(continuation.documents, config.document,
        (action,payload)=>validatedPayload(config,action,payload));
    }
    continuation?.publish(roomId,storage);
  } catch (error) {
    documents?.close();
    await new Promise(done=>server.close(done));
    throw error;
  }
  const owner=addMember(hostName);
  const pointerHeartbeat=setInterval(()=>{ for(const client of pointerStreams) client.send(true); },1000);
  pointerHeartbeat.unref();
  const expiryTimer=setTimeout(()=>close(),8*60*60*1000);
  expiryTimer.unref();
  const close=()=>new Promise(resolve=>{
    clearTimeout(expiryTimer);
    clearInterval(pointerHeartbeat);
    server.close(()=>{
      documents?.close();
      documents=undefined;
      if (lock?.isOpen) lock.close();
      resolve();
    });
    server.closeAllConnections();
  });
  return {...owner,baseUrl,localBaseUrl,inviteUrl:inviteUrl(),close};
}
