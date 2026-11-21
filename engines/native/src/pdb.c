#include <emscripten/emscripten.h>
#include "session.h"

// result of a PDB load -> the reason that the worker reports
typedef enum {
	PDB_LOADED,
	PDB_UNREADABLE,
	PDB_MISMATCH,
} PdbLoad;

/**
 * \brief Keeps what a walk over the PDB's symbols needs to list the procedures or the data.
 */
typedef struct {
	PJ *j;
	RzSetU *listed; ///< addresses that the listing has, which the walk leaves out
	HtUP *publics; ///< address -> demangled name of the public symbol there, which has the access of a member
	ut64 baddr;
	bool is_code; ///< whether the walk lists procedures, else data
	RzDemanglerFlag flags;
} PdbWalk;

/**
 * \brief Returns whether a PDB file's GUID matches the GUID in the PE binary's debug directory.
 */
static bool pdb_matches(RzBinObject *object, RzPdb *pdb) {
	const char *guid = object && object->info ? object->info->guid : NULL;
	if (!guid || !pdb->s_pdb) {
		return false;
	}

	const RzPdbGuid *id = &pdb->s_pdb->hdr.unique_id;
	char text[40];
	rz_strf(text, "%08X%04X%04X%02X%02X%02X%02X%02X%02X%02X%02X", id->data1, id->data2, id->data3, id->data4[0],
		id->data4[1], id->data4[2], id->data4[3], id->data4[4], id->data4[5], id->data4[6], id->data4[7]);
	return !rz_str_ncasecmp(guid, text, strlen(text));
}

/**
 * \brief Loads the names and types of a PDB file into the session after it checks that the file belongs to the binary.
 *
 * Keeps the PDB file for the procedures of the functions that the session prepares later, and prepares each function
 * again.
 */
EMSCRIPTEN_KEEPALIVE int session_load_pdb(Session *session, const char *path) {
	RzCore *core = session_use(session);
	RzPdb *pdb = rz_bin_pdb_parse_from_file(path);
	if (!pdb) {
		return PDB_UNREADABLE;
	}

	bool matches = pdb_matches(rz_bin_cur_object(core->bin), pdb);
	rz_bin_pdb_free(pdb);
	if (!matches) {
		return PDB_MISMATCH;
	}

	pdb = rz_core_pdb_load_info(core, path);
	if (!pdb) {
		return PDB_UNREADABLE;
	}

	rz_bin_pdb_free(session->pdb);
	session->pdb = pdb;
	rz_set_u_free(session->prepared);
	session->prepared = rz_set_u_new();
	return PDB_LOADED;
}

static ut64 symbol_address(RzPdb *pdb, const PDBSectionOffset *offset, ut64 baddr) {
	ut64 rva = rz_bin_pdb_to_rva(pdb, offset);
	return rva == UT64_MAX ? UT64_MAX : rva + baddr;
}

static bool collect_public(RzPdb *pdb, const PDBSymbol *symbol, void *user) {
	PdbWalk *walk = user;
	const PDBSPublic *public = symbol && symbol->kind == PDB_Public ? symbol->data : NULL;
	ut64 addr = public && RZ_STR_ISNOTEMPTY(public->name) ? symbol_address(pdb, &public->offset, walk->baddr) : UT64_MAX;
	if (addr == UT64_MAX || ht_up_find(walk->publics, addr, NULL)) {
		return true;
	}

	char *name = rz_demangler_msvc(public->name, walk->flags);
	ht_up_insert(walk->publics, addr, name ? name : rz_str_dup(public->name));
	return true;
}

/**
 * \brief Lists a procedure or a global of the PDB that the listing doesn't have, by the name of the public symbol at
 * its address when there is one.
 */
static bool add_symbol(RzPdb *pdb, const PDBSymbol *symbol, void *user) {
	PdbWalk *walk = user;
	const char *name = NULL;
	const PDBSectionOffset *offset = NULL;
	ut64 size = 0;
	bool global = false;
	if (symbol && walk->is_code && symbol->kind == PDB_Procedure) {
		const PDBSProcedure *procedure = symbol->data;
		name = procedure->name;
		offset = &procedure->offset;
		size = procedure->length;
		global = procedure->global;
	} else if (symbol && !walk->is_code && symbol->kind == PDB_Data) {
		const PDBSData *data = symbol->data;
		name = data->name;
		offset = &data->offset;
		global = data->global;
	}

	ut64 addr = RZ_STR_ISNOTEMPTY(name) ? symbol_address(pdb, offset, walk->baddr) : UT64_MAX;
	if (addr == UT64_MAX || rz_set_u_contains(walk->listed, addr)) {
		return true;
	}

	const char *public_name = ht_up_find(walk->publics, addr, NULL);
	rz_set_u_add(walk->listed, addr);
	listing_add_symbol(walk->j, addr, size, public_name ? public_name : name, global);
	return true;
}

/**
 * \brief Adds the procedures, or else the globals, of the session's PDB file whose addresses the listing doesn't have.
 */
void pdb_add_symbols(PJ *j, Session *session, RzSetU *listed, bool is_code) {
	if (!session->pdb) {
		return;
	}

	PdbWalk walk = {
		.j = j,
		.listed = listed,
		.publics = ht_up_new(NULL, free),
		.baddr = rz_bin_get_baddr(session->core->bin),
		.is_code = is_code,
		.flags = rz_demangler_get_flags(session->core->bin->demangler),
	};
	rz_pdb_all_symbols_foreach(session->pdb, collect_public, &walk);
	rz_pdb_all_symbols_foreach(session->pdb, add_symbol, &walk);
	ht_up_free(walk.publics);
}
