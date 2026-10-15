import { hostContract } from './contract.ts';
import { invoke } from './service.ts';
let text='';
try {
 for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>1024*1024)throw Error('Bridge input exceeds 1 MiB');}
 const request=hostContract.invoke.input.parse(JSON.parse(text));
 const result=await invoke(request);
 process.stdout.write(JSON.stringify({ok:true,result})+'\n');
}catch(error){process.stdout.write(JSON.stringify({ok:false,error:String(error)})+'\n');}
