/* Shared by the actual adapter and the deterministic Linux contract harness. */
#ifndef NULL_BROKER_CONTRACTS_H
#define NULL_BROKER_CONTRACTS_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#define NB_THREADS 128
enum {NB_HOLD_FAILED, NB_HELD, NB_TERMINATING};
enum {NB_IDLE, NB_STEPPING, NB_WAIT_EXIT, NB_REPLAYING};
typedef struct {uint32_t id; unsigned held, deferred, terminating; int live;} NB_THREAD_STATE;
typedef struct {uint32_t owner; uintptr_t site; unsigned phase; NB_THREAD_STATE threads[NB_THREADS];} NB_STEP;
typedef int (*nb_suspend_fn)(void *, uint32_t);
static NB_THREAD_STATE *nb_thread(NB_STEP *s, uint32_t id) {
  for (unsigned i = 0; i < NB_THREADS; ++i) if (s->threads[i].live && s->threads[i].id == id) return &s->threads[i];
  return NULL;
}
static int nb_join(NB_STEP *s, uint32_t id, nb_suspend_fn suspend, void *ctx) {
  if (!id || nb_thread(s, id)) return 0;
  for (unsigned i = 0; i < NB_THREADS; ++i) if (!s->threads[i].live) {
    NB_THREAD_STATE *t = &s->threads[i]; memset(t, 0, sizeof(*t)); t->id = id; t->live = 1;
    if (s->owner && id != s->owner) {
      int result = suspend(ctx, id);
      if (result == NB_TERMINATING && s->phase == NB_WAIT_EXIT) t->terminating = 1;
      else if (result == NB_HELD) t->held = 1;
      else return 0;
    }
    return 1;
  }
  return 0;
}
static int nb_begin(NB_STEP *s, uint32_t owner, uintptr_t site, nb_suspend_fn suspend, void *ctx) {
  if (s->owner || !nb_thread(s, owner)) return 0;
  s->owner = owner; s->site = site; s->phase = NB_STEPPING;
  int waiting = 0;
  for (unsigned i = 0; i < NB_THREADS; ++i) {
    NB_THREAD_STATE *t = &s->threads[i];
    if (t->live && t->id != owner) {
      if (t->held) return 0;
      int result = suspend(ctx, t->id);
      if (result == NB_TERMINATING) {t->terminating = 1; waiting = 1;}
      else if (result == NB_HELD) t->held = 1;
      else return 0;
    }
  }
  if (waiting) {
    if (suspend(ctx, owner) != NB_HELD) return 0;
    s->phase = NB_WAIT_EXIT; return NB_TERMINATING;
  }
  return 1;
}
static int nb_depart(NB_STEP *s, uint32_t id) {
  NB_THREAD_STATE *t = nb_thread(s, id);
  if (!t || t->held || s->owner == id || (t->terminating && s->phase != NB_WAIT_EXIT)) return 0;
  t->live = 0; return 1;
}
/* Only call after ContinueDebugEvent has completed the real EXIT_THREAD event. */
static int nb_wake(NB_STEP *s, nb_suspend_fn resume, void *ctx) {
  if (s->phase != NB_WAIT_EXIT) return 1;
  for (unsigned i = 0; i < NB_THREADS; ++i) if (s->threads[i].live && s->threads[i].terminating) return 1;
  if (!resume(ctx, s->owner)) return 0;
  s->phase = NB_REPLAYING; return 1;
}
static int nb_replayed(NB_STEP *s, uint32_t id, uintptr_t site) {
  if (s->phase != NB_REPLAYING || s->owner != id || s->site != site) return 0;
  s->phase = NB_STEPPING; return 1;
}
static int nb_defer(NB_STEP *s, uint32_t id) {
  NB_THREAD_STATE *t = nb_thread(s, id);
  if (!s->owner || s->owner == id || !t || t->held != 1 || t->deferred) return 0;
  t->deferred = 1; return 1;
}
/* Caller MUST reinstall the original trap and restore the owner's flags first. */
static int nb_finish(NB_STEP *s, uint32_t owner, nb_suspend_fn resume, void *ctx) {
  if (!owner || s->owner != owner || s->phase != NB_STEPPING) return 0;
  for (unsigned i = 0; i < NB_THREADS; ++i) {
    NB_THREAD_STATE *t = &s->threads[i];
    if (t->held) {if (t->held != 1 || !resume(ctx, t->id)) return 0; t->held = 0; t->deferred = 0;}
  }
  s->owner = 0; s->site = 0; s->phase = NB_IDLE; return 1;
}

typedef struct {uintptr_t base; size_t size; int committed, writable, guarded;} NB_REGION;
typedef int (*nb_query_fn)(void *, uintptr_t, NB_REGION *);
static int nb_output_span(uintptr_t start, size_t size, size_t alignment, nb_query_fn query, void *ctx) {
  if (!start || !size || !alignment || start % alignment || size > UINTPTR_MAX - start) return 0;
  uintptr_t end = start + size, cursor = start;
  while (cursor < end) {
    NB_REGION r;
    if (!query(ctx, cursor, &r) || !r.committed || !r.writable || r.guarded || !r.size || r.base > cursor || r.size > UINTPTR_MAX - r.base) return 0;
    uintptr_t next = r.base + r.size;
    if (next <= cursor) return 0;
    cursor = next < end ? next : end;
  }
  return 1;
}
static int nb_outputs(uintptr_t handle, uintptr_t iosb, nb_query_fn query, void *ctx) {
  return nb_output_span(handle, 8, 8, query, ctx) && nb_output_span(iosb, 16, 8, query, ctx) &&
    (handle + 8 <= iosb || iosb + 16 <= handle);
}

/* A target address is read once, never handed to the host's object manager. */
typedef struct {uint32_t length, level; uint8_t tracking, effective, padding[2];} NB_QOS;
typedef int (*nb_read_fn)(void *, uintptr_t, void *, size_t);
/* NtCreateFile's final stack argument is ULONG in an eight-byte x64 slot. */
static int nb_create_extras(const uint64_t args[7]) {
  return (!!args[0]) | ((!!args[5]) << 1) | ((!!(uint32_t)args[6]) << 2);
}
/* ProcessHandleInformation x64: prove absence without issuing I/O on a stale handle. */
static int nb_credential_absent(const void *snapshot, size_t length, uint64_t candidate, uint64_t control) {
  if (!snapshot || length<16 || !candidate || !control || control==UINT64_MAX || control==candidate) return 0;
  uint64_t count; memcpy(&count,snapshot,8);
  if (!count || count>(length-16)/40) return 0;
  int found=0;
  for (size_t i=0;i<(size_t)count;i++) {
    uint64_t handle; memcpy(&handle,(const unsigned char *)snapshot+16+i*40,8);
    if (handle==candidate) return 0;
    if (handle==control) found=1;
  }
  return found;
}
static int nb_snapshot_qos(uintptr_t address, NB_QOS *out, nb_read_fn read, void *ctx) {
  memset(out, 0, sizeof(*out));
  if (!address) return 1;
  if (address > UINTPTR_MAX - sizeof(*out) || !read(ctx, address, out, sizeof(*out))) return 0;
  return out->length == sizeof(*out) && out->level <= 3 && out->tracking <= 1 && out->effective <= 1;
}
#endif
