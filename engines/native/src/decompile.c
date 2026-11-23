#include <emscripten/emscripten.h>
#include "session.h"

// rz-ghidra's decompile of the function at an address, which writes Ghidra's error into the code when it fails
RzAnnotatedCode *rz_ghidra_decompile_annotated_code(RzCore *core, ut64 addr);

#define DECOMPILER_ERROR "Ghidra Decompiler Error: "

static const char *const highlights[] = {
	[RZ_SYNTAX_HIGHLIGHT_TYPE_KEYWORD] = "keyword",
	[RZ_SYNTAX_HIGHLIGHT_TYPE_COMMENT] = "comment",
	[RZ_SYNTAX_HIGHLIGHT_TYPE_DATATYPE] = "datatype",
	[RZ_SYNTAX_HIGHLIGHT_TYPE_FUNCTION_NAME] = "function_name",
	[RZ_SYNTAX_HIGHLIGHT_TYPE_FUNCTION_PARAMETER] = "function_parameter",
	[RZ_SYNTAX_HIGHLIGHT_TYPE_LOCAL_VARIABLE] = "local_variable",
	[RZ_SYNTAX_HIGHLIGHT_TYPE_CONSTANT_VARIABLE] = "constant_variable",
	[RZ_SYNTAX_HIGHLIGHT_TYPE_GLOBAL_VARIABLE] = "global_variable",
};

static const char *const types[] = {
	[RZ_CODE_ANNOTATION_TYPE_OFFSET] = "offset",
	[RZ_CODE_ANNOTATION_TYPE_SYNTAX_HIGHLIGHT] = "syntax_highlight",
	[RZ_CODE_ANNOTATION_TYPE_FUNCTION_NAME] = "function_name",
	[RZ_CODE_ANNOTATION_TYPE_GLOBAL_VARIABLE] = "global_variable",
	[RZ_CODE_ANNOTATION_TYPE_CONSTANT_VARIABLE] = "constant_variable",
	[RZ_CODE_ANNOTATION_TYPE_LOCAL_VARIABLE] = "local_variable",
	[RZ_CODE_ANNOTATION_TYPE_FUNCTION_PARAMETER] = "function_parameter",
};

/**
 * \brief Adds an annotation like `pdgj` writes it, with its address as a hex string.
 */
static void add_annotation(PJ *j, const RzCodeAnnotation *annotation) {
	pj_o(j);
	pj_kn(j, "start", annotation->start);
	pj_kn(j, "end", annotation->end);
	pj_ks(j, "type", annotation->type < RZ_ARRAY_SIZE(types) ? types[annotation->type] : "");
	switch (annotation->type) {
	case RZ_CODE_ANNOTATION_TYPE_OFFSET:
		session_put_address(j, "offset", annotation->offset.offset);
		break;
	case RZ_CODE_ANNOTATION_TYPE_FUNCTION_NAME:
		pj_ks(j, "name", annotation->reference.name);
		session_put_address(j, "offset", annotation->reference.offset);
		break;
	case RZ_CODE_ANNOTATION_TYPE_GLOBAL_VARIABLE:
	case RZ_CODE_ANNOTATION_TYPE_CONSTANT_VARIABLE:
		session_put_address(j, "offset", annotation->reference.offset);
		break;
	case RZ_CODE_ANNOTATION_TYPE_LOCAL_VARIABLE:
	case RZ_CODE_ANNOTATION_TYPE_FUNCTION_PARAMETER:
		pj_ks(j, "name", annotation->variable.name);
		break;
	case RZ_CODE_ANNOTATION_TYPE_SYNTAX_HIGHLIGHT:
		if (annotation->syntax_highlight.type < RZ_ARRAY_SIZE(highlights)) {
			pj_ks(j, "syntax_highlight", highlights[annotation->syntax_highlight.type]);
		}
		break;
	default:
		break;
	}
	pj_end(j);
}

/**
 * \brief Decompiles the function at an address and returns its C with the annotations like `pdgj`, or Ghidra's error
 * in `errors`, as JSON.
 *
 * Writes addresses as hex strings, where `pdgj` writes numbers that lose the low bits of addresses above 2^53. The
 * caller frees the result with free().
 */
EMSCRIPTEN_KEEPALIVE char *session_decompile(Session *session, const char *addr) {
	RzAnnotatedCode *code = rz_ghidra_decompile_annotated_code(session->core, strtoull(addr, NULL, 16));
	if (!code) {
		return NULL;
	}

	PJ *j = pj_new();
	pj_o(j);
	if (rz_str_startswith(code->code, DECOMPILER_ERROR) && rz_vector_empty(&code->annotations)) {
		pj_ka(j, "errors");
		pj_s(j, code->code);
		pj_end(j);
	} else {
		pj_ks(j, "code", code->code);
		pj_ka(j, "annotations");
		RzCodeAnnotation *annotation;
		rz_vector_foreach (&code->annotations, annotation) {
			add_annotation(j, annotation);
		}
		pj_end(j);
	}
	pj_end(j);
	rz_annotated_code_free(code);
	return pj_drain(j);
}
