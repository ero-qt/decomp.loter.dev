#include <emscripten/emscripten.h>
#include "session.h"

static bool has_address(const RzBinSymbol *symbol) {
	return !symbol->is_imported && symbol->vaddr && symbol->vaddr != UT64_MAX;
}

static bool is_function(const RzBinSymbol *symbol) {
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
 * \brief Adds a function or global, but only takes the address while the cap counts, and only counts a symbol above
 * the cap's max_addr.
 */
static void add_symbol(PJ *j, ut64 addr, ut64 size, const char *name, bool global) {
	if (cap.is_counting) {
		rz_vector_push(&cap.addrs, &addr);
		return;
	}
	if (addr > cap.max_addr) {
		cap.omitted++;
		return;
	}

	pj_o(j);
	session_put_address(j, "addr", addr);
	pj_kn(j, "size", size);
	pj_ks(j, "name", name);
	pj_kb(j, "global", global);
	pj_end(j);
}

/**
 * \brief Adds the symbols of a kind, 1 for each address, and returns the set of their addresses.
 *
 * A file can have a symbol twice, like an ELF file in its dynamic and its full symbol table.
 */
static RzSetU *add_symbols(PJ *j, RzBinObject *object, bool (*is_kind)(const RzBinSymbol *)) {
	RzSetU *listed = rz_set_u_new();
	const RzPVector *symbols = rz_bin_object_get_symbols(object);
	void **it;
	if (symbols) {
		rz_pvector_foreach (symbols, it) {
			RzBinSymbol *symbol = *it;
			char *name = is_kind(symbol) && !rz_set_u_contains(listed, symbol->vaddr) ? names_of_symbol(object, symbol) : NULL;
			if (name) {
				rz_set_u_add(listed, symbol->vaddr);
				add_symbol(j, symbol->vaddr, symbol->size, name, is_global(symbol));
			}
			free(name);
		}
	}
	return listed;
}

/**
 * \brief Adds the functions of the symbols and the entry points without a symbol, which get the name `entry`.
 */
static void add_functions(PJ *j, RzBinObject *object) {
	pj_ka(j, "functions");
	RzSetU *listed = add_symbols(j, object, is_function);
	const RzPVector *entries = rz_bin_object_get_entries(object);
	void **it;
	if (entries) {
		rz_pvector_foreach (entries, it) {
			RzBinAddr *entry = *it;
			if (!rz_set_u_contains(listed, entry->vaddr)) {
				rz_set_u_add(listed, entry->vaddr);
				add_symbol(j, entry->vaddr, 0, "entry", true);
			}
		}
	}
	rz_set_u_free(listed);
	pj_end(j);
}

/**
 * \brief Adds the first max imports and counts the others in `omittedImports`.
 */
static void add_imports(PJ *j, RzBinObject *object, size_t max) {
	pj_ka(j, "imports");
	const RzPVector *imports = rz_bin_object_get_imports(object);
	size_t count = imports ? rz_pvector_len(imports) : 0;
	for (size_t i = 0; i < count && i < max; i++) {
		RzBinImport *import = rz_pvector_at(imports, i);
		const char *raw = RZ_STR_ISNOTEMPTY(import->dname) ? import->dname : import->name;
		char *name = names_clean(raw ? raw : "");
		pj_o(j);
		pj_ks(j, "name", name);
		pj_ks(j, "library", import->libname ? import->libname : "");
		pj_kb(j, "function", import->type && !strcmp(import->type, RZ_BIN_TYPE_FUNC_STR));
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
	add_functions(ignored, object);
	rz_set_u_free(add_symbols(ignored, object, is_data));
	pj_free(ignored);

	rz_vector_sort(&cap.addrs, compare_addresses, false, NULL);
	size_t count = rz_vector_len(&cap.addrs);
	cap.max_addr = count > max ? *(ut64 *)rz_vector_index_ptr(&cap.addrs, max - 1) : UT64_MAX;
	cap.omitted = 0;
	cap.is_counting = false;
	rz_vector_fini(&cap.addrs);
}

/**
 * \brief Lists the image base, functions, globals and imports of the open file and the structs of its debug
 * information as JSON, or returns NULL without a binary.
 *
 * Lists the max functions and globals with the lowest addresses and the first max imports, and counts the others in
 * `omitted` and `omittedImports`. Lists names as the demangler writes them, with their parameters. The worker groups
 * them into rows. The caller frees the result with free().
 */
EMSCRIPTEN_KEEPALIVE char *session_listing(Session *session, size_t max) {
	RzCore *core = session_use(session);
	RzBinObject *object = rz_bin_cur_object(core->bin);
	if (!object) {
		return NULL;
	}

	max = RZ_MAX(max, 1);
	find_max_address(session, object, max);
	PJ *j = pj_new();
	pj_o(j);
	session_put_address(j, "base", rz_bin_get_baddr(core->bin));
	add_functions(j, object);
	pj_ka(j, "data");
	rz_set_u_free(add_symbols(j, object, is_data));
	pj_end(j);
	pj_kn(j, "omitted", cap.omitted);
	add_imports(j, object, max);
	add_types(j, core);
	pj_end(j);
	return pj_drain(j);
}
