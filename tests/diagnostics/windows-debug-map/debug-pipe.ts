import type {Captured} from './capture.ts';
export const debugPipeLabels=['DEBUG-PIPE-HELD','DEBUG-PIPE-CLOSED'] as const;
function check(value:unknown,field:string):asserts value {if(!value)throw Error('normal DEBUG stdout cleanup: '+field);}
/** This records a diagnostic's cleanup evidence, never production admission. */
export function validateDebugPipe(h:Captured,marker:string,role:1|2){
 check(!h.timedOut&&h.code!==null,'completed exact helper');
 check(new RegExp(`^TASK_ROUTE_${debugPipeLabels[role-1]}_[a-f0-9]{32}$`).test(marker),'launch marker/role');
 const lines=h.err.split(/\r?\n/),proof=lines.filter(l=>l.startsWith('debug-pipe '));
 check(proof.length===5,'one barrier, three stream mappings and one result');
 const begin=proof[0]!.match(/^debug-pipe barrier helper=([1-9]\d*) root=([1-9]\d*) role=([12]) at=([1-9]\d*)$/);
 const end=proof[4]!.match(/^debug-pipe result helper=([1-9]\d*) root=([1-9]\d*) role=([12]) mask=511 begin=([1-9]\d*) at=([1-9]\d*) error=0$/);
 check(begin&&end,'native successful result');
 const helper=Number(begin[1]),root=Number(begin[2]),started=Number(begin[4]),finished=Number(end[5]);
 check(helper===h.pid&&root!==helper&&helper<=0xffffffff&&root<=0xffffffff&&Number(begin[3])===role,'helper/root identity and role');
 check(begin[1]===end[1]&&begin[2]===end[2]&&begin[3]===end[3]&&begin[4]===end[4],'immutable proof identity');
 check(Number.isSafeInteger(started)&&Number.isSafeInteger(finished)&&started<=finished,'native time order');
 const barrierIndex=lines.indexOf(proof[0]!);let lastIndex=barrierIndex;
 for(const line of proof.slice(1)){const index=lines.indexOf(line);check(index>lastIndex,'ordered unique proof');lastIndex=index;}
 const streams=proof.slice(1,4).map((line,i)=>{
  const m=line.match(/^debug-pipe stream=([012]) original=([1-9]\d*) crt=([1-9]\d*) fd=([012]) type=3 flush-attempted=([01]) flush-result=0 close-attempted=([01]) close-result=0 invalid=([01]) invalid-error=([06]) close-at=(\d+)$/);
  check(m&&Number(m[1])===i&&Number(m[4])===i,'three exact CRT pipe mappings');
  check(m[2]===m[3]&&BigInt(m[2]!)<0xffffffffffffffffn,'original CRT ownership');
  const closed=role===2&&i===1,at=Number(m[9]);
  check(Number(m[5])===Number(i!==0)&&Number(m[6])===Number(closed)&&Number(m[7])===Number(closed)&&Number(m[8])===(closed?6:0),'output flushes and fd1-only successful close/invalidity');
  check(Number.isSafeInteger(at)&&(closed?started<=at&&at<=finished:at===0),'closure time inside action');
  return {original:m[2]!,crt:m[3]!,fd:i,type:3,closed,closeAt:at};
 });
 check(new Set(streams.map(s=>s.original)).size===3,'no stream aliases');
 for(const line of ['cleanup job-active=0','debug-drain cleanup=1 captured=6 remaining=0 error=0',
  ...['root-thread','root-process','job'].map(s=>`cleanup close=${s} closed=1 error=0`),
  ...[0,1,2].map(i=>`stream-cleanup index=${i} success=1 error=0`),
  ...['station-restore','desktop','station'].map(s=>`window-cleanup action=${s} success=1 error=0`)]){
  check(lines.filter(l=>l===line).length===1&&lines.indexOf(line)<barrierIndex,'all owned cleanup precedes original stdout action');
 }
 const mapIndex=lines.findIndex(l=>l.startsWith('cleanup object=map-before-link-close '));
 check(mapIndex>lastIndex,'stdout action before first map cleanup');
 check(!h.err.includes('map-retire ')&&!h.err.includes('retirement-timing ')&&!h.err.includes('anchor-overlap '),'normal DEBUG without replacement/fault');
 const name=h.err.match(/^private-map path=(.+) create=0x00000000\r?$/m)?.[1]?.replace(/\r$/,'');
 check(name&&new RegExp(`^\\\\(?:Sessions\\\\[0-9]+\\\\)?BaseNamedObjects\\\\boite\\.route\\.${helper}$`).test(name),'exact private map');
 const starts=[...h.out.matchAll(new RegExp('^inspect-start='+marker+'\\.generation-([012]) pid=([1-9]\\d*)\\r$','gm'))];
 check(starts.length===3&&starts.every((m,i)=>Number(m[1])===i),'three ordered target generations');
 const pids=starts.map(m=>Number(m[2]));check(pids[0]===root&&new Set([...pids,helper]).size===4,'root and child identities');
 const stdoutLines=h.out.split('\r\n'),expected:string[]=[];
 for(let i=0;i<3;i++){
  const label=marker+'.generation-'+i;
  const status=['0xc0000353','0xc0000022'].find(value=>stdoutLines.includes(`${label} debug-object-query=${value} handle=0000000000000000`));
  check(status,'no host debugger authority');
  expected.push(`inspect-start=${label} pid=${pids[i]}`,`${label} appcontainer=1 in-job=1 routing=1 bytes=${Buffer.byteLength(marker)} open-error=0 marker=${marker}`,`${label} ambient-denial=5`,`${label} debug-object-query=${status} handle=0000000000000000`,`${label} host-debug-control=0 known=1`,`${label} application-exception-forwarded=1 handler-removed=1`);
  if(i<2)expected.push(`${label} child-created=1 pid=${pids[i+1]} error=0`);
 }
 for(let i=2;i>=0;i--)expected.push(`${marker}.generation-${i} inspect-exit=0 child-exit=0 forced=0`);
 check(h.out===expected.join('\r\n')+'\r\n','unchanged exact child transcript and no helper stdout bytes');
 return {helper,root,role,started,finished,streams,map:name,stdoutBytes:Buffer.byteLength(h.out),productionAccepted:false};
}
