import type { AgentRoutine, AgentSchedule, RpcParams } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import { boolean, integer, object, text } from './validation.ts';

export function checkSchedule(value:AgentSchedule):AgentSchedule {
  object(value,'schedule');
  if(value.kind==='once')return{kind:'once',at:integer(value.at,'schedule.at',1,8_640_000_000_000_000)};
  if(value.kind==='interval')return{kind:'interval',everyMinutes:integer(value.everyMinutes,'everyMinutes',1,525600)};
  if(value.kind==='daily'){
    if(typeof value.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time))throw refused('schedule.time: expected HH:mm');
    text(value.timezone,'schedule.timezone',100);
    try{new Intl.DateTimeFormat('en',{timeZone:value.timezone}).format();}catch{throw refused('schedule.timezone: expected an IANA timezone');}
    return{kind:'daily',time:value.time,timezone:value.timezone};
  }
  throw refused('schedule.kind: expected once, interval or daily');
}
export function nextOccurrence(schedule:AgentSchedule,after:number):number|null {
  if(schedule.kind==='once')return schedule.at>after?schedule.at:null;
  if(schedule.kind==='interval')return after+schedule.everyMinutes*60000;
  const format=new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:schedule.timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  const afterDate=date.format(after), afterTime=format.format(after);
  // Two days cover a nonexistent local time at the DST transition. No model call.
  for(let minute=Math.floor(after/60000)*60000+60000;minute<=after+49*3600000;minute+=60000)if(format.format(minute)===schedule.time && (date.format(minute)!==afterDate || afterTime<schedule.time))return minute;
  throw refused('schedule: could not find the next local occurrence');
}
export class AgentRoutines {
  constructor(private readonly core:Core){}
  private get r(){return this.core.workforce.records;}
  save(params:RpcParams<'agents.routine.save'>):AgentRoutine {
    const v=params.value;object(v,'routine');const agent=this.r.get('profile',text(v.agentId,'agentId',160));
    if(params.threadId){const session=this.core.workforce.session(params.threadId);if(session.agentId!==agent.id||session.scope.kind!=='agent')throw refused('routine: use the agent direct conversation to schedule work');this.core.workforce.assertScope(session,session.scope,'routines');}
    const previous=params.id?this.r.get('routine',params.id):null;
    if(previous&&previous.agentId!==agent.id)throw refused('agentId: a routine cannot change owner');
    const schedule=checkSchedule(v.schedule),enabled=boolean(v.enabled,'enabled');
    const changed=JSON.stringify(previous?.schedule)!==JSON.stringify(schedule);
    const nextAt=!enabled?null:previous?.enabled&&!changed?previous.nextAt:schedule.kind==='once'?schedule.at:nextOccurrence(schedule,Date.now());
    const value={agentId:agent.id,name:text(v.name,'name',120),prompt:text(v.prompt,'prompt',16000),schedule,enabled,nextAt,lastWorkId:previous?.lastWorkId??null,lastScheduledAt:previous?.lastScheduledAt??null};
    const result=params.id?this.r.update('routine',params.id,params.expectedRevision!,value):this.r.create('routine',value);
    this.core.workforce.changed();return result;
  }
  run(params:RpcParams<'agents.routine.run'>){
    return this.r.command(`routine:${params.routineId}`,params.requestId,{routineId:params.routineId},()=>{
      const routine=this.r.get('routine',params.routineId),agent=this.r.get('profile',routine.agentId);
      if(agent.status!=='active')throw refused('routine: agent is paused or archived');
      if(routine.lastWorkId&&!['done','cancelled'].includes(this.r.get('work',routine.lastWorkId).status))throw refused('routine: previous work is unfinished');
      const work=this.core.workforce.resident.enqueue(agent.id,routine.prompt);
      this.r.update('routine',routine.id,routine.revision,{...routine,lastWorkId:work.id,lastScheduledAt:Date.now(),nextAt:routine.enabled?nextOccurrence(routine.schedule,Date.now()):null,enabled:routine.enabled&&routine.schedule.kind!=='once'});
      this.core.workforce.changed();return work;
    });
  }
  /**
   * The earliest future `nextAt` as of a record-write count. A due routine held back
   * by a paused agent or unfinished work waits for a record write too, so until
   * the count moves or that time comes, a tick reads nothing.
   */
  private next:{writes:number;at:number|null}|null=null;
  tick(now=Date.now()):void {
    if(this.core.workforce.limits().paused||this.core.stopping)return;
    const writes=this.r.writes;
    if(this.next&&this.next.writes===writes&&(this.next.at===null||this.next.at>now))return;
    let at:number|null=null,ran=false;
    for(const routine of this.r.list('routine')){
      if(!routine.enabled||routine.nextAt===null)continue;
      if(routine.nextAt>now){at=at===null?routine.nextAt:Math.min(at,routine.nextAt);continue;}
      if(this.r.get('profile',routine.agentId).status!=='active')continue;
      if(routine.lastWorkId&&!['done','cancelled'].includes(this.r.get('work',routine.lastWorkId).status))continue;
      this.run({routineId:routine.id,requestId:`due-${routine.nextAt}-${routine.revision}`});
      ran=true;
    }
    // A run moved its routine's nextAt: read them all again next time.
    this.next=ran?null:{writes,at};
  }
}
