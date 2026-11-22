#include <emscripten/emscripten.h>
#include "session.h"

#define ADDRESS_CMP(addr, at) RZ_NUM_CMP(addr, *(const ut64 *)(at))

static int compare_addresses(const void *a, const void *b, void *user) {
	ut64 left = *(const ut64 *)a;
	ut64 right = *(const ut64 *)b;
	return left < right ? -1 : left > right;
}

static bool add_named_start(RzFlagItem *item, void *user) {
	rz_vector_push((RzVector *)user, &item->offset);
	return true;
}

/**
 * \brief Returns the end of the function at an address: the end of its symbol, else the start of the next function
 * symbol or function of the names file, else UT64_MAX.
 */
static ut64 function_end(Session *session, ut64 addr) {
	RzBinObject *object = rz_bin_cur_object(session->core->bin);
	const RzPVector *symbols = object ? rz_bin_object_get_symbols(object) : NULL;
	RzBinSymbol *own = names_symbol_at(session, addr);
	if (own && own->size) {
		return UT64_ADD_OVFCHK(addr, own->size) ? UT64_MAX : addr + own->size;
	}

	void **it;
	if (symbols && rz_vector_empty(&session->starts)) {
		rz_pvector_foreach (symbols, it) {
			RzBinSymbol *symbol = *it;
			if (listing_is_function(symbol)) {
				rz_vector_push(&session->starts, &symbol->vaddr);
			}
		}
		rz_flag_foreach_prefix(session->core->flags, "names.", -1, add_named_start, &session->starts);
		rz_vector_sort(&session->starts, compare_addresses, false, NULL);
	}

	size_t index;
	rz_vector_upper_bound(&session->starts, addr, index, ADDRESS_CMP);
	return index < rz_vector_len(&session->starts) ? *(ut64 *)rz_vector_index_ptr(&session->starts, index) : UT64_MAX;
}

/**
 * \brief Removes the blocks outside of the function's range.
 *
 * The analysis follows jumps into cold parts and into the functions that a tail jump reaches.
 */
static void keep_own_blocks(RzAnalysisFunction *fcn, ut64 end) {
	for (size_t i = rz_pvector_len(fcn->bbs); i > 0; i--) {
		RzAnalysisBlock *block = rz_pvector_at(fcn->bbs, i - 1);
		if (block->addr < fcn->addr || block->addr >= end) {
			rz_analysis_function_remove_block(fcn, block);
		}
	}
}

/**
 * \brief Wraps the stack offsets of a 32-bit function's variables to 32 bits.
 *
 * The analysis of 32-bit x86 code computes some offsets in 64 bits, like -0x100000010 for -0x10, which the decompiler
 * rejects.
 */
static void wrap_stack_offsets(RzCore *core, RzAnalysisFunction *fcn) {
	if (rz_config_get_i(core->config, "asm.bits") != 32) {
		return;
	}

	void **it;
	rz_pvector_foreach (&fcn->vars, it) {
		RzAnalysisVar *var = *it;
		st64 offset = var->storage.stack_off;
		if (var->storage.type == RZ_ANALYSIS_VAR_STORAGE_STACK && (offset < INT32_MIN || offset > INT32_MAX)) {
			var->storage.stack_off = (st32)(ut32)offset;
			st64 wrapped = var->storage.stack_off;
			char *name = wrapped < 0 ? rz_str_newf("var_%" PFMT64x "h", (ut64)-wrapped) : rz_str_newf("arg_%" PFMT64x "h", (ut64)wrapped);
			rz_analysis_var_rename(var, name, false);
			free(name);
		}
	}
}

/**
 * \brief Gives a function its name for code, or that name with its address when another function has it.
 *
 * Rizin keeps functions' names unique.
 */
static void rename_function(Session *session, RzAnalysisFunction *fcn) {
	char *name = names_for_code(session, fcn->addr);
	if (strcmp(fcn->name, name) && !rz_analysis_function_rename(fcn, name)) {
		char *unique = rz_str_newf("%s_%" PFMT64x, name, fcn->addr);
		rz_analysis_function_rename(fcn, unique);
		free(unique);
	}
	free(name);
}

/**
 * \brief Creates the function at an address that the function calls or jumps to, or gives it its name.
 *
 * The decompiler then shows the call by the target's name and turns a jump to it into a call. Leaves a function that
 * the session prepared alone.
 */
static void name_target(Session *session, ut64 addr) {
	RzCore *core = session->core;
	if (rz_set_u_contains(session->prepared, addr) || !rz_io_is_valid_offset(core->io, addr, RZ_PERM_X)) {
		return;
	}

	RzAnalysisFunction *fcn = rz_analysis_get_function_at(core->analysis, addr);
	if (!fcn) {
		char *name = names_for_code(session, addr);
		fcn = rz_analysis_create_function(core->analysis, name, addr, RZ_ANALYSIS_FCN_TYPE_FCN);
		free(name);
	}
	if (fcn) {
		debug_info_apply_dwarf(core, fcn);
		debug_info_apply_pdb(session, fcn);
		names_file_apply_signature(session, fcn);
		rename_function(session, fcn);
	}
}

/**
 * \brief Returns whether an address is in a section of the binary, which leaves out the small numbers of a binary that
 * starts at 0.
 */
static bool in_section(RzCore *core, ut64 addr) {
	RzBinObject *object = rz_bin_cur_object(core->bin);
	return addr != UT64_MAX && object && rz_bin_get_section_at(object, addr, true);
}

/**
 * \brief Gives a data address the name `data_<address>` when an instruction of the function reads, writes or takes the
 * address and the address doesn't have a flag yet.
 *
 * An immediate that only looks like an address stays a number.
 */
static void name_data(RzCore *core, ut64 from, ut64 addr) {
	ut8 bytes[32] = { 0 };
	rz_io_read_at_mapped(core->io, from, bytes, sizeof(bytes));
	RzAnalysisOp op;
	rz_analysis_op_init(&op);
	rz_analysis_op(core->analysis, &op, from, bytes, sizeof(bytes), RZ_ANALYSIS_OP_MASK_BASIC | RZ_ANALYSIS_OP_MASK_VAL);
	bool memory = (ut64)op.ptr == addr && (op.refptr > 0 || (op.type & RZ_ANALYSIS_OP_TYPE_MASK) == RZ_ANALYSIS_OP_TYPE_LEA);
	rz_analysis_op_fini(&op);

	const RzList *flags = rz_flag_get_list(core->flags, addr);
	if (memory && rz_list_empty(flags) && in_section(core, addr)) {
		char *name = rz_str_newf("data_%" PFMT64x, addr);
		rz_flag_set(core->flags, name, addr, 0);
		free(name);
	}
}

/**
 * \brief Names the blocks that a function jumps to, like `loc_1040`, the targets of its calls and jumps and its data.
 */
static void name_parts(Session *session, RzAnalysisFunction *fcn) {
	void **it;
	rz_pvector_foreach (fcn->bbs, it) {
		RzAnalysisBlock *block = *it;
		if (block->addr != fcn->addr) {
			char *label = rz_str_newf("loc_%" PFMT64x, block->addr);
			rz_analysis_function_set_label(fcn, label, block->addr);
			free(label);
		}
	}

	RzList *xrefs = rz_analysis_function_get_xrefs_from(fcn);
	RzListIter *xref_it;
	RzAnalysisXRef *xref;
	rz_list_foreach (xrefs, xref_it, xref) {
		if (xref->type == RZ_ANALYSIS_XREF_TYPE_DATA) {
			name_data(session->core, xref->from, xref->to);
		} else if (xref->type != RZ_ANALYSIS_XREF_TYPE_STRING && !rz_analysis_function_contains(fcn, xref->to)) {
			name_target(session, xref->to);
		}
	}
	rz_list_free(xrefs);
}

/**
 * \brief Analyzes the function at an address on the first request for it, only keeps its own blocks and adds its debug
 * information.
 */
static RzAnalysisFunction *prepare(Session *session, ut64 addr) {
	RzCore *core = session->core;
	RzAnalysisFunction *fcn = rz_analysis_get_function_at(core->analysis, addr);
	if (fcn && rz_set_u_contains(session->prepared, addr)) {
		return fcn;
	}

	// analyzes again a function that another function's analysis created, because that one doesn't have variables
	// and may have the blocks of other functions
	if (fcn) {
		rz_analysis_function_delete(fcn);
	}
	if (!rz_core_analysis_function_add(core, NULL, addr, false)) {
		return NULL;
	}
	fcn = rz_analysis_get_function_at(core->analysis, addr);
	if (!fcn) {
		return NULL;
	}

	rz_set_u_add(session->prepared, addr);
	keep_own_blocks(fcn, function_end(session, addr));
	wrap_stack_offsets(core, fcn);
	debug_info_apply_dwarf(core, fcn);
	debug_info_apply_pdb(session, fcn);
	names_file_apply_signature(session, fcn);
	rename_function(session, fcn);
	name_parts(session, fcn);
	return fcn;
}

/**
 * \brief Prepares the function at an address for the decompiler and returns its address, the bytes of its blocks, its
 * name and its signature as JSON, or NULL when Rizin doesn't find a function there.
 *
 * The caller frees the result with free().
 */
EMSCRIPTEN_KEEPALIVE char *session_prepare(Session *session, const char *addr) {
	RzAnalysisFunction *fcn = prepare(session, strtoull(addr, NULL, 16));
	if (!fcn) {
		return NULL;
	}

	char *signature = rz_analysis_function_get_signature(fcn);
	PJ *j = pj_new();
	pj_o(j);
	session_put_address(j, "addr", fcn->addr);
	pj_kn(j, "size", rz_analysis_function_realsize(fcn));
	pj_ks(j, "name", fcn->name);
	pj_ks(j, "signature", signature ? signature : "");
	pj_end(j);
	free(signature);
	return pj_drain(j);
}

/**
 * \brief Returns the signature of the function at an address from its debug information, else the demangled name of
 * its symbol or PDB function when that name has the parameter types, else NULL.
 *
 * The caller frees the result with free().
 */
EMSCRIPTEN_KEEPALIVE char *session_describe(Session *session, const char *addr) {
	RzAnalysisFunction *fcn = prepare(session, strtoull(addr, NULL, 16));
	if (!fcn) {
		return NULL;
	}

	RzCore *core = session->core;
	if (fcn->has_debuginfo || rz_type_func_exist(rz_analysis_get_type_db(core->analysis), fcn->name)) {
		return rz_analysis_function_get_signature(fcn);
	}

	RzBinSymbol *symbol = names_symbol_at(session, fcn->addr);
	const char *name = symbol && RZ_STR_ISNOTEMPTY(symbol->dname) ? symbol->dname : NULL;
	const RzList *flags = name ? NULL : rz_flag_get_list(core->flags, fcn->addr);
	RzListIter *it;
	RzFlagItem *flag;
	rz_list_foreach (flags, it, flag) {
		if (rz_str_startswith(flag->name, "pdb.") && RZ_STR_ISNOTEMPTY(flag->realname) && strchr(flag->realname, '(')) {
			name = flag->realname;
		}
	}
	return name && strchr(name, '(') ? names_signature(name) : NULL;
}
