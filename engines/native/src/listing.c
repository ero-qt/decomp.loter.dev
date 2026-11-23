#include <emscripten/emscripten.h>
#include "session.h"

static bool has_address(const RzBinSymbol *symbol) {
	return !symbol->is_imported && symbol->vaddr && symbol->vaddr != UT64_MAX;
}

/**
 * \brief Returns whether a symbol is a function of the binary, which leaves out imports.
 */
bool listing_is_function(const RzBinSymbol *symbol) {
	return has_address(symbol) && symbol->type && !strcmp(symbol->type, RZ_BIN_TYPE_FUNC_STR);
}

static bool is_data(const RzBinSymbol *symbol) {
	return has_address(symbol) && symbol->type && !strcmp(symbol->type, RZ_BIN_TYPE_OBJECT_STR);
}

static bool is_global(const RzBinSymbol *symbol) {
	return symbol->bind && (!strcmp(symbol->bind, RZ_BIN_BIND_GLOBAL_STR) || !strcmp(symbol->bind, RZ_BIN_BIND_WEAK_STR));
}

/**
 * \brief Keeps the cap of a listing's functions and globals, so a binary with millions of symbols gets a reply that
 * fits into the worker's memory.
 */
static struct {
	bool is_counting; ///< whether a symbol only adds its address to addrs, which finds max_addr
	RzVector /*<ut64>*/ addrs;
	ut64 max_addr; ///< the highest address that the listing writes
	ut64 omitted; ///< count of the symbols above max_addr
} cap;

/**
 * \brief Adds a function or global with its clean name and the access and words that its MSVC name starts with.
 *
 * Only takes the address while the cap counts, and only counts a symbol above the cap's max_addr.
 */
void listing_add_symbol(PJ *j, ut64 addr, ut64 size, const char *raw_name, bool global) {
	if (cap.is_counting) {
		rz_vector_push(&cap.addrs, &addr);
		return;
	}
	if (addr > cap.max_addr) {
		cap.omitted++;
		return;
	}

	char *name = names_clean(raw_name);
	pj_o(j);
	session_put_address(j, "addr", addr);
	pj_kn(j, "size", size);
	pj_ks(j, "name", name);
	pj_kb(j, "global", global);
	names_add_msvc_words(j, raw_name);
	pj_end(j);
	free(name);
}

/**
 * \brief Adds the symbols of a kind and those of the session's PDB file, 1 for each address, and returns the set of
 * their addresses.
 *
 * A file can have a symbol twice, like an ELF file in its dynamic and its full symbol table.
 */
static RzSetU *add_symbols(PJ *j, Session *session, RzBinObject *object, bool (*is_kind)(const RzBinSymbol *)) {
	RzSetU *listed = rz_set_u_new();
	const RzPVector *symbols = rz_bin_object_get_symbols(object);
	void **it;
	if (symbols) {
		rz_pvector_foreach (symbols, it) {
			RzBinSymbol *symbol = *it;
			const char *name = is_kind(symbol) && !rz_set_u_contains(listed, symbol->vaddr) ? names_raw_of_symbol(object, symbol) : NULL;
			if (name) {
				rz_set_u_add(listed, symbol->vaddr);
				listing_add_symbol(j, symbol->vaddr, symbol->size, name, is_global(symbol));
			}
		}
	}

	pdb_add_symbols(j, session, listed, is_kind == listing_is_function);
	return listed;
}

/**
 * \brief Adds the functions of the symbols and the entry points without a symbol, which get the name `entry`.
 */
static void add_functions(PJ *j, Session *session, RzBinObject *object) {
	pj_ka(j, "functions");
	RzSetU *listed = add_symbols(j, session, object, listing_is_function);
	const RzPVector *entries = rz_bin_object_get_entries(object);
	void **it;
	if (entries) {
		rz_pvector_foreach (entries, it) {
			RzBinAddr *entry = *it;
			if (!rz_set_u_contains(listed, entry->vaddr)) {
				rz_set_u_add(listed, entry->vaddr);
				listing_add_symbol(j, entry->vaddr, 0, "entry", true);
			}
		}
	}
	rz_set_u_free(listed);
	pj_end(j);
}

/**
 * \brief Returns the address of an import's stub or pointer, like its entry in an ELF file's PLT, or UT64_MAX.
 *
 * A call of the import goes to that address.
 */
static ut64 import_address(RzBinObject *object, RzBinImport *import) {
	RzBinSymbol *symbol = import->name ? rz_bin_object_get_symbol_of_import(object, import) : NULL;
	return symbol && symbol->vaddr ? symbol->vaddr : UT64_MAX;
}

/**
 * \brief Returns whether an import is a function: its type says so, or its stub lies in a section of code.
 */
static bool is_import_function(RzBinObject *object, RzBinImport *import, ut64 addr) {
	if (import->type && !strcmp(import->type, RZ_BIN_TYPE_FUNC_STR)) {
		return true;
	}

	RzBinSection *section = addr != UT64_MAX ? rz_bin_get_section_at(object, addr, true) : NULL;
	return section && section->perm & RZ_PERM_X;
}

/**
 * \brief Adds the first max imports with their addresses and counts the others in `omittedImports`.
 */
static void add_imports(PJ *j, RzBinObject *object, size_t max) {
	pj_ka(j, "imports");
	const RzPVector *imports = rz_bin_object_get_imports(object);
	size_t count = imports ? rz_pvector_len(imports) : 0;
	for (size_t i = 0; i < count && i < max; i++) {
		RzBinImport *import = rz_pvector_at(imports, i);
		const char *raw = RZ_STR_ISNOTEMPTY(import->dname) ? import->dname : import->name;
		char *name = names_clean(raw ? raw : "");
		ut64 addr = import_address(object, import);
		pj_o(j);
		pj_ks(j, "name", name);
		pj_ks(j, "library", import->libname ? import->libname : "");
		pj_kb(j, "function", is_import_function(object, import, addr));
		if (addr != UT64_MAX) {
			session_put_address(j, "addr", addr);
		}
		pj_end(j);
		free(name);
	}
	pj_end(j);
	pj_kn(j, "omittedImports", count > max ? count - max : 0);
}

/**
 * \brief Adds the struct names of the type database, which has the classes of the file's debug information.
 */
static void add_types(PJ *j, RzCore *core) {
	pj_ka(j, "types");
	RzList *types = rz_type_db_get_base_types_of_kind(rz_analysis_get_type_db(core->analysis), RZ_BASE_TYPE_KIND_STRUCT);
	RzListIter *it;
	RzBaseType *type;
	rz_list_foreach (types, it, type) {
		pj_s(j, type->name);
	}
	rz_list_free(types);
	pj_end(j);
}

/**
 * \brief Adds the name of the PDB file in the debug directory, without its folder, and whether it's loaded.
 */
static void add_pdb(PJ *j, Session *session, RzBinObject *object) {
	const char *path = object->info && object->info->debug_file_name ? object->info->debug_file_name : "";
	const char *name = path;
	for (const char *at = path; *at; at++) {
		name = *at == '/' || *at == '\\' ? at + 1 : name;
	}

	pj_ks(j, "pdb", rz_str_endswith_icase(name, ".pdb") ? name : "");
	pj_kb(j, "hasPdb", session->pdb != NULL);
}

static int compare_addresses(const void *a, const void *b, void *user) {
	ut64 left = *(const ut64 *)a;
	ut64 right = *(const ut64 *)b;
	return left < right ? -1 : left > right;
}

/**
 * \brief Sets the cap's max_addr to the address of the symbol at max in address order, or UT64_MAX for a binary with
 * at most max functions and globals. Takes a max of at least 1.
 *
 * Lists the symbols once without writing them, which takes the same steps as the listing.
 */
static void find_max_address(Session *session, RzBinObject *object, size_t max) {
	PJ *ignored = pj_new();
	cap.is_counting = true;
	rz_vector_init(&cap.addrs, sizeof(ut64), NULL, NULL);
	add_functions(ignored, session, object);
	rz_set_u_free(add_symbols(ignored, session, object, is_data));
	pj_free(ignored);

	rz_vector_sort(&cap.addrs, compare_addresses, false, NULL);
	size_t count = rz_vector_len(&cap.addrs);
	cap.max_addr = count > max ? *(ut64 *)rz_vector_index_ptr(&cap.addrs, max - 1) : UT64_MAX;
	cap.omitted = 0;
	cap.is_counting = false;
	rz_vector_fini(&cap.addrs);
}

/**
 * \brief Adds the count of the binary's strings, which the worker only lists up to its cap.
 */
static void add_string_count(PJ *j, RzBinObject *object) {
	const RzPVector *strings = rz_bin_object_get_strings(object);
	pj_kn(j, "strings", strings ? rz_pvector_len(strings) : 0);
}

/**
 * \brief Lists the image base, functions, globals and imports of the open file, the structs of its debug information,
 * the classes of its RTTI, its PDB file and the count of its strings as JSON, or returns NULL without a binary.
 *
 * Lists the max functions and globals with the lowest addresses and the first max imports, and counts the others in
 * `omitted` and `omittedImports`. Lists names as the demangler writes them, with their parameters. The worker groups
 * them into rows. The caller frees the result with free().
 */
EMSCRIPTEN_KEEPALIVE char *session_listing(Session *session, size_t max) {
	RzCore *core = session->core;
	RzBinObject *object = rz_bin_cur_object(core->bin);
	if (!object) {
		return NULL;
	}

	max = RZ_MAX(max, 1);
	find_max_address(session, object, max);
	PJ *j = pj_new();
	pj_o(j);
	session_put_address(j, "base", rz_bin_get_baddr(core->bin));
	add_functions(j, session, object);
	pj_ka(j, "data");
	rz_set_u_free(add_symbols(j, session, object, is_data));
	pj_end(j);
	pj_kn(j, "omitted", cap.omitted);
	add_pdb(j, session, object);
	add_imports(j, object, max);
	add_types(j, core);
	classes_add_rtti(j, session, object);
	add_string_count(j, object);
	pj_end(j);
	return pj_drain(j);
}
