import { fork } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startHost } from './host.mjs';

export function launchHost(options) {
  return new Promise((resolve,reject)=>{
    const child=fork(fileURLToPath(import.meta.url),['--serve-room'],{
      detached:true,stdio:['ignore','ignore','ignore','ipc'],execArgv:[]
    });
    const timer=setTimeout(()=>fail(Error('Room startup timed out.')),45000);
    function finish(){clearTimeout(timer);child.off('error',fail);child.off('exit',exited);}
    function fail(e){finish();child.kill();reject(e);}
    function exited(){fail(Error('Room host exited during startup.'));}
    child.once('error',fail);child.once('exit',exited);
    child.once('message',msg=>{
      finish();
      if(!msg.ok){child.kill();return reject(Error(msg.message||'Room startup failed.'));}
      child.disconnect();child.unref();
      const result=msg.result;
      const close=async()=>{await fetch(result.localBaseUrl+'/api/rooms/'+result.roomId+'/close',{
        method:'POST',redirect:'error',headers:{authorization:'Bearer '+result.memberToken,'content-type':'application/json'},body:'{}'
      });};
      resolve({...result,close});
    });
    child.send(options);
  });
}
if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url && process.argv[2]==='--serve-room' && process.send) {
  process.once('message',async options=>{
    try {
      const {close,...result}=await startHost(options);
      process.send({ok:true,result},err=>{if(err)close();});
    }catch(err){process.send({ok:false,message:err.message},()=>process.exit(1));}
  });
}
