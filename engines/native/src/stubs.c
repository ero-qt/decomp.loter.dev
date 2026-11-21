#include <rz_core.h>
#include <rz_socket.h>

// the browser has neither signals nor sockets, and the static build declares these functions without compiling them,
// so they do nothing here

RZ_API void rz_signal_sigmask(int how, const sigset_t *newmask, sigset_t *oldmask) {
}

RZ_API RzStopPipe *rz_stop_pipe_new(void) {
	return malloc(1);
}

RZ_API void rz_stop_pipe_free(RzStopPipe *stop_pipe) {
	free(stop_pipe);
}

RZ_API void rz_stop_pipe_stop(RzStopPipe *stop_pipe) {
}

RZ_API RzStopPipeSelectResult rz_stop_pipe_select_single(RzStopPipe *stop_pipe, RzSocket *sock, bool sock_write, ut64 timeout_ms) {
	return RZ_STOP_PIPE_STOPPED;
}
