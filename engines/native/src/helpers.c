#include "session.h"

// the instructions that a scan reads from a function's start, which covers a helper that only passes its call on
#define SCAN_OPS 24
// the calls that a scan follows from a function that raises an exception to the exception's name
#define THROW_DEPTH 3

/**
 * \brief What the straight code from a function's start does until it returns, traps or jumps away.
 */
typedef struct {
	ut64 targets[4]; ///< the functions that the code calls or jumps to
	size_t target_count;
	ut64 data[6]; ///< the addresses that the code takes or reads
	size_t data_count;
	ut64 tail; ///< the function that the code jumps to at its end, or UT64_MAX
	bool is_plain; ///< whether the code reached its end without a branch or an indirect jump
	bool returns;
	bool stops; ///< whether the code ends in a trap or in a jump back into itself, so it never returns
} Scan;

static void add_address(ut64 *list, size_t *count, size_t size, ut64 addr) {
	for (size_t i = 0; i < *count; i++) {
		if (list[i] == addr) {
			return;
		}
	}
	if (*count < size) {
		list[(*count)++] = addr;
	}
}

static bool never_returns(RzCore *core, ut64 addr, int depth);

/**
 * \brief Reads the instructions from an address until the code returns, traps, jumps away, branches or calls a
 * function that doesn't return, because clang leaves out the trap after such a call.
 *
 * Follows a jump forward inside the function, like the jump over the error path of a function that only calls another.
 */
static void scan_code(RzCore *core, ut64 addr, int depth, Scan *scan) {
	memset(scan, 0, sizeof(*scan));
	scan->tail = UT64_MAX;
	ut64 at = addr;
	for (int i = 0; i < SCAN_OPS; i++) {
		ut8 bytes[32] = { 0 };
		rz_io_read_at_mapped(core->io, at, bytes, sizeof(bytes));
		RzAnalysisOp op;
		rz_analysis_op_init(&op);
		int size = rz_analysis_op(core->analysis, &op, at, bytes, sizeof(bytes), RZ_ANALYSIS_OP_MASK_BASIC | RZ_ANALYSIS_OP_MASK_VAL);
		ut32 type = op.type & RZ_ANALYSIS_OP_TYPE_MASK;
		ut64 jump = op.jump;
		ut64 ptr = op.ptr;
		rz_analysis_op_fini(&op);
		if (size < 1) {
			return;
		}

		switch (type) {
		case RZ_ANALYSIS_OP_TYPE_RET:
			scan->returns = true;
			scan->is_plain = true;
			return;
		case RZ_ANALYSIS_OP_TYPE_TRAP:
		case RZ_ANALYSIS_OP_TYPE_ILL:
			scan->stops = true;
			scan->is_plain = true;
			return;
		case RZ_ANALYSIS_OP_TYPE_CALL:
			add_address(scan->targets, &scan->target_count, RZ_ARRAY_SIZE(scan->targets), jump);
			if (depth < THROW_DEPTH && never_returns(core, jump, depth + 1)) {
				scan->stops = true;
				scan->is_plain = true;
				return;
			}
			break;
		case RZ_ANALYSIS_OP_TYPE_JMP:
			if (jump > at && jump - at < 0x40) {
				at = jump;
				continue;
			}

			scan->is_plain = true;
			if (jump >= addr && jump <= at) {
				scan->stops = true;
			} else {
				scan->tail = jump;
				add_address(scan->targets, &scan->target_count, RZ_ARRAY_SIZE(scan->targets), jump);
			}
			return;
		case RZ_ANALYSIS_OP_TYPE_UJMP:
		case RZ_ANALYSIS_OP_TYPE_UCALL:
		case RZ_ANALYSIS_OP_TYPE_CJMP:
		case RZ_ANALYSIS_OP_TYPE_CCALL:
		case RZ_ANALYSIS_OP_TYPE_CRET:
		case RZ_ANALYSIS_OP_TYPE_SWI:
			return;
		default:
			if (ptr && ptr != UT64_MAX) {
				add_address(scan->data, &scan->data_count, RZ_ARRAY_SIZE(scan->data), ptr);
			}
			break;
		}
		at += size;
	}
}

/**
 * \brief Follows the functions that only pass their call on to 1 other function, from an address to the function that
 * does the work, like from an export of IL2CPP's API to the runtime's own function.
 */
static ut64 find_implementation(RzCore *core, ut64 addr) {
	for (int depth = 0; depth < 4; depth++) {
		Scan scan;
		scan_code(core, addr, 0, &scan);
		if (!scan.is_plain || scan.target_count != 1) {
			break;
		}
		addr = scan.targets[0];
	}
	return addr;
}

/**
 * \brief Returns whether the straight code of a function ends without a return, in a trap after its calls, in a jump
 * back into itself or in a jump to such a function.
 */
static bool never_returns(RzCore *core, ut64 addr, int depth) {
	Scan scan;
	scan_code(core, addr, depth, &scan);
	if (!scan.is_plain || scan.returns) {
		return false;
	}
	if (scan.stops) {
		return true;
	}
	return scan.tail != UT64_MAX && depth < THROW_DEPTH && never_returns(core, scan.tail, depth + 1);
}

/**
 * \brief Finds the helper whose text the code of a function or of the functions that it calls points to, like the
 * name of the exception's class that a function of the runtime raises.
 */
static const SessionHelper *find_by_text(Session *session, ut64 addr, int depth) {
	RzCore *core = session->core;
	Scan scan;
	scan_code(core, addr, depth, &scan);
	for (size_t i = 0; i < scan.data_count; i++) {
		char text[64] = { 0 };
		rz_io_read_at_mapped(core->io, scan.data[i], (ut8 *)text, sizeof(text) - 1);
		void **it;
		rz_pvector_foreach (&session->helper_list, it) {
			const SessionHelper *helper = *it;
			if (helper->how == '^' && !strcmp(helper->source, text)) {
				return helper;
			}
		}
	}

	for (size_t i = 0; depth < THROW_DEPTH && i < scan.target_count; i++) {
		const SessionHelper *helper = find_by_text(session, scan.targets[i], depth + 1);
		if (helper) {
			return helper;
		}
	}
	return NULL;
}

static void helper_free(void *item) {
	SessionHelper *helper = item;
	if (helper) {
		free(helper->source);
		free(helper->name);
		free(helper->signature);
		free(helper);
	}
}

/**
 * \brief Drops the helpers of a names file, and starts the list of a new session.
 */
void helpers_clear(Session *session) {
	rz_pvector_fini(&session->helper_list);
	rz_pvector_init(&session->helper_list, helper_free);
	ht_up_free(session->helper_implementations);
	ht_up_free(session->helpers);
	rz_set_u_free(session->checked_helpers);
	rz_set_u_free(session->noreturn_helpers);
	session->helper_implementations = NULL;
	session->helpers = NULL;
	session->checked_helpers = NULL;
	session->noreturn_helpers = NULL;
}

/**
 * \brief Adds a helper of the game's runtime from a line of a names file, which starts with how the session finds the
 * helper's functions, then has what it finds them by, the helper's name, its kind and the C signature of its
 * functions or an empty text, each after a tab.
 *
 * A line with `!` and an export, like `!il2cpp_object_new`, finds the functions that end in the same function as the
 * export. A line with `^` and a text, like `^NullReferenceException`, finds the functions that never return and
 * point to the text. A line with `&` finds the functions that take the address of a global of the names file.
 */
void helpers_add_line(Session *session, const char *line) {
	const char *tab = strchr(line, '\t');
	const char *second = tab ? strchr(tab + 1, '\t') : NULL;
	const char *third = second ? strchr(second + 1, '\t') : NULL;
	SessionHelper *helper = third ? RZ_NEW0(SessionHelper) : NULL;
	if (!helper) {
		return;
	}

	helper->how = line[0];
	helper->source = rz_str_ndup(line + 1, tab - line - 1);
	helper->name = rz_str_ndup(tab + 1, second - tab - 1);
	helper->kind = (ut32)strtoul(second + 1, NULL, 10);
	helper->signature = rz_str_dup(third + 1);
	rz_pvector_push(&session->helper_list, helper);
	if (!session->helpers) {
		session->helper_implementations = ht_up_new(NULL, NULL);
		session->helpers = ht_up_new(NULL, NULL);
		session->checked_helpers = rz_set_u_new();
		session->noreturn_helpers = rz_set_u_new();
	}
	if (helper->how != '!') {
		return;
	}

	RzCore *core = session->core;
	RzBinObject *object = rz_bin_cur_object(core->bin);
	const RzPVector *symbols = object ? rz_bin_object_get_symbols(object) : NULL;
	void **it;
	if (symbols) {
		rz_pvector_foreach (symbols, it) {
			RzBinSymbol *symbol = *it;
			if (symbol->name && !strcmp(symbol->name, helper->source) && rz_io_is_valid_offset(core->io, symbol->vaddr, RZ_PERM_X)) {
				ht_up_insert(session->helper_implementations, find_implementation(core, symbol->vaddr), helper);
				break;
			}
		}
	}
}

/**
 * \brief Makes the function at an address the helper of the names file that takes a global's address.
 */
void helpers_set_global_taker(Session *session, ut64 addr) {
	if (!session->helpers || rz_set_u_contains(session->checked_helpers, addr)) {
		return;
	}

	void **it;
	rz_pvector_foreach (&session->helper_list, it) {
		SessionHelper *helper = *it;
		if (helper->how == '&') {
			rz_set_u_add(session->checked_helpers, addr);
			ht_up_insert(session->helpers, addr, helper);
			return;
		}
	}
}

/**
 * \brief Returns the helper of the names file whose work the function at an address does, or NULL, and sets
 * `is_noreturn` for a function whose code doesn't return, also without a helper.
 */
const SessionHelper *helpers_find(Session *session, ut64 addr, bool *is_noreturn) {
	*is_noreturn = false;
	if (!session->helpers) {
		return NULL;
	}

	RzCore *core = session->core;
	if (!rz_set_u_contains(session->checked_helpers, addr)) {
		rz_set_u_add(session->checked_helpers, addr);
		const SessionHelper *helper = ht_up_find(session->helper_implementations, find_implementation(core, addr), NULL);
		if (!helper && never_returns(core, addr, 0)) {
			helper = find_by_text(session, addr, 0);
			rz_set_u_add(session->noreturn_helpers, addr);
		}
		if (helper) {
			ht_up_insert(session->helpers, addr, (void *)helper);
		}
	}

	*is_noreturn = rz_set_u_contains(session->noreturn_helpers, addr);
	return ht_up_find(session->helpers, addr, NULL);
}
