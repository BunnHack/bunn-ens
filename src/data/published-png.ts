// Download the actual workflow PNG, not a screenshot, re-encoding, or SVG substitute.
export async function publishedPng(url:string,signal:AbortSignal):Promise<Blob>{
 if(!/^https:\/\/bunnhack\.github\.io\/bunn-ens\/ncep-ensembles\/runs\/(?:GEFS|AIGEFS)\/20\d{6}T(?:00|06|12|18)0000Z\/(?:regions\/(?:world|wp|ep|al|ni|si|sp)|storms\/(?:AL|EP|CP|WP|IO|AA|BB|SH|SP|SI)\d{2}20\d{2}-(?:track|wind|pressure))\.png(?:\?v=[a-f0-9]{12})?$/.test(url))throw Error('非已发布PNG路径')
 const timeout=AbortSignal.timeout(30_000),response=await fetch(url,{signal:AbortSignal.any([signal,timeout]),credentials:'omit',redirect:'error'})
 if(!response.ok||!response.body)throw Error('PNG暂不可用，不以其他图代替')
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
 try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>8*1024*1024){await reader.cancel();throw Error('PNG超过安全大小限制')}chunks.push(chunk.value)}}finally{reader.releaseLock()}
 const bytes=new Uint8Array(size);let position=0;for(const chunk of chunks){bytes.set(chunk,position);position+=chunk.length}
 if(size<24||![137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n))throw Error('原图不是PNG，不保存替代文件')
 return new Blob([bytes],{type:'image/png'})
}
