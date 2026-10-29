#include <stdint.h>
#include <stddef.h>
#include <string.h>

/* Compare the explicit allow-only fixture ACL, including its trustees, ACE
 * order, inheritance flags and exact rights. Windows expands GENERIC_ALL for
 * the created object; normalize that expected mask only, never its descriptor.
 * This wire-layout check also runs without Win32 or mocked security APIs. */
static int target_acl_matches(const void *wanted, size_t wanted_bytes,
    const void *actual, size_t actual_bytes, uint32_t all_access) {
  if (!wanted || !actual || wanted_bytes < 8 || wanted_bytes > 2048 ||
      wanted_bytes != actual_bytes || !all_access || (all_access & 0xf0000000)) return 0;
  const unsigned char *w = wanted, *a = actual;
  if (memcmp(w, a, 8) || (w[0] != 2 && w[0] != 4) || w[1] || w[6] || w[7]) return 0;
  uint16_t extent, count; memcpy(&extent, w + 2, 2); memcpy(&count, w + 4, 2);
  if (extent != wanted_bytes || !count) return 0;
  size_t at = 8;
  for (unsigned int i = 0; i < count; i++) {
    if (at + 8 > wanted_bytes || memcmp(w + at, a + at, 4) || w[at] != 0) return 0;
    uint16_t bytes; memcpy(&bytes, w + at + 2, 2);
    if (bytes < 16 || bytes > wanted_bytes - at || w[at + 8] != 1 || w[at + 9] > 15 ||
        bytes != 16 + w[at + 9] * 4 || memcmp(w + at + 8, a + at + 8, bytes - 8)) return 0;
    uint32_t wanted_mask, actual_mask;
    memcpy(&wanted_mask, w + at + 4, 4); memcpy(&actual_mask, a + at + 4, 4);
    // The pinned fixture uses GENERIC_ALL only; other generic requests have
    // no mapping in this diagnostic and must not silently lose any bits.
    if (wanted_mask & 0xe0000000) return 0;
    if (wanted_mask & 0x10000000) wanted_mask = (wanted_mask & ~0x10000000u) | all_access;
    if (wanted_mask != actual_mask) return 0;
    at += bytes;
  }
  return at == wanted_bytes;
}
