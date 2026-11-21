// imports only mscoree.dll, like a .NET program, whose code the loader hands to the runtime
__declspec(dllimport) int _CorExeMain(void);

int start(void) {
    return _CorExeMain();
}
