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
 * \brief Runs a Rizin command and returns its output, which the caller frees with free().
 */
EMSCRIPTEN_KEEPALIVE char *session_cmd(Session *session, const char *cmd) {
	return rz_core_cmd_str(session_use(session), cmd);
}
