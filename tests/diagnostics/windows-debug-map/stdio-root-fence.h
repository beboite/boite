/* Diagnostic-only CRT-owned original standard stream experiment. */
#include <io.h>
#include <errno.h>
static BOOL stdio_root_mode, stdout_root_mode, zero_root_mode, byte_root_mode, close_root_mode;
typedef struct {
  ULONGLONG original, crt;
  DWORD fd, type, flush_attempted; LONG flush_result;
  DWORD close_attempted; LONG close_result;
  DWORD invalid, invalid_error;
  ULONGLONG close_at;
} SF_STREAM;
typedef struct { LF_FRAME base; SF_STREAM streams[3]; } SF_FRAME;
typedef char sf_fixed_size[(sizeof(SF_FRAME) == 400) ? 1 : -1];
typedef struct { DWORD attempted; BOOL result; DWORD transferred,error; ULONGLONG at; } SF_ZERO;
typedef struct {SF_FRAME streams; SF_ZERO zero;} SF_ZERO_FRAME;
typedef char sf_zero_fixed_size[(sizeof(SF_ZERO_FRAME) == 424) ? 1 : -1];
static DWORD sf_acquired, sf_closed;
/* SF_STREAMS_BEGIN: compiled verbatim by the non-native guard regression. */
static DWORD sf_streams(SF_FRAME *f, const wchar_t *marker, DWORD experiment) {
  if(experiment>4 || (f->base.role!=1 && f->base.role!=2)) return ERROR_INVALID_DATA;
  FILE *files[3] = {stdin, stdout, stderr}; DWORD ids[3] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  for (int i=0;i<3;i++) {
    SF_STREAM *s=&f->streams[i]; HANDLE original=GetStdHandle(ids[i]);
    int fd=_fileno(files[i]); s->fd=(DWORD)fd;
    s->original=(ULONGLONG)(ULONG_PTR)original;
    if (fd!=i || !original || original==INVALID_HANDLE_VALUE) return ERROR_INVALID_DATA;
    s->crt=(ULONGLONG)(ULONG_PTR)_get_osfhandle(fd); s->type=GetFileType(original);
    DWORD flags=0;
    if (s->crt!=s->original || s->type!=FILE_TYPE_PIPE || !GetHandleInformation(original,&flags)) return ERROR_INVALID_DATA;
    for(int j=0;j<i;j++) if(f->streams[j].original==s->original) return ERROR_INVALID_DATA;
  }
  /* The raw experiments write only after the common stderr marker and flushes. */
  if(((!experiment || (experiment==1 && f->base.role==2)) && fputws(marker,stdout)<0) || fputws(marker,stderr)<0) return ERROR_WRITE_FAULT;
  for(int i=1;i<3;i++) { SF_STREAM *s=&f->streams[i];s->flush_attempted=1;s->flush_result=fflush(files[i]);if(s->flush_result) return ERROR_WRITE_FAULT; }
  for(int i=0;i<3;i++) {
    SF_STREAM *s=&f->streams[i];
    if(f->base.role==2 && (!experiment || (experiment==4 && i==1))) {
      s->close_attempted=1;s->close_result=fclose(files[i]);
      DWORD flags=0;BOOL valid=GetHandleInformation((HANDLE)(ULONG_PTR)s->original,&flags);
      s->invalid=!valid;s->invalid_error=valid?0:GetLastError();s->close_at=ownership_wall_ms();
      if(s->close_result || !s->invalid || s->invalid_error!=ERROR_INVALID_HANDLE) return ERROR_INVALID_DATA;
    }else {
      if(_fileno(files[i])!=i || (ULONGLONG)(ULONG_PTR)_get_osfhandle(i)!=s->original) return ERROR_INVALID_DATA;
      DWORD flags=0;if(!GetHandleInformation((HANDLE)(ULONG_PTR)s->original,&flags)) return ERROR_INVALID_HANDLE;
    }
  }
  return 0;
}
static DWORD sf_zero_write(SF_FRAME *f,SF_ZERO *zero) {
  if(f->base.role==1)return 0;
  BYTE buffer=0;zero->attempted=1;zero->transferred=0xffffffff;
  zero->result=WriteFile((HANDLE)(ULONG_PTR)f->streams[1].original,&buffer,0,&zero->transferred,NULL);
  zero->error=zero->result?0:GetLastError();zero->at=ownership_wall_ms();
  if(!zero->result)return zero->error?zero->error:ERROR_WRITE_FAULT;
  return zero->transferred?ERROR_INVALID_DATA:0;
}
static DWORD sf_byte_write(SF_FRAME *f,SF_ZERO *call) {
  if(f->base.role==1)return 0;
  BYTE buffer='!';call->attempted=1;call->transferred=0xffffffff;
  call->result=WriteFile((HANDLE)(ULONG_PTR)f->streams[1].original,&buffer,1,&call->transferred,NULL);
  call->error=call->result?0:GetLastError();call->at=ownership_wall_ms();
  if(call->result!=TRUE)return call->error?call->error:ERROR_WRITE_FAULT;
  return call->transferred==1?0:ERROR_INVALID_DATA;
}
static DWORD sf_prepare_streams(SF_FRAME *f,SF_ZERO *zero,const wchar_t *marker,DWORD experiment) {
  DWORD error=sf_streams(f,marker,experiment);
  return error ? error : experiment==2 ? sf_zero_write(f,zero) : experiment==3 ? sf_byte_write(f,zero) : 0;
}
/* SF_STREAMS_END */
/* Publication is conditional on the real successful close, including RETURN.
 * Counter fields predict that one close, never a publication on close failure. */
static DWORD sf_file(const wchar_t *directory,const wchar_t *label,const wchar_t *phase,SF_FRAME *f,BOOL write,DWORD bytes) {
  wchar_t path[4300],pending[4300];int n=swprintf(path,4300,L"%ls\\%ls.%ls.bin",directory,label,phase);
  if(n<0||n>=4300)return ERROR_INSUFFICIENT_BUFFER;
  int m=swprintf(pending,4300,L"%ls.pending",path);if(m<0||m>=4300)return ERROR_INSUFFICIENT_BUFFER;
  HANDLE file=CreateFileW(write?pending:path,write?GENERIC_WRITE:GENERIC_READ,write?0:FILE_SHARE_READ,NULL,write?CREATE_NEW:OPEN_EXISTING,0,NULL);
  if(file==INVALID_HANDLE_VALUE)return GetLastError();
  sf_acquired++;DWORD used=0,error=0;LARGE_INTEGER size;
  if(write){f->base.acquired=sf_acquired;f->base.closed=sf_closed+1;}
  BOOL ok=write?WriteFile(file,f,bytes,&used,NULL):ReadFile(file,f,bytes,&used,NULL);
  if(!ok){error=GetLastError();if(!error)error=ERROR_READ_FAULT;}
  else if(used!=bytes)error=ERROR_INVALID_DATA;
  if(!error&&!write&&(!GetFileSizeEx(file,&size)||size.QuadPart!=bytes))error=ERROR_INVALID_DATA;
  BOOL closed=CloseHandle(file);DWORD close_error=closed?0:GetLastError();if(closed)sf_closed++;
  if(!error&&!closed)error=close_error?close_error:ERROR_INVALID_HANDLE;
  if(!error&&write&&!MoveFileExW(pending,path,0))error=GetLastError();
  return error;
}
static DWORD stdio_root_fence(int result, DWORD experiment) {
  if(experiment>4)return ERROR_INVALID_DATA;
  wchar_t label[40]={0},directory[4096]={0},fault[32]={0},marker[400];SF_ZERO_FRAME frame;ZeroMemory(&frame,sizeof(frame));SF_FRAME *f=&frame.streams;DWORD error=0,bytes=(experiment==2||experiment==3)?sizeof(frame):sizeof(*f);
  DWORD length=GetEnvironmentVariableW(experiment==4?L"BOITE_STDOUT_CLOSE_LABEL":experiment==3?L"BOITE_STDOUT_BYTE_LABEL":experiment==2?L"BOITE_STDOUT_ZERO_LABEL":experiment?L"BOITE_STDOUT_WRITE_LABEL":L"BOITE_STDIO_ROOT_LABEL",label,40);
  if(!length||length>=40)return ERROR_INVALID_NAME;
  f->base.role=!wcscmp(label,experiment==4?L"ASSIGNED-PIPE-HELD":experiment==3?L"ASSIGNED-BYTE-SILENT":experiment==2?L"ASSIGNED-ZERO-SILENT":experiment?L"ASSIGNED-STDOUT-SILENT":L"ASSIGNED-STDIO-HELD")?1:!wcscmp(label,experiment==4?L"ASSIGNED-PIPE-CLOSED":experiment==3?L"ASSIGNED-BYTE-WRITE":experiment==2?L"ASSIGNED-ZERO-WRITE":experiment?L"ASSIGNED-STDOUT-WRITE":L"ASSIGNED-STDIO-CLOSED")?2:0;
  DWORD count=GetEnvironmentVariableW(experiment==4?L"BOITE_STDOUT_CLOSE_DIRECTORY":experiment==3?L"BOITE_STDOUT_BYTE_DIRECTORY":experiment==2?L"BOITE_STDOUT_ZERO_DIRECTORY":experiment?L"BOITE_STDOUT_WRITE_DIRECTORY":L"BOITE_STDIO_ROOT_DIRECTORY",directory,4096);
  if(!count||count>=4096)return ERROR_INVALID_NAME;
  f->base.magic=experiment==4?0x53434631:experiment==3?0x42574631:experiment==2?0x5a574631:experiment?0x53574631:0x53524631;f->base.version=1;f->base.bytes=bytes;f->base.phase=1;f->base.result=(DWORD)result;
  f->base.helper=rt_frame.helper;f->base.root=rt_frame.root;f->base.helper_created=rt_frame.helper_created;f->base.root_created=rt_frame.created;
  f->base.cleanup=lf_cleanup_mask;f->base.ready=ownership_wall_ms();f->base.root_deadline=rt_frame.deadline;
  f->base.deadline=f->base.ready+3000<f->base.root_deadline?f->base.ready+3000:f->base.root_deadline;
  ULONGLONG tick_deadline=GetTickCount64()+(f->base.deadline>f->base.ready?f->base.deadline-f->base.ready:0);
  if(!f->base.role||result!=125||anchor_overlap_mode!=1||retirement_timing_mode!=1||
    GetEnvironmentVariableW(L"BOITE_DIAGNOSTIC_ANCHOR_FAULT",fault,32)!=8||wcscmp(fault,L"assigned")||
    !lf_hex(f->base.compiler_nonce,experiment==4?L"BOITE_STDOUT_CLOSE_NONCE":experiment==3?L"BOITE_STDOUT_BYTE_NONCE":experiment==2?L"BOITE_STDOUT_ZERO_NONCE":experiment?L"BOITE_STDOUT_WRITE_NONCE":L"BOITE_STDIO_ROOT_NONCE")||rt_nonce(f->base.nonce)||
    !f->base.root||f->base.helper!=GetCurrentProcessId()||f->base.helper_created!=rt_created(GetCurrentProcess(),FALSE)||
    probe_map||probe_link||swap_map||f->base.cleanup!=0x1ff||ao_files_acquired!=ao_files_closed)error=ERROR_INVALID_DATA;
  if(!ProcessIdToSessionId(GetCurrentProcessId(),&f->base.session))error=GetLastError();
  int used=swprintf(marker,400,experiment==4?L"close-fence barrier label=%ls nonce=%ls helper=%lu helper-created=%llu root=%lu created=%llu ready=%llu deadline=%llu\n":experiment==3?L"byte-fence barrier label=%ls nonce=%ls helper=%lu helper-created=%llu root=%lu created=%llu ready=%llu deadline=%llu\n":experiment==2?L"zero-fence barrier label=%ls nonce=%ls helper=%lu helper-created=%llu root=%lu created=%llu ready=%llu deadline=%llu\n":experiment?L"stdout-fence barrier label=%ls nonce=%ls helper=%lu helper-created=%llu root=%lu created=%llu ready=%llu deadline=%llu\n":L"stdio-fence barrier label=%ls nonce=%ls helper=%lu helper-created=%llu root=%lu created=%llu ready=%llu deadline=%llu\n",label,f->base.nonce,f->base.helper,f->base.helper_created,f->base.root,f->base.root_created,f->base.ready,f->base.deadline);
  if(used<0||used>=400)error=ERROR_INSUFFICIENT_BUFFER;
  if(!error)error=sf_prepare_streams(f,&frame.zero,marker,experiment);
  /* No stdio operation, including generic failure(), occurs beyond here. */
  if(!error&&(ownership_wall_ms()>=f->base.deadline||GetTickCount64()>=tick_deadline||!rt_in_time()))error=ERROR_TIMEOUT;
  f->base.at=ownership_wall_ms();
  if(!error)error=sf_file(directory,label,L"ready",f,TRUE,bytes);
  while(!error) {
    if(ownership_wall_ms()>=f->base.deadline||GetTickCount64()>=tick_deadline||!rt_in_time()){error=ERROR_TIMEOUT;break;}
    SF_ZERO_FRAME release;ZeroMemory(&release,sizeof(release));error=sf_file(directory,label,L"release",&release.streams,FALSE,bytes);
    if(error==ERROR_FILE_NOT_FOUND||error==ERROR_SHARING_VIOLATION){error=0;Sleep(5);continue;}
    if(error)break;
    SF_ZERO_FRAME identity=release;identity.streams.base.phase=1;identity.streams.base.at=f->base.at;
    if(release.streams.base.phase!=2||release.streams.base.at<f->base.at||release.streams.base.at>=f->base.deadline||memcmp(&identity,&frame,bytes)) {error=ERROR_INVALID_DATA;break;}
    if(ownership_wall_ms()>=f->base.deadline||GetTickCount64()>=tick_deadline||sf_acquired!=sf_closed){error=ERROR_TIMEOUT;break;}
    f->base.phase=3;f->base.at=ownership_wall_ms();error=sf_file(directory,label,L"return",f,TRUE,bytes);
    if(!error&&(ownership_wall_ms()>=f->base.deadline||GetTickCount64()>=tick_deadline||sf_acquired!=sf_closed))error=ERROR_TIMEOUT;
    break;
  }
  if(error) {f->base.phase=4;f->base.at=ownership_wall_ms();f->base.error=error;(void)sf_file(directory,label,L"failed",f,TRUE,bytes);}
  return error;
}
