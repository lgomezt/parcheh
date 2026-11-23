import http from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { openDocumentStore } from './document-store.mjs';
import { openCoordinator } from './coordinator.mjs';
import { lockProject, prepareProject } from './project-continuity.mjs';
import { createHistory, scanTree } from './project.mjs';
import { projectAsset, projectAssetBytes, projectAssetPolicy } from './project-assets.mjs';
import { invalidDisplayName, normalizeDisplayName } from './display-name.mjs';
import {
  verifyAuthToken,
  normalizeEmail,
  issueProvisionalEmailToken,
  issueVerifyChallengeToken,
  issueDeviceCertificate,
  verifyDeviceSignature,
} from './auth-tokens.mjs';

const assets = new Map([
  ['/project.js', 'project.js'],
  ['/invite.mjs', 'invite.mjs'],
  ['/display-name.mjs', new URL('./display-name.mjs', import.meta.url)],
  ['/join.js', 'join.js'],
  ['/browser-handoff.mjs', 'browser-handoff.mjs'],
  ['/app-bridge.mjs', 'app-bridge.mjs'],
]);
const inviteBrandAssets = new Map([
  ['/invite-brand/mark.png', 'image/png'],
  ['/invite-brand/paint.jpg', 'image/jpeg'],
  ['/invite-brand/instrument-sans.ttf', 'font/ttf'],
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
async function rawBody(req, limit = 2048) {
  if (Number(req.headers['content-length']) > limit) throw fail(413, 'Message exceeds limit.');
  const chunks = []; let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) throw fail(413, 'Message exceeds limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
  res.writeHead(200,{'content-type':type.startsWith('text/') ? type+'; charset=utf-8' : type,'content-security-policy':policy});
  res.end(data);
}
const shellPolicy="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self' http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:*; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export async function startHost(options) {
  const lock = options.continuityHome && await lockProject(options.continuityHome,options.source);
  let continuation;
  try {
    if (lock) continuation=await prepareProject(options.continuityHome,options.source,options.continueFromRoom);
    return await serveHost(options,lock,continuation);
  } catch (error) {
    try { await continuation?.discard(); } finally { lock?.close(); }
    throw error;
  }
}

async function serveHost(options, lock, continuation) {
  let {
    source, storage, displayName, deferPublish = false, bind = '127.0.0.1', port = 0, publicOrigin,
    maxMembers = Number(process.env.PARCHEH_MAX_MEMBERS) || 64, relayOrigin, deviceIdentity, continuityHome,
    allowGuestInvite,
    sharingMode = 'instant',
    allowedEmails = null,
    allowedDomain = null,
    trustedAuthPublicKeys = [],
    onSendEmail = null,
  } = options;

  if (sharingMode !== undefined && !['instant', 'email', 'restricted'].includes(sharingMode)) {
    throw new Error("sharingMode must be 'instant', 'email', or 'restricted'.");
  }
  if (sharingMode === 'restricted' && !allowedEmails && !allowedDomain) {
    throw new Error('Restricted rooms require allowedEmails or allowedDomain.');
  }
  if (allowGuestInvite === undefined) {
    allowGuestInvite = sharingMode !== 'restricted';
  }

  const { loadOrCreateDeviceIdentity } = await import('./device-identity.mjs');
  const hostIdentity = deviceIdentity || await loadOrCreateDeviceIdentity(continuityHome || dirname(storage));

  const effectiveRelayOrigin = relayOrigin || (process.env.PARCHEH_RELAY_ORIGIN || '').trim() || null;
  if (effectiveRelayOrigin) {
    bind = '127.0.0.1';
  }
  if (bind === '[::1]') bind = '::1';
  const advertised=publicAddress(bind,publicOrigin);
  const advertiseBoundPort=advertised && new URL(advertised).port==='0';
  if (advertiseBoundPort && !(Number(port)===0 && new URL(advertised).hostname===bind &&
      advertised.startsWith('http:') && localAddress(bind) && !loopback(bind))) {
    throw Error('A dynamic public port requires a matching private LAN interface and an ephemeral listener.');
  }
  if (!Number.isInteger(Number(port))||Number(port)<0||Number(port)>65535) throw Error('Invalid listening port.');
  const hostName=nameOf(displayName);
  const tree=continuation?.tree ?? await scanTree(source);
  await mkdir(dirname(storage),{recursive:true,mode:0o700});
  const history=continuation ? await continuation.history(hostName) : await createHistory(storage,tree,hostName);
  const gitStorage = history.storage || storage;
  let current=await history.head(), config=shareConfig(current.tree), currentBytes=snapshotBytes(current);
  const scopeRev=current.rev, floor=continuation?.floor ?? 1;
  const scopeBaseline=floor>1 ? await history.head(floor) : null;
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
  let roomId = randomUUID();
  const inviteLifetime = 8 * 60 * 60 * 1000;
  let inviteSecret = token(), expires = Date.now() + inviteLifetime;

  let coordinator;
  const roomReconnectSecret = randomBytes(32);
  const relayBridgeSecret = randomBytes(32).toString('base64url');
  const memberReconnectSecret = (memberId) =>
    createHmac('sha256', roomReconnectSecret).update(String(memberId)).digest('base64url');
  let relayTransport = null;
  let relayIssuerPubKeyHex = null;
  if (effectiveRelayOrigin) {
    const { attachHostRelay } = await import('./relay-transport.mjs');
    relayTransport = await attachHostRelay({
      relayOrigin: effectiveRelayOrigin,
      deviceIdentity: hostIdentity,
      getInviteSecret: () => (!coordinator || coordinator.isInviteRevoked() || Date.now() > expires) ? null : inviteSecret,
      getReconnectSecret: (memberId) => {
        if (!coordinator || !coordinator.activeMembers().some(m => m.id === memberId)) return null;
        return memberReconnectSecret(memberId);
      },
      relayBridgeSecret,
      localPort: () => server.address().port,
      storage: gitStorage,
    });
    relayTransport.storage = gitStorage;
    roomId = relayTransport.roomId;
    expires = relayTransport.expiresAt;

    try {
      const pubKeyRes = await fetch(effectiveRelayOrigin + '/v1/auth/public-key', {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      if (pubKeyRes && pubKeyRes.ok) {
        const pkData = await pubKeyRes.json().catch(() => null);
        if (pkData?.issuerPublicKeyHex) relayIssuerPubKeyHex = pkData.issuerPublicKeyHex;
      }
    } catch {}
  }

  coordinator = openCoordinator(resolve(storage) + '.coordinator.sqlite', {
    roomId,
    maxMembers,
    inviteSecret,
    inviteExpires: expires,
    allowGuestInvite,
    sharingMode,
    allowedEmails,
    allowedDomain,
  });

  const syncRelayPolicy = async () => {
    if (relayTransport?.uploadPolicy) {
      await relayTransport.uploadPolicy({
        sharingMode: coordinator.sharingMode(),
        ...(coordinator.domainHint() && { domainHint: coordinator.domainHint() }),
      }).catch(() => {});
    }
  };
  await syncRelayPolicy();

  const envTrustedKeys = (process.env.PARCHEH_TRUSTED_AUTH_PUBKEY || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const effectiveTrustedPublicKeys = [
    relayIssuerPubKeyHex,
    hostIdentity.publicKeyHex,
    ...envTrustedKeys,
    ...(trustedAuthPublicKeys || []),
  ].filter(Boolean);
  function documentScope(config) {
    const doc=config?.document;
    return doc ? JSON.stringify([doc.id,...[...doc.actions].sort().map(id=>[id,config.payloads[id]])]) : '';
  }
  let documents, scope=documentScope(config), projectedScope=scope;
  function refreshDocuments() {
    if (!documents) return;
    if (scope===projectedScope) return;
    documents.project(config?.document,(action,payload)=>validatedPayload(config,action,payload));
    projectedScope=scope;
  }
  function documentStore() {
    if (!documents) {
      const directory=resolve(storage)+'.documents';
      mkdirSync(directory,{recursive:true,mode:0o700});
      documents=openDocumentStore(join(directory,roomId+'.sqlite'));
    }
    refreshDocuments();
    return documents;
  }
  let assetToken=token();
  const pointers=new Map(), lastSeen=new Map(), actions=[];
  const sharingByMember=new Map(), editing=new Map(), joinReceipts=new Map();
  const handoffs = new Map();
  const inviteUrl = () => (effectiveRelayOrigin ? effectiveRelayOrigin : baseUrl) + '/r/' + roomId + '#' + inviteSecret;
  async function syncPoster() {
    if (!relayTransport) return;
    const preview = invitePreviewBytes(current.tree, config?.invitePreview);
    if (preview) {
      await relayTransport.uploadPoster(preview, inviteSecret).catch(() => {});
    }
  }
  const pointerStreams = new Set();
  function visiblePointers(member, now = Date.now()) {
    if (!sharingByMember.get(member.id)?.sharing.pointers) return [];
    return [...pointers.values()].filter(p => p.memberId !== member.id && p.surface === appSurface()
      && now-p.at < POINTER_TIMEOUT && now-(lastSeen.get(p.memberId) ?? 0) < PEER_TIMEOUT)
      .map(({at, ...pointer}) => pointer);
  }
  function publishPointers() {
    for (const client of pointerStreams) client.send();
  }
  function cleanupMemberPresence(memberId) {
    pointers.delete(memberId);
    lastSeen.delete(memberId);
    editing.delete(memberId);
    for (const client of pointerStreams) {
      if (client.id === memberId) {
        pointerStreams.delete(client);
        client.close();
      }
    }
    publishPointers();
  }
  function streamPointers(member, res) {
    if ([...pointerStreams].filter(client => client.id === member.id).length >= 2)
      throw fail(429,'Too many cursor streams.');
    res.writeHead(200, {'content-type':'application/x-ndjson', 'x-accel-buffering':'no'});
    let blocked = false, last;
    const client = {id:member.id, close() { if (!res.destroyed) res.end(); }, send(heartbeat = false) {
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
  function addMember(name, { email = null, emailVerified = false, deviceKey = null } = {}) {
    let enrolled;
    try {
      enrolled = coordinator.addMember({ name, email, emailVerified, deviceKey });
    } catch (err) {
      if (err.status) throw fail(err.status, err.message);
      throw err;
    }
    sharingByMember.set(enrolled.member.id, { sharing: { pointers: true, actions: true }, sharingEpoch: 0, sharingActionSeq: sequence });
    return {
      roomId,
      memberId: enrolled.member.id,
      name: enrolled.member.name,
      memberToken: enrolled.memberToken,
      ...(effectiveRelayOrigin && { reconnectSecret: memberReconnectSecret(enrolled.member.id) }),
      browserUrl: baseUrl + '/view/' + roomId + '#' + enrolled.browserToken,
      ...(email && { email, emailVerified: Boolean(emailVerified), emailStatus: emailVerified ? 'verified' : 'unverified' }),
    };
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
      pointers.set(member.id,{...event,colorIndex:member.colorIndex??0,x:msg.x,y:msg.y,at:Date.now()});
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

  let published=false, closing=false, setupTimer;
  function activate() {
    if (closing) throw fail(409,'Room setup has ended.');
    if (published) return;
    continuation?.publish(roomId,storage);
    published=true;
    clearTimeout(setupTimer);
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
      const isTopLevelShellNavigation = req.method === 'GET' &&
        (path === '/r/' + roomId || path === '/view/' + roomId) &&
        req.headers['sec-fetch-mode'] === 'navigate' &&
        req.headers['sec-fetch-dest'] === 'document';
      if (req.headers['sec-fetch-site'] === 'cross-site' && !isTopLevelShellNavigation) {
        throw fail(403, 'Cross-site request blocked.');
      }
      if(req.headers.origin && ![baseUrl,localBaseUrl].includes(req.headers.origin)) throw fail(403,'Unknown origin.');
      if(req.method==='GET') {
        if(path==='/r/'+roomId) return await asset(res,'join.html','text/html',shellPolicy + "; img-src 'self' blob:; font-src 'self'");
        if(inviteBrandAssets.has(path)) return await asset(res,path.slice(1),inviteBrandAssets.get(path),shellPolicy);
        if(path==='/view/'+roomId) return await asset(res,'project.html','text/html',shellPolicy);
        if(assets.has(path)) return await asset(res,assets.get(path),'text/javascript',shellPolicy);
      }
      if (req.method === 'GET' && /^\/api\/rooms\/[^/]+\/invite-preview$/.test(path)) {
        const secret = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (path !== '/api/rooms/' + roomId + '/invite-preview' ||
            !coordinator.checkInvite(secret)) throw fail(403,'Invalid or expired invitation.');
        const preview = invitePreviewBytes(current.tree, config?.invitePreview);
        if (!preview) return res.writeHead(204).end();
        holdResponse(res, preview.length);
        return res.writeHead(200, {'content-type':'image/png','content-length':preview.length}).end(preview);
      }
      if (req.method === 'GET' && path === '/api/auth/public-key') {
        return json({ issuerPublicKeyHex: hostIdentity.publicKeyHex });
      }
      if (req.method === 'POST' && path === '/api/auth/provisional') {
        const body = await jsonBody(req);
        const email = normalizeEmail(body?.email);
        if (!email) throw fail(400, 'Valid email address is required.');
        const claimToken = issueProvisionalEmailToken({ email }, hostIdentity.privateKey);
        return json({ ok: true, claimToken, email });
      }
      if (req.method === 'POST' && path === '/api/auth/request-verify') {
        const body = await jsonBody(req);
        const email = normalizeEmail(body?.email);
        const devicePublicKeyHex = String(body?.devicePublicKeyHex || '').trim().toLowerCase();
        if (!email) throw fail(400, 'Valid email address is required.');
        if (!/^[0-9a-f]{64}$/.test(devicePublicKeyHex)) throw fail(400, 'Valid devicePublicKeyHex is required.');
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const challengeToken = issueVerifyChallengeToken({ email, devicePublicKeyHex, code }, hostIdentity.privateKey);
        const expiresAt = Date.now() + 15 * 60_000;
        if (typeof onSendEmail === 'function') {
          await onSendEmail({ email, code, challengeToken });
        } else if (process.env.PARCHEH_RESEND_API_KEY) {
          try {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                authorization: `Bearer ${process.env.PARCHEH_RESEND_API_KEY}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                from: 'parcheh <verify@parcheh.augi.ca>',
                to: [email],
                subject: `Your parcheh verification code: ${code}`,
                text: `Your 6-digit verification code is: ${code}\n\nThis code will expire in 15 minutes.`,
              }),
            });
          } catch {
            throw fail(502, 'Email verification delivery failed.');
          }
        } else {
          throw fail(503, 'Email verification delivery is not configured.');
        }
        return json({ ok: true, challengeToken, expiresAt });
      }
      if (req.method === 'POST' && path === '/api/auth/complete-verify') {
        const body = await jsonBody(req);
        const email = normalizeEmail(body?.email);
        const code = String(body?.code || '').trim();
        const challengeToken = String(body?.challengeToken || '').trim();
        const devicePublicKeyHex = String(body?.devicePublicKeyHex || '').trim().toLowerCase();
        const proofSigHex = String(body?.proofSigHex || '').trim();
        if (!email || !code || !challengeToken || !devicePublicKeyHex || !proofSigHex) {
          throw fail(400, 'email, code, challengeToken, devicePublicKeyHex, and proofSigHex are required.');
        }
        const verification = verifyAuthToken(challengeToken, [hostIdentity.publicKeyHex]);
        if (!verification.valid || verification.payload?.kind !== 'verify_challenge') {
          throw fail(400, verification.reason || 'Invalid challenge token.');
        }
        const challenge = verification.payload;
        if (challenge.email !== email || challenge.devicePublicKeyHex !== devicePublicKeyHex) {
          throw fail(400, 'Challenge parameters mismatch.');
        }
        const codeHash = createHash('sha256').update(code).digest('hex');
        if (codeHash !== challenge.codeHash) {
          throw fail(400, 'Invalid verification code.');
        }
        const proofPayload = Buffer.from('parcheh-verify:' + email + ':' + code + ':' + challengeToken, 'utf8');
        let sigValid = false;
        try {
          sigValid = verifyDeviceSignature(devicePublicKeyHex, proofPayload, proofSigHex);
        } catch {}
        if (!sigValid) {
          throw fail(403, 'Invalid device proof signature.');
        }
        const deviceCertificate = issueDeviceCertificate({ email, devicePublicKeyHex }, hostIdentity.privateKey);
        return json({ ok: true, deviceCertificate, email, devicePublicKeyHex });
      }
      const prefix='/api/rooms/'+roomId+'/';
      if (!path.startsWith(prefix)) throw fail(404,'Unknown room or endpoint.');
      const route=path.slice(prefix.length);
      if (req.method === 'GET' && route === 'policy') {
        return json({ sharingMode: coordinator.sharingMode(), domainHint: coordinator.domainHint() });
      }
      if (!published && !['status','scope','snapshot','sharing','close','host-ready','policy'].includes(route)) {
        throw fail(503,'The host workspace is still opening.');
      }
      const handoffMatch = /^handoffs\/([0-9a-f]{64})$/.exec(route);
      if (handoffMatch) {
        const handoffId = handoffMatch[1];
        if (req.method === 'GET') {
          const secret = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
          if (!coordinator.checkInvite(secret)) throw fail(403, 'Invalid or expired invitation.');
          const item = handoffs.get(handoffId);
          if (!item || Date.now() > item.expiresAt) {
            if (item) handoffs.delete(handoffId);
            return res.writeHead(204).end();
          }
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': item.data.length,
          });
          return res.end(item.data);
        }
        if (req.method === 'PUT') {
          const rawToken = (req.headers.authorization || '').replace(/^Bearer /, '');
          const grant = coordinator.verifyGrant(rawToken);
          if (!req.headers.authorization?.startsWith('Bearer ') || !grant) throw fail(403, 'Room credential required.');
          if (grant.revoked) throw fail(403, 'Participant has been revoked or left the room.');
          if (grant.role !== 'editor') throw fail(403, 'Wrong credential for this operation.');
          if (coordinator.isInviteRevoked() || Date.now() > expires) throw fail(403, 'Invitation has been revoked or expired.');
          const bytes = await rawBody(req, 2048);
          if (bytes.length === 0) throw fail(400, 'Empty handoff body.');
          const now = Date.now();
          for (const [id, item] of handoffs) {
            if (now > item.expiresAt) handoffs.delete(id);
          }
          if (handoffs.size >= 256) {
            handoffs.delete(handoffs.keys().next().value);
          }
          handoffs.set(handoffId, { data: bytes, expiresAt: now + 10 * 60_000 });
          return res.writeHead(204).end();
        }
        throw fail(405, 'Method not allowed.');
      }
      if(route==='join' && req.method==='POST'){
        const msg=await jsonBody(req);
        fields(msg,['inviteSecret','displayName'],['requestId','handoff','claimToken','deviceCertificate','guestEdPubHex','joinProofNonce','joinProofSigHex','email']);
        if (!coordinator.checkInvite(msg.inviteSecret)) throw fail(403,'Invalid or expired invitation.');

        let authenticatedGuestEdPubHex = null;
        if (relayTransport && sameSecret(req.headers['x-parcheh-relay-bridge'], relayBridgeSecret)) {
          const peerHeader = req.headers['x-parcheh-peer-ed25519'];
          if (typeof peerHeader === 'string' && /^[0-9a-f]{64}$/i.test(peerHeader)) {
            authenticatedGuestEdPubHex = peerHeader.toLowerCase();
          }
        }
        if (!authenticatedGuestEdPubHex && msg.guestEdPubHex && msg.joinProofNonce && msg.joinProofSigHex) {
          const signBuf = Buffer.from(`${roomId}:${msg.requestId || ''}:${msg.joinProofNonce}`, 'utf8');
          try {
            if (verifyDeviceSignature(msg.guestEdPubHex, signBuf, msg.joinProofSigHex)) {
              authenticatedGuestEdPubHex = String(msg.guestEdPubHex).toLowerCase();
            }
          } catch {}
        }

        let verifiedCert = null;
        let provisionalClaim = null;
        if (msg.deviceCertificate) {
          const res = verifyAuthToken(msg.deviceCertificate, effectiveTrustedPublicKeys);
          if (
            res.valid &&
            res.payload?.kind === 'device_email_cert' &&
            res.payload.verified === true &&
            authenticatedGuestEdPubHex &&
            res.payload.devicePublicKeyHex?.toLowerCase() === authenticatedGuestEdPubHex
          ) {
            verifiedCert = res.payload;
          }
        }
        if (msg.claimToken) {
          const res = verifyAuthToken(msg.claimToken, effectiveTrustedPublicKeys);
          if (res.valid && res.payload?.kind === 'provisional_email') {
            provisionalClaim = res.payload;
          }
        }

        const mode = coordinator.sharingMode();
        let memberEmail = null;
        let memberEmailVerified = false;

        if (mode === 'instant') {
          if (verifiedCert) {
            memberEmail = verifiedCert.email;
            memberEmailVerified = true;
          } else if (provisionalClaim) {
            memberEmail = provisionalClaim.email;
            memberEmailVerified = false;
          }
        } else if (mode === 'email') {
          if (verifiedCert) {
            memberEmail = verifiedCert.email;
            memberEmailVerified = true;
          } else if (provisionalClaim) {
            memberEmail = provisionalClaim.email;
            memberEmailVerified = false;
          } else {
            throw fail(403, 'Enter an email address to join this room.');
          }
        } else if (mode === 'restricted') {
          if (!verifiedCert) {
            throw fail(403, 'Verified email certificate required for this restricted room.');
          }
          if (!authenticatedGuestEdPubHex || verifiedCert.devicePublicKeyHex.toLowerCase() !== authenticatedGuestEdPubHex.toLowerCase()) {
            throw fail(403, 'Verified email certificate required for this restricted room.');
          }
          if (!coordinator.isEmailAllowed(verifiedCert.email)) {
            throw fail(403, 'Your verified email is not on the guest list for this restricted room.');
          }
          memberEmail = verifiedCert.email;
          memberEmailVerified = true;
        }

        const name=nameOf(msg.displayName);
        if(msg.requestId===undefined) return json(addMember(name, { email: memberEmail, emailVerified: memberEmailVerified, deviceKey: authenticatedGuestEdPubHex }));
        if(typeof msg.requestId!=='string' || !uuid.test(msg.requestId)) throw fail(400,'Invalid join request ID.');
        const key=msg.requestId.toLowerCase();
        const previous=joinReceipts.get(key);
        if(previous && previous.name!==name) throw fail(409,'This join request already belongs to another name.');
        if(previous) return json(previous.receipt);
        const receipt=addMember(name, { email: memberEmail, emailVerified: memberEmailVerified, deviceKey: authenticatedGuestEdPubHex });
        joinReceipts.set(key,{name,receipt});
        return json(receipt);
      }
      const rawToken = (req.headers.authorization || '').replace(/^Bearer /, '');
      const grant = coordinator.verifyGrant(rawToken);
      if (!req.headers.authorization?.startsWith('Bearer ') || !grant) throw fail(403, 'Room credential required.');
      if (grant.revoked) throw fail(403, 'Participant has been revoked or left the room.');
      const browser=['activity','live','pointers','config','document','invite'].includes(route);
      if (grant.role!==(browser?'browser':'editor')) throw fail(403,'Wrong credential for this operation.');
      if (req.method==='GET') {
        if(route==='snapshot') {
          holdResponse(res,currentBytes);
          return json(current);
        }
        if(route==='scope') return json({tree:scopeRules});
        if(route==='history') {
          const entries=(await history.log()).filter(r=>r.rev>=floor);
          if (scopeBaseline) entries[0]={rev:floor,oid:scopeBaseline.oid,actor:entries[0].actor,
            paths:Object.keys(scopeBaseline.tree),supersededPaths:[]};
          return json({entries});
        }
        const settings=sharingByMember.get(grant.member.id);
        if(route==='invite') {
          if (!coordinator.canMemberInvite(grant.member.id)) throw fail(403, 'Only the host can share invitations for this room.');
          if (coordinator.isInviteRevoked()) throw fail(403, 'Invitation has been revoked.');
          return json({inviteUrl:inviteUrl()});
        }
        if(route==='document') {
          const doc=documentAccess(grant.member,url.searchParams.get('documentId'));
          const cursor=url.searchParams.get('after');
          if(!/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw fail(400,'Invalid document cursor.');
          return json(documentStore().read(doc.id,Number(cursor)));
        }
        if(route==='status') return json({
          roomId,rev:current.rev,oid:current.oid,members:coordinator.activeMembers(),previewAvailable:!!entryUrl(),
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
          const activeMembers = coordinator.activeMembers();
          const peers=activeMembers.filter(m=>m.id!==grant.member.id && now-(lastSeen.get(m.id)??0)<PEER_TIMEOUT);
          return json({
            rev:current.rev,self:grant.member,peers,...settings,actionSeq:sequence,
            documentHead:settings.sharing.actions && config?.document ? documentStore().head(config.document.id) : 0,
            editing:activeMembers.filter(m=>editing.has(m.id)).map(m=>({memberId:m.id,name:m.name})),
            actions:settings.sharing.actions ? actions.filter(e=>e.seq>settings.sharingActionSeq && e.surface===surface) : [],
            pointers:visiblePointers(grant.member,now),
          });
        }
      }
      if (req.method==='POST' && route==='host-ready') {
        if (grant.member.id!==coordinator.getHostMemberId()) throw fail(403,'Only the host can finish room setup.');
        fields(await jsonBody(req),[]);
        activate();
        return json({ready:true});
      }
      if (req.method === 'POST' && route === 'host-invite') {
        if (grant.member.id !== coordinator.getHostMemberId()) throw fail(403,'Only the host can renew an invitation.');
        fields(await jsonBody(req),[]);
        if (Date.now() > expires || coordinator.isInviteRevoked()) {
          inviteSecret = token();
          expires = Date.now() + inviteLifetime;
          coordinator.newInvite(grant.member.id, inviteSecret, expires);
          await syncPoster();
        }
        return json({inviteUrl:inviteUrl()});
      }
      if(req.method==='POST' && route==='close'){
        if(grant.member.id!==coordinator.getHostMemberId()) throw fail(403,'Only the host can close the room.');
        fields(await jsonBody(req),[]);
        res.once('finish',()=>{setImmediate(close);}); return json({closed:true});
      }
      if(req.method==='POST' && route==='leave'){
        fields(await jsonBody(req),[]);
        let result;
        try { result = coordinator.leaveRoom(grant.member.id); }
        catch (e) { throw fail(e.status || 400, e.message); }
        cleanupMemberPresence(grant.member.id);
        return json({ left: true, roomId });
      }
      if(req.method==='POST' && route==='revoke-member'){
        const msg=await jsonBody(req);
        fields(msg,['member']);
        if(typeof msg.member!=='string'||!msg.member.trim()) throw fail(400,'Invalid member identifier.');
        let result;
        try { result = coordinator.revokeMember(msg.member, grant.member.id); }
        catch (e) { throw fail(e.status || 400, e.message); }
        cleanupMemberPresence(result.revoked.id);
        if (relayTransport) {
          relayTransport.rotateGroupKeyAndKick({ revokedMemberId: result.revoked.id, newEpoch: result.groupKeyEpoch });
        }
        return json(result);
      }
      if(req.method==='POST' && route==='revoke-invite'){
        fields(await jsonBody(req),[]);
        let result;
        try { result = coordinator.revokeInvite(grant.member.id); }
        catch (e) { throw fail(e.status || 400, e.message); }
        return json(result);
      }
      if(req.method==='POST' && route==='new-invite'){
        const body = await jsonBody(req);
        fields(body,[],['sharingMode','allowedEmails','allowedDomain','allowGuestInvite']);
        const nextSecret = token();
        const nextExpires = Date.now() + inviteLifetime;
        try {
          coordinator.newInvite(grant.member.id, nextSecret, nextExpires, {
            sharingMode: body.sharingMode,
            allowedEmails: body.allowedEmails,
            allowedDomain: body.allowedDomain,
            allowGuestInvite: body.allowGuestInvite,
          });
        }
        catch (e) { throw fail(e.status || 400, e.message); }
        inviteSecret = nextSecret;
        expires = nextExpires;
        await syncPoster();
        await syncRelayPolicy();
        return json({ inviteUrl: inviteUrl() });
      }
      if(req.method==='POST' && route==='claim-email'){
        const body = await jsonBody(req);
        fields(body,['email']);
        const email = normalizeEmail(body.email);
        if(!email) throw fail(400, 'Valid email address is required.');
        coordinator.updateMemberEmail(grant.member.id, email, false);
        return json({ ok: true, email });
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
      if (req.method === 'POST' && route === 'pack') {
        const msg = await jsonBody(req, 16384);
        fields(msg, [], ['wantOid', 'haveOids']);
        const targetOid = msg.wantOid ?? current.oid;
        if (typeof targetOid !== 'string' || !/^[0-9a-f]{40}$/.test(targetOid)) {
          throw fail(400, 'Invalid wantOid.');
        }
        const haves = Array.isArray(msg.haveOids) ? msg.haveOids : [];
        if (haves.some(h => typeof h !== 'string' || !/^[0-9a-f]{40}$/.test(h))) {
          throw fail(400, 'Invalid haveOids.');
        }
        const { exportPack } = await import('./git-pack.mjs');
        const packBuf = await exportPack(gitStorage, targetOid, haves);
        holdResponse(res, packBuf.length);
        if (req.headers.accept === 'application/octet-stream') {
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': packBuf.length,
          });
          return res.end(packBuf);
        }
        return json({ rev: current.rev, oid: current.oid, packBase64: packBuf.toString('base64') });
      }
      if(req.method==='POST' && route==='submit'){
        const length=Number(req.headers['content-length'] ?? MAX_SUBMIT_BYTES);
        if(length>MAX_SUBMIT_BYTES) throw fail(413,'Message exceeds limit.');
        const release=reserveBulk(length);
        try {
          const msg=await jsonBody(req,MAX_SUBMIT_BYTES); fields(msg,['id','baseRev','changes']);
          if(typeof msg.id!=='string'||msg.id.length>100||!msg.id||!Number.isSafeInteger(msg.baseRev)||msg.baseRev<1) throw fail(400,'Invalid submission.');
          let receipt;
          try { receipt=await history.submit({...msg,author:grant.member.name},{scopeRev, minimumRev:floor, excluded:continuation?.excluded, originalRules:continuation?.originalRules}); }
          catch { throw fail(409,'Submission rejected. Check the base, changed paths, and submission ID.'); }
          coordinator.recordRevision({ rev: receipt.rev, oid: receipt.oid, actor: grant.member.name, submissionId: msg.id });
          if(receipt.rev>current.rev){
            const priorOid = current.oid;
            const head=await history.head();
            if(head.rev>current.rev){
              current=head;config=shareConfig(head.tree);currentBytes=snapshotBytes(head);
              scope=documentScope(config);
              refreshDocuments();
              assetToken=token();pointers.clear();actions.length=0;publishPointers();
            }
            if (relayTransport) {
              await relayTransport.broadcastRevision({ rev: receipt.rev, oid: receipt.oid, prevOid: priorOid }).catch(() => {});
              await syncPoster();
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
    if (continuation?.documents) {
      const file = await lstat(continuation.documents).catch(e => { if (e.code !== 'ENOENT') throw e; });
      if (file?.isFile()) documentStore().inherit(continuation.documents, config?.document,
        (action,payload)=>validatedPayload(config,action,payload));
    }
    if (!deferPublish) activate();
    await syncPoster();
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
    closing=true;
    clearTimeout(setupTimer);
    clearTimeout(expiryTimer);
    clearInterval(pointerHeartbeat);
    relayTransport?.closeRelayRoom();
    server.close(async()=>{
      coordinator.close();
      documents?.close();
      documents=undefined;
      try { if (!published) await continuation?.discard(); } finally {
        if (lock?.isOpen) lock.close();
        resolve();
      }
    });
    server.closeAllConnections();
  });
  if (!published) setupTimer=setTimeout(close,120000).unref();
  return {...owner,baseUrl,localBaseUrl,inviteUrl:inviteUrl(),close};
}
