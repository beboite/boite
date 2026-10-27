#include "contracts.h"
#include <assert.h>
#include <stdio.h>
typedef struct {int count[4]; unsigned suspended, resumed;} TRACE;
static int hold(void *ctx, uint32_t id) {TRACE *t = ctx; assert(id < 4); ++t->count[id]; ++t->suspended; return 1;}
static int release(void *ctx, uint32_t id) {TRACE *t = ctx; assert(id < 4 && t->count[id] == 1); --t->count[id]; ++t->resumed; return 1;}
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
  NB_STEP s = {0}; TRACE t = {0};
  assert(nb_join(&s, 1, hold, &t) && nb_join(&s, 2, hold, &t));
  assert(nb_begin(&s, 1, 0x100, hold, &t));
  assert(s.owner == 1 && t.count[1] == 0 && t.count[2] == 1);
  /* B's debug event was queued before A explicitly suspended it. */
  assert(nb_defer(&s, 2));
  assert(!nb_begin(&s, 2, 0x200, hold, &t));
  assert(s.owner == 1 && s.site == 0x100 && t.count[1] == 0 && t.count[2] == 1);
  assert(nb_join(&s, 3, hold, &t) && t.count[3] == 1);
  assert(!nb_finish(&s, 2, release, &t));
  assert(nb_finish(&s, 1, release, &t)); /* trap A rearmed before release */
  assert(!s.owner && t.count[2] == 0 && t.count[3] == 0);
  assert(nb_begin(&s, 2, 0x200, hold, &t)); /* replay B decodes afresh */
  assert(t.count[1] == 1 && t.count[2] == 0);
  assert(nb_finish(&s, 2, release, &t));
  assert(t.suspended == t.resumed && t.count[1] == 0 && t.count[2] == 0 && t.count[3] == 0);
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
  unsigned char handles[96]={0}; uint64_t count=2, control=20, candidate=UINT64_C(0x10000000000001b4), other=24;
  memcpy(handles,&count,8); memcpy(handles+16,&control,8); memcpy(handles+56,&other,8);
  assert(nb_credential_absent(handles,sizeof(handles),candidate,control));
  assert(!nb_credential_absent(handles,95,candidate,control)); /* Truncated final entry. */
  assert(!nb_credential_absent(handles,sizeof(handles),candidate,28)); /* Missing positive control. */
  assert(!nb_credential_absent(handles,sizeof(handles),control,control)); /* Numeric collision. */
  assert(!nb_credential_absent(handles,sizeof(handles),0,control));
  memcpy(handles+56,&candidate,8);
  assert(!nb_credential_absent(handles,sizeof(handles),candidate,control));
  count=UINT64_MAX; memcpy(handles,&count,8);
  assert(!nb_credential_absent(handles,sizeof(handles),candidate,control));
  count=0; memcpy(handles,&count,8);
  assert(!nb_credential_absent(handles,sizeof(handles),candidate,control));
  puts("NB_LOCAL queued-replay=1 balanced=1 progress=2 pointer-contracts=1 qos-snapshot=1 create-abi=1 credential-snapshot=1"); return 0;
}
