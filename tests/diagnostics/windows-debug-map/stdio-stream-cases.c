#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
typedef unsigned char BYTE;typedef uint32_t DWORD;typedef int32_t LONG;typedef uint64_t ULONGLONG;typedef uintptr_t ULONG_PTR;typedef int BOOL;typedef void *HANDLE;
#define TRUE 1
#define ERROR_INVALID_DATA 13
#define ERROR_INVALID_HANDLE 6
#define ERROR_WRITE_FAULT 29
#define FILE_TYPE_PIPE 3
#define STD_INPUT_HANDLE 0
#define STD_OUTPUT_HANDLE 1
#define STD_ERROR_HANDLE 2
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
typedef struct {DWORD role;} BASE;
typedef struct {ULONGLONG original,crt;DWORD fd,type,flush_attempted;LONG flush_result;DWORD close_attempted;LONG close_result;DWORD invalid,invalid_error;ULONGLONG close_at;} SF_STREAM;
typedef struct {BASE base;SF_STREAM streams[3];} SF_FRAME;
typedef struct {DWORD attempted;BOOL result;DWORD transferred,error;ULONGLONG at;} SF_ZERO;
static int raw_calls,raw_bad,last_error_reads;
static char operations[64];static int operation_count;
static int mode,closed[3],attempts[3],flushes[3],sequence[3],nclose,nwrite,last_error,cases;
static int index_of(FILE *f){return f==stdin?0:f==stdout?1:2;}
static HANDLE GetStdHandle(DWORD i){return (HANDLE)(uintptr_t)(mode==1&&i==1?100:100+i);}
static int _fileno(FILE *f){return mode==2&&f==stdin?3:index_of(f);}
static intptr_t _get_osfhandle(int fd){return mode==3&&fd==0?999:100+fd;}
static DWORD GetFileType(HANDLE h){(void)h;return mode==4?1:3;}
static BOOL GetHandleInformation(HANDLE h,DWORD *flags){int i=(int)(uintptr_t)h-100;*flags=0;if(mode==8)return 0;if(i>=0&&i<3&&closed[i]&&mode!=7){last_error=6;return 0;}return 1;}
static DWORD GetLastError(void){last_error_reads++;return (DWORD)last_error;}
BOOL WriteFile(HANDLE h,const void *buffer,DWORD bytes,DWORD *used,void *overlapped){raw_calls++;operations[operation_count++]='w';if(h!=(HANDLE)(uintptr_t)101||!buffer||bytes!=(DWORD)(mode>=12?1:0)||overlapped||(mode>=12&&*(const BYTE*)buffer!='!'))raw_bad=1;
 if(mode==9){*used=0;last_error=5;return 0;}if(mode==10){*used=1;return 1;}if(mode==16){*used=1;return 2;}if(mode==13){*used=0;return 1;}if(mode==14)return 1;if(mode==15){*used=0;last_error=5;return 0;}if(mode!=11)*used=mode>=12?1:0;return 1;}
static ULONGLONG ownership_wall_ms(void){return (ULONGLONG)(1000+nclose);}
static int emit(const wchar_t *s,FILE *f){(void)s;operations[operation_count++]=(char)('a'+index_of(f));nwrite++;return 0;}
static int flush(FILE *f){int i=index_of(f);operations[operation_count++]=(char)('x'+i);flushes[i]++;return mode==5&&i==1?-1:0;}
static int close_stream(FILE *f){int i=index_of(f);operations[operation_count++]=(char)('0'+i);attempts[i]++;sequence[nclose++]=i;if((mode==6&&i==0)||(mode==17&&i==1))return -1;closed[i]=1;return mode==18&&i==1?-1:0;}
#define fputws emit
#define fflush flush
#define fclose close_stream
#include "stdio-stream-function.h"
#undef fclose
#undef fflush
#undef fputws
#define CHECK(s,e) do{cases++;if(!(e)){fprintf(stderr,"stdio case failed: %s\n",s);return 1;}}while(0)
static void reset(int bad){mode=bad;memset(closed,0,sizeof(closed));memset(attempts,0,sizeof(attempts));memset(flushes,0,sizeof(flushes));memset(sequence,0,sizeof(sequence));nclose=nwrite=last_error=operation_count=raw_calls=raw_bad=last_error_reads=0;memset(operations,0,sizeof(operations));}
int main(void){
 for(int role=1;role<=2;role++){reset(0);SF_FRAME f={0};f.base.role=(DWORD)role;
  CHECK("valid exact context",sf_streams(&f,L"barrier\n",0)==0);
  CHECK("flush output only",flushes[0]==0&&flushes[1]==1&&flushes[2]==1);
  CHECK("common final marker before closure",nwrite==2);
  CHECK("role owner closure count",nclose==(role==2?3:0));
  for(int i=0;i<3;i++){CHECK("original descriptor mapping",f.streams[i].fd==(DWORD)i&&f.streams[i].original==(ULONGLONG)(100+i)&&f.streams[i].crt==(ULONGLONG)(100+i));
   CHECK("only closed arm closes",attempts[i]==(role==2?1:0));
   CHECK("immediate invalidity recorded",f.streams[i].invalid==(DWORD)(role==2)&&f.streams[i].invalid_error==(DWORD)(role==2?6:0));}
  CHECK("stderr closes last",role==1||(sequence[0]==0&&sequence[1]==1&&sequence[2]==2));
 }
 for(int bad=1;bad<=8;bad++){reset(bad);SF_FRAME f={0};f.base.role=2;
  CHECK("bad preflight/flush/closure rejects",sf_streams(&f,L"barrier\n",0)!=0);
  CHECK("bad mapping/flush never closes",(bad>5&&bad<8)||nclose==0);
  CHECK("no retry after close refusal",bad!=6||nclose==1);
  CHECK("missing invalidity never continues closure",bad!=7||nclose==1);
 }
 for(int role=1;role<=2;role++){reset(0);SF_FRAME f={0};f.base.role=(DWORD)role;
  CHECK("stdout explicit experiment",sf_streams(&f,L"barrier\n",1)==0);
  CHECK("stdout selected write then common flush order",!strcmp(operations,role==1?"cyz":"bcyz"));
  CHECK("stdout keeps every original open",nclose==0&&attempts[0]==0&&attempts[1]==0&&attempts[2]==0);
  CHECK("stdout only flushes output",flushes[0]==0&&flushes[1]==1&&flushes[2]==1);
  for(int i=0;i<3;i++)CHECK("stdout never records a closure",f.streams[i].close_attempted==0&&f.streams[i].invalid==0&&f.streams[i].invalid_error==0&&f.streams[i].close_at==0);
 }
 reset(0);SF_FRAME invalid={0};invalid.base.role=1;CHECK("unknown experiment never writes",sf_streams(&invalid,L"barrier\n",5)!=0&&nwrite==0&&nclose==0);
 for(int role=1;role<=2;role++){reset(0);SF_FRAME f={0};SF_ZERO zero={0};f.base.role=(DWORD)role;last_error=123;
  CHECK("zero selected native path succeeds",sf_prepare_streams(&f,&zero,L"barrier\n",2)==0);
  CHECK("zero selected write actually called once",raw_calls==(role==2?1:0));
  CHECK("zero exact original stdout nonnull zero count synchronous",raw_bad==0);
  CHECK("zero stderr and common flush precede the raw write",!strcmp(operations,role==1?"cyz":"cyzw"));
  CHECK("zero never closes original handles",nclose==0&&attempts[0]==0&&attempts[1]==0&&attempts[2]==0);
  CHECK("zero records real BOOL transferred and fresh timestamp",role==1?(zero.attempted==0&&zero.result==0&&zero.transferred==0&&zero.error==0&&zero.at==0):(zero.attempted==1&&zero.result==1&&zero.transferred==0&&zero.error==0&&zero.at==1000));
  CHECK("zero success never reads stale last error",last_error_reads==0);
 }
 for(int bad=1;bad<=11;bad++){if(bad==6||bad==7)continue;reset(bad);SF_FRAME f={0};SF_ZERO zero={0};f.base.role=2;
  CHECK("zero bad mapping flush or actual write refuses",sf_prepare_streams(&f,&zero,L"barrier\n",2)!=0);
  CHECK("zero failed operation never retries or closes",nclose==0&&raw_calls==(bad>=9?1:0));
  if(bad==9)CHECK("zero failed BOOL preserves native error",zero.attempted==1&&zero.result==0&&zero.error==5&&zero.transferred==0&&last_error_reads==1);
  if(bad==10)CHECK("zero nonzero transfer preserved",zero.result==1&&zero.transferred==1);
  if(bad==11)CHECK("zero untouched sentinel refused",zero.result==1&&zero.transferred==0xffffffff);
 }
 for(int role=1;role<=2;role++){reset(12);SF_FRAME f={0};SF_ZERO call={0};f.base.role=(DWORD)role;last_error=123;
  CHECK("byte actual native path succeeds",sf_prepare_streams(&f,&call,L"barrier\n",3)==0);
  CHECK("byte exact original stdout valid exclamation count one synchronous",raw_bad==0&&raw_calls==(role==2?1:0));
  CHECK("byte common stderr and flush before raw write",!strcmp(operations,role==1?"cyz":"cyzw"));
  CHECK("byte never closes originals",nclose==0&&attempts[0]==0&&attempts[1]==0&&attempts[2]==0);
  CHECK("byte authentic BOOL count and timestamp",role==1?(call.attempted==0&&call.result==0&&call.transferred==0&&call.error==0&&call.at==0):(call.attempted==1&&call.result==1&&call.transferred==1&&call.error==0&&call.at==1000));
  CHECK("byte success does not read stale last error",last_error_reads==0);
 }
 for(int bad=13;bad<=16;bad++){reset(bad);SF_FRAME f={0};SF_ZERO call={0};f.base.role=2;
  CHECK("byte partial untouched sentinel or failed call refused",sf_prepare_streams(&f,&call,L"barrier\n",3)!=0);
  CHECK("byte refusal never retries or closes",raw_calls==1&&raw_bad==0&&nclose==0);
  CHECK("byte failed BOOL preserves error",bad!=15||(call.result==0&&call.error==5&&last_error_reads==1));
 }
 for(int role=1;role<=2;role++){reset(0);SF_FRAME f={0};SF_ZERO unused={0};f.base.role=(DWORD)role;
  CHECK("stdout close explicit native path succeeds",sf_prepare_streams(&f,&unused,L"barrier\n",4)==0);
  CHECK("stdout close common stderr flush then only fd1 closure",!strcmp(operations,role==1?"cyz":"cyz1"));
  CHECK("stdout close never writes stdout or raw bytes",nwrite==1&&raw_calls==0);
  CHECK("stdout close only closes original stdout once",nclose==(role==2?1:0)&&attempts[0]==0&&attempts[1]==(role==2?1:0)&&attempts[2]==0);
  CHECK("stdout close original stdout validated immediately",role==1||(f.streams[1].close_result==0&&f.streams[1].invalid==1&&f.streams[1].invalid_error==6&&f.streams[1].close_at==1001));
  for(int i=0;i<3;i++){CHECK("stdout close exact CRT mapping",f.streams[i].fd==(DWORD)i&&f.streams[i].original==(ULONGLONG)(100+i)&&f.streams[i].crt==(ULONGLONG)(100+i));
   if(i!=1||role==1)CHECK("stdout close unselected streams remain open",closed[i]==0&&f.streams[i].close_attempted==0&&f.streams[i].invalid==0&&f.streams[i].invalid_error==0&&f.streams[i].close_at==0);}
 }
 for(int bad=1;bad<=8;bad++){reset(bad==6?17:bad);SF_FRAME f={0};SF_ZERO unused={0};f.base.role=2;
  CHECK("stdout close bad preflight flush close or invalidity rejects",sf_prepare_streams(&f,&unused,L"barrier\n",4)!=0);
  CHECK("stdout close bad mapping or flush never closes",(bad==6||bad==7)||nclose==0);
  CHECK("stdout close failed closure or invalidity never retries",(bad!=6&&bad!=7)||(nclose==1&&attempts[1]==1));
 }
 reset(18);SF_FRAME close_failed={0};SF_ZERO close_unused={0};close_failed.base.role=2;
 CHECK("stdout close fclose failure rejects even if handle became invalid",sf_prepare_streams(&close_failed,&close_unused,L"barrier\n",4)!=0&&attempts[1]==1&&closed[1]==1);
 printf("STDIO_STREAM_GUARDS_PASS cases=%d native=false\n",cases);return 0;
}
