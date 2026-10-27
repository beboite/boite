/* Shared by the actual adapter and the deterministic Linux contract harness. */
#ifndef NULL_BROKER_CONTRACTS_H
#define NULL_BROKER_CONTRACTS_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#define NB_THREADS 128
typedef struct {uint32_t id; unsigned held, deferred; int live;} NB_THREAD_STATE;
typedef struct {uint32_t owner; uintptr_t site; NB_THREAD_STATE threads[NB_THREADS];} NB_STEP;
typedef int (*nb_suspend_fn)(void *, uint32_t);
static NB_THREAD_STATE *nb_thread(NB_STEP *s, uint32_t id) {
  for (unsigned i = 0; i < NB_THREADS; ++i) if (s->threads[i].live && s->threads[i].id == id) return &s->threads[i];
  return NULL;
}
static int nb_join(NB_STEP *s, uint32_t id, nb_suspend_fn suspend, void *ctx) {
  if (!id || nb_thread(s, id)) return 0;
  for (unsigned i = 0; i < NB_THREADS; ++i) if (!s->threads[i].live) {
    NB_THREAD_STATE *t = &s->threads[i]; memset(t, 0, sizeof(*t)); t->id = id; t->live = 1;
    if (s->owner && id != s->owner) {if (!suspend(ctx, id)) return 0; t->held = 1;}
    return 1;
  }
  return 0;
}
static int nb_begin(NB_STEP *s, uint32_t owner, uintptr_t site, nb_suspend_fn suspend, void *ctx) {
  if (s->owner || !nb_thread(s, owner)) return 0;
  s->owner = owner; s->site = site;
  for (unsigned i = 0; i < NB_THREADS; ++i) {
    NB_THREAD_STATE *t = &s->threads[i];
    if (t->live && t->id != owner) {if (t->held || !suspend(ctx, t->id)) return 0; t->held = 1;}
  }
  return 1;
}
static int nb_defer(NB_STEP *s, uint32_t id) {
  NB_THREAD_STATE *t = nb_thread(s, id);
  if (!s->owner || s->owner == id || !t || t->held != 1 || t->deferred) return 0;
  t->deferred = 1; return 1;
}
/* Caller MUST reinstall the original trap and restore the owner's flags first. */
static int nb_finish(NB_STEP *s, uint32_t owner, nb_suspend_fn resume, void *ctx) {
  if (!owner || s->owner != owner) return 0;
  for (unsigned i = 0; i < NB_THREADS; ++i) {
    NB_THREAD_STATE *t = &s->threads[i];
    if (t->held) {if (t->held != 1 || !resume(ctx, t->id)) return 0; t->held = 0; t->deferred = 0;}
  }
  s->owner = 0; s->site = 0; return 1;
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
static int nb_snapshot_qos(uintptr_t address, NB_QOS *out, nb_read_fn read, void *ctx) {
  memset(out, 0, sizeof(*out));
  if (!address) return 1;
  if (address > UINTPTR_MAX - sizeof(*out) || !read(ctx, address, out, sizeof(*out))) return 0;
  return out->length == sizeof(*out) && out->level <= 3 && out->tracking <= 1 && out->effective <= 1;
}
#endif
