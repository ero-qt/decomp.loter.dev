#include <emscripten/emscripten.h>
#include "session.h"

// the bytes that the disassembler reads for 1 instruction, which cover x86's longest instruction of 15 bytes
#define MAX_INSTRUCTION_BYTES 32
// the size of Rizin's buffer for an instruction's text in `pDj`
#define MAX_TEXT_BYTES 512

/**
 * \brief Writes an instruction's text with Rizin's names into text the way `pDj` does, with the function's variables
 * first and then the flags of the addresses.
 */
static void write_named_text(RzCore *core, ut64 addr, RzAnalysisOp *op, RzAnalysisHint *hint, const char *opcode, char *text, bool sub_var) {
	bool big_endian = rz_asm_is_big_endian_set(core->rasm);
	core->parser->subrel_addr = 0;
	ut64 subrel_addr = UT64_MAX;
	if (core->parser->subrel && rz_io_read_i(core->io, op->ptr, &subrel_addr, op->refptr, big_endian)) {
		core->parser->subrel_addr = subrel_addr;
	}

	char *raw = rz_str_dup(opcode);
	if (sub_var && raw) {
		RzAnalysisFunction *fcn = rz_analysis_get_fcn_in(core->analysis, addr, RZ_ANALYSIS_FCN_TYPE_NULL);
		rz_parse_subvar(core->parser, fcn, op, raw, text, MAX_TEXT_BYTES);
	}
	if (!*text) {
		rz_str_ncpy(text, opcode, MAX_TEXT_BYTES);
	}

	// copies the text first, because the filter's input and output have to be different buffers
	char *substituted = rz_str_dup(text);
	if (substituted) {
		rz_parse_filter(core->parser, addr, core->flags, hint, substituted, text, MAX_TEXT_BYTES, big_endian);
	}
	free(substituted);
	free(raw);
}

/**
 * \brief Writes the instruction at the start of bytes as a JSON object and returns its size, which is at least 1.
 */
static size_t add_instruction(RzCore *core, PJ *j, ut64 addr, const ut8 *bytes, size_t left, bool sub_var) {
	size_t length = RZ_MIN(left, MAX_INSTRUCTION_BYTES);
	RzAnalysisHint *hint = rz_analysis_hint_get(core->analysis, addr);
	RzAnalysisOp op;
	rz_analysis_op_init(&op);
	RzAsmOp asm_op;
	rz_asm_op_init(&asm_op);
	rz_asm_set_pc(core->rasm, addr);
	int analyzed = rz_analysis_op(core->analysis, &op, addr, bytes, length, RZ_ANALYSIS_OP_MASK_OPEX | RZ_ANALYSIS_OP_MASK_HINT);
	int disassembled = rz_asm_disassemble(core->rasm, &asm_op, bytes, length);

	pj_o(j);
	session_put_address(j, "addr", addr);
	size_t size;
	if (analyzed < 1 || disassembled < 1) {
		size = RZ_MAX(rz_analysis_archinfo(core->analysis, RZ_ANALYSIS_ARCHINFO_MIN_OP_SIZE), 1);
		pj_kn(j, "size", size);
		pj_ks(j, "text", "invalid");
		pj_ks(j, "opcode", "invalid");
	} else {
		char text[MAX_TEXT_BYTES] = { 0 };
		const char *opcode = rz_asm_op_get_asm(&asm_op);
		size = RZ_MAX(rz_asm_op_get_size(&asm_op), 1);
		write_named_text(core, addr, &op, hint, opcode ? opcode : "", text, sub_var);
		pj_kn(j, "size", size);
		pj_ks(j, "text", text);
		pj_ks(j, "opcode", opcode ? opcode : "");
		if (op.jump != UT64_MAX) {
			session_put_address(j, "jump", op.jump);
		}
	}
	pj_end(j);

	rz_asm_op_fini(&asm_op);
	rz_analysis_op_fini(&op);
	rz_analysis_hint_free(hint);
	return size;
}

/**
 * \brief Disassembles the instructions of size bytes from an address until their bytes reach max_bytes, and returns
 * each one's address, size, text with Rizin's names, raw text and jump target as JSON, or NULL when the bytes can't be
 * read.
 *
 * Reads only the bytes that the instructions need, because `pDj` passes each instruction all the bytes after it and
 * its time grows faster than the bytes. Takes Rizin's settings for the names like `pDj`. The caller frees the result
 * with free().
 */
EMSCRIPTEN_KEEPALIVE char *session_disassemble(Session *session, const char *addr, size_t size, size_t max_bytes) {
	RzCore *core = session->core;
	ut64 start = strtoull(addr, NULL, 16);
	size_t length = RZ_MIN(size, max_bytes + MAX_INSTRUCTION_BYTES);
	ut8 *bytes = malloc(RZ_MAX(length, 1));
	if (!bytes || !rz_io_read_at_mapped(core->io, start, bytes, length)) {
		free(bytes);
		return NULL;
	}

	core->parser->subrel = rz_config_get_b(core->config, "asm.sub.rel");
	core->parser->localvar_only = rz_config_get_b(core->config, "asm.sub.varonly");
	bool sub_var = rz_config_get_b(core->config, "asm.sub.var");

	PJ *j = pj_new();
	pj_a(j);
	for (size_t offset = 0; offset < length && offset < max_bytes;) {
		offset += add_instruction(core, j, start + offset, bytes + offset, length - offset, sub_var);
	}
	pj_end(j);
	free(bytes);
	return pj_drain(j);
}
