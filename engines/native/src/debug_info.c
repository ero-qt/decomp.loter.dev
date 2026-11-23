#include <emscripten/emscripten.h>
#include "session.h"

// DWARF register numbers of the stack and frame pointers of x86 and AArch64
#define DWARF_X86_SP    4
#define DWARF_X86_BP    5
#define DWARF_X86_64_SP 7
#define DWARF_X86_64_BP 6
#define DWARF_ARM64_SP  31
#define DWARF_ARM64_BP  29

/**
 * \brief Returns the lowest stack offset that the entry block of a function reaches, which is where the stack pointer
 * stays after the prologue.
 */
static RzStackAddr lowest_stack_offset(RzAnalysisFunction *fcn) {
	RzAnalysisBlock *entry = rz_analysis_get_block_at(fcn->analysis, fcn->addr);
	RzStackAddr lowest = 0;
	for (int i = 0; entry && i < entry->ninstr; i++) {
		RzStackAddr offset = rz_analysis_block_get_sp_at(entry, rz_analysis_block_get_op_addr(entry, i));
		lowest = offset != RZ_STACK_ADDR_INVALID && offset < lowest ? offset : lowest;
	}
	return lowest;
}

static ut8 dwarf_stack_pointer(RzCore *core) {
	if (!rz_analysis_is_cpu(core->analysis, "x86")) {
		return DWARF_ARM64_SP;
	}
	return rz_config_get_i(core->config, "asm.bits") == 64 ? DWARF_X86_64_SP : DWARF_X86_SP;
}

/**
 * \brief Returns the stack offset of a DWARF function's frame base.
 *
 * Rizin places the variables at an offset from the frame base as if the frame base were the stack pointer at the
 * entry.
 */
static RzStackAddr frame_base_offset(RzCore *core, RzAnalysisFunction *fcn, const RzAnalysisDwarfFunction *dwarf_fcn) {
	RzAnalysisDebugInfo *debug_info = rz_analysis_get_debug_info(core->analysis);
	RzBinDwarfDie *die = debug_info->dw && debug_info->dw->info
		? ht_up_find(debug_info->dw->info->die_by_offset, dwarf_fcn->offset, NULL)
		: NULL;
	RzBinDwarfAttr *attr = die ? rz_bin_dwarf_die_get_attr(die, DW_AT_frame_base) : NULL;
	if (!attr || (attr->value.kind != RzBinDwarfAttr_Exprloc && attr->value.kind != RzBinDwarfAttr_Block) ||
		attr->value.block.length < 1) {
		return 0;
	}

	ut8 op = rz_bin_dwarf_block_data(&attr->value.block)[0];
	bool x86 = rz_analysis_is_cpu(core->analysis, "x86");
	int bits = rz_config_get_i(core->config, "asm.bits");
	if (op == DW_OP_call_frame_cfa) {
		return x86 ? bits / 8 : 0;
	}
	if (op < DW_OP_reg0 || op > DW_OP_reg31) {
		return 0;
	}

	ut8 reg = op - DW_OP_reg0;
	if (reg == dwarf_stack_pointer(core)) {
		return lowest_stack_offset(fcn);
	}

	ut8 bp = x86 && bits == 64 ? DWARF_X86_64_BP : DWARF_X86_BP;
	return reg == (x86 ? bp : DWARF_ARM64_BP) ? -fcn->bp_off : 0;
}

/**
 * \brief Moves the DWARF locals of a function at an offset from the frame base by the frame base's stack offset.
 */
static void place_dwarf_locals(RzCore *core, RzAnalysisFunction *fcn, const RzAnalysisDwarfFunction *dwarf_fcn) {
	RzStackAddr frame_base = frame_base_offset(core, fcn, dwarf_fcn);
	ut8 sp = dwarf_stack_pointer(core);
	void **it;
	rz_pvector_foreach (&fcn->vars, it) {
		RzAnalysisVar *var = *it;
		RzAnalysisDwarfVariable *dwarf_var = var->origin.kind == RZ_ANALYSIS_VAR_ORIGIN_DWARF ? var->origin.dw_var : NULL;
		RzBinDwarfLocation *location = dwarf_var && dwarf_var->kind != RZ_ANALYSIS_VAR_KIND_FORMAL_PARAMETER ? dwarf_var->location : NULL;
		if (!location || var->storage.type != RZ_ANALYSIS_VAR_STORAGE_STACK) {
			continue;
		}
		if (location->kind == RzBinDwarfLocationKind_FB_OFFSET) {
			var->storage.stack_off += frame_base;
		} else if (location->kind == RzBinDwarfLocationKind_REGISTER_OFFSET && location->register_number == sp) {
			var->storage.stack_off += lowest_stack_offset(fcn);
		}
	}
}

/**
 * \brief Removes the variables that the analysis found where a variable of the debug information is.
 */
static void remove_shadowed_variables(RzAnalysis *analysis, RzAnalysisFunction *fcn) {
	for (size_t i = rz_pvector_len(&fcn->vars); i > 0; i--) {
		RzAnalysisVar *var = rz_pvector_at(&fcn->vars, i - 1);
		bool stack = var->storage.type == RZ_ANALYSIS_VAR_STORAGE_STACK;
		if (!stack || var->origin.kind != RZ_ANALYSIS_VAR_ORIGIN_NONE) {
			continue;
		}

		void **it;
		rz_pvector_foreach (&fcn->vars, it) {
			RzAnalysisVar *debug_var = *it;
			RzStackAddr start = debug_var->storage.stack_off;
			if (debug_var->origin.kind != RZ_ANALYSIS_VAR_ORIGIN_NONE && debug_var->storage.type == RZ_ANALYSIS_VAR_STORAGE_STACK &&
				var->storage.stack_off >= start && var->storage.stack_off < start + (st64)rz_analysis_var_size(analysis, debug_var)) {
				rz_analysis_function_delete_var(fcn, var);
				break;
			}
		}
	}
}

/**
 * \brief Sets the parameters of a function from a signature.
 *
 * Marks them as parameters, because Rizin counts a variable of unknown kind in a function with debug information as a
 * local.
 */
static void mark_parameters(RzAnalysisFunction *fcn, RzCallable *callable) {
	rz_analysis_function_set_type(fcn->analysis, fcn, callable);
	void **it;
	rz_pvector_foreach (callable->args, it) {
		RzCallableArg *arg = *it;
		RzAnalysisVar *var = arg && arg->name ? rz_analysis_function_get_var_byname(fcn, arg->name) : NULL;
		if (var) {
			var->kind = RZ_ANALYSIS_VAR_KIND_FORMAL_PARAMETER;
		}
	}
}

/**
 * \brief Adds the names and types of the DWARF information to a function.
 *
 * Rizin only adds them in the analysis of the whole binary, so this runs that step on a table with only this function.
 * Sets the parameters from the signature in the type database, because a parameter's DWARF location is often right
 * only at the start of the function.
 */
void debug_info_apply_dwarf(RzCore *core, RzAnalysisFunction *fcn) {
	RzAnalysisDebugInfo *debug_info = rz_analysis_get_debug_info(core->analysis);
	RzAnalysisDwarfFunction *dwarf_fcn = debug_info ? ht_up_find(debug_info->function_by_addr, fcn->addr, NULL) : NULL;
	if (!dwarf_fcn || fcn->has_debuginfo) {
		return;
	}

	HtUP *all = debug_info->function_by_addr;
	HtUP *one = ht_up_new(NULL, NULL);
	ht_up_insert(one, fcn->addr, dwarf_fcn);
	debug_info->function_by_addr = one;
	rz_analysis_dwarf_integrate_functions(core->analysis, core->flags);
	debug_info->function_by_addr = all;
	ht_up_free(one);

	RzCallable *callable = dwarf_fcn->prefer_name
		? rz_type_func_get(rz_analysis_get_type_db(core->analysis), dwarf_fcn->prefer_name)
		: NULL;
	if (callable) {
		mark_parameters(fcn, callable);
	}
	place_dwarf_locals(core, fcn, dwarf_fcn);
	remove_shadowed_variables(core->analysis, fcn);
}

/**
 * \brief Adds the parameters, locals and type of the procedure of the session's PDB file to a function.
 *
 * The load of the PDB file only adds the names of its functions.
 */
void debug_info_apply_pdb(Session *session, RzAnalysisFunction *fcn) {
	RzCore *core = session->core;
	if (session->pdb && !fcn->has_debuginfo &&
		rz_analysis_pdb_integrate_function(core->analysis, session->pdb, rz_bin_get_baddr(core->bin), fcn)) {
		remove_shadowed_variables(core->analysis, fcn);
	}
}

/**
 * \brief Returns the C definition of a struct in the type database, which has the classes of the file's debug
 * information, or NULL for a name without a struct.
 *
 * The caller frees the result with free().
 */
EMSCRIPTEN_KEEPALIVE char *session_struct(Session *session, const char *name) {
	RzTypeDB *typedb = rz_analysis_get_type_db(session->core->analysis);
	RzBaseType *type = rz_type_db_get_base_type(typedb, name);
	if (!type || type->kind != RZ_BASE_TYPE_KIND_STRUCT) {
		return NULL;
	}
	return rz_type_db_base_type_as_pretty_string(typedb, type, RZ_TYPE_PRINT_MULTILINE | RZ_TYPE_PRINT_END_NEWLINE, 1);
}
