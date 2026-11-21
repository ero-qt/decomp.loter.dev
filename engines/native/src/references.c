#include <emscripten/emscripten.h>
#include "session.h"

static int compare_xrefs(const void *a, const void *b, void *user) {
	ut64 left = ((const RzAnalysisXRef *)a)->from;
	ut64 right = ((const RzAnalysisXRef *)b)->from;
	return left < right ? -1 : left > right;
}

/**
 * \brief Returns the addresses of the code and data that refer to an address, in address order, as a JSON array of hex
 * strings.
 *
 * The caller frees the result with free().
 */
EMSCRIPTEN_KEEPALIVE char *session_references(Session *session, const char *addr) {
	RzCore *core = session_use(session);
	RzList *xrefs = rz_analysis_xrefs_get_to(core->analysis, strtoull(addr, NULL, 16));
	if (xrefs) {
		rz_list_sort(xrefs, compare_xrefs, NULL);
	}

	PJ *j = pj_new();
	pj_a(j);
	RzListIter *it;
	RzAnalysisXRef *xref;
	rz_list_foreach (xrefs, it, xref) {
		char text[32];
		pj_s(j, rz_strf(text, "0x%" PFMT64x, xref->from));
	}
	pj_end(j);
	rz_list_free(xrefs);
	return pj_drain(j);
}

/**
 * \brief Returns the first max strings of the binary with their addresses as hex strings, each cut after max_bytes, as
 * JSON.
 *
 * Only cuts a string between 2 characters of UTF-8. The caller frees the result with free().
 */
EMSCRIPTEN_KEEPALIVE char *session_strings(Session *session, size_t max, size_t max_bytes) {
	RzBinObject *object = rz_bin_cur_object(session_use(session)->bin);
	const RzPVector *strings = object ? rz_bin_object_get_strings(object) : NULL;
	size_t count = strings ? rz_pvector_len(strings) : 0;

	PJ *j = pj_new();
	pj_a(j);
	for (size_t i = 0; i < count && i < max; i++) {
		const RzBinString *string = rz_pvector_at(strings, i);
		const char *value = string->string ? string->string : "";
		size_t full = strlen(value);
		size_t length = RZ_MIN(full, max_bytes);
		// steps back to a character's start, because only a character's later bytes start with the bits 10
		while (length > 0 && length < full && (value[length] & 0xc0) == 0x80) {
			length--;
		}

		char *text = rz_str_ndup(value, length);
		pj_o(j);
		session_put_address(j, "addr", string->vaddr);
		pj_ks(j, "text", text);
		pj_end(j);
		free(text);
	}
	pj_end(j);
	return pj_drain(j);
}
