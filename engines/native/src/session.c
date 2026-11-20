#include <emscripten/emscripten.h>
#include "session.h"

extern RzCorePlugin rz_core_plugin_ghidra;

/**
 * \brief Points the shared console at the session's core and returns the core.
 *
 * Rizin has 1 console for all cores and calls back into the core that registered last.
 */
RzCore *session_use(Session *session) {
	rz_core_bind_cons(session->core);
	return session->core;
}

/**
 * \brief Writes an address as a hex string, because the worker's numbers lose the low bits of addresses above 2^53.
 */
void session_put_address(PJ *j, const char *key, ut64 addr) {
	char text[32];
	pj_ks(j, key, rz_strf(text, "0x%" PFMT64x, addr));
}

/**
 * \brief Starts a session with a new core that has the Ghidra plugin and prints plain text.
 */
EMSCRIPTEN_KEEPALIVE Session *session_new(void) {
	Session *session = RZ_NEW0(Session);
	if (!session) {
		return NULL;
	}

	session->core = rz_core_new();
	if (!session->core) {
		free(session);
		return NULL;
	}

	RzConfig *config = session->core->config;
	rz_core_plugin_add(session->core, &rz_core_plugin_ghidra);
	rz_config_set_i(config, "scr.color", 0);
	rz_config_set_b(config, "scr.interactive", false);
	rz_config_set_b(config, "scr.prompt", false);
	rz_config_set_b(config, "scr.utf8", false);
	return session;
}

/**
 * \brief Frees a session and clears the shared console's break state.
 *
 * A freed core leaves the break state set, which makes every later command stop at once.
 */
EMSCRIPTEN_KEEPALIVE void session_free(Session *session) {
	rz_core_free(session->core);
	rz_cons_break_clear();
	free(session);
}

/**
 * \brief Loads the open file's binary and checks that a plugin other than `any` reads it.
 *
 * Rizin reads every file with the plugin `any`.
 */
static bool load_binary(RzCore *core, const char *path) {
	if (!rz_core_bin_load(core, path, UT64_MAX)) {
		return false;
	}

	RzBinObject *object = rz_bin_cur_object(core->bin);
	return object && object->plugin && strcmp(object->plugin->name, "any");
}

/**
 * \brief Opens a file, loads its binary and returns whether Rizin reads the binary's format.
 *
 * A fat Mach-O file needs asm.arch and asm.bits to pick a slice, so the open tries the AArch64 slice, then the x86-64
 * one.
 */
EMSCRIPTEN_KEEPALIVE bool session_open(Session *session, const char *path) {
	static const struct {
		const char *arch;
		int bits;
	} slices[] = { { "arm", 64 }, { "x86", 64 } };

	RzCore *core = session_use(session);
	if (!rz_core_file_open(core, path, RZ_PERM_R, 0)) {
		return false;
	}
	if (load_binary(core, path)) {
		return true;
	}

	for (size_t i = 0; i < RZ_ARRAY_SIZE(slices); i++) {
		rz_config_set(core->config, "asm.arch", slices[i].arch);
		rz_config_set_i(core->config, "asm.bits", slices[i].bits);
		if (load_binary(core, path)) {
			return true;
		}
	}
	return false;
}

/**
 * \brief Runs a Rizin command and returns its output, which the caller frees with free().
 */
EMSCRIPTEN_KEEPALIVE char *session_cmd(Session *session, const char *cmd) {
	return rz_core_cmd_str(session_use(session), cmd);
}
