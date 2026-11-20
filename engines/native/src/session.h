#ifndef NATIVE_SESSION_H
#define NATIVE_SESSION_H

#include <rz_core.h>

/**
 * \brief Keeps the Rizin core of 1 open file.
 */
typedef struct {
	RzCore *core;
	RzSetU *prepared; ///< addresses of the functions that the session analyzed and prepared for the decompiler
	RzVector /*<ut64>*/ starts; ///< sorted start addresses of the function symbols, filled on the first analysis
} Session;

RzCore *session_use(Session *session);
void session_put_address(PJ *j, const char *key, ut64 addr);

char *names_clean(const char *name);
char *names_of_symbol(RzBinObject *object, const RzBinSymbol *symbol);
char *names_for_code(RzCore *core, ut64 addr);

bool listing_is_function(const RzBinSymbol *symbol);

void debug_info_apply_dwarf(RzCore *core, RzAnalysisFunction *fcn);

#endif
