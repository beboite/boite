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
  puts("NB_LOCAL queued-replay=1 balanced=1 progress=2 pointer-contracts=1"); return 0;
}
