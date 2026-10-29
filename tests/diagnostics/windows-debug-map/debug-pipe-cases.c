#include <stdio.h>
#include <wchar.h>
#include <string.h>
#include <stdlib.h>
typedef unsigned long DWORD;typedef long LONG;typedef unsigned long long ULONGLONG;
#define ERROR_INVALID_DATA 13
#define ERROR_INSUFFICIENT_BUFFER 122
#define ZeroMemory(p,n) memset(p,0,n)
typedef struct {DWORD role;} BASE;
typedef struct {ULONGLONG original,crt;DWORD fd,type,flush_attempted;LONG flush_result;DWORD close_attempted;LONG close_result;DWORD invalid,invalid_error;ULONGLONG close_at;} SF_STREAM;
typedef struct {BASE base;SF_STREAM streams[3];} SF_FRAME;
static DWORD lf_cleanup_mask;
static int debug_mode,assignment_scope,retire_owned_map,retirement_timing_mode,directory_twin_mode,captured,active,target_captured,auxiliary_captured,root_exited;
static struct {DWORD pid;int exited;} records[6];
static DWORD calls,stream_error;static ULONGLONG wall;
static DWORD GetCurrentProcessId(void){return 11;}
static ULONGLONG ownership_wall_ms(void){ULONGLONG result=wall;wall+=2;return result;}
static DWORD sf_streams(SF_FRAME *f,const wchar_t *marker,DWORD experiment){
 calls++;if(experiment!=4)return ERROR_INVALID_DATA;
 fputws(marker,stderr);
 for(int i=0;i<3;i++){SF_STREAM *s=&f->streams[i];s->original=s->crt=(ULONGLONG)(100+i);s->fd=(DWORD)i;s->type=3;s->flush_attempted=i!=0;
  if(f->base.role==2&&i==1){s->close_attempted=s->invalid=1;s->invalid_error=6;s->close_at=101;}}
 return stream_error;
}
#include "debug-pipe-function.h"
static void reset(void){calls=stream_error=0;wall=100;debug_pipe_mode=1;lf_cleanup_mask=511;debug_mode=1;assignment_scope=retire_owned_map=retirement_timing_mode=directory_twin_mode=active=0;captured=6;target_captured=auxiliary_captured=3;root_exited=1;for(int i=0;i<6;i++){records[i].pid=(DWORD)(21+i);records[i].exited=1;}}
#define CHECK(e) do{checks++;if(!(e)){fprintf(stderr,"DEBUG_PIPE_GUARD_FAILED line=%d\n",__LINE__);return 1;}}while(0)
int main(int argc,char **argv){
 int checks=0;reset();if(argc==2){debug_pipe_mode=(DWORD)atoi(argv[1]);return (int)debug_pipe_cleanup(21);}
 debug_pipe_mode=0;CHECK(debug_pipe_cleanup(0)==0&&calls==0);
 for(DWORD role=1;role<=2;role++){reset();debug_pipe_mode=role;CHECK(debug_pipe_cleanup(21)==0&&calls==1);}
 reset();stream_error=5;CHECK(debug_pipe_cleanup(21)==5&&calls==1);
 for(int bad=0;bad<14;bad++){reset();switch(bad){
  case 0:debug_pipe_mode=3;break;case 1:debug_mode=0;break;case 2:assignment_scope=1;break;case 3:retire_owned_map=1;break;
  case 4:retirement_timing_mode=1;break;case 5:directory_twin_mode=1;break;case 6:lf_cleanup_mask=510;break;case 7:captured=5;break;
  case 8:active=1;break;case 9:target_captured=2;break;case 10:auxiliary_captured=2;break;case 11:records[0].pid=22;break;
  case 12:root_exited=0;break;case 13:records[5].exited=0;break;}
  CHECK(debug_pipe_cleanup(21)==ERROR_INVALID_DATA&&calls==0);
 }
 reset();CHECK(debug_pipe_cleanup(0)==ERROR_INVALID_DATA&&calls==0);
 printf("DEBUG_PIPE_GUARDS_PASS checks=%d\n",checks);return 0;
}
