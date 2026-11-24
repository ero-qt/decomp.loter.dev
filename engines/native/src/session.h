#ifndef NATIVE_SESSION_H
#define NATIVE_SESSION_H

#include <rz_core.h>
#include <rz_pdb.h>
#include <rz_ghidra.h>

/**
 * \brief A helper of a game's runtime from a names file, like the function that runs a class's static constructor.
 */
typedef struct {
	char how; ///< how the session finds the helper's functions, `!` by an export, `^` by a text or `&` by a global
	char *source; ///< the export's name or the text
	char *name; ///< the name that the helper's functions get
	ut32 kind; ///< the helper's kind, which the names file gives
	char *signature; ///< the C signature of the helper's functions, or an empty text
} SessionHelper;

/**
 * \brief A struct of a names file with its C# name, and the text that the name points to.
 */
typedef struct {
	RzGhidraCSharpType type;
	char *name;
} SessionCSharpType;

/**
 * \brief A global of a names file with its C# text, and the record that its texts point into.
 */
typedef struct {
	RzGhidraCSharpGlobal global;
	RzGhidraCSharpFunction method;
	char *record;
} SessionCSharpGlobal;

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
	bool has_names; ///< whether the session loaded a names file
	HtUP /*<ut64, char *>*/ *signatures; ///< C signatures of the names file's functions by their addresses
	RzPVector /*<RzType *>*/ signature_types; ///< parsed signatures, which the functions' variables borrow from
	HtUP /*<ut64, RzType *>*/ *parsed_signatures; ///< parsed signatures by their functions' addresses
	RzPVector /*<SessionHelper *>*/ helper_list; ///< the helpers of the names file
	HtUP /*<ut64, SessionHelper *>*/ *helper_implementations; ///< helpers by the functions that their exports end in
	HtUP /*<ut64, SessionHelper *>*/ *helpers; ///< helpers by the addresses of their functions
	RzSetU *checked_helpers; ///< the addresses that the session looked for a helper at
	RzSetU *noreturn_helpers; ///< the addresses of the checked functions whose code doesn't return
	char *names_text; ///< the text of the names file, which the functions' C# records point into
	HtUP /*<ut64, const char *>*/ *csharp_functions; ///< what the names file's functions are in C#, by their addresses
	HtUP /*<ut64, SessionCSharpGlobal *>*/ *csharp_globals; ///< the names file's globals by their addresses
	HtSP /*<const char *, SessionCSharpType *>*/ *csharp_types; ///< the names file's structs by their names
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
void debug_info_set_parameters(RzAnalysisFunction *fcn, RzCallable *callable);
void debug_info_apply_pdb(Session *session, RzAnalysisFunction *fcn);

void pdb_add_symbols(PJ *j, Session *session, RzSetU *listed, bool is_code);

void names_file_add_functions(PJ *j, Session *session, RzSetU *listed);
bool names_file_is_il2cpp(RzBinObject *object);
void names_file_apply_signature(Session *session, RzAnalysisFunction *fcn);
void locals_apply_pointed_types(Session *session, RzAnalysisFunction *fcn);

void helpers_clear(Session *session);
void helpers_add_line(Session *session, const char *line);
void helpers_set_global_taker(Session *session, ut64 addr);
const SessionHelper *helpers_find(Session *session, ut64 addr, bool *is_noreturn);

void csharp_clear(Session *session);
void csharp_add_function(Session *session, ut64 addr, char *record);
void csharp_add_global(Session *session, ut64 addr, const char *record);
void csharp_add_type_line(Session *session, const char *line);

void decompile_put_code(PJ *j, const RzAnnotatedCode *code);

#endif
