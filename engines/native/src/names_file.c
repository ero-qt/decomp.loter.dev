#include <emscripten/emscripten.h>
#include "session.h"

// result of a names file's load -> the reason that the worker reports, in the order of `PdbLoad`
typedef enum {
	NAMES_LOADED,
	NAMES_UNREADABLE,
	NAMES_MISMATCH,
} NamesLoad;

/**
 * \brief A function's address, name and C signature from a line of a names file.
 */
typedef struct {
	ut64 addr;
	const char *name;
	const char *signature; ///< the signature, or NULL for a line without one
	char *csharp; ///< what the function or global is in C#, after the signature, or NULL for a line without it
	bool is_thumb; ///< whether the address had bit 0 set, which marks Thumb code in a 32-bit ARM binary
} NamedAddress;

/**
 * \brief Reads a line of a names file, the address relative to the image in hex, a space, the name, an optional
 * tab with the signature and an optional tab with what the line's function or global is in C#, or returns false for
 * a line without an address and a name.
 *
 * Clears bit 0 of an address in a 32-bit ARM binary, where the bit marks Thumb code, like in Unity's method pointers.
 */
static bool read_line(char *line, ut64 baddr, bool is_arm32, NamedAddress *named) {
	char *end = NULL;
	ut64 rva = strtoull(line, &end, 16);
	if (end == line || *end != ' ' || !end[1]) {
		return false;
	}

	char *tab = strchr(end + 1, '\t');
	char *csharp = tab ? strchr(tab + 1, '\t') : NULL;
	if (tab) {
		*tab = '\0';
	}
	if (csharp) {
		*csharp = '\0';
	}
	named->csharp = csharp ? csharp + 1 : NULL;
	named->is_thumb = is_arm32 && (rva & 1);
	named->addr = baddr + (named->is_thumb ? rva & ~1ULL : rva);
	named->name = end + 1;
	named->signature = tab && tab[1] ? tab + 1 : NULL;
	return true;
}

/**
 * \brief Adds the C types of a header to the type database, like the structs of a game's classes, which the
 * signatures of a names file point to.
 *
 * Keeps the types that parse when others don't, because a function whose signature doesn't parse only keeps its name.
 */
static void load_header(RzCore *core, const char *path) {
	char *text = RZ_STR_ISNOTEMPTY(path) ? rz_file_slurp(path, NULL) : NULL;
	if (!text) {
		return;
	}

	char *error = NULL;
	rz_type_parse_string(rz_analysis_get_type_db(core->analysis), text, &error);
	free(error);
	free(text);
}

/**
 * \brief Adds a global variable with its name and C type at each address of a names file's globals, like a class's
 * TypeInfo global with the class's struct, which the decompiler then reads fields through.
 *
 * Takes `void *` for a type that doesn't parse, because a global without a type doesn't get its name in the decompiler.
 */
static void load_globals(Session *session, RzVector /*<NamedAddress>*/ *globals) {
	RzCore *core = session->core;
	RzTypeParser *parser = rz_analysis_get_type_db(core->analysis)->parser;
	NamedAddress *named;
	rz_vector_foreach (globals, named) {
		char *error = NULL;
		RzType *type = named->signature ? rz_type_parse_string_single(parser, named->signature, &error) : NULL;
		free(error);
		if (!type) {
			type = rz_type_parse_string_single(parser, "void *", NULL);
		}

		// the global takes the type, also when it doesn't get added
		rz_analysis_var_global_delete_byaddr_at(core->analysis, named->addr);
		if (type) {
			rz_analysis_var_global_create(core->analysis, named->name, type, named->addr);
		}
		if (named->csharp) {
			csharp_add_global(session, named->addr, named->csharp);
		}
	}
}

/**
 * \brief Reads the lines of a names file into the functions at addresses in a section of code and the globals at
 * addresses in any section, adds the helpers of its helper lines and leaves out the other lines. The names point into
 * the text, which the lines' ends split.
 */
static void read_lines(Session *session, char *text, RzVector /*<NamedAddress>*/ *found, RzVector /*<NamedAddress>*/ *globals) {
	RzCore *core = session->core;
	RzBinObject *object = rz_bin_cur_object(core->bin);
	ut64 baddr = rz_bin_get_baddr(core->bin);
	bool is_arm32 = !strcmp(rz_config_get(core->config, "asm.arch"), "arm") && rz_config_get_i(core->config, "asm.bits") != 64;
	for (char *line = text, *next; line && *line; line = next) {
		next = strchr(line, '\n');
		if (next) {
			*next++ = '\0';
		}

		if (strchr("!^&", *line)) {
			helpers_add_line(session, line);
			continue;
		}
		if (*line == '#' || *line == '.') {
			csharp_add_type_line(session, line);
			continue;
		}

		NamedAddress named;
		bool is_global = *line == '@';
		bool is_read = read_line(line + is_global, baddr, is_arm32 && !is_global, &named);
		RzBinSection *section = is_read && object ? rz_bin_get_section_at(object, named.addr, true) : NULL;
		if (section && is_global) {
			rz_vector_push(globals, &named);
		} else if (section && section->perm & RZ_PERM_X) {
			rz_vector_push(found, &named);
		}
	}
}

/**
 * \brief Loads a names file, which has 1 line for each function, then 1 line for each global that starts with `@`,
 * and the header with the types of its signatures, or an empty path without a header. A line that starts with `!`,
 * `^` or `&` adds a helper of the game's runtime, see helpers_add_line().
 *
 * Sets a `names.` flag at each address in a section of code with the name as the flag's real name, which the listing
 * and the decompiler read, and drops the flags and signatures of an earlier names file. Refuses a file without such an
 * address, because its names belong to another binary. Prepares each function again, so the decompiler gets the names
 * and signatures.
 */
EMSCRIPTEN_KEEPALIVE int session_load_names(Session *session, const char *path, const char *header_path) {
	RzCore *core = session->core;
	char *text = rz_file_slurp(path, NULL);
	if (!text) {
		return NAMES_UNREADABLE;
	}

	RzVector *found = rz_vector_new(sizeof(NamedAddress), NULL, NULL);
	RzVector *globals = rz_vector_new(sizeof(NamedAddress), NULL, NULL);
	helpers_clear(session);
	csharp_clear(session);
	read_lines(session, text, found, globals);
	if (rz_vector_empty(found)) {
		rz_vector_free(found);
		rz_vector_free(globals);
		free(text);
		return NAMES_MISMATCH;
	}

	load_header(core, header_path);
	load_globals(session, globals);
	rz_vector_free(globals);
	rz_flag_unset_glob(core->flags, "names.*");
	ht_up_free(session->signatures);
	session->signatures = ht_up_new(NULL, free);
	ht_up_free(session->parsed_signatures);
	session->parsed_signatures = ht_up_new(NULL, NULL);
	NamedAddress *named;
	rz_vector_foreach (found, named) {
		char flag_name[32];
		RzFlagItem *item = rz_flag_set(core->flags, rz_strf(flag_name, "names.%" PFMT64x, named->addr), named->addr, 1);
		if (item) {
			rz_flag_item_set_realname(core->flags, item, named->name);
		}
		if (named->signature && session->signatures) {
			ht_up_update(session->signatures, named->addr, rz_str_dup(named->signature));
		}
		if (named->csharp) {
			csharp_add_function(session, named->addr, named->csharp);
		}
		// marks Thumb code for the analysis, because a stripped binary doesn't have the symbols that mark it
		if (named->is_thumb) {
			rz_analysis_hint_set_bits(core->analysis, named->addr, 16);
		}
	}

	// lists the functions' starts again with the first function that needs its end, with the names file's functions
	rz_vector_clear(&session->starts);
	// keeps the text, because the functions' C# records point into it
	rz_vector_free(found);
	free(session->names_text);
	session->names_text = text;
	session->has_names = true;
	rz_set_u_free(session->prepared);
	session->prepared = rz_set_u_new();
	return NAMES_LOADED;
}

/**
 * \brief Adds the C types of a header to the type database, like the structs that a function's signature and
 * globals point to, which the decompiler resolves by their names when it decompiles, and the globals of a file of
 * names file lines that start with `@`, or an empty path without globals.
 */
EMSCRIPTEN_KEEPALIVE void session_load_types(Session *session, const char *header_path, const char *globals_path) {
	load_header(session->core, header_path);
	char *text = RZ_STR_ISNOTEMPTY(globals_path) ? rz_file_slurp(globals_path, NULL) : NULL;
	if (!text) {
		return;
	}

	RzVector *found = rz_vector_new(sizeof(NamedAddress), NULL, NULL);
	RzVector *globals = rz_vector_new(sizeof(NamedAddress), NULL, NULL);
	read_lines(session, text, found, globals);
	load_globals(session, globals);
	rz_vector_free(found);
	rz_vector_free(globals);
	free(text);
}

/**
 * \brief Sets the parameters and return type of a function from its signature in the names file, like a class's
 * struct for `__this`, which the decompiler then reads fields through.
 *
 * Leaves a function alone whose signature doesn't parse, like the signature of Il2CppDumper's `script.json`, whose
 * types are in its `il2cpp.h`. Keeps the parsed signature in place of its text, because the session analyzes a method
 * again that a caller's decompile created, and the signature of `Object..ctor` would otherwise parse for each of its
 * 100,000 callers.
 */
void names_file_apply_signature(Session *session, RzAnalysisFunction *fcn) {
	if (fcn->has_debuginfo) {
		return;
	}

	RzType *type = ht_up_find(session->parsed_signatures, fcn->addr, NULL);
	const char *signature = !type && session->signatures ? ht_up_find(session->signatures, fcn->addr, NULL) : NULL;
	if (signature) {
		RzTypeDB *typedb = rz_analysis_get_type_db(session->core->analysis);
		char *error = NULL;
		type = rz_type_parse_string_declaration_single(typedb->parser, signature, &error);
		free(error);
		if (!type || type->kind != RZ_TYPE_KIND_CALLABLE || !type->callable) {
			rz_type_free(type);
			return;
		}

		rz_pvector_push(&session->signature_types, type);
		ht_up_insert(session->parsed_signatures, fcn->addr, type);
		ht_up_delete(session->signatures, fcn->addr);
	}
	if (type) {
		debug_info_set_parameters(fcn, type->callable);
	}
}

/**
 * \brief Keeps what a walk over the `names.` flags needs to list the functions of a names file.
 */
typedef struct {
	PJ *j;
	RzSetU *listed; ///< addresses that the listing has, which the walk leaves out
} NamesWalk;

static bool add_named_function(RzFlagItem *item, void *user) {
	NamesWalk *walk = user;
	if (RZ_STR_ISNOTEMPTY(item->realname) && !rz_set_u_contains(walk->listed, item->offset)) {
		rz_set_u_add(walk->listed, item->offset);
		listing_add_symbol(walk->j, item->offset, 0, item->realname, true);
	}
	return true;
}

/**
 * \brief Adds the functions of the names file at the addresses that the listing doesn't have yet.
 */
void names_file_add_functions(PJ *j, Session *session, RzSetU *listed) {
	NamesWalk walk = { .j = j, .listed = listed };
	rz_flag_foreach_prefix(session->core->flags, "names.", -1, add_named_function, &walk);
}

/**
 * \brief Returns whether the binary exports `il2cpp_init`, like the binary of a Unity game that IL2CPP built.
 */
bool names_file_is_il2cpp(RzBinObject *object) {
	const RzPVector *symbols = rz_bin_object_get_symbols(object);
	void **it;
	if (symbols) {
		rz_pvector_foreach (symbols, it) {
			RzBinSymbol *symbol = *it;
			if (symbol->name && !strcmp(symbol->name, "il2cpp_init")) {
				return true;
			}
		}
	}
	return false;
}
