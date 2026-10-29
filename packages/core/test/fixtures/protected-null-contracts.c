#include "protected-null-contracts.h"
#include <assert.h>
#include <stdio.h>

typedef struct {unsigned held[301], suspensions, resumes; unsigned terminating[301];} TRACE;
static int hold(void *ctx, uint32_t id) {
  TRACE *t = ctx; assert(id && id <= 300);
  if (t->terminating[id]) return NB_TERMINATING;
  assert(!t->held[id]); t->held[id]++; t->suspensions++; return NB_HELD;
}
static int release(void *ctx, uint32_t id) {
  TRACE *t = ctx; assert(id && id <= 300 && t->held[id] == 1);
  t->held[id]--; t->resumes++; return 1;
}
static int query(void *ctx, uintptr_t address, NB_REGION *r) {
  int mode = *(int *)ctx;
  *r = (NB_REGION){address & ~(uintptr_t)4095, 4096, 1, 1, 0};
  if (mode == 1 && address >= 0x2000) r->writable = 0;
  if (mode == 2 && address >= 0x2000) r->committed = 0;
  if (mode == 3) r->guarded = 1;
  if (mode == 4) r->size = 0;
  if (mode == 5) {r->base = UINTPTR_MAX - 2; r->size = 4096;}
  return mode != 6;
}
typedef struct {NB_QOS value; unsigned reads; int readable;} QOS_MEMORY;
static int read_qos(void *ctx, uintptr_t address, void *out, size_t size) {
  QOS_MEMORY *m = ctx; ++m->reads;
  assert(address == 0x1000 && size == sizeof(m->value));
  if (!m->readable) return 0;
  memcpy(out, &m->value, size); return 1;
}
int main(void) {
  NB_STEP state = {0}; TRACE trace = {0};
  for (uint32_t id = 1; id <= 300; id++) assert(nb_join(&state, id, hold, &trace));
  assert(nb_begin(&state, 1, 0x1000, hold, &trace) == NB_HELD);
  assert(trace.suspensions == 299 && !trace.held[1]);
  assert(nb_defer(&state, 2));
  assert(!nb_begin(&state, 2, 0x2000, hold, &trace));
  assert(nb_finish(&state, 1, release, &trace));
  assert(trace.suspensions == trace.resumes);
  trace.terminating[3] = trace.terminating[300] = 1;
  assert(nb_begin(&state, 2, 0x2000, hold, &trace) == NB_TERMINATING);
  assert(state.phase == NB_WAIT_EXIT && trace.held[2] == 1);
  assert(nb_wake(&state, release, &trace) && state.phase == NB_WAIT_EXIT);
  assert(nb_depart(&state, 3));
  assert(nb_wake(&state, release, &trace) && state.phase == NB_WAIT_EXIT && trace.held[2] == 1);
  assert(nb_depart(&state, 300));
  assert(nb_wake(&state, release, &trace) && state.phase == NB_REPLAYING && trace.held[2] == 0);
  assert(nb_wake(&state, release, &trace));
  assert(!nb_replayed(&state, 1, 0x2000) && !nb_replayed(&state, 2, 0x1000));
  assert(nb_replayed(&state, 2, 0x2000));
  assert(nb_finish(&state, 2, release, &trace));
  assert(trace.suspensions == trace.resumes);
  int mode = 0;
  assert(nb_outputs(0x1000, 0x2000, query, &mode));
  assert(nb_output_span(0x1ff8, 16, 8, query, &mode));
  assert(!nb_outputs(0x1000, 0x1000, query, &mode));
  assert(!nb_outputs(0x1008, 0x1000, query, &mode));
  assert(!nb_outputs(0x1001, 0x2000, query, &mode));
  assert(!nb_outputs(UINTPTR_MAX - 7, 0x2000, query, &mode));
  for (mode = 1; mode <= 6; ++mode) {
    assert(!nb_outputs(0x1000, 0x2000, query, &mode));
    assert(!nb_output_span(0x1ff8, 16, 8, query, &mode));
  }
  QOS_MEMORY memory = {{12, 2, 0, 1, {0xff, 0xff}}, 0, 1}; NB_QOS snapshot;
  assert(nb_snapshot_qos(0, &snapshot, read_qos, &memory) && !memory.reads && !snapshot.length);
  for (unsigned level = 0; level < 4; ++level) for (unsigned tracking = 0; tracking < 2; ++tracking) for (unsigned effective = 0; effective < 2; ++effective) {
    memory.value = (NB_QOS){12, level, tracking, effective, {0xff, 0xff}};
    unsigned reads = memory.reads;
    assert(nb_snapshot_qos(0x1000, &snapshot, read_qos, &memory) && memory.reads == reads + 1);
    memory.value.level = 99; /* The host uses this detached snapshot, never a target pointer. */
    assert(snapshot.length == 12 && snapshot.level == level && snapshot.tracking == tracking && snapshot.effective == effective);
  }
  const NB_QOS bad[] = {{0, 0, 0, 0, {0}}, {11, 0, 0, 0, {0}}, {13, 0, 0, 0, {0}},
    {12, 4, 0, 0, {0}}, {12, 2, 2, 0, {0}}, {12, 2, 0, 2, {0}}};
  for (unsigned i = 0; i < sizeof(bad) / sizeof(*bad); ++i) {memory.value = bad[i]; assert(!nb_snapshot_qos(0x1000, &snapshot, read_qos, &memory));}
  memory.readable = 0; assert(!nb_snapshot_qos(0x1000, &snapshot, read_qos, &memory));
  unsigned reads = memory.reads;
  assert(!nb_snapshot_qos(UINTPTR_MAX - 4, &snapshot, read_qos, &memory) && memory.reads == reads);
  uint64_t args[7] = {0};
  assert(nb_create_extras(args) == 0);
  args[6] = UINT64_C(0xfeedface00000000);
  assert(nb_create_extras(args) == 0); /* Upper ULONG slot bytes are unspecified. */
  args[6] |= 1;
  assert(nb_create_extras(args) == 4);
  args[6] = UINT64_C(0xfeedface00000000); args[0] = UINT64_C(0x100000000);
  assert(nb_create_extras(args) == 1); /* Pointers still occupy the full slot. */
  args[0] = 0; args[5] = UINT64_C(0x100000000);
  assert(nb_create_extras(args) == 2);
  args[0] = 1; args[6] |= 1;
  assert(nb_create_extras(args) == 7);
  nb_dispose(&state);
  assert(!state.threads && !state.count && !state.owner);
  /* Cancellation destroys the job before freeing parked bookkeeping; it must
   * not issue a speculative wake or run an instruction on the way out. */
  memset(&trace, 0, sizeof(trace)); trace.terminating[2] = 1;
  assert(nb_join(&state, 1, hold, &trace) && nb_join(&state, 2, hold, &trace));
  assert(nb_begin(&state, 1, 0x3000, hold, &trace) == NB_TERMINATING);
  assert(!nb_finish(&state, 1, release, &trace));
  nb_dispose(&state); assert(trace.suspensions == 1 && trace.resumes == 0);
  size_t capacity = SIZE_MAX;
  assert(!nb_grow(NULL, &capacity, sizeof(NB_THREAD_STATE)) && capacity == SIZE_MAX);
  puts("PROTECTED_NULL growth=300 queued-replay=1 terminating-workers=2 balanced=1 cancellation=1 output-spans=1 qos-snapshot=1 create-abi=1");
  return 0;
}
