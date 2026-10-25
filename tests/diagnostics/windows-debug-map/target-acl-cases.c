#include <stdio.h>
#include "target-acl.h"

/* Windows ACL/ACCESS_ALLOWED_ACE/SID wire layout, with two synthetic trustees.
 * The kernel expands GENERIC_ALL in the observed process/thread descriptor. */
static void fixture(unsigned char bytes[48], uint32_t mask) {
  memset(bytes, 0, 48); bytes[0] = 2; bytes[2] = 48; bytes[4] = 2;
  for (unsigned int i = 0; i < 2; i++) {
    unsigned int start = 8 + i * 20;
    bytes[start + 2] = 20; memcpy(bytes + start + 4, &mask, 4);
    bytes[start + 8] = 1; bytes[start + 9] = 1; bytes[start + 15] = 5;
    bytes[start + 16] = (unsigned char)(18 + i);
  }
}
static unsigned int cases;
#define CHECK(name, expression) do { cases++; if (!(expression)) { \
  fprintf(stderr, "target ACL case failed: %s\n", name); return 1; } } while (0)

int main(void) {
  unsigned char wanted[48], actual[48], changed[48];
  fixture(wanted, 0x10000000); fixture(actual, 0x001fffff);
  CHECK("GENERIC_ALL expands for process/thread objects", target_acl_matches(wanted, 48, actual, 48, 0x001fffff));
  fixture(changed, 0x80000000);
  CHECK("unsupported generic rights refuse", !target_acl_matches(changed, 48, changed, 48, 0x001fffff));
  CHECK("explicit rights remain exact", target_acl_matches(actual, 48, actual, 48, 0x001fffff));
  CHECK("unexpanded observed rights refuse", !target_acl_matches(wanted, 48, wanted, 48, 0x001fffff));
  memcpy(changed, actual, 48); changed[12] &= 0xfe;
  CHECK("missing terminate right refuses", !target_acl_matches(wanted, 48, changed, 48, 0x001fffff));
  memcpy(changed, actual, 48); changed[15] |= 4;
  CHECK("additional rights refuse", !target_acl_matches(wanted, 48, changed, 48, 0x001fffff));
  memcpy(changed, actual, 48); changed[44] ^= 1;
  CHECK("changed trustee refuses", !target_acl_matches(wanted, 48, changed, 48, 0x001fffff));
  memcpy(changed, actual, 48); changed[9] = 0x10;
  CHECK("changed inheritance refuses", !target_acl_matches(wanted, 48, changed, 48, 0x001fffff));
  memcpy(changed, actual, 48); changed[4] = 1;
  CHECK("missing ACE refuses", !target_acl_matches(wanted, 48, changed, 48, 0x001fffff));
  memcpy(changed, actual, 48); changed[24] = 19; changed[44] = 18;
  CHECK("reordered trustees refuse", !target_acl_matches(wanted, 48, changed, 48, 0x001fffff));
  memcpy(changed, actual, 48); changed[8] = 1;
  CHECK("unsupported ACE type refuses", !target_acl_matches(changed, 48, changed, 48, 0x001fffff));
  memcpy(changed, actual, 48); changed[1] = 1;
  CHECK("reserved ACL bytes refuse", !target_acl_matches(changed, 48, changed, 48, 0x001fffff));
  CHECK("truncated descriptor refuses", !target_acl_matches(wanted, 48, actual, 47, 0x001fffff));
  memcpy(changed, actual, 48); changed[2] = 47;
  CHECK("wrong ACL extent refuses", !target_acl_matches(changed, 48, changed, 48, 0x001fffff));
  memcpy(changed, actual, 48); changed[10] = 18;
  CHECK("wrong ACE extent refuses", !target_acl_matches(changed, 48, changed, 48, 0x001fffff));
  memcpy(changed, actual, 48); changed[17] = 16;
  CHECK("out of range SID extent refuses", !target_acl_matches(changed, 48, changed, 48, 0x001fffff));
  CHECK("missing ACL refuses", !target_acl_matches(NULL, 0, actual, 48, 0x001fffff));
  CHECK("wrong object mapping refuses", !target_acl_matches(wanted, 48, actual, 48, 0x000f003f));
  printf("TARGET_ACL_CASES_PASS: %u cases\n", cases); return 0;
}
