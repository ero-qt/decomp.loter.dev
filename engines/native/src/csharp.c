#include <emscripten/emscripten.h>
#include <rz_ghidra.h>
#include "session.h"

static void global_free(void *value) {
	SessionCSharpGlobal *global = value;
	if (global) {
		free(global->record);
		free(global);
	}
}

static void type_free(void *value) {
	SessionCSharpType *type = value;
	if (type) {
		free(type->name);
		free(type);
	}
}

static void sharers_free(void *value) {
	rz_vector_free(value);
}

/**
 * \brief Drops the C# records of the session's names file.
 */
void csharp_clear(Session *session) {
	ht_up_free(session->csharp_functions);
	ht_up_free(session->csharp_globals);
	ht_sp_free(session->csharp_types);
	ht_up_free(session->csharp_sharers);
	session->csharp_functions = ht_up_new(NULL, NULL);
	session->csharp_globals = ht_up_new(NULL, global_free);
	session->csharp_types = ht_sp_new(HT_STR_DUP, NULL, type_free);
	session->csharp_sharers = ht_up_new(NULL, sharers_free);
}

/**
 * \brief Keeps what a function at an address is in C# from the end of the function's line in a names file, its kind
 * as a digit of RzGhidraCSharpKind, `s` for a static method or `i`, the count of its C# parameters, the C# name of
 * its type and the member's name, each after a tab.
 *
 * Splits the text at the tabs and keeps it, so the names file's text has to stay.
 */
void csharp_add_function(Session *session, ut64 addr, char *record) {
	char *type = strchr(record, '\t');
	char *name = type ? strchr(type + 1, '\t') : NULL;
	if (!name || !record[0] || !record[1]) {
		return;
	}

	*type = '\0';
	*name = '\0';
	ht_up_update(session->csharp_functions, addr, record);
}

/**
 * \brief Keeps what a method that shares the code of the function at an address is in C#, from a line of a names file
 * that starts with `%`: the method's index among the methods that share the code, its kind, `s` or `i` and count of
 * parameters like in a function's line, the C# name of its type, its name and the structs that its C parameters point
 * to with a comma between them, each after a tab.
 *
 * Splits the text at the tabs and keeps it, so the names file's text has to stay.
 */
void csharp_add_sharer(Session *session, ut64 addr, char *record) {
	char *fields[5] = { record };
	for (size_t i = 1; i < RZ_ARRAY_SIZE(fields); i++) {
		char *tab = strchr(fields[i - 1], '\t');
		if (!tab) {
			return;
		}
		*tab = '\0';
		fields[i] = tab + 1;
	}
	const char *head = fields[1];
	if (!head[0] || !head[1]) {
		return;
	}

	RzVector *sharers = ht_up_find(session->csharp_sharers, addr, NULL);
	if (!sharers) {
		sharers = rz_vector_new(sizeof(RzGhidraCSharpSharer), NULL, NULL);
		if (!sharers || !ht_up_insert(session->csharp_sharers, addr, sharers)) {
			rz_vector_free(sharers);
			return;
		}
	}

	RzGhidraCSharpSharer *sharer = rz_vector_push(sharers, NULL);
	if (!sharer) {
		return;
	}
	sharer->index = (ut32)strtoul(fields[0], NULL, 10);
	sharer->function.kind = (RzGhidraCSharpKind)(head[0] - '0');
	sharer->function.is_static = head[1] == 's';
	sharer->function.parameters = (ut32)strtoul(head + 2, NULL, 10);
	sharer->function.type = fields[2];
	sharer->function.name = fields[3];
	sharer->parameter_structs = fields[4];
}

/**
 * \brief Keeps what the global at an address is in C# from the end of the global's line in a names file, its C# text,
 * like `typeof(Circle)`, the name of the type that it names, and for a method's global the method's kind, `s` or `i`
 * and count of parameters like in a function's line and the method's name, each after a tab. A global without a type
 * or a method has empty texts there.
 */
void csharp_add_global(Session *session, ut64 addr, const char *record) {
	SessionCSharpGlobal *global = RZ_NEW0(SessionCSharpGlobal);
	if (!global) {
		return;
	}

	global->record = rz_str_dup(record);
	char *fields[4] = { global->record, "", "", "" };
	for (size_t i = 1; i < RZ_ARRAY_SIZE(fields); i++) {
		char *tab = strchr(fields[i - 1], '\t');
		if (!tab) {
			break;
		}
		*tab = '\0';
		fields[i] = tab + 1;
	}

	global->global.text = fields[0];
	global->global.type = *fields[1] ? fields[1] : NULL;
	if (fields[2][0] && fields[2][1]) {
		global->method.kind = (RzGhidraCSharpKind)(fields[2][0] - '0');
		global->method.is_static = fields[2][1] == 's';
		global->method.parameters = (ut32)strtoul(fields[2] + 2, NULL, 10);
		global->method.type = fields[1];
		global->method.name = fields[3];
		global->global.method = &global->method;
	}
	ht_up_update(session->csharp_globals, addr, global);
}

/**
 * \brief Reads a line of a names file about a struct. A line with `#` has the struct's name, the C# name of its type
 * and `o` for the struct of a class's objects, `a` for the struct of an array's objects, `s` for the struct of a
 * class's static fields, `m` for the runtime's metadata of a class or a method or `-`. A line with `.` has
 * the struct's name, a member's C name and the member's C# name, which the member of the type database gets,
 * because C doesn't take every name that C# has, like `<Radius>k__BackingField`.
 */
void csharp_add_type_line(Session *session, const char *line) {
	const char *tab = strchr(line, '\t');
	const char *second = tab ? strchr(tab + 1, '\t') : NULL;
	if (!second) {
		return;
	}

	char *struct_name = rz_str_ndup(line + 1, tab - line - 1);
	if (*line == '#') {
		SessionCSharpType *type = RZ_NEW0(SessionCSharpType);
		if (type) {
			type->name = rz_str_ndup(tab + 1, second - tab - 1);
			type->type.name = type->name;
			type->type.is_array = second[1] == 'a';
			type->type.is_object = second[1] == 'o' || type->type.is_array;
			type->type.is_static = second[1] == 's';
			type->type.is_metadata = second[1] == 'm';
			ht_sp_update(session->csharp_types, struct_name, type);
		}
		free(struct_name);
		return;
	}

	RzTypeDB *typedb = rz_analysis_get_type_db(session->core->analysis);
	RzBaseType *base = rz_type_db_get_base_type(typedb, struct_name);
	char *c_name = rz_str_ndup(tab + 1, second - tab - 1);
	RzTypeStructMember *member;
	if (base && base->kind == RZ_BASE_TYPE_KIND_STRUCT) {
		rz_vector_foreach (&base->struct_data.members, member) {
			if (!strcmp(member->name, c_name)) {
				free(member->name);
				member->name = rz_str_dup(second + 1);
				break;
			}
		}
	}
	free(c_name);
	free(struct_name);
}

static const RzGhidraCSharpFunction *find_function(void *user, ut64 addr) {
	static RzGhidraCSharpFunction function;
	Session *session = user;
	const char *record = ht_up_find(session->csharp_functions, addr, NULL);
	if (record) {
		function.kind = (RzGhidraCSharpKind)(record[0] - '0');
		function.is_static = record[1] == 's';
		function.parameters = (ut32)strtoul(record + 2, NULL, 10);
		function.type = record + strlen(record) + 1;
		function.name = function.type + strlen(function.type) + 1;
		return &function;
	}

	const SessionHelper *helper = session->helpers ? ht_up_find(session->helpers, addr, NULL) : NULL;
	if (!helper) {
		return NULL;
	}

	function.kind = (RzGhidraCSharpKind)helper->kind;
	function.is_static = true;
	function.parameters = 0;
	// a helper that the session found by a text raises the exception of the class with that name
	function.type = helper->how == '^' ? helper->source : "";
	function.name = helper->name;
	return &function;
}

static const RzGhidraCSharpGlobal *find_global(void *user, ut64 addr) {
	SessionCSharpGlobal *global = ht_up_find(((Session *)user)->csharp_globals, addr, NULL);
	return global ? &global->global : NULL;
}

static const RzGhidraCSharpSharer *find_sharer(void *user, ut64 addr, ut32 index) {
	RzVector *sharers = ht_up_find(((Session *)user)->csharp_sharers, addr, NULL);
	return sharers && index < rz_vector_len(sharers) ? rz_vector_index_ptr(sharers, index) : NULL;
}

static const RzGhidraCSharpType *find_type(void *user, const char *name) {
	SessionCSharpType *type = ht_sp_find(((Session *)user)->csharp_types, name, NULL);
	return type ? &type->type : NULL;
}

/**
 * \brief Returns the name of the exception's class that the helper at an address raises, or NULL for another function.
 */
static const char *find_raised_class(Session *session, ut64 addr) {
	const SessionHelper *helper = session->helpers ? ht_up_find(session->helpers, addr, NULL) : NULL;
	return helper && helper->how == '^' ? helper->source : NULL;
}

static void link_fini(void *item, void *user) {
	free(((RzGhidraCSharpLink *)item)->name);
}

/**
 * \brief Decompiles the function at an address into C# with the names of the session's names file and returns the
 * code with its annotations like session_decompile(), and the parts that name types and fields in `links`. The link
 * of the class of a raised exception has the type `raised_type` and the class's name. The link of a method that a call
 * of shared code reads as, or of its type, has the method's index among the methods that share the code in `sharer`.
 *
 * The caller frees the result with free().
 */
EMSCRIPTEN_KEEPALIVE char *session_decompile_csharp(Session *session, const char *addr) {
	static const char *const kinds[] = {
		[RZ_GHIDRA_CSHARP_LINK_TYPE] = "type",
		[RZ_GHIDRA_CSHARP_LINK_FIELD] = "field",
		[RZ_GHIDRA_CSHARP_LINK_DECLARING_TYPE] = "declaring_type",
		[RZ_GHIDRA_CSHARP_LINK_PROPERTY] = "property",
		[RZ_GHIDRA_CSHARP_LINK_SHARER] = "sharer",
		[RZ_GHIDRA_CSHARP_LINK_SHARER_TYPE] = "sharer_type",
	};
	RzGhidraCSharpNames names = {
		.user = session,
		.function = find_function,
		.global = find_global,
		.type = find_type,
		.sharer = find_sharer,
	};
	RzVector links;
	rz_vector_init(&links, sizeof(RzGhidraCSharpLink), link_fini, NULL);
	RzAnnotatedCode *code = rz_ghidra_decompile_csharp(session->core, strtoull(addr, NULL, 16), &names, &links);
	if (!code) {
		rz_vector_fini(&links);
		return NULL;
	}

	PJ *j = pj_new();
	pj_o(j);
	decompile_put_code(j, code);
	pj_ka(j, "links");
	RzGhidraCSharpLink *link;
	rz_vector_foreach (&links, link) {
		pj_o(j);
		pj_kn(j, "start", link->start);
		pj_kn(j, "end", link->end);
		const char *raised = link->kind == RZ_GHIDRA_CSHARP_LINK_DECLARING_TYPE ? find_raised_class(session, link->offset) : NULL;
		pj_ks(j, "type", raised ? "raised_type" : kinds[link->kind]);
		if (raised || link->name) {
			pj_ks(j, "name", raised ? raised : link->name);
		}
		if (link->kind == RZ_GHIDRA_CSHARP_LINK_SHARER || link->kind == RZ_GHIDRA_CSHARP_LINK_SHARER_TYPE) {
			pj_kn(j, "sharer", link->sharer);
		}
		session_put_address(j, "offset", link->offset);
		pj_end(j);
	}
	pj_end(j);
	pj_end(j);
	rz_annotated_code_free(code);
	rz_vector_fini(&links);
	return pj_drain(j);
}
