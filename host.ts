import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { spawn } from 'node:child_process';
import { isAbsolute, join, delimiter } from 'node:path';
import { lstatSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { hostContract } from './contract';
export default experimental_defineHostEntry({contract:hostContract,handlers:{invoke:async(input,context)=>{
 if(!isAbsolute(input.sourceRoot)||lstatSync(input.sourceRoot).isSymbolicLink())throw Error('Plugin runtime must be an absolute trusted source directory');
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>! /^(BASH_ENV|ENV|ZDOTDIR|NODE_OPTIONS|NODE_PATH|GIT_|LD_|DYLD_)/.test(k)));
 env.PATH=(env.PATH??'').split(delimiter).filter(isAbsolute).join(delimiter);
 return new Promise((resolve,reject)=>{const child=spawn('node',[join(input.sourceRoot,'bridge.mjs')],{cwd:input.sourceRoot,env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});const decoder=new StringDecoder('utf8');let out='',err='',bytes=0,closed=false;let kill:ReturnType<typeof setTimeout>|undefined;
 const abort=()=>{if(closed)return;try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{}kill=setTimeout(()=>{if(!closed)try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}},3000);};
 context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
 child.stdout.on('data',b=>{bytes+=b.length;if(bytes>8*1024*1024){abort();return;}out+=decoder.write(b);});child.stderr.on('data',b=>{err=(err+b).slice(-8192);});child.on('error',reject);child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
 child.on('close',code=>{closed=true;clearTimeout(kill);context.signal.removeEventListener('abort',abort);out+=decoder.end();if(bytes>8*1024*1024)return reject(Error('Pair Review result exceeds the 8 MiB host limit'));if(code!==0)return reject(Error(err||'Pair Review runtime stopped'));try{const value=JSON.parse(out);if(!value.ok)throw Error(value.error);resolve(value.result);}catch(e){reject(e);}});
 });
}}});
