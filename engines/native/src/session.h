#ifndef NATIVE_SESSION_H
#define NATIVE_SESSION_H

#include <rz_core.h>

/**
 * \brief Keeps the Rizin core of 1 open file.
 */
typedef struct {
	RzCore *core;
} Session;

RzCore *session_use(Session *session);
void session_put_address(PJ *j, const char *key, ut64 addr);

char *names_clean(const char *name);
char *names_of_symbol(RzBinObject *object, const RzBinSymbol *symbol);

#endif
