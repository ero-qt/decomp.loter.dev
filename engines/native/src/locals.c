#include "session.h"

// the instructions that a scan reads after an instruction that takes a local's address, up to the call that gets it
#define ARGUMENT_OPS 16

/**
 * \brief What the instruction at an address does for the scan of a call's arguments.
 */
typedef struct {
	ut32 type;
	int size;
	ut64 jump;
	char written[32]; ///< the register that the instruction writes, or an empty text
} ScannedOp;

static bool scan_op(RzCore *core, ut64 addr, ScannedOp *scanned) {
	ut8 bytes[32] = { 0 };
	rz_io_read_at_mapped(core->io, addr, bytes, sizeof(bytes));
	RzAnalysisOp op;
	rz_analysis_op_init(&op);
	scanned->size = rz_analysis_op(core->analysis, &op, addr, bytes, sizeof(bytes), RZ_ANALYSIS_OP_MASK_BASIC | RZ_ANALYSIS_OP_MASK_VAL);
	scanned->type = op.type & RZ_ANALYSIS_OP_TYPE_MASK;
	scanned->jump = op.jump;
	rz_str_ncpy(scanned->written, op.dst && op.dst->reg && op.dst->reg->name ? op.dst->reg->name : "", sizeof(scanned->written));
	rz_analysis_op_fini(&op);
	return scanned->size > 0;
}

/**
 * \brief Returns the type that the parameter in a register of the function at an address points to, from the
 * function's signature in the names file, or NULL for a function without one and for a parameter that isn't a pointer.
 */
static const RzType *find_pointed_type(Session *session, ut64 callee_addr, const char *reg) {
	RzCore *core = session->core;
	RzAnalysisFunction *callee = rz_analysis_get_function_at(core->analysis, callee_addr);
	const RzType *signature = ht_up_find(session->parsed_signatures, callee_addr, NULL);
	if (!callee || !callee->cc || !signature) {
		return NULL;
	}

	const RzPVector *args = signature->callable->args;
	for (size_t i = 0; i < rz_pvector_len(args); i++) {
		const char *arg_reg = rz_analysis_cc_arg(core->analysis, callee->cc, (int)i);
		const RzCallableArg *arg = rz_pvector_at(args, i);
		if (arg_reg && !strcmp(arg_reg, reg)) {
			return arg->type && arg->type->kind == RZ_TYPE_KIND_POINTER ? arg->type->pointer.type : NULL;
		}
	}
	return NULL;
}

/**
 * \brief Follows the code after an instruction that puts a local's address into a register, to the call that takes the
 * register as an argument, and returns the type that the call's parameter points to, or NULL.
 *
 * Stops at an instruction that writes the register again and at a jump, because the call then doesn't get the address.
 */
static const RzType *find_argument_type(Session *session, ut64 addr, const ScannedOp *taker) {
	ut64 at = addr + taker->size;
	for (int i = 0; i < ARGUMENT_OPS; i++) {
		ScannedOp scanned;
		if (!scan_op(session->core, at, &scanned)) {
			return NULL;
		}

		switch (scanned.type) {
		case RZ_ANALYSIS_OP_TYPE_CALL:
			return find_pointed_type(session, scanned.jump, taker->written);
		case RZ_ANALYSIS_OP_TYPE_JMP:
		case RZ_ANALYSIS_OP_TYPE_CJMP:
		case RZ_ANALYSIS_OP_TYPE_UJMP:
		case RZ_ANALYSIS_OP_TYPE_UCALL:
		case RZ_ANALYSIS_OP_TYPE_RET:
			return NULL;
		default:
			if (!strcmp(scanned.written, taker->written)) {
				return NULL;
			}
			break;
		}
		at += scanned.size;
	}
	return NULL;
}

/**
 * \brief Gives a local on the stack the type that a parameter of a call points to, when the code passes the local's
 * address to a function with a signature in the names file, like the `bool` behind an `out bool` parameter of C#.
 *
 * Rizin only guesses a number of the size of the local's accesses, which the decompiler takes as the local's type.
 * Only reads `lea`, so a local of ARM code keeps its guessed type.
 */
void locals_apply_pointed_types(Session *session, RzAnalysisFunction *fcn) {
	RzCore *core = session->core;
	RzTypeDB *typedb = rz_analysis_get_type_db(core->analysis);
	void **it;
	rz_pvector_foreach (&fcn->vars, it) {
		RzAnalysisVar *var = *it;
		bool is_guessed = var->origin.kind == RZ_ANALYSIS_VAR_ORIGIN_NONE && var->kind != RZ_ANALYSIS_VAR_KIND_FORMAL_PARAMETER;
		if (!is_guessed || var->storage.type != RZ_ANALYSIS_VAR_STORAGE_STACK || !var->type) {
			continue;
		}

		RzAnalysisVarAccess *access;
		rz_vector_foreach (&var->accesses, access) {
			ut64 addr = fcn->addr + access->offset;
			ScannedOp taker;
			if (!scan_op(core, addr, &taker) || taker.type != RZ_ANALYSIS_OP_TYPE_LEA || !taker.written[0]) {
				continue;
			}

			const RzType *pointed = find_argument_type(session, addr, &taker);
			if (pointed && rz_type_db_get_bitsize(typedb, pointed) == rz_type_db_get_bitsize(typedb, var->type)) {
				rz_analysis_var_set_type(var, rz_type_clone(pointed), false);
				break;
			}
		}
	}
}
