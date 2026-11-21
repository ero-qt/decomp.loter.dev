#include "session.h"

// the largest file whose RTTI the engine recovers, in bytes of sections, because the recovery reads every section
// in 1 call that can't be canceled
#define MAX_RTTI_BYTES (64 * 1024 * 1024)

/**
 * \brief Returns whether the engine recovers the classes of a binary from its RTTI: a binary without function
 * symbols, whose classes nothing else shows, within MAX_RTTI_BYTES of sections.
 */
static bool needs_rtti(RzBinObject *object) {
	const RzPVector *symbols = rz_bin_object_get_symbols(object);
	void **it;
	if (symbols) {
		rz_pvector_foreach (symbols, it) {
			if (listing_is_function(*it)) {
				return false;
			}
		}
	}

	const RzPVector *sections = rz_bin_object_get_sections_all(object);
	ut64 bytes = 0;
	if (sections) {
		rz_pvector_foreach (sections, it) {
			ut64 size = ((RzBinSection *)*it)->vsize;
			if (UT64_ADD_OVFCHK(bytes, size)) {
				return false;
			}
			bytes += size;
		}
	}
	return bytes <= MAX_RTTI_BYTES;
}

/**
 * \brief Adds the classes from the RTTI of a binary without function symbols, each with the addresses of the functions
 * in its vtables.
 *
 * Recovers the classes once per session, because a listing after a PDB file's load lists them again.
 */
void classes_add_rtti(PJ *j, Session *session, RzBinObject *object) {
	pj_ka(j, "classes");
	if (!needs_rtti(object)) {
		pj_end(j);
		return;
	}

	RzCore *core = session->core;
	if (!session->is_rtti_recovered) {
		rz_analysis_rtti_recover_all(core->analysis);
		session->is_rtti_recovered = true;
	}
	RzPVector *classes = rz_analysis_class_get_all(core->analysis, true);
	void **it;
	rz_pvector_foreach (classes, it) {
		const char *name = sdbkv_key(*it);
		RzVector *methods = rz_analysis_class_method_get_all(core->analysis, name);
		pj_o(j);
		pj_ks(j, "name", name);
		pj_ka(j, "methods");
		RzAnalysisMethod *method;
		rz_vector_foreach (methods, method) {
			char text[32];
			pj_s(j, rz_strf(text, "0x%" PFMT64x, method->addr));
		}
		pj_end(j);
		pj_end(j);
		rz_vector_free(methods);
	}
	rz_pvector_free(classes);
	pj_end(j);
}
