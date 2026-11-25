#ifndef NATIVE_SESSION_H
#define NATIVE_SESSION_H

#include <rz_core.h>
#include <rz_pdb.h>

/**
 * \brief Keeps the Rizin core of 1 open file.
 */
typedef struct {
	RzCore *core;
	RzSetU *prepared; ///< addresses of the functions that the session analyzed and prepared for the decompiler
	RzVector /*<ut64>*/ starts; ///< sorted start addresses of the function symbols, filled on the first analysis
	HtUP /*<ut64, RzBinSymbol *>*/ *symbols; ///< the binary's symbols by their addresses, filled on the first lookup
	RzPdb *pdb; ///< the loaded PDB file, whose procedures the session adds to each function that it prepares
	bool is_rtti_recovered; ///< whether the analysis has the classes of the binary's RTTI
} Session;

void session_put_address(PJ *j, const char *key, ut64 addr);

char *names_clean(const char *name);
char *names_signature(const char *name);
const char *names_raw_of_symbol(RzBinObject *object, const RzBinSymbol *symbol);
char *names_of_symbol(RzBinObject *object, const RzBinSymbol *symbol);
void names_add_msvc_words(PJ *j, const char *name);
char *names_for_code(Session *session, ut64 addr);
RzBinSymbol *names_symbol_at(Session *session, ut64 addr);

bool listing_is_function(const RzBinSymbol *symbol);
void listing_add_symbol(PJ *j, ut64 addr, ut64 size, const char *raw_name, bool global);
void classes_add_rtti(PJ *j, Session *session, RzBinObject *object);

void debug_info_apply_dwarf(RzCore *core, RzAnalysisFunction *fcn);
void debug_info_apply_pdb(Session *session, RzAnalysisFunction *fcn);

void pdb_add_symbols(PJ *j, Session *session, RzSetU *listed, bool is_code);

#endif
