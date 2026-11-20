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

#endif
